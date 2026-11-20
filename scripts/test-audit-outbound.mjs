// Offline regression: execute the real outbound audit branches with fake QQ sends.
// No production config, state, tokens, network, or running services are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { SENSITIVE_RE } from '../src/sensitive.js';

const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const fixtureToken = '0123456789abcdef0123456789abcdef';
function section(start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing branch start: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing branch end: ${end}`);
  return source.slice(from, to);
}
const redactor = section('  function redactKnownTokensWithCount(text) {', '\n  // 最近一次发送');
const auditAndSend = section('  async function auditAndSend(key, text) {', '\n  // 会话模型应用去重');
const autoAudit = section('                let auditBlocked = false;', '\n                if (auditBlocked) {');

function harness() {
  const sent = [];
  const context = vm.createContext({
    KNOWN_AGENT_TOKENS: new Set([fixtureToken]),
    SENSITIVE_RE,
    shouldAuditKey: () => true,
    cfg: { security: { interceptNotify: true } },
    log() {},
    appendActivity() {},
    sendToQQ: async (key, text) => { sent.push(text); },
  });
  vm.runInContext(`${redactor}\n${auditAndSend}\nfunction auditAuto(plain) {
    const key = 'group:123';
    ${autoAudit}
    return { plain, auditBlocked };
  }`, context);
  return { sent, context };
}

for (const text of [
  `你好，token=${fixtureToken}`,
  `你好，token = ${fixtureToken}`,
  JSON.stringify({ message: '你好', token: fixtureToken }),
  `Authorization: Bearer ${fixtureToken}`,
]) {
  test(`both outbound branches allow fully redacted ${text.startsWith('{') ? 'JSON' : text.split('=')[0].slice(0, 20)}`, async () => {
    const { sent, context } = harness();
    const expected = text.replaceAll(fixtureToken, '***');
    assert.equal(await context.auditAndSend('group:123', text), true);
    assert.deepEqual(sent, [expected]);
    assert.equal(sent.some((item) => item.includes(fixtureToken)), false);
    const auto = context.auditAuto(text);
    assert.equal(auto.auditBlocked, false);
    assert.equal(auto.plain, expected);
  });
}

for (const sensitive of [
  'password=fixture-password',
  'api_key=fixture-api-key',
  String.raw`C:\Users\fixture\private.txt`,
  String.raw`\\server\share\private.txt`,
  '/root/.ssh/id_rsa',
  'token=***fixture-secret',
]) {
  test(`both branches still block real sensitive data: ${sensitive}`, async () => {
    const { sent, context } = harness();
    const text = `token=${fixtureToken}\n${sensitive}`;
    assert.equal(await context.auditAndSend('group:123', text), false);
    assert.equal(sent.length, 1, 'only a generic interception notice may be sent');
    assert.equal(sent[0].includes(sensitive), false);
    assert.equal(sent[0].includes(fixtureToken), false);
    assert.equal(context.auditAuto(text).auditBlocked, true);
  });
}

test('repeated checks are stateless and log redaction still strips real secrets', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(SENSITIVE_RE.test('token=***'), false);
    assert.equal(SENSITIVE_RE.test('token=fixture-secret'), true);
  }
  const logText = 'token=*** password=fixture-password';
  const redacted = logText.replace(new RegExp(SENSITIVE_RE.source, SENSITIVE_RE.flags + 'g'), '***');
  assert.equal(redacted.includes('fixture-password'), false);
  assert.equal(redacted, 'token=*** ***');
});
