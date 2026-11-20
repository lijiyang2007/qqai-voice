// 切换「音色套」：让桥接用哪个音色的预存语音库，并可选同步切换合成音色。
//
// 背景：预存语音按音色分目录存放（audio/<voiceId>/）。这个脚本做两件事：
//   1. 把语音库指向 audio/<voiceId>/（写 state/voice-override.json 的 libraryDir）
//   2. --with-tts 时连合成音色一起换（不然会出现「预存是 A、现场合成是 B」）
//
// 用法：
//   node scripts/use-voice-library.mjs --list              # 看有哪些音色套
//   node scripts/use-voice-library.mjs voc_8yud7hz7c9q2    # 只切语音库
//   node scripts/use-voice-library.mjs voc_xxx --with-tts  # 语音库 + 合成音色一起切
//   node scripts/use-voice-library.mjs --clear             # 回到 audio/ 根目录 + config 音色

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flagOf = (n) => argv.includes(`--${n}`);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

function consoleToken() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}
const TOKEN = consoleToken();
if (!TOKEN) { console.error('❌ 读不到 state/console-token。'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const baseDir = path.join(ROOT, cfg?.socialV2?.voice?.dir || 'audio');

// --list：列出已建好的音色套
if (flagOf('list')) {
  const activeId = cfg?.socialV2?.voice?.tts?.breeze?.voiceId;
  const dirs = fs.existsSync(baseDir)
    ? fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];
  const topFiles = fs.existsSync(baseDir)
    ? fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isFile() && /\.(mp3|wav)$/i.test(e.name)).length
    : 0;
  console.log('音色套：\n');
  if (topFiles) console.log(`  (根目录)             ${String(topFiles).padStart(3)} 条  ← 未分类/旧版`);
  for (const d of dirs) {
    const n = fs.readdirSync(path.join(baseDir, d.name)).filter((f) => /\.(mp3|wav)$/i.test(f)).length;
    const mark = d.name === activeId ? '  ← 当前默认音色' : '';
    console.log(`  ${d.name.padEnd(20)} ${String(n).padStart(3)} 条${mark}`);
  }
  if (!topFiles && !dirs.length) console.log('  (空)');
  console.log('\n切换：node scripts/use-voice-library.mjs voc_xxx [--with-tts]');
  process.exit(0);
}

const BASE = 'http://127.0.0.1:3100';
async function call(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'x-console-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  return json ?? { raw: text };
}

try {
  if (flagOf('clear')) {
    await call('POST', '/api/socialV2/voice-profile', { clear: true });
    console.log('✅ 已清除覆盖：语音库回到 audio/ 根目录，音色回到 config.json');
    process.exit(0);
  }

  const raw = positional[0] ?? '';
  if (!raw) {
    const r = await call('GET', '/api/socialV2/voice-profile');
    // 显示**实际生效**的目录：桥接会优先用 audio/<当前音色>/，只在不存在时回落根目录。
    // 只看 override.libraryDir 会误报成「根目录」（第一次就这么错过）。
    const activeId = r.effective.breezeVoiceId;
    const perVoice = activeId ? path.join(baseDir, activeId) : '';
    const perVoiceCount = perVoice && fs.existsSync(perVoice)
      ? fs.readdirSync(perVoice).filter((f) => /\.(mp3|wav)$/i.test(f)).length : 0;
    const rootCount = fs.existsSync(baseDir)
      ? fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isFile() && /\.(mp3|wav)$/i.test(e.name)).length : 0;
    const libLabel = perVoiceCount
      ? `audio/${activeId}/  (${perVoiceCount} 条)`
      : `audio/  (根目录, ${rootCount} 条)`;
    console.log('当前：');
    console.log(`  合成音色  ${activeId || '(未设置)'}`);
    console.log(`  语音库    ${libLabel}`);
    if (r.override?.libraryDir) console.log(`  显式指定  audio/${r.override.libraryDir}/（覆盖了自动解析）`);
    console.log('\n可选：node scripts/use-voice-library.mjs --list');
    process.exit(0);
  }

  if (!/^voc_[A-Za-z0-9]+$/.test(raw)) {
    console.error(`❌ voiceId 格式不合法：${raw}`);
    process.exit(1);
  }

  const dir = path.join(baseDir, raw);
  if (!fs.existsSync(dir)) {
    console.error(`❌ audio/${raw}/ 不存在。先用这个音色生成一套：`);
    console.error(`   node scripts/build-voice-library.mjs --voice ${raw}`);
    process.exit(1);
  }
  const count = fs.readdirSync(dir).filter((f) => /\.(mp3|wav)$/i.test(f)).length;
  if (!count) {
    console.error(`❌ audio/${raw}/ 是空的。`);
    process.exit(1);
  }

  const patch = { libraryDir: raw };
  if (flagOf('with-tts')) patch.voiceId = raw;

  const r = await call('POST', '/api/socialV2/voice-profile', patch);
  console.log(`✅ 已切换到音色套 ${raw}（${count} 条语音）`);
  console.log(`   语音库    audio/${raw}/`);
  console.log(`   合成音色  ${r.effective.breezeVoiceId}`);
  if (!flagOf('with-tts') && r.effective.breezeVoiceId !== raw) {
    console.log('');
    console.log(`   ⚠️ 合成音色仍是 ${r.effective.breezeVoiceId}，和预存语音不一致。`);
    console.log(`      要一起切：node scripts/use-voice-library.mjs ${raw} --with-tts`);
  }
} catch (error) {
  console.error(`❌ ${error?.message ?? error}`);
  process.exit(1);
}
