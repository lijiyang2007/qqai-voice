// Durable at-most-once send receipts, owned by one bridge process per stateDir.
// No network, timers, pruning, path-bearing public fields, or implicit resend permission.
// Caller must send ONLY when begin().created === true, after current target/limits checks.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const VOICE_RECEIPT_MAX_RECORDS = 10000;
export const VOICE_RECEIPT_MAX_BYTES = 16 * 1024 * 1024;
const STATES = new Set(['pending', 'sent', 'verified', 'uncertain', 'rejected']);
const own = (o, k) => Object.hasOwn(o, k);
function error(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; throw e; }
function idOf(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(id)) error('Invalid delivery id'); return id; }
function targetOf(target) { if (typeof target !== 'string' || !/^(group|private):[1-9]\d{0,19}$/.test(target)) error('Invalid delivery target'); return target; }
function hashOf(hash) { if (typeof hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hash)) error('Invalid audio SHA256'); return hash.toLowerCase(); }
function messageOf(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) error('Invalid QQ message id');
  if (!['number', 'string'].includes(typeof value) || !/^-?[1-9]\d{0,19}$/.test(String(value))) error('Invalid QQ message id');
  return String(value);
}
const clone = r => r == null ? null : { ...r };

export function createVoiceDeliveryReceipts({ stateDir, now = Date.now, maxRecords = VOICE_RECEIPT_MAX_RECORDS, maxBytes = VOICE_RECEIPT_MAX_BYTES }) {
  if (typeof stateDir !== 'string' || !stateDir || typeof now !== 'function'
      || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > VOICE_RECEIPT_MAX_RECORDS
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > VOICE_RECEIPT_MAX_BYTES) error('Invalid receipt store configuration');
  const root = path.resolve(stateDir); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'voice-delivery-receipts.json');
  let records = Object.create(null), poisoned = false;
  function healthy() { if (poisoned) error('Receipt persistence failed; sending is disabled until operator review', 503); }
  function clock() { const n = now(); if (!Number.isSafeInteger(n) || n < 0) error('Invalid receipt clock', 503); return n; }
  function encode(next) { return JSON.stringify({ version: 1, records: next }, null, 2); }
  function persist(next) {
    healthy();
    const data = encode(next);
    if (Buffer.byteLength(data, 'utf8') > maxBytes) error('Receipt store full; old claims retained, new operation rejected', 507);
    const temp = path.join(root, `.voice-delivery-receipts-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temp, 'wx');
      fs.writeFileSync(fd, data, 'utf8'); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      records = next; // Publish only after the atomic durable-file replacement succeeds.
    } catch {
      poisoned = true;
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      // Keep diagnostic temp artifacts. Never delete/recreate the claims on failure.
      error('Receipt persistence failed; sending is disabled until operator review', 503);
    }
  }
  function validateStored(id, r) {
    idOf(id);
    const fields = new Set(['deliveryId','target','sha256','status','createdAt','updatedAt','messageId','verified','retryable']);
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !fields.has(k))) error('Invalid receipt record', 503);
    if (r.deliveryId !== id || !STATES.has(r.status) || !Number.isSafeInteger(r.createdAt) || r.createdAt < 0
        || !Number.isSafeInteger(r.updatedAt) || r.updatedAt < r.createdAt || r.verified !== (r.status === 'verified') || r.retryable !== false) error('Invalid receipt record', 503);
    const result = { deliveryId:id, target:targetOf(r.target), sha256:hashOf(r.sha256), status:r.status,
      createdAt:r.createdAt, updatedAt:r.updatedAt, verified:r.verified, retryable:false };
    if (own(r,'messageId')) result.messageId = messageOf(r.messageId);
    if (['sent','verified'].includes(r.status) && !result.messageId) error('Sent receipt has no message id', 503);
    if (['pending','rejected'].includes(r.status) && result.messageId) error('Unsent receipt has message id', 503);
    return result;
  }
  if (fs.existsSync(file)) {
    let saved;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) error('Invalid receipt store', 503);
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.version !== 1 || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records)
          || Object.keys(saved).some(k => !['version','records'].includes(k)) || Object.keys(saved.records).length > maxRecords) error('Invalid receipt store', 503);
      for (const [id,r] of Object.entries(saved.records)) records[id] = validateStored(id,r);
    } catch { error('Receipt store is corrupt or unreadable; refusing to send', 503); }
    let changed = false;
    for (const [id,r] of Object.entries(records)) {
      if (r.status === 'pending') {
        records[id] = { ...r, status:'uncertain', updatedAt:Math.max(clock(),r.updatedAt), verified:false }; changed = true;
      }
    }
    if (changed) persist(records); // Crash may have happened after gateway send but before markSent.
  }
  function bound({ deliveryId, target, sha256 }) {
    healthy(); idOf(deliveryId); targetOf(target); const hash = hashOf(sha256);
    const r = records[deliveryId];
    if (r && (r.target !== target || r.sha256 !== hash)) error('Delivery id is already bound to a different target or audio', 409);
    return { r, hash };
  }
  function begin(input) {
    const { r, hash } = bound(input);
    if (r) return { created:false, record:clone(r) };
    if (Object.keys(records).length >= maxRecords) error('Receipt store full; old claims retained, new claim rejected', 507);
    const t = clock();
    const receipt = { deliveryId:input.deliveryId, target:input.target, sha256:hash, status:'pending', createdAt:t, updatedAt:t, verified:false, retryable:false };
    // Reserve enough room for this claim's worst-size future state. No TTL pruning.
    const reserve = { ...receipt, status:'uncertain', messageId:'-99999999999999999999', updatedAt:Number.MAX_SAFE_INTEGER };
    const next = Object.assign(Object.create(null),records,{[input.deliveryId]:receipt});
    const reserved = Object.assign(Object.create(null),records,{[input.deliveryId]:reserve});
    if (Buffer.byteLength(encode(reserved),'utf8') > maxBytes - Object.keys(records).length * 80) error('Receipt store full; old claims retained, new claim rejected', 507);
    persist(next);
    return { created:true, record:clone(receipt) };
  }
  function current(id) { healthy(); idOf(id); const r = records[id]; if (!r) error('Unknown delivery id',404); return r; }
  function update(r, status, extra = {}) {
    const next = { ...r, ...extra, status, updatedAt:Math.max(clock(),r.updatedAt), verified:status === 'verified', retryable:false };
    persist(Object.assign(Object.create(null),records,{[r.deliveryId]:next})); return clone(next);
  }
  function markSent(id, { messageId } = {}) {
    const r = current(id), value = messageOf(messageId);
    if (r.messageId && r.messageId !== value) error('Delivery message id cannot be replaced',409);
    if (r.status === 'rejected') error('Rejected delivery cannot be marked sent',409);
    if (['sent','verified'].includes(r.status)) return clone(r);
    // Also accepts a late, definite success response after uncertainty, never a resend.
    return update(r,'sent',{messageId:value});
  }
  function markVerified(id, input = {}) {
    const r = current(id);
    if (!r.messageId || !['sent','uncertain','verified'].includes(r.status)) error('Persist message id before readback verification',409);
    if (input.messageId !== undefined && messageOf(input.messageId) !== r.messageId) error('Readback message id mismatch',409);
    if (r.status === 'verified') return clone(r);
    return update(r,'verified');
  }
  function markUncertain(id) {
    const r = current(id);
    if (['verified','uncertain','rejected'].includes(r.status)) return clone(r);
    return update(r,'uncertain');
  }
  function markRejected(id, { preSend } = {}) {
    const r = current(id);
    if (preSend !== true) error('Rejection requires definite pre-send failure',409);
    if (r.status === 'rejected') return clone(r);
    if (r.status !== 'pending' || r.messageId) error('Cannot reject a possibly sent delivery',409);
    return update(r,'rejected'); // Terminal claim retained, never returned as retryable.
  }
  function get(input) { return clone(bound(input).r); }
  return { begin, get, markSent, markVerified, markUncertain, markRejected };
}
