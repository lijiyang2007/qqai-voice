// 文字转语音（TTS）单元测试：清洗 / SSML / GEC 令牌 / 离线兜底脚本。
//
// 离线部分是确定的、不碰网络；真合成默认跳过，需要显式打开：
//   $env:QQ_BRIDGE_TEST_TTS_LIVE="1"; node scripts/test-voice-tts.mjs
// 打开后会真的调用一次 Edge 朗读与一次 Windows SAPI，并在 state/tts 留下缓存文件。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEdgeSsml, buildNaturalEdgeSsml, DEFAULT_EDGE_VOICE, edgeSecMsGec, humanizeSpeechText, normalizeEdgeVoice, sanitizeSpeechText, TTS_EDGE_VOICES, voiceLocale } from '../src/tts-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 文字清洗');
{
  ok(sanitizeSpeechText('**晚安**啦😴') === '晚安 啦', '去掉 Markdown 与 emoji');
  ok(!sanitizeSpeechText('[CQ:face,id=1]你好').includes('CQ'), '去掉 CQ 码');
  ok(!sanitizeSpeechText('看这个 https://example.com/a?b=1 吧').includes('http'), 'URL 不念原文');
  ok(sanitizeSpeechText('  多  个\n空白\t字符  ') === '多 个 空白 字符', '折叠空白与换行');
  ok(sanitizeSpeechText('a'.repeat(500), { maxChars: 20 }).length === 20, '按 maxChars 截断');
  ok(sanitizeSpeechText('😴 [CQ:face,id=1] https://x.com') === '链接', '只有表情/链接 → 只剩可念内容或空');
  ok(sanitizeSpeechText('') === '', '空字符串不报错');
}

console.log('## SSML 与音色');
{
  const ssml = buildEdgeSsml({ text: '你好 <世界> & "朋友"', voice: 'zh-CN-YunxiNeural', rate: 12 });
  ok(!ssml.includes('<世界>'), '文本里的尖括号被转义');
  ok(ssml.includes('&amp;') && ssml.includes('&quot;'), '& 与引号被转义');
  ok(ssml.includes('name="zh-CN-YunxiNeural"'), '音色名进了 voice 标签');
  ok(ssml.includes('rate="+12%"'), '语速用百分比');
  ok(ssml.includes('xml:lang="zh-CN"'), 'locale 由音色推断');
  ok(voiceLocale('zh-CN-liaoning-XiaobeiNeural') === 'zh-CN', '方言音色 locale 仍是 zh-CN');

  const bad = ['zh-CN-XiaoxiaoNeural" onload="x', '"><script>', 'zh-CN-Xiaoxiao', ''];
  ok(bad.slice(0, 3).every((v) => { try { normalizeEdgeVoice(v); return false; } catch { return true; } }), '非法音色名被拒（防 SSML 注入）');
  ok(normalizeEdgeVoice('') === DEFAULT_EDGE_VOICE, '空音色 → 默认晓晓');
  ok(TTS_EDGE_VOICES.length >= 5, `推荐音色列表 ${TTS_EDGE_VOICES.length} 个`);
}

console.log('## Sec-MS-GEC v2');
{
  const fixed = Date.UTC(2026, 9, 27, 16, 0, 0); // 2026-10-27T16:00:00Z
  const a = edgeSecMsGec(fixed);
  const b = edgeSecMsGec(fixed + 60 * 1000);
  const c = edgeSecMsGec(fixed + 6 * 60 * 1000);
  ok(/^[0-9A-F]{16}-[0-9A-F]{64}$/.test(a), '格式为 <CS64 16 hex>-<SHA256 64 hex>', a.slice(0, 24) + '…');
  ok(a === b, '同一 5 分钟时间片内稳定');
  ok(a !== c, '跨时间片变化');
  ok(edgeSecMsGec(Date.now()) !== edgeSecMsGec(Date.now() + 3600 * 1000), '一小时后令牌不同');
}

console.log('## 口语化与自然断句');
{
  ok(humanizeSpeechText('你怎么还不睡。都几点了。') === '你怎么还不睡，都几点了。', '句号转逗号，只在结尾收句号');
  ok(humanizeSpeechText('真的吗？太好了！') === '真的吗？太好了！', '问号/感叹号保留');
  ok(!humanizeSpeechText('第一、第二；第三。').includes('、'), '顿号转逗号');
  ok(humanizeSpeechText('嗯') === '嗯。', '没有结尾标点时补句号');

  const short = buildNaturalEdgeSsml({ text: '晚安啦。', voice: 'zh-CN-XiaoyiNeural' });
  ok((short.match(/<prosody/g) || []).length === 1, '单句只用 1 个 prosody');

  const long = buildNaturalEdgeSsml({ text: '诶，你怎么还不睡啊。今天服务器又抽风了。忙了一下午。累死我了。', voice: 'zh-CN-XiaoyiNeural' });
  const count = (long.match(/<prosody/g) || []).length;
  ok(count <= 2, '长句最多 2 个 prosody（Edge 超过 2 个会断连）', `实际 ${count}`);
  ok(!long.includes('<break'), '不使用 <break>（Edge 朗读不支持）');
  ok(!long.includes('express-as'), '不使用 express-as（Edge 朗读不支持）');
  ok(long.includes('rate="+1.5%"') && long.includes('rate="-2%"'), '前后两段有轻微语速差');
}

console.log('## AI 通道不许模型覆盖音色');
{
  // 真实踩过的坑：模型调用 qq_send_voice 时会自己传 voiceName（工具描述里举例的晓晓），
  // 把配置里的默认音色覆盖掉，用户看到的现象是「改了配置但音色没变」。
  // 这里静态守住：AI 通道调 sendVoiceTextForV2 时不能把请求体里的 voiceName/rate 传进去。
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const aiAt = bridgeSrc.indexOf("url.pathname === '/api/socialV2/send-voice'");
  ok(aiAt > 0, '找到 AI 语音发送路由');
  const aiSection = bridgeSrc.slice(aiAt, aiAt + 6000);
  ok(!/voiceName:\s*String\(body\.voiceName/.test(aiSection), 'AI 路由不转发 voiceName');
  ok(!/rate:\s*body\.rate/.test(aiSection), 'AI 路由不转发 rate');
  ok(aiSection.includes('一律忽略 voiceName'), '代码里写明了忽略原因（防回归）');
}

console.log('## 兜底脚本');
{
  const script = path.join(ROOT, 'scripts', 'tts-sapi.ps1');
  ok(fs.existsSync(script), '存在 scripts/tts-sapi.ps1');
  if (fs.existsSync(script)) {
    const buf = fs.readFileSync(script);
    // Windows PowerShell 5.1 会按 ANSI 读无 BOM 的 .ps1；中文注释里有全角符号时会把脚本解析坏。
    ok(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, '脚本带 UTF-8 BOM（PowerShell 5.1 必需）');
    const text = buf.toString('utf8');
    ok(text.includes('System.Speech') && text.includes('SetOutputToWaveFile'), '使用 System.Speech 写出 WAV');
    ok(text.includes('16000'), '统一 16kHz（便于网关转 SILK）');
  }
}

if (process.env.QQ_BRIDGE_TEST_TTS_LIVE === '1') {
  console.log('## live：真的合成（Edge + SAPI）');
  const { synthesizeSpeech } = await import('../src/tts-core.js');
  const outDir = path.join(ROOT, 'state', 'tts');
  try {
    const edge = await synthesizeSpeech('测试一下，这是在线合成的声音。', { provider: 'edge', outDir });
    ok(edge.provider === 'edge' && edge.bytes > 1000 && fs.existsSync(edge.file), 'Edge 合成出音频', `${edge.bytes} B / ${edge.duration?.toFixed(1)}s`);
    const cached = await synthesizeSpeech('测试一下，这是在线合成的声音。', { provider: 'edge', outDir });
    ok(cached.cached === true, '同文本命中缓存');
  } catch (error) {
    fail += 1;
    console.error('  ❌ Edge 合成失败：' + (error?.message ?? error));
  }
  if (process.platform === 'win32') {
    try {
      const sapi = await synthesizeSpeech('测试一下，这是本地合成的声音。', { provider: 'sapi', outDir });
      ok(sapi.provider === 'sapi' && sapi.bytes > 1000, 'SAPI 合成出音频', `${sapi.bytes} B / ${sapi.duration?.toFixed(1)}s`);
    } catch (error) {
      fail += 1;
      console.error('  ❌ SAPI 合成失败：' + (error?.message ?? error));
    }
  } else {
    console.log('  ⏭  跳过 SAPI：仅 Windows');
  }
} else {
  console.log('## live：跳过（设 QQ_BRIDGE_TEST_TTS_LIVE=1 可真的合成）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
