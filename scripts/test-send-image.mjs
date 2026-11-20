// send-image 闸门自检（负向为主，全程不往任何真人会话发出图片）。
// 用法：node scripts/test-send-image.mjs
//
// 为什么这么测：正向「真发一张」会打扰真人，所以这里把每道闸门单独探一遍，
// 关键一项是「引用解析失败」——它在真正调用网关之前就返回，所以能验证
// 「路由 → token → 白名单 → 目录白名单 → 读文件 → 体积 → 引用解析」整条链，
// 而最终 sendImageBufferToKey 不会被触发。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const BASE = `http://127.0.0.1:${cfg.consolePort || 3100}`;
const consoleTok = /^[A-Za-z0-9_-]{16,128}$/.test(String(cfg.consoleToken ?? '').trim())
  ? String(cfg.consoleToken).trim()
  : fs.readFileSync(path.join(ROOT, 'state/console-token'), 'utf8').trim();

const ownerKey = `private:${cfg.ownerQQ}`;
const ownerTok = st.conversations?.[ownerKey]?.agentToken;
if (!ownerTok) { console.log('NO OWNER TOKEN'); process.exit(1); }

const paintDir = path.join(process.env.USERPROFILE ?? 'C:/Users/example', 'Desktop', '千问1生图');
const tiny = path.join(paintDir, '_selftest_tiny.png');
fs.mkdirSync(paintDir, { recursive: true });
// 1x1 PNG
fs.writeFileSync(tiny, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const big = path.join(paintDir, '_selftest_big.bin');
const maxBytes = Number(cfg.socialV2?.media?.maxBytes) || 8 * 1024 * 1024;
fs.writeFileSync(big, Buffer.alloc(maxBytes + 1024 * 1024, 1));

async function call(body, token) {
  const res = await fetch(BASE + '/api/socialV2/send-image', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': consoleTok,
      ...(token ? { 'x-agent-token': token, 'x-agent-call': '1' } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

let all = true;
const row = (name, r, expect) => {
  const ok = String(r.status) === String(expect);
  const err = r.json?.error ? ` | ${String(r.json.error).slice(0, 80)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}] HTTP ${r.status}（预期 ${expect}）${err}`);
  if (!ok) all = false;
};

// 1) 无 agent token
row('无 agent token 被拒', await call({ key: ownerKey, path: tiny }, null), 403);
// 2) token 是假的
row('假 token 被拒', await call({ key: ownerKey, path: tiny }, 'deadbeef'.repeat(4)), 403);
// 3) 目录白名单：系统文件
row('目录外文件被拒', await call({ key: ownerKey, path: 'C:\\Windows\\win.ini' }, ownerTok), 403);
// 4) 目录白名单：同名前缀但不在目录内（前缀穿越）
row('前缀穿越被拒', await call({ key: ownerKey, path: paintDir + '_evil\\x.png' }, ownerTok), 403);
// 5) 目录内但文件不存在
row('文件不存在被拒', await call({ key: ownerKey, path: path.join(paintDir, 'nope-not-here.png') }, ownerTok), 400);
// 6) 超过体积上限
row('超体积被拒', await call({ key: ownerKey, path: big }, ownerTok), 413);
// 7) 路径为空
row('path 为空被拒', await call({ key: ownerKey, path: '' }, ownerTok), 400);
// 8) key 格式错
row('key 格式错被拒', await call({ key: 'nope', path: tiny }, ownerTok), 403);
// 9) 引用不存在的消息 → 在真正发送之前就失败（不会把图发出去）
row('引用不存在的消息被拒', await call({ key: ownerKey, path: tiny, replyToMessageId: '999999999999' }, ownerTok), 400);

for (const f of [tiny, big]) { try { fs.unlinkSync(f); } catch {} }
console.log(all ? '\n全部闸门 PASS（没有向任何会话发出图片）' : '\n有 FAIL，需要修');
process.exit(all ? 0 : 1);
