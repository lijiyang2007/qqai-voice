// TTS 缓存 LRU 的自检（不花钱、不联网）。
//
// 验证三件事：
//   1. 超过 cacheMaxFiles 时，删的是**最久没被用过**的，不是最早的；
//   2. 命中缓存会 touch mtime，所以常用句不会被冷门新句挤掉；
//   3. TTL 过期仍然生效（两条规则是「先 TTL、后条数」）。
//
// 用法：node scripts/tts-cache-selftest.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesizeSpeech } from '../src/tts-core.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-lru-'));
const listMp3 = () => fs.readdirSync(dir).filter((n) => /\.mp3$/i.test(n)).sort();

// 直接造缓存文件，避免真的调用 TTS。
// 文件名格式要和 tts-core 一致：`${provider}-${digest}.mp3`。
function makeFile(name, ageMs) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(1024, 0x41));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
}

console.log('\n[1/3] 条数上限：超过 maxFiles 时删最旧的');
{
  for (const n of listMp3()) fs.unlinkSync(path.join(dir, n));
  // 5 个文件，年龄从旧到新：a(最旧) … e(最新)
  const ages = { 'a.mp3': 50, 'b.mp3': 40, 'c.mp3': 30, 'd.mp3': 20, 'e.mp3': 10 };
  for (const [n, min] of Object.entries(ages)) makeFile(n, min * 60000);
  // 触发一次合成，maxFiles=3 → 应该只留最新的 3 个（c/d/e）
  await synthesizeSpeech('触发清理', {
    provider: 'edge', outDir: dir, maxChars: 50,
    cacheTtlMs: 7 * 24 * 3600000, cacheMaxFiles: 3
  }).catch(() => {}); // 合成会失败（没网/无 sapi），不影响清理逻辑
  const left = listMp3().filter((n) => ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'].includes(n));
  check('只保留 maxFiles 条', left.length <= 3, `剩余 ${left.join(',') || '(无)'}`);
  check('删掉的是最旧的两个', !left.includes('a.mp3') && !left.includes('b.mp3'), `保留 ${left.join(',')}`);
  check('最新的一定还在', left.includes('e.mp3'), `e.mp3 ${left.includes('e.mp3') ? '在' : '被误删'}`);
}

console.log('\n[2/3] 命中缓存 touch mtime → 常用句不被挤掉');
{
  for (const n of listMp3()) fs.unlinkSync(path.join(dir, n));
  // old.mp3 很旧，fresh1/fresh2 较新。上限 2。
  makeFile('old.mp3', 60 * 60000);
  makeFile('fresh1.mp3', 30 * 60000);
  makeFile('fresh2.mp3', 10 * 60000);
  // 手动 touch old.mp3，模拟"刚刚被命中过"
  const now = new Date();
  fs.utimesSync(path.join(dir, 'old.mp3'), now, now);
  await synthesizeSpeech('再触发一次清理', {
    provider: 'edge', outDir: dir, maxChars: 50,
    cacheTtlMs: 7 * 24 * 3600000, cacheMaxFiles: 2
  }).catch(() => {});
  const left = listMp3().filter((n) => ['old.mp3', 'fresh1.mp3', 'fresh2.mp3'].includes(n));
  check('被 touch 过的 old.mp3 存活', left.includes('old.mp3'), `保留 ${left.join(',')}`);
  check('最久未用的 fresh1 被淘汰', !left.includes('fresh1.mp3'), `保留 ${left.join(',')}`);
}

console.log('\n[3/3] TTL 过期优先于条数上限');
{
  for (const n of listMp3()) fs.unlinkSync(path.join(dir, n));
  makeFile('expired.mp3', 2 * 3600000); // 2 小时前，TTL 设 1 小时 → 应删
  makeFile('alive.mp3', 10 * 60000);    // 10 分钟前 → 保留
  await synthesizeSpeech('TTL 测试', {
    provider: 'edge', outDir: dir, maxChars: 50,
    cacheTtlMs: 3600000, cacheMaxFiles: 100
  }).catch(() => {});
  const left = listMp3();
  check('过期文件被删', !left.includes('expired.mp3'), `剩余 ${left.join(',') || '(无)'}`);
  check('未过期文件保留', left.includes('alive.mp3'), `剩余 ${left.join(',') || '(无)'}`);
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
