// Track only newly accepted controlled jobs. No historical scanning, QQ or GPU dependency.
// A single bridge instance owns stateDir; durable claims precede notification side effects.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SONG_JOB_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
const STATES = new Set(['pending', 'notifying', 'notified', 'done', 'uncertain', 'expired']);
const copy = value => value == null ? null : structuredClone(value);
function fail(message) { throw new Error(message); }
function jobOf(job) { if (typeof job !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(job)) fail('Invalid song job id'); return job; }
function keyOf(key) { if (typeof key !== 'string' || !/^(group|private):[1-9]\d{0,19}$/.test(key)) fail('Invalid song job target'); return key; }
function songOf(song) {
  if (typeof song !== 'string') return '';
  // Do not echo arbitrary input/diagnostics. Suspicious labels are discarded entirely.
  if (song.length > 160 || /[\u0000-\u001f\u007f]|[a-z]:[\\/]|\\\\|(?:https?|file):|\b(?:token|secret|api[_-]?key|bearer)\b|\[CQ:|\/(?:Users|home|tmp|etc|var)\//i.test(song)) return '';
  return song.trim();
}
const SAFE_REASONS = new Set([
  '歌名、歌手或发行版本需要确认；请确认准确歌曲版本后再点。',
  '未取得通过校验的无损音源，已暂停；不会改用低音质来源。',
  '成品交付检查未通过，已保留母带；请管理员检查，勿自动重发。',
  '排队等待已达到上限，尚未启动制作或发送；请稍后重新点歌。',
  '监督进程清理结果待核实，队列已暂停；请管理员检查，禁止自动重放任务。',
  '高质量任务未完成；请管理员查看本地诊断，不要自动重提。',
  '成品已生成，但尚未确认发送成功。',
]);
function noSend(s) { return s.noSend === true || s.no_send === true || s.delivery === 'not_requested' || s.error === '仅制作测试，没有请求发送。'; }
function notification(job, s) {
  const prefix = `点歌任务 ${job}：`;
  if (s.deliveryUncertain === true || s.delivery_uncertain === true || s.stage === 'delivery_uncertain') {
    return prefix + '发送结果暂时无法确认，可能已受理或已发出。请管理员核对当前会话，禁止自动重发。';
  }
  if (s.retryProhibited === true || s.retry_prohibited === true) return prefix + '任务结果需要管理员核实，禁止自动重试或重发。';
  if (SAFE_REASONS.has(s.error)) return prefix + s.error;
  const type = s.failure_type ?? s.failureType;
  const reasons = {
    NeedsReview: '歌名、歌手或发行版本需要确认，已暂停，请补充准确版本。',
    SourceError: '未取得通过校验的无损音源，已暂停，不会降音质强行制作。',
    DeliveryHeld: '成品交付检查未通过，需管理员核实，勿自动重发。',
  };
  if (Object.hasOwn(reasons, type)) return prefix + reasons[type];
  if (s.qualityHold === true || s.quality_hold === true || s.stage === 'held_for_review') return prefix + '质量或版本检查暂停，需管理员复核；不会继续假报“还在制作”。';
  if (s.stage === 'queue_expired') return prefix + '排队等待已达到上限，未启动制作或发送。';
  if (s.status === 'done') return prefix + '制作已完成，但发送尚未确认成功，请管理员检查，勿自动重发。';
  return prefix + '处理未完成，需管理员检查；不是仍在制作，请勿反复提交。';
}

export function createSongJobNotifier({ stateDir, now = Date.now, readStatus, allowed, notify, log = () => {} }) {
  if (typeof stateDir !== 'string' || !stateDir || ![now, readStatus, allowed, notify, log].every(x => typeof x === 'function')) throw new TypeError('Invalid song job notifier callbacks');
  const root = path.resolve(stateDir); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'song-job-notifier.json');
  let records = Object.create(null), running = null;
  function clock() { const t = now(); if (!Number.isSafeInteger(t) || t < 0) fail('Invalid notifier clock'); return t; }
  function persist() {
    const temp = path.join(root, `.song-job-notifier-${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, records }, null, 2), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version !== 1 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)) fail('Invalid notifier store');
    for (const [job, old] of Object.entries(data.records)) {
      jobOf(job); keyOf(old?.key);
      if (old.job !== job || !STATES.has(old.status) || !Number.isSafeInteger(old.created) || old.created < 0 || !Number.isSafeInteger(old.updated)) fail('Invalid notifier record');
      const r = { job, key: old.key, song: songOf(old.song), created: old.created, updated: old.updated, status: old.status };
      // notifyKey（可选）：终止通知改发到另一个会话（管理员代点歌时发给 admin，避免成品目标
      // 收到本来不该它操心的失败/复核提示）。只允许显式配置过的合法 key，缺省就等于 key。
      if (old.notifyKey !== undefined) {
        keyOf(old.notifyKey);
        if (old.notifyKey !== old.key) r.notifyKey = old.notifyKey;
      }
      if (old.claim !== undefined) {
        if (!old.claim || old.claim.id !== `${job}:terminal_notice` || !Number.isSafeInteger(old.claim.at)) fail('Invalid notifier claim');
        r.claim = { id: old.claim.id, at: old.claim.at };
      }
      if (old.status === 'notifying' || (old.status === 'pending' && r.claim)) { r.status = 'uncertain'; r.updated = clock(); }
      else if (r.status === 'pending' && clock() - r.created >= SONG_JOB_NOTICE_TTL_MS) { r.status = 'expired'; r.updated = clock(); }
      records[job] = r;
    }
    persist();
  }
  function set(r, status) { r.status = status; r.updated = clock(); persist(); }
  function track({ job, key, song, notifyKey }) {
    jobOf(job); keyOf(key);
    const notifyTo = notifyKey == null ? null : keyOf(notifyKey);
    const old = records[job];
    if (old) {
      if (old.key !== key) fail('Song job is already bound to another target');
      return copy(old); // No reset of terminal claims or TTL on repeated tracking.
    }
    const t = clock(); const r = { job, key, song: songOf(song), created: t, updated: t, status: 'pending' };
    if (notifyTo && notifyTo !== key) r.notifyKey = notifyTo;
    records[job] = r; persist(); return copy(r);
  }
  async function permittedFor(target) {
    let ok = false;
    try { ok = await allowed(target); } catch { /* fail closed */ }
    return ok === true;
  }
  async function permitted(r) {
    // 通知要发给 r.notifyKey（缺省是 r.key），所以两边都必须仍然可发；
    // 任何一边不再允许就作废，避免留一条永远发不出去的记录。
    if (!await permittedFor(r.key)) { set(r, 'expired'); return false; }
    if (r.notifyKey && r.notifyKey !== r.key && !await permittedFor(r.notifyKey)) { set(r, 'expired'); return false; }
    return true;
  }
  async function processOne(r) {
    if (r.status !== 'pending') return;
    if (clock() - r.created >= SONG_JOB_NOTICE_TTL_MS) { set(r, 'expired'); return; }
    if (!await permitted(r)) return;
    let s;
    try { s = await readStatus({ jobId: r.job, target: r.key }); }
    catch { log('song-job-notifier status unavailable; no notification attempted'); return; }
    if (!s || typeof s !== 'object' || Array.isArray(s) || (s.job !== undefined && s.job !== r.job)) return;
    // A status adapter must not be able to redirect the durable target.
    if (s.target !== undefined && s.target !== r.key) { set(r, 'uncertain'); return; }
    if (s.sent === true || noSend(s)) { set(r, 'done'); return; }
    if (!['failed', 'done'].includes(s.status)) return;
    if (!await permitted(r)) return;
    if (clock() - r.created >= SONG_JOB_NOTICE_TTL_MS) { set(r, 'expired'); return; }
    r.claim = { id: `${r.job}:terminal_notice`, at: clock() };
    set(r, 'notifying'); // Durable at-most-once claim before external side effect.
    if (!await permitted(r)) return;
    try {
      const result = await notify({ key: r.notifyKey ?? r.key, message: notification(r.job, s), job: r.job });
      if (result?.ok === false) throw new Error('notification rejected');
      set(r, 'notified');
    } catch {
      set(r, 'uncertain');
      log('song-job-notifier notification uncertain; automatic retry prohibited');
    }
  }
  function tick() {
    if (running) return running;
    running = (async () => { for (const r of Object.values(records)) await processOne(r); })().finally(() => { running = null; });
    return running;
  }
  function get(job) { return copy(records[jobOf(job)]); }
  function list() { return Object.values(records).map(copy); }
  return { track, tick, get, list };
}
