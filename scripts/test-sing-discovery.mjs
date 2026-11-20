// Offline contracts: real bridge functions in a temporary fixture, never live QQ/config/state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { renderPatch } from './build-agent-preset-patches.mjs';
import * as roleCard from '../src/role-card.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.stack); }
}
function call(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('fixture timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(config, run) {
  let submits = 0;
  const h = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false }, ...config } },
    globals: { ...roleCard, createCoverJobService: () => ({ submit() { submits++; throw new Error('must not submit'); }, status() { throw new Error('must not inspect jobs'); } }) } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  h.setMode('reserved2');
  try { await run(h, server.address().port); assert.equal(submits, 0); assert.equal(h.calls.sent.length, 0); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
const guidanceMarker = '【受控点歌（私聊/群聊）】';
await test('private and group discover singing independently of TTS', () => fixture({}, async (h, port) => {
  assert.equal(h.cfg.socialV2.tools.sing, true);
  assert.equal(h.cfg.socialV2.tools.sendVoice, false);
  for (const key of ['private:123', 'group:456']) {
    const response = await call(port, '/api/socialV2/prompt?key=' + encodeURIComponent(key));
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.ok(response.json.enabledTools.includes('qq_sing / qq_sing_status'));
    assert.equal(response.json.singing.enabled, true);
    assert.ok(response.json.singing.guidance.includes('不是 qq_send_voice'));
    assert.ok(response.json.singing.guidance.includes('只有 sent=true'));
    assert.ok(h.buildWakePromptV2(key, 'bootstrap').includes(guidanceMarker));
  }
}));
for (const config of [{ tools: { sing: false } }, { sing: { enabled: false } }]) {
  await test('disabled singing is not advertised ' + JSON.stringify(config), () => fixture(config, async (h, port) => {
    const res = await call(port, '/api/socialV2/prompt?key=private:123');
    assert.equal(res.json.singing.enabled, false);
    assert.equal(res.json.singing.guidance, '');
    assert.ok(!res.json.enabledTools.includes('qq_sing / qq_sing_status'));
    h.getSocialV2State('private:123').unread = [{ text: '唱郭静的 又是艳阳天' }];
    assert.ok(!h.buildWakePromptV2('private:123', 'bootstrap').includes(guidanceMarker));
  }));
}
await test('wake guidance is bounded to bootstrap or unread singing topic and never submits', () => fixture({}, async (h) => {
  for (const key of ['private:123', 'group:456']) {
    const st = h.getSocialV2State(key);
    st.unread = [{ text: '今天吃啥' }];
    assert.ok(!h.buildWakePromptV2(key, 'question').includes(guidanceMarker));
    for (const text of ['唱郭静的 又是艳阳天', '你会唱歌吗', '我今天唱歌了', '不要唱歌', '来个完整版']) {
      st.unread = [{ text }];
      const prompt = h.buildWakePromptV2(key, 'question');
      assert.ok(prompt.includes(guidanceMarker), text);
      assert.ok(prompt.includes('不等于提交请求'));
      assert.ok(prompt.includes('不自行换歌'));
      assert.ok(prompt.includes('【默认整首】'));
      assert.ok(prompt.includes('mode="full"'));
      assert.ok(prompt.includes('质量暂停'));
    }
    st.unread = []; st.recentMessages = [{ text: '唱一首歌' }];
    assert.ok(!h.buildWakePromptV2(key, 'timeout').includes(guidanceMarker), 'stale history must not repeat reminder');
    st.unread = [{ text: '唱一首歌', isSelf: true }];
    assert.ok(!h.buildWakePromptV2(key, 'replyCheck').includes(guidanceMarker), 'own reply is not new user intent');
  }
}));
await test('sing tool flag persists and invalid values preserve disabled state in fixture only', () => fixture({}, async (h, port) => {
  let res = await call(port, '/api/socialV2/config', { tools: { sing: false } });
  assert.equal(res.status, 200);
  assert.equal(h.cfg.socialV2.tools.sing, false);
  res = await call(port, '/api/socialV2/config', { tools: { sing: 'true' } });
  assert.equal(res.status, 200);
  assert.equal(h.cfg.socialV2.tools.sing, false);
  const persisted = JSON.parse(fs.readFileSync(h.temp + '/config.json', 'utf8'));
  assert.equal(persisted.socialV2.tools.sing, false);
  res = await call(port, '/api/socialV2/config', { tools: { sing: true } });
  assert.equal(res.status, 200);
  assert.equal(h.cfg.socialV2.tools.sing, true);
}));
await test('non reserved2 mode never advertises unavailable singing API', () => fixture({}, async (h, port) => {
  h.setMode('closed-agent');
  const res = await call(port, '/api/socialV2/prompt?key=private:123');
  assert.equal(res.status, 200);
  assert.equal(res.json.singing.enabled, false);
  assert.ok(!res.json.enabledTools.includes('qq_sing / qq_sing_status'));
}));
await test('source and generated preset enforce honest controlled singing without local permissions', async () => {
  const source = fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8');
  const patch = fs.readFileSync(new URL('../plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml', import.meta.url), 'utf8');
  assert.equal(patch, renderPatch('qq-chat-v2'));
  for (const text of [source, patch]) {
    for (const rule of [guidanceMarker, 'ok=true 且 job 非空', 'sent=true', '不是本地执行权限', '不记得歌词', '质量暂停', '短试听段', '不保证无损']) assert.ok(text.includes(rule), rule);
    assert.ok(text.includes('你没有本地工具'));
  }
  const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  const singing = mcp.slice(mcp.indexOf("    'qq_sing',"), mcp.indexOf("    'qq_sing_status',"));
  assert.ok(!/约 3 分钟|3~6 分钟|20 分钟以上/.test(singing));
  for (const rule of ['不是 qq_send_voice', '不代表授权提交', '不擅自换歌', 'ok=true 且 job 非空', '质量检查可能暂停', '短试听段']) assert.ok(singing.includes(rule), rule);
});
if (failures) process.exitCode = 1;
else console.log('All singing discovery tests passed (no production I/O).');
