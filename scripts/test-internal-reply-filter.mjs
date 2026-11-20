// Offline only: synthetic content, no QQ sends or production session reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTurnCollector, stripInternalAssistantText } from '../src/dsh-client.js';
import { SENSITIVE_RE } from '../src/sensitive.js';

const privateText = String.raw`C:\Users\fixture\private.txt token=fixture-only-secret`;
function collect(parts) {
  const c = createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 1 } });
  for (const text of parts) c.push({ type: 'assistant/message', data: {
    turn: 1, message: { content: [{ type: 'text', text }] },
  } });
  const result = c.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(c.size(), 0);
  return result.text;
}

test('actual incident shape: analysis followed by closed or unclosed handoff summary', () => {
  for (const close of ['', '</summary>']) {
    const reply = `<analysis>内部梳理 ${privateText}</analysis>\n<summary>文件和工具参数 ${privateText}${close}`;
    assert.equal(collect([reply]).trim(), '');
  }
});

test('thinking is removed while the actual reply is preserved', () => {
  for (const name of ['analysis', 'thinking', 'think', 'summary', 'THINKING']) {
    assert.equal(collect([`<${name}>${privateText}</${name}>你好呀`]), '你好呀');
    assert.equal(collect([`你好呀<${name}>${privateText}</${name}>`]), '你好呀');
  }
});

test('nested, unmatched, and truncated internal blocks fail closed', () => {
  assert.equal(collect([`<analysis><summary>${privateText}</summary>内部</analysis>你好`]), '你好');
  assert.equal(collect([`<analysis>${privateText}</summary>内部`]), '');
  assert.equal(collect([`你好<thinking>${privateText}`]), '你好');
  assert.equal(collect([`<analysis><summary>${privateText}</analysis>内部`]), '');
});

test('tags and private content split across messages stay internal', () => {
  assert.equal(collect(['<ana', `lysis>${privateText}</anal`, 'ysis><sum', `mary>${privateText}`]), '');
  assert.equal(collect(['<thinking>', privateText, '</thinking>', '你好']), '你好');
});

test('ordinary replies are unchanged and real secrets outside internal tags remain auditable', () => {
  for (const text of ['你好', '今天聊聊 summary 和 analysis', '2 < 3', 'https://example.com/guide']) {
    assert.equal(stripInternalAssistantText(text), text);
  }
  const text = collect([`<thinking>内部</thinking>${privateText}`]);
  assert.equal(text, privateText);
  assert.equal(SENSITIVE_RE.test(text), true);
});

test('collector still ignores reasoning and chunks without duplicating final text', () => {
  const c = createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 2 } });
  c.push({ type: 'assistant/chunk', data: { turn: 2, text: privateText } });
  c.push({ type: 'assistant/message', data: { turn: 2, message: { content: [
    { type: 'reasoning', text: privateText }, { type: 'text', text: '你好' },
  ] } } });
  assert.equal(c.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }).text, '你好');
});
