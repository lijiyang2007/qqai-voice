// 代发功能自检：只验证闸门，不真发任何消息给第三方。
// 用法：node state/tmp/relay-selftest.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const BASE = `http://127.0.0.1:${cfg.consolePort || 3100}`;
// MCP 侧真实调用方式：x-console-token（控制台鉴权）+ x-agent-token（会话绑定）+ x-agent-call。
const consoleTok = /^[A-Za-z0-9_-]{16,128}$/.test(String(cfg.consoleToken ?? '').trim())
  ? String(cfg.consoleToken).trim()
  : fs.readFileSync(path.join(ROOT, 'state/console-token'), 'utf8').trim();

const ownerKey = `private:${cfg.ownerQQ}`;
const ownerTok = state.conversations?.[ownerKey]?.agentToken;
const otherKey = 'private:22222222';
const otherTok = state.conversations?.[otherKey]?.agentToken;

if (!ownerTok) { console.log('NO OWNER TOKEN — 先让管理员私聊产生一次会话'); process.exit(1); }

async function call(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-console-token': consoleTok,
      ...(token ? { 'x-agent-token': token, 'x-agent-call': '1' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const row = (name, r, expect) => {
  const ok = String(r.status) === String(expect);
  const err = r.json?.error ? ` | ${String(r.json.error).slice(0, 90)}` : '';
  const extra = r.json?.ok ? ` | sent=${r.json.sent ?? '-'} targets=${(r.json.private?.length ?? 0)}+${(r.json.groups?.length ?? 0)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}] HTTP ${r.status}（预期 ${expect}）${err}${extra}`);
  return ok;
};

let all = true;
// 1) 目标清单：owner 会话应能拿到
const t1 = await call('GET', `/api/socialV2/relay-targets?key=${encodeURIComponent(ownerKey)}`, null, ownerTok);
all = row('owner 拉取代发目标', t1, 200) && all;
console.log('   私聊目标：' + (t1.json?.private ?? []).map((p) => `${p.name || '（无称呼）'}:${p.qq}`).join('、'));
console.log('   群目标：' + (t1.json?.groups ?? []).map((g) => `${g.name || '（无名）'}:${g.group}`).join('、'));

// 2) 非 owner 会话（妈妈的私聊）不能代发
const t2 = await call('POST', '/api/socialV2/relay-send', { key: otherKey, token: otherTok, target: 'private:33333333', messages: '测试' }, otherTok);
all = row('非管理员会话代发被拒', t2, 403) && all;

// 3) 非白名单私聊被拒
const t3 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: 'private:123456789', messages: '测试' }, ownerTok);
all = row('非白名单私聊被拒', t3, 403) && all;

// 4) 非白名单群被拒
const t4 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: 'group:999999', messages: '测试' }, ownerTok);
all = row('非白名单群被拒', t4, 403) && all;

// 5) 代发给自己被拒
const t5 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: ownerKey, messages: '测试' }, ownerTok);
all = row('代发给自己被拒', t5, 400) && all;

// 6) target 格式错误被拒
const t6 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: '妈妈', messages: '测试' }, ownerTok);
all = row('target 格式错误被拒', t6, 400) && all;

// 7) 超长消息被拒
const t7 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: 'private:22222222', messages: '测'.repeat(600) }, ownerTok);
all = row('超长消息被拒', t7, 400) && all;

// 8) 敏感信息被拒（本机路径）
const t8 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: 'private:22222222', messages: 'C:\\Users\\Administrator\\secret.txt' }, ownerTok);
all = row('敏感信息被拒', t8, 403) && all;

// 9) 令牌不对被拒
const t9 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: 'deadbeef'.repeat(4), target: 'private:22222222', messages: '测试' }, 'deadbeef'.repeat(4));
all = row('令牌无效被拒', t9, 403) && all;

// 10) 什么内容都没给 → 拒绝（不能空发）
const t10 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: 'private:22222222' }, ownerTok);
all = row('空内容被拒', t10, 400) && all;

// 11) forwardFromMessageId 指向不存在的消息 → 拒绝（防"随便编个 id 让桥接去抓外部图"）
const t11 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: 'private:22222222', forwardFromMessageId: '999999999999' }, ownerTok);
all = row('转发不存在的消息被拒', t11, 400) && all;

// 12) stickerId 不存在 → 失败但不发送
const t12 = await call('POST', '/api/socialV2/relay-send', { key: ownerKey, token: ownerTok, target: 'private:22222222', stickerId: 'no-such-sticker-id' }, ownerTok);
all = row('无效表情 id 被拒', t12, 500) && all;

console.log(all ? '\n全部闸门 PASS（没有向任何第三方发出消息）' : '\n有 FAIL，需要修');
