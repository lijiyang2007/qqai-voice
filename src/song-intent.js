// Missing-artist intent state machine. No QQ/network/GPU dependency; callbacks are injected.
// Single bridge instance owns stateDir. All claims are synchronously persisted before await.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeBilibiliSongUrl } from './bilibili-song.js';

export const SONG_ARTIST_WAIT_MS = 120000;
export const SONG_INTENT_STALE_MS = 600000; // measured after the two-minute deadline

// Deterministic ingress guard for private chats.  The model is still responsible for
// interpreting ordinary conversation, but an explicit "sing <title>" request with no
// artist must not depend on the model remembering to call wait_artist: otherwise no
// durable record/deadline exists and the advertised two-minute fallback can never run.
export function parseTitleOnlySongRequest(value) {
  if (typeof value !== 'string') return null;
  let line = value.trim().replace(/\s+/g, ' ');
  if (!line || line.length > 120 || /[\u0000-\u001f\u007f]|\[CQ:|https?:|file:|[a-z]:[\\/]|\\\\/i.test(line)) return null;
  if (/^(?:别唱|不要唱|不用唱|不唱|唱不了|唱歌不行)(?:了|啦|呀|啊|吧|嘛|[。！!])?$/u.test(line)) return null;
  const match = /^(?:那你)?(?:请)?(?:给我)?(?:(?:来)?(?:唱|翻唱|点歌)(?:一首|首|一下)?|来(?:一)?首)[：:\s]*(.+)$/u.exec(line);
  if (!match) return null;
  let title = match[1].trim().replace(/[。！!]+$/u, '').trim();
  title = title.replace(/(?:好不好|行不行|可以吗|能不能|好吗|行吗|可以不|吧|呀|啊|嘛)[？?。！!]*$/u, '').trim();
  title = title.replace(/^[《“"]|[》”"]$/gu, '').trim();
  if (!title || title.length > 80 || /[？?\n\r]/u.test(title)) return null;
  // Explicit artist/version syntax is already a complete request and should go through
  // the normal exact-query submission path instead of starting an artist wait.
  if (/(?:歌手|版本|原唱|演唱)\s*[是：:]|\bby\b|.+的\s*.+/iu.test(title)) return null;
  return { title, mode: 'full' };
}

const ACTIVE = new Set(['asking', 'pending', 'resolving', 'submitting', 'notifying']);
const IN_FLIGHT = new Set(['asking', 'resolving', 'submitting', 'notifying']);
const STATES = new Set([...ACTIVE, 'submitted', 'failed', 'cancelled', 'expired', 'uncertain']);

function fail(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; throw e; }
function keyOf(value) {
  if (typeof value !== 'string' || !/^(group|private):[1-9]\d{4,19}$/.test(value)) fail('会话 key 格式无效');
  return value;
}
function requesterOf(value, key) {
  const id = String(value ?? '');
  if (!/^[1-9]\d{4,19}$/.test(id)) fail('必须提供实际点歌者身份');
  if (key.startsWith('private:') && key !== `private:${id}`) fail('私聊点歌者与会话不一致', 403);
  return id;
}
function textOf(value, label, max = 160) {
  if (typeof value !== 'string') fail(`${label}不能为空`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.length > max || /[\u0000-\u001f\u007f]|\[CQ:/i.test(value)
      || /^(?:[a-z]:[\\/]|\\\\|\/|file:|https?:)/i.test(text)) fail(`${label}格式无效`);
  return text;
}
function modeOf(value = 'full') { if (!['full', 'chorus'].includes(value)) fail('mode 只能是 full 或 chorus'); return value; }
const copy = (value) => value == null ? null : structuredClone(value);

export function createSongIntentService({ stateDir, now = Date.now, resolve, submit, notify, allowed, log = () => {} }) {
  if (typeof stateDir !== 'string' || !stateDir || ![now, resolve, submit, notify, allowed].every(x => typeof x === 'function')) {
    throw new TypeError('stateDir and now/resolve/submit/notify/allowed callbacks are required');
  }
  const root = path.resolve(stateDir);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'song-intents.json');
  let records = Object.create(null);
  function clock() { const t = now(); if (!Number.isSafeInteger(t) || t < 0) throw new Error('Invalid intent clock'); return t; }
  function persist() {
    const temp = path.join(root, `.song-intents-${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, records }, null, 2), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  if (fs.existsSync(file)) {
    // Invalid disk state fails closed. Never silently erase claims or resume a stale task.
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !saved.records || Array.isArray(saved.records)) throw new Error('Invalid song intent store');
    for (const [key, r] of Object.entries(saved.records)) {
      keyOf(key);
      if (!r || r.key !== key || typeof r.id !== 'string' || !/^[a-f0-9-]{36}$/.test(r.id)
          || !STATES.has(r.status) || !Array.isArray(r.claims)
          || !Number.isSafeInteger(r.deadline) || !Number.isSafeInteger(r.created)) throw new Error('Invalid song intent record');
      requesterOf(r.requesterId, key); textOf(r.title, '歌名'); modeOf(r.mode);
      if (r.deadline !== r.created + SONG_ARTIST_WAIT_MS) throw new Error('Invalid intent deadline');
      // Deep whitelist prevents unrelated callback fields (e.g. tokens) from persisting.
      const restored = Object.fromEntries(['id','key','title','mode','requesterId','created','deadline','updated','status'].map(k => [k, r[k]]));
      restored.claims = r.claims.map(c => {
        if (!c || typeof c.kind !== 'string' || !/^(?:resolve|submit|notify_[a-z_]+)$/.test(c.kind) || c.id !== `${r.id}:${c.kind}` || !Number.isSafeInteger(c.at)) throw new Error('Invalid intent claim');
        return { id: c.id, kind: c.kind, at: c.at };
      });
      if (r.artist !== undefined) restored.artist = textOf(r.artist, '歌手');
      if (r.job !== undefined) { if (typeof r.job !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(r.job)) throw new Error('Invalid intent job'); restored.job = r.job; }
      if (r.selection !== undefined) {
        const s = r.selection;
        if (!s || (!s.videoUrl && (!Number.isSafeInteger(s.trackId) || s.trackId <= 0))) throw new Error('Invalid intent selection');
        restored.selection = { song: textOf(s.song, '准确歌曲'), title: textOf(s.title, '选中歌名'), artist: textOf(s.artist, '选中歌手'), ...(s.videoUrl?{videoUrl:normalizeBilibiliSongUrl(s.videoUrl)}:{trackId:s.trackId,allowVariant:s.allowVariant===true}) };
      }
      if (r.reason !== undefined && typeof r.reason === 'string' && /^[a-z_]{1,80}$/.test(r.reason)) restored.reason = r.reason;
      if (r.outcome !== undefined && STATES.has(r.outcome)) restored.outcome = r.outcome;
      records[key] = restored;
      if (IN_FLIGHT.has(r.status)) {
        records[key].status = 'uncertain'; records[key].reason = 'restart_in_flight_no_replay'; records[key].updated = clock();
      } else if (r.status === 'pending' && clock() - r.deadline > SONG_INTENT_STALE_MS) {
        records[key].status = 'expired'; records[key].reason = 'stale_after_restart'; records[key].updated = clock();
      }
    }
    persist();
  }
  function change(r, status, fields = {}) {
    Object.assign(r, fields, { status, updated: clock() });
    persist();
  }
  function claim(r, kind, status, fields = {}) {
    r.claims.push({ id: `${r.id}:${kind}`, kind, at: clock() });
    change(r, status, fields);
  }
  function current(r, status) { return records[r.key]?.id === r.id && r.status === status; }
  function own(input) {
    const key = keyOf(input.key), requesterId = requesterOf(input.requesterId, key);
    const r = records[key];
    if (!r) fail('当前没有待补充的点歌', 404);
    if (r.requesterId !== requesterId) fail('只有原点歌者能补充、替换或取消', 403);
    if (input.intentId !== undefined && input.intentId !== r.id) fail('点歌请求已被替换，请刷新状态', 409);
    return r;
  }
  async function permitted(r, expected) {
    let ok = false;
    try { ok = await allowed(r.key, r.requesterId); } catch { /* fail closed */ }
    if (!current(r, expected)) return false;
    if (ok !== true) {
      const afterSubmit = r.claims.some(c => c.kind === 'submit');
      change(r, r.job ? 'submitted' : afterSubmit ? 'uncertain' : 'cancelled', { reason: 'permission_revoked' });
      return false;
    }
    return true;
  }
  async function announce(r, type, message, finalState, extras = {}) {
    claim(r, `notify_${type}`, 'notifying', { outcome: finalState });
    if (!await permitted(r, 'notifying')) return copy(r);
    try {
      const response = await notify({ key: r.key, requesterId: r.requesterId, intentId: r.id, type, message, ...extras });
      if (response?.ok === false) throw new Error('notification rejected');
      if (current(r, 'notifying')) change(r, finalState);
    } catch {
      if (current(r, 'notifying')) change(r, 'uncertain', { reason: 'notification_uncertain_no_replay' });
      log('song-intent notification uncertain; no automatic replay');
    }
    return copy(r);
  }
  async function ask(r) {
    if (!await permitted(r, 'asking')) return copy(r);
    try {
      const response = await notify({ key: r.key, requesterId: r.requesterId, intentId: r.id, type: 'ask_artist', message: `《${r.title}》想听哪位歌手的版本？两分钟内告诉我；没有补充的话，我会自动选择匹配版本。` });
      if (response?.ok === false) throw new Error('notification rejected');
      if (current(r, 'asking')) change(r, 'pending');
    } catch {
      // The explicit song request is already durably authorized.  A transient QQ
      // failure must not erase the 120-second fallback; keep the intent pending but
      // never replay the question automatically (delivery itself is uncertain).
      if (current(r, 'asking')) change(r, 'pending', { reason: 'question_notification_uncertain_no_replay' });
      log('song-intent question notification uncertain; waiting continues without replay');
    }
    return copy(r);
  }
  function begin(input) {
    const key = keyOf(input.key), requesterId = requesterOf(input.requesterId, key);
    const title = textOf(input.title, '歌名'), mode = modeOf(input.mode);
    const old = records[key];
    if (old && ACTIVE.has(old.status)) {
      if (old.requesterId !== requesterId) fail('当前已有其他人的待处理点歌', 409);
      fail('已有待处理点歌，请补充歌手、替换或取消', 409);
    }
    if (old?.status === 'uncertain') fail('前次结果不确定，请管理员核实后再建请求', 409);
    const created = clock();
    const r = { id: randomUUID(), key, requesterId, title, mode, created, deadline: created + SONG_ARTIST_WAIT_MS, updated: created, status: 'asking', claims: [] };
    records[key] = r;
    claim(r, 'notify_ask_artist', 'asking');
    return ask(r);
  }
  function autoSelect(input) {
    const key = keyOf(input.key), requesterId = requesterOf(input.requesterId, key);
    const title = textOf(input.title, '歌名'), mode = modeOf(input.mode);
    const old = records[key];
    if (old && ACTIVE.has(old.status)) {
      if (old.requesterId !== requesterId) fail('当前已有其他人的待处理点歌', 409);
      fail('已有点歌正在解析或提交，请勿重复点歌', 409);
    }
    if (old?.status === 'uncertain') fail('前次结果不确定，请管理员核实后再建请求', 409);
    const created = clock();
    const r = { id: randomUUID(), key, requesterId, title, mode, created, deadline: created + SONG_ARTIST_WAIT_MS, updated: created, status: 'resolving', claims: [] };
    records[key] = r;
    claim(r, 'resolve', 'resolving');
    return execute(r, undefined, true);
  }
  async function execute(r, artist, autoSelect) {
    if (!await permitted(r, 'resolving')) return copy(r);
    let selected;
    try {
      selected = await resolve(r.title, artist, autoSelect, { key: r.key, requesterId: r.requesterId, intentId: r.id });
      if (!current(r, 'resolving')) return copy(records[r.key]);
      const selection = { song: textOf(selected?.song, '准确歌曲'), title: textOf(selected?.title, '选中歌名'), artist: textOf(selected?.artist, '选中歌手'), ...(selected?.videoUrl?{videoUrl:normalizeBilibiliSongUrl(selected.videoUrl)}:{trackId:selected?.trackId,allowVariant:selected?.allowVariant===true}) };
      if (!selection.videoUrl && (!Number.isSafeInteger(selection.trackId) || selection.trackId <= 0)) throw new Error('missing exact track');
      selected = selection;
    } catch {
      if (!current(r, 'resolving')) return copy(records[r.key]);
      r.reason = 'resolve_failed';
      return announce(r, 'failed', `《${r.title}》暂时没找到可确认的合适版本，没有提交制作。请补充准确歌名和歌手后重新点歌。`, 'failed');
    }
    // Recheck permission immediately before the second side effect; no await between
    // the synchronous durable claim and submit except this explicit authorization check.
    if (!await permitted(r, 'resolving')) return copy(r);
    claim(r, 'submit', 'submitting', { selection: selected });
    let result;
    try {
      result = await submit({ key: r.key, target: r.key, requesterId: r.requesterId, intentId: r.id, idempotencyKey: r.id, mode: r.mode, song: selected.song, ...(selected.videoUrl?{videoUrl:selected.videoUrl}:{trackId:selected.trackId}), ...(selected.allowVariant ? {allowVariant:true} : {}) });
      if (!result || typeof result.job !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(result.job)) throw new Error('unconfirmed submission');
    } catch {
      change(r, 'uncertain', { reason: 'submission_uncertain_no_replay' });
      log('song-intent submission uncertain; no automatic replay');
      // A separate notification claim is safe; never retry the submission itself.
      return announce(r, 'submission_uncertain', `《${r.title}》的提交结果暂时无法确认，请先核查进度，不要重复点歌。`, 'uncertain');
    }
    r.job = result.job;
    return announce(r, 'submitted', selected.videoUrl ? `已按指定B站视频提交完整分P音轨翻唱，任务号 ${r.job}。使用视频本身的音质，不查原唱或红心；暂不代表制作或发送成功。` : `选了${selected.artist}的《${selected.title}》，已提交${r.mode === 'full' ? '整首' : '短试听'}，任务号 ${r.job}。`, 'submitted', { job: r.job, artist: selected.artist, title: selected.title });
  }
  function provideArtist(input) {
    const r = own(input), artist = textOf(input.artist, '歌手');
    if (!['pending', 'asking'].includes(r.status)) fail('请求已开始处理或已结束，不能再修改歌手', 409);
    if (clock() - r.deadline > SONG_INTENT_STALE_MS) { change(r, 'expired', { reason: 'stale_artist_reply' }); return Promise.resolve(copy(r)); }
    claim(r, 'resolve', 'resolving', { artist });
    return execute(r, artist, false);
  }
  function cancel(input) {
    const r = own(input);
    if (!['pending', 'asking', 'resolving'].includes(r.status)) return { ...copy(r), cancelled: false, message: r.job ? '任务已提交；此操作不能取消已提交的制作任务。' : '请求已开始提交或已结束，不能保证取消；不会自动重放。' };
    change(r, 'cancelled', { reason: 'requester_cancelled' });
    return { ...copy(r), cancelled: true, message: '已取消等待请求，未提交制作。' };
  }
  function replace(input) {
    const r = own(input);
    if (!['pending', 'asking', 'resolving'].includes(r.status)) fail('已开始提交或已结束，不能替换；不会取消已提交的任务', 409);
    // Validate before cancelling the old intent.
    const title = textOf(input.title, '歌名'), mode = modeOf(input.mode);
    change(r, 'cancelled', { reason: 'requester_replaced' });
    return autoSelect({ key: r.key, requesterId: r.requesterId, title, mode });
  }
  async function tick() {
    const work = [];
    for (const r of Object.values(records)) {
      if (r.status !== 'pending' || clock() < r.deadline) continue;
      if (clock() - r.deadline > SONG_INTENT_STALE_MS) { change(r, 'expired', { reason: 'stale_timeout' }); continue; }
      claim(r, 'resolve', 'resolving'); // before the first await: wins the artist/timeout race
      work.push(execute(r, undefined, true));
    }
    return Promise.all(work);
  }
  function observeMessage({ key, text, requesterId }) {
    keyOf(key);
    const r = records[key];
    if (!r || r.requesterId !== String(requesterId) || !['pending', 'asking'].includes(r.status) || typeof text !== 'string') return Promise.resolve({ handled: false });
    const line = text.trim();
    if (/^(?:取消点歌|取消这首|别唱了|不唱了|不用唱了)[。！!]?$/u.test(line)) return Promise.resolve({ handled: true, result: cancel({ key, requesterId, intentId: r.id }) });
    const match = /^(?:歌手(?:是|[：:])\s*(.+)|是\s*(.+?)\s*的|(.+?)\s*的版本)[。！!]?$/u.exec(line);
    if (!match) return Promise.resolve({ handled: false }); // bare names/short chat are deliberately not guessed
    const artist = (match[1] || match[2] || match[3]).trim().replace(/[。！!]$/u, '');
    if (!artist || artist.length > 80 || /[？?\n\r]/u.test(artist)) return Promise.resolve({ handled: false });
    // provideArtist claims synchronously before it returns its Promise, ahead of timeout tick.
    return provideArtist({ key, artist, requesterId, intentId: r.id }).then(result => ({ handled: true, result }));
  }
  function get(key) { return copy(records[keyOf(key)]); }
  function list() { return Object.values(records).map(copy); }
  return { begin, autoSelect, provideArtist, replace, cancel, tick, observeMessage, get, list };
}
