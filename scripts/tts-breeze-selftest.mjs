// BreezeBlue TTS 接入的自检（不花 credits）。
//
// 两条路：
//   1. mock 路（默认）：起一个本地假 Breeze 服务，验证请求头/请求体/落盘/缓存/回退，
//      顺便验「Key 缺失」「401」「200 但回 JSON」这些失败分支。
//   2. 真路（--live）：拿真 Key 打一次接口，生成到 state/tts/ 下，不发送到 QQ。
//
// 用法：
//   node scripts/tts-breeze-selftest.mjs            # 全 mock
//   node scripts/tts-breeze-selftest.mjs --live     # 真实合成一句（会花几个 credits）
//   node scripts/tts-breeze-selftest.mjs --live --voice voc_xxx --text "随便一句话"
//
// 真路只读 BREEZE_API_KEY / state/secrets/breeze.json，不会打印密钥。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeBreeze, readBreezeApiKey, breezeKeyStatus, estimateBreezeCredits } from '../src/tts-breeze.js';
import { synthesizeSpeech } from '../src/tts-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 一个最小的「合法 mp3」：ID3 头 + 少量字节，够让 size/缓存判断工作。
function fakeMp3(seed = 'x') {
  const body = Buffer.alloc(2048, 0x41);
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([id3, Buffer.from(String(seed)), body]);
}

async function mockServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      const key = req.headers['xi-api-key'];
      // 故意把几种失败分支编进 URL 里，方便逐条断言。
      if (req.url.includes('voc_401')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invalid api key' }));
        return;
      }
      if (req.url.includes('voc_json200')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'no audio' }));
        return;
      }
      if (!key) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'missing key' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(fakeMp3(body.text ?? ''));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}`, seen };
}

async function mockSuite() {
  console.log('\n[1/3] mock 服务：请求形状 / 落盘 / 缓存 / 失败分支');
  const { server, baseUrl, seen } = await mockServer();
  const outDir = path.join(os.tmpdir(), `breeze-selftest-${Date.now()}`);
  try {
    // 1. 正常合成：验证 URL、header、body
    const r1 = await synthesizeBreeze('呜哇，被你发现啦！', {
      voiceId: 'voc_u3nxkd5578wc', apiKey: 'test-key', baseUrl, timeoutMs: 8000
    });
    const req1 = seen.at(-1);
    check('URL 带 voice_id 与 output_format', req1.url.includes('/v1/text-to-speech/voc_u3nxkd5578wc') && req1.url.includes('output_format=mp3'), req1.url);
    check('method 是 POST', req1.method === 'POST');
    check('带了 xi-api-key 头', req1.headers['xi-api-key'] === 'test-key');
    check('content-type 是 json', /application\/json/.test(req1.headers['content-type'] ?? ''));
    check('body.text 就是原文', req1.body.text === '呜哇，被你发现啦！', JSON.stringify(req1.body.text));
    check('body.voice_settings.speed 默认 1', req1.body.voice_settings?.speed === 1);
    check('返回 mp3 字节', r1.format === 'mp3' && r1.buffer.length > 0, `${r1.buffer.length} bytes`);
    check('估算了 credits', r1.credits === estimateBreezeCredits('呜哇，被你发现啦！'), `credits=${r1.credits}`);

    // 2. 401
    let msg401 = '';
    try { await synthesizeBreeze('测试', { voiceId: 'voc_401', apiKey: 'bad', baseUrl, timeoutMs: 8000 }); }
    catch (e) { msg401 = e.message; }
    check('401 报错并提示 Key 无效', /401/.test(msg401) && /API Key/.test(msg401), msg401);

    // 3. 200 + JSON
    let msgJson = '';
    try { await synthesizeBreeze('测试', { voiceId: 'voc_json200', apiKey: 'k', baseUrl, timeoutMs: 8000 }); }
    catch (e) { msgJson = e.message; }
    check('200 但不是音频 → 报错', /没有返回音频/.test(msgJson), msgJson);

    // 4. 没有 Key
    //
    // 注意：这个用例最初只删了环境变量，但一旦用户真的把 Key 写进了
    // state/secrets/breeze.json（正常情况就该这样），删环境变量也拦不住回退读取，
    // 于是这条会"失败"。要么把整个 Key 来源都屏蔽掉，要么跳过——这里选择
    // 用一个临时的空 root 让 readBreezeApiKey 读不到文件，从而真正模拟"未配置"。
    const savedEnv = process.env.BREEZE_API_KEY;
    delete process.env.BREEZE_API_KEY;
    let msgNoKey = '';
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-nokey-'));
    try {
      // voiceId 合法、apiKey 显式传空，并且 secret 目录也指向空目录
      await synthesizeBreeze('测试', {
        voiceId: 'voc_u3nxkd5578wc', apiKey: '', baseUrl, timeoutMs: 8000, root: emptyRoot
      });
    } catch (e) { msgNoKey = e.message; }
    try { fs.rmSync(emptyRoot, { recursive: true, force: true }); } catch {}
    if (savedEnv !== undefined) process.env.BREEZE_API_KEY = savedEnv;
    check('没有 Key 时报错且不泄露任何密钥', /没有 BreezeBlue API Key/.test(msgNoKey), msgNoKey);

    // 5. 非法 voiceId（防注入）
    let msgBad = '';
    try { await synthesizeBreeze('测试', { voiceId: '../etc/passwd', apiKey: 'k', baseUrl, timeoutMs: 8000 }); }
    catch (e) { msgBad = e.message; }
    check('非法 voiceId 被拒', /格式不合法/.test(msgBad), msgBad);

    // 6. synthesizeSpeech 整链：breeze-first 命中云端并落盘
    const s1 = await synthesizeSpeech('呜哇，被你发现啦！', {
      provider: 'breeze-first',
      breeze: { voiceId: 'voc_u3nxkd5578wc', apiKey: 'test-key', baseUrl, timeoutMs: 8000 },
      outDir, maxChars: 200, cacheTtlMs: 3600000
    });
    check('synthesizeSpeech 走的是 breeze', s1.provider === 'breeze', s1.provider);
    check('文件真的落盘了', fs.existsSync(s1.file) && fs.statSync(s1.file).size > 0, s1.file);
    const before = seen.length;
    const s2 = await synthesizeSpeech('呜哇，被你发现啦！', {
      provider: 'breeze-first',
      breeze: { voiceId: 'voc_u3nxkd5578wc', apiKey: 'test-key', baseUrl, timeoutMs: 8000 },
      outDir, maxChars: 200, cacheTtlMs: 3600000
    });
    check('同句第二次命中缓存，没有重复请求', s2.cached === true && seen.length === before, `cached=${s2.cached}`);

    // 7. 云端失败 → 自动回退（这里没有 Edge 网络也应当能落到 sapi，或至少给出组合错误）
    let fellBack = null;
    try {
      fellBack = await synthesizeSpeech('回退测试', {
        provider: 'breeze-first',
        breeze: { voiceId: 'voc_401', apiKey: 'bad', baseUrl, timeoutMs: 5000 },
        outDir, maxChars: 200, cacheTtlMs: 3600000
      });
    } catch (e) {
      fellBack = { error: e.message };
    }
    const backOk = fellBack?.provider && fellBack.provider !== 'breeze';
    check('云端 401 后不再停在 breeze（回退到 edge/sapi）', Boolean(backOk) || /Edge|SAPI/.test(fellBack?.error ?? ''),
      fellBack?.provider ? `回退到 ${fellBack.provider}` : (fellBack?.error ?? '').slice(0, 120));

    // 8. 没有 voiceId 时，breeze-first 静默退化成 edge 链，不报「没配 voiceId」
    const s3 = await synthesizeSpeech('退化测试', { provider: 'breeze-first', breeze: { voiceId: '' }, outDir, maxChars: 200, cacheTtlMs: 3600000 })
      .then((r) => r).catch((e) => ({ error: e.message }));
    check('没配 voiceId 时不因 breeze 而失败', !s3.error || !/voiceId/.test(s3.error), s3.provider ?? (s3.error ?? '').slice(0, 100));
  } finally {
    server.close();
  }
}

async function liveSuite() {
  console.log('\n[2/3] 真接口：用真 Key 合成一句（会花 credits）');
  const status = breezeKeyStatus();
  console.log(`  密钥来源：${status.source}${status.configured ? '' : '（未配置）'}`);
  if (!status.configured) {
    console.log('  ⚠️ 没有密钥，跳过。把 Key 写进 state/secrets/breeze.json 或设 BREEZE_API_KEY 再来。');
    return;
  }
  const voiceId = argOf('voice', 'voc_u3nxkd5578wc');
  const text = argOf('text', '呜哇，被你发现啦！我在认真思考呢，才没有摸鱼。');
  const t0 = Date.now();
  const r = await synthesizeBreeze(text, { voiceId, timeoutMs: 30000 });
  const ms = Date.now() - t0;
  const outDir = path.join(ROOT, 'state', 'tts');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `breeze-live-${Date.now()}.mp3`);
  fs.writeFileSync(file, r.buffer);
  check('真接口返回音频', r.buffer.length > 1024, `${r.buffer.length} bytes, ${ms}ms`);
  check('音频是 mp3（ID3 或帧同步）', r.buffer[0] === 0x49 || r.buffer[0] === 0xff, `first=0x${r.buffer[0].toString(16)}`);
  console.log(`  文件：${file}`);
  console.log(`  文本：${text}`);
  console.log(`  音色：${voiceId}  估算 credits：${r.credits}`);
}

function reportPath() {
  console.log('\n[3/3] 结论');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exitCode = 1;
}

if (LIVE) {
  await liveSuite();
} else {
  await mockSuite();
}
reportPath();
