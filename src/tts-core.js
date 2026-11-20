// 文字转语音（TTS）内核：把 AI 想说的话合成为音频文件，再交给语音发送链路。
//
// 背景：早期 `qq_send_voice` 只能从 `audio/` 语音库里挑一个**预先放好**的音频，
// 也就是说 AI 只会念别人准备的那几句话。要让 AI 真正「开口说话」，需要它自己
// 把文字变成声音，于是有了这一层。
//
// 两个合成后端：
//   · edge —— 微软 Edge「朗读」在线服务。音色自然（晓晓 / 云希 / 云健 …），是默认选择；
//              需要能访问 speech.platform.bing.com，失败时自动回退 sapi。
//   · sapi —— Windows 自带 System.Speech（离线）。音色老是老，但**一定可用**，
//              没网 / 服务改协议时至少还能出声。
//
// Edge 的接入细节（2026-10 起变了两次，别随手改）：
//   1. 握手必须带 `Sec-MS-GEC` 与浏览器 `Origin` / `User-Agent`，否则直接 403；
//   2. 2026-10-13 起 v1 的 GEC 被拒，要发 v2：对「版权声明 + 时间片 + token」做
//      SHA-256，再用 CS64 混淆出 `<CS64>-<SHA256>` 双摘要。算法来自
//      rany2/edge-tts#492（MIT）与 msedge-tts 2.1.1 的实现，只做最小移植；
//   3. Node 内置的 WebSocket **不能自定义请求头**（发不了 Origin），所以这里用
//      `node:https` 自己做 RFC 6455 握手与分帧 —— 不引入 ws 依赖。
//
// 依赖约定：只用 node 内置模块；子进程一律 `stdio: 'ignore'` + 写文件回传
// （受限沙箱里 spawn + pipe 会 EPERM，见 voice-core.js 开头的同一说明）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { synthesizeBreeze, estimateBreezeCredits } from './tts-breeze.js';

/** 推荐的 Edge 中文音色（给工具描述与控制台用，不是白名单——白名单是正则）。 */
export const TTS_EDGE_VOICES = Object.freeze([
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女，温暖）' },
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊（女，活泼，更像真人聊天）' },
  { name: 'zh-CN-YunxiNeural', label: '云希（男，年轻）' },
  { name: 'zh-CN-YunjianNeural', label: '云健（男，浑厚）' },
  { name: 'zh-CN-YunxiaNeural', label: '云夏（男，少年）' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（女，东北话）' },
  { name: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（女，陕西话）' }
]);

export const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoxiaoNeural';

const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_CHROME_VERSION = '143.0.3650.96';
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';
// Edge 输出 24kHz 单声道 MP3；96kbps 比朗读默认的 48kbps 少一层压缩毛刺，
// 再交给 QQ 转 SILK 时也更耐转码。
const EDGE_MP3_BITRATE = 96000;
const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

/**
 * 把聊天里的一段文字清洗成「适合念出来」的话。
 *
 * 语音没有富文本：CQ 码、Markdown 记号、URL、表情符号念出来都很怪（有的还会被
 * 逐字读成英文），所以这里统一清掉。emojis 直接删掉而不是念名字——群聊里
 * 「晚安啦😴」念成「晚安啦」最自然。
 */
export function sanitizeSpeechText(input, { maxChars = 300 } = {}) {
  let s = String(input ?? '');
  if (!s) return '';
  s = s.replace(/\[CQ:[^\]]*\]/gi, ' ');
  s = s.replace(/\[(图片|表情|语音|视频|文件|动画表情|转发消息[^\]]*)\]/g, ' ');
  s = s.replace(/https?:\/\/\S+/gi, ' 链接 ');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/[*_~`#>|]+/g, ' ');
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  // emoji / 变体选择符 / 零宽字符：Edge 与 SAPI 的处理不一致，干脆全部剔除。
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{2060}]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  const limit = clampNumber(maxChars, 300, 1, 2000);
  if (s.length > limit) s = s.slice(0, limit).trim();
  return s;
}

/** 校验 Edge 音色名（防止把任意字符串塞进 SSML 属性）。 */
export function normalizeEdgeVoice(voice) {
  const v = String(voice ?? '').trim();
  if (!v) return DEFAULT_EDGE_VOICE;
  if (!/^[A-Za-z]{2,3}-[A-Za-z0-9-]{2,48}Neural$/.test(v)) {
    throw new Error(`音色名不合法：${v}（应形如 zh-CN-XiaoxiaoNeural）`);
  }
  return v;
}

/** 由音色名推断 locale（zh-CN-liaoning-XiaobeiNeural → zh-CN）。 */
export function voiceLocale(voice) {
  const parts = String(voice ?? '').split('-');
  if (parts.length < 2) return 'zh-CN';
  return `${parts[0]}-${parts[1]}`;
}

/**
 * 组装 Edge 的 SSML。
 *
 * `style` 是 Azure/Edge 的「说话风格」：chat（闲聊）/ gentle / calm / cheerful …
 * 闲聊风格会把字正腔圆的播报腔压下去，是「别像人机」的关键开关之一。
 * `styleDegree` 是风格强度（0.01 ~ 2.0）。
 */
export function buildEdgeSsml({ text, voice = DEFAULT_EDGE_VOICE, rate = 0, pitch = 0, volume = 0, style = '', styleDegree = 1.6 } = {}) {
  const v = normalizeEdgeVoice(voice);
  const r = clampNumber(rate, 0, -50, 100);
  const p = clampNumber(pitch, 0, -50, 50);
  const vol = clampNumber(volume, 0, -50, 50);
  const signed = (n) => `${n >= 0 ? '+' : ''}${n}%`;
  const prosody = `<prosody pitch="${p >= 0 ? '+' : ''}${p}Hz" rate="${signed(r)}" volume="${signed(vol)}">${escapeXml(text)}</prosody>`;
  const styleName = String(style ?? '').trim();
  let inner = prosody;
  if (styleName) {
    if (!/^[A-Za-z][A-Za-z0-9]{1,23}$/.test(styleName)) throw new Error(`说话风格不合法：${styleName}`);
    // styledegree 不是所有通道都认；传 0 表示只带 style、不带强度。
    const attrs = Number(styleDegree) > 0
      ? ` style="${styleName}" styledegree="${Math.min(2, Math.max(0.01, Number(styleDegree) || 1.6))}"`
      : ` style="${styleName}"`;
    inner = `<mstts:express-as${attrs}>${prosody}</mstts:express-as>`;
  }
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${voiceLocale(v)}">`
    + `<voice name="${v}">`
    + inner
    + `</voice></speak>`;
}

/**
 * 「别像人机」版 SSML：把整段话分成前后两段，各给一点点不同的语速/音高。
 *
 * 为什么只分两段：实测 Edge 朗读通道对 `<prosody>` 元素数量有硬限制——
 * 一条 SSML 里超过 2 个 prosody 会直接断开连接（3 个必失败，2 个正常），
 * 而 `mstts:express-as`（chat 等风格）和 `<break>` 也都不被支持。
 * 所以这里用「两段微差」这个唯一可靠的写法：打散通篇一个语速的念稿感，
 * 又不会触发服务端限制。短句（单句）直接走普通 SSML。
 */
export function buildNaturalEdgeSsml({ text, voice = DEFAULT_EDGE_VOICE, rate = 0, pitch = 0, volume = 0 } = {}) {
  const v = normalizeEdgeVoice(voice);
  const baseRate = clampNumber(rate, 0, -50, 100);
  const basePitch = clampNumber(pitch, 0, -50, 50);
  const vol = clampNumber(volume, 0, -50, 50);
  const signedPct = (n) => `${n >= 0 ? '+' : ''}${n}%`;
  const signedHz = (n) => `${n >= 0 ? '+' : ''}${n}Hz`;

  const clauses = String(text ?? '')
    .split(/(?<=[，,。！？!?…；;、])/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (clauses.length <= 1) {
    return buildEdgeSsml({ text, voice: v, rate: baseRate, pitch: basePitch, volume: vol });
  }

  // 按字符数从中间切成两段（尽量在句子边界）
  const total = clauses.reduce((sum, clause) => sum + clause.length, 0);
  let acc = 0;
  let cut = clauses.length;
  for (let i = 0; i < clauses.length; i += 1) {
    acc += clauses[i].length;
    if (acc >= total / 2) { cut = i + 1; break; }
  }
  const groups = [clauses.slice(0, cut).join(''), clauses.slice(cut).join('')].filter(Boolean);
  if (groups.length < 2) {
    return buildEdgeSsml({ text, voice: v, rate: baseRate, pitch: basePitch, volume: vol });
  }

  // 后半句略慢一点、略低一点，像真人说到后半句会松下来。
  const deltas = [[1.5, 0], [-2, -1]];
  const body = groups.map((group, index) => {
    const [rateDelta, pitchDelta] = deltas[index] ?? [0, 0];
    return `<prosody rate="${signedPct(baseRate + rateDelta)}" pitch="${signedHz(basePitch + pitchDelta)}" volume="${signedPct(vol)}">${escapeXml(group)}</prosody>`;
  }).join('');

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${voiceLocale(v)}">`
    + `<voice name="${v}">${body}</voice></speak>`;
}

/**
 * 把「写出来的字」改成「说出来的话」。
 *
 * 中文 TTS 最像播报的地方不是音色，而是标点：每个句号都会被读成一次完整停顿，
 * 句子一板一眼。日常聊天里句号很少，停顿也更碎，所以这里：
 *   · 句号（不含问号/感叹号/省略号）→ 逗号，只在最后补一个句号；
 *   · 分号、顿号 → 逗号；
 *   · 折叠重复标点与空白。
 * 语气词（啊/呢/吧/嘛/诶…）本来就在 AI 的文本里，这里不额外加，避免篡改原意。
 */
export function humanizeSpeechText(input, { maxChars = 2000 } = {}) {
  let s = sanitizeSpeechText(input, { maxChars });
  if (!s) return '';
  // 先保住问号/感叹号/省略号（它们自带语调），其余句末句号转逗号
  s = s.replace(/。/g, '，');
  s = s.replace(/[；;]/g, '，');
  s = s.replace(/、/g, '，');
  s = s.replace(/[，,]{2,}/g, '，');
  s = s.replace(/\s*([，。！？!?…])\s*/g, '$1');
  s = s.replace(/^[，,\s]+/, '');
  // 结尾如果是逗号，收成句号（否则 TTS 会觉得话没说完，尾音发虚）
  s = s.replace(/[，,]$/, '。');
  if (!/[。！？!?…～~]$/.test(s)) s += '。';
  return s;
}

// ── Sec-MS-GEC v2（Edge 朗读的防滥用令牌） ──────────────────────────────────
//
// 参考实现：https://github.com/rany2/edge-tts/pull/492
// CS64 是微软自己对 SHA-256 摘要做的混淆：把 32 位字按小端拆成两两一组，
// 先做若干轮 rotate/multiply 混合，再与摘要前 8 字节（作为密钥）异或。
// 这里逐行照搬（包括那些看起来没道理、但少了就不行的调整常量）。

const CS64_SWAP_FIRST = { word: 0xEF0569FB, sum: 0x76F50F34, product: 0xC3EFEA97 };
const CS64_SWAP_SECOND = { word: 0xC31713DB, sum: 0x1881CE3C, product: 0x35BD1EC9 };
const CS64_MIX_FIRST = [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83];
const CS64_MIX_SECOND = [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69];

function swapHalves(value) {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function mixAndMultiply(value, multipliers) {
  let v = value >>> 0;
  for (const m of multipliers) v = Math.imul(swapHalves(v), m) >>> 0;
  return v;
}

function swapTerm(word, key, multipliers) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), multipliers.word);
  const product = Math.imul(swapHalves(sum), multipliers.sum) >>> 0;
  return (Math.imul(swapHalves(product), multipliers.product) + product) >>> 0;
}

function cs64Checksum(message, digest) {
  const digestView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const firstKey = (digestView.getUint32(0, true) | 1) >>> 0;
  const secondKey = (digestView.getUint32(4, true) | 1) >>> 0;
  const padded = new Uint8Array(Math.ceil(message.length / 8) * 8);
  padded.set(message);
  const words = new DataView(padded.buffer);
  let swapSum = 0;
  let lastSwap = 0;
  let mix = 0;
  let mixSum = 0;
  for (let offset = 0; offset < padded.length; offset += 8) {
    const firstWord = words.getUint32(offset, true);
    const secondWord = words.getUint32(offset + 4, true);
    lastSwap = swapTerm(secondWord, secondKey, CS64_SWAP_SECOND);
    swapSum = (swapSum + swapTerm(firstWord, firstKey, CS64_SWAP_FIRST) + lastSwap) >>> 0;
    mix = mixAndMultiply(Math.imul(mix + firstWord, firstKey) >>> 0, CS64_MIX_FIRST);
    mixSum = (mixSum + mix) >>> 0;
    mix = mixAndMultiply(Math.imul(mix + secondWord, secondKey) >>> 0, CS64_MIX_SECOND);
    mixSum = (mixSum + mix) >>> 0;
  }
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, (lastSwap ^ mix) >>> 0, true);
  view.setUint32(4, (swapSum ^ mixSum) >>> 0, true);
  return out;
}

function toUpperHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * 生成 Sec-MS-GEC v2：`<CS64>-<SHA256>`。
 * 时间片固定为 5 分钟（300s）对齐，所以同一时间片内的结果稳定，便于缓存/测试。
 */
export function edgeSecMsGec(nowMs = Date.now()) {
  const ticks = Math.floor(nowMs / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  const message = Buffer.from(`${EDGE_COPYRIGHT}${rounded * 10000000}${EDGE_TRUSTED_CLIENT_TOKEN}`, 'utf8');
  const digest = new Uint8Array(crypto.createHash('sha256').update(message).digest());
  return `${toUpperHex(cs64Checksum(message, digest))}-${toUpperHex(digest)}`;
}

// ── 最小 RFC 6455 客户端 ────────────────────────────────────────────────────

function encodeClientFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  const headerLen = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | opcode;
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  mask.copy(frame, headerLen);
  for (let i = 0; i < len; i += 1) frame[headerLen + 4 + i] = data[i] ^ mask[i & 3];
  return frame;
}

/** 逐帧解析服务端数据（服务端帧不掩码）；返回未消费的尾巴。 */
function parseServerFrames(buffer, onFrame) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (buffer.length - p < 2) break;
      len = buffer.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buffer.length - p < 8) break;
      const big = buffer.readBigUInt64BE(p);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket 帧过大');
      len = Number(big);
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length - p < 4) break;
      mask = buffer.subarray(p, p + 4);
      p += 4;
    }
    if (buffer.length - p < len) break;
    let payload = buffer.subarray(p, p + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    }
    offset = p + len;
    onFrame({ fin, opcode, payload });
  }
  return buffer.subarray(offset);
}

function httpsUpgrade(url, timeoutMs) {
  const target = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      port: target.port || 443,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        Origin: EDGE_ORIGIN,
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_CHROME_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${EDGE_CHROME_VERSION.split('.')[0]}.0.0.0`
      }
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`Edge TTS 握手超时（${timeoutMs}ms）`));
    }, timeoutMs);
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== expected) {
        try { socket.destroy(); } catch {}
        const error = new Error(`Edge TTS 握手被拒（HTTP ${res.statusCode}）`);
        error.statusCode = res.statusCode;
        reject(error);
        return;
      }
      resolve({ socket, head });
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 500) body += chunk; });
      res.on('end', () => {
        const error = new Error(`Edge TTS 握手被拒（HTTP ${res.statusCode}${body ? `：${body.trim().slice(0, 120)}` : ''}）`);
        error.statusCode = res.statusCode;
        error.serverDate = res.headers.date;
        reject(error);
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

async function edgeSynthesizeOnce(ssml, { outputFormat = EDGE_OUTPUT_FORMAT, timeoutMs, clockOffsetMs = 0 }) {
  const secMsGec = edgeSecMsGec(Date.now() + clockOffsetMs);
  const connectionId = crypto.randomUUID();
  const requestId = crypto.randomUUID().replace(/-/g, '');
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
    + `?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}`
    + `&Sec-MS-GEC=${encodeURIComponent(secMsGec)}`
    + `&Sec-MS-GEC-Version=2-${EDGE_CHROME_VERSION}`
    + `&ConnectionId=${connectionId}`;

  const { socket, head } = await httpsUpgrade(url, Math.min(timeoutMs, 12000));

  return new Promise((resolve, reject) => {
    let pending = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    let fragments = [];
    let fragOpcode = 0;
    const chunks = [];
    let gotAudio = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      try { socket.end(); } catch {}
      try { socket.destroy(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Edge TTS 合成超时（${timeoutMs}ms，已收到 ${chunks.length} 个音频帧）`));
    }, timeoutMs);

    const send = (opcode, payload) => {
      try { socket.write(encodeClientFrame(opcode, Buffer.from(payload, 'utf8'))); }
      catch (error) { finish(new Error(`Edge TTS 写入失败：${error?.message ?? error}`)); }
    };

    const onMessage = (frame) => {
      if (frame.opcode === 0x8) { // close
        finish(gotAudio ? null : new Error('Edge TTS 连接在收到音频前被关闭'), { buffer: Buffer.concat(chunks) });
        return;
      }
      if (frame.opcode === 0x9) { // ping
        try { socket.write(encodeClientFrame(0xa, frame.payload)); } catch {}
        return;
      }
      if (frame.opcode === 0xa) return; // pong
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        fragments = [frame.payload];
        fragOpcode = frame.opcode;
      } else if (frame.opcode === 0x0) {
        fragments.push(frame.payload);
      } else {
        return;
      }
      if (!frame.fin) return;
      const full = Buffer.concat(fragments);
      fragments = [];
      // 文本帧是「X-RequestId:…\r\nPath:turn.end\r\n\r\n{}」这种纯文本；
      // 二进制帧才是「2 字节头长度 + 文本头 + 音频数据」。
      if (fragOpcode === 0x1) {
        const message = full.toString('utf8');
        if (message.includes('Path:turn.end')) {
          const buffer = Buffer.concat(chunks);
          if (!buffer.length) finish(new Error('Edge TTS 没有返回音频数据'));
          else finish(null, { buffer });
        }
        return;
      }
      if (full.length < 2) return;
      const headerLen = full.readUInt16BE(0);
      if (headerLen > full.length - 2) return;
      const header = full.subarray(2, 2 + headerLen).toString('utf8');
      if (header.includes('Path:audio')) {
        const audio = full.subarray(2 + headerLen);
        if (audio.length) {
          chunks.push(audio);
          gotAudio = true;
        }
        return;
      }
      if (header.includes('Path:turn.end')) {
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) finish(new Error('Edge TTS 没有返回音频数据'));
        else finish(null, { buffer });
      }
    };

    socket.on('data', (chunk) => {
      try {
        pending = parseServerFrames(Buffer.concat([pending, chunk]), onMessage);
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', (error) => finish(new Error(`Edge TTS 连接错误：${error?.message ?? error}`)));
    socket.on('close', () => {
      if (gotAudio && chunks.length) finish(null, { buffer: Buffer.concat(chunks) });
      else finish(new Error('Edge TTS 连接提前关闭'));
    });

    // speech.config → 指定输出格式（固定 24kHz/48kbps 单声道 MP3）
    send(0x1, `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
      + JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat
            }
          }
        }
      }));
    // SSML → 真正要念的内容
    send(0x1, `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n` + ssml);
  });
}

/**
 * 直接按给定 SSML 合成（内部/测试用）。
 * 正常调用请走 synthesizeEdge / synthesizeSpeech —— 它们会清洗文本并做回退。
 */
export async function synthesizeEdgeSsml(ssml, { outputFormat = EDGE_OUTPUT_FORMAT, timeoutMs = 15000 } = {}) {
  const result = await edgeSynthesizeOnce(String(ssml ?? ''), {
    outputFormat,
    timeoutMs: clampNumber(timeoutMs, 15000, 2000, 60000)
  });
  return result.buffer;
}

/**
 * 用 Edge 朗读服务合成。返回 { buffer, voice, style, format:'mp3' }。
 *
 * `style` 是说话风格（chat / gentle / calm …）。服务端偶尔不认某个风格，
 * 这时自动退回「不指定风格」再合成一次，而不是让整条语音失败。
 * 403 时按服务端 Date 校正一次时钟（本机时间偏差超过 5 分钟会让 GEC 时间片错位）。
 */
export async function synthesizeEdge(text, {
  voice = DEFAULT_EDGE_VOICE,
  rate = 0,
  pitch = 0,
  style = '',
  styleDegree = 1.6,
  natural = true,
  outputFormat = EDGE_OUTPUT_FORMAT,
  timeoutMs = 15000
} = {}) {
  const body = sanitizeSpeechText(text);
  if (!body) throw new Error('要合成的文字是空的');
  const normalizedVoice = normalizeEdgeVoice(voice);
  const budget = clampNumber(timeoutMs, 15000, 2000, 60000);
  const styleName = String(style ?? '').trim();
  const plainSsml = () => buildEdgeSsml({ text: body, voice: normalizedVoice, rate, pitch });
  const naturalSsml = () => buildNaturalEdgeSsml({ text: body, voice: normalizedVoice, rate, pitch });

  // 依次尝试，谁先成功用谁：自然断句 → 指定风格 → 默认。
  const attempts = [];
  if (natural) {
    attempts.push({ ssml: naturalSsml(), style: '', natural: true });
  }
  if (styleName) {
    attempts.push({
      ssml: buildEdgeSsml({ text: body, voice: normalizedVoice, rate, pitch, style: styleName, styleDegree }),
      style: styleName,
      natural: false
    });
  }
  attempts.push({ ssml: plainSsml(), style: '', natural: false });

  let lastError = null;
  let clockOffsetMs = 0;
  for (const attempt of attempts) {
    try {
      const result = await edgeSynthesizeOnce(attempt.ssml, { outputFormat, timeoutMs: budget, clockOffsetMs });
      return {
        buffer: result.buffer,
        voice: normalizedVoice,
        style: attempt.style,
        natural: attempt.natural,
        format: 'mp3'
      };
    } catch (error) {
      lastError = error;
      if (process.env.TTS_DEBUG === '1') {
        console.error('[tts] attempt failed:', attempt.natural ? 'natural' : (attempt.style ? `style=${attempt.style}` : 'plain'), '-', error?.message ?? error);
      }
      // 403 只在第一次失败时按服务端时间校正，之后沿用校正值重试
      if (error?.statusCode === 403 && error?.serverDate && !clockOffsetMs) {
        const serverMs = Date.parse(error.serverDate);
        if (Number.isFinite(serverMs)) clockOffsetMs = serverMs - Date.now();
      }
    }
  }
  throw lastError;
}

// ── Windows SAPI（离线兜底） ────────────────────────────────────────────────

const SAPI_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tts-sapi.ps1');

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

/**
 * 用 Windows 自带语音合成（System.Speech）。返回 { buffer, voice, format:'wav' }。
 * 先把文字写成 UTF-8 临时文件再交给 PowerShell —— 避免命令行引号/编码把中文吃掉。
 */
export async function synthesizeSapi(text, { voice = '', rate = 0, timeoutMs = 20000, tmpDir = null } = {}) {
  if (process.platform !== 'win32') throw new Error('SAPI 合成只在 Windows 上可用');
  const body = sanitizeSpeechText(text);
  if (!body) throw new Error('要合成的文字是空的');
  if (!fs.existsSync(SAPI_SCRIPT)) throw new Error(`缺少 SAPI 脚本：${SAPI_SCRIPT}`);

  const dir = tmpDir || path.join(os.tmpdir(), 'qq-bridge-tts');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const textFile = path.join(dir, `sapi-${stamp}.txt`);
  const wavFile = path.join(dir, `sapi-${stamp}.wav`);
  fs.writeFileSync(textFile, body, 'utf8');

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SAPI_SCRIPT,
    '-TextFile', textFile, '-OutFile', wavFile, '-Rate', String(clampNumber(rate, 0, -10, 10))];
  if (voice) args.push('-VoiceName', String(voice));

  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(powershellPath(), args, { windowsHide: true, stdio: 'ignore' });
      } catch (error) {
        reject(new Error(`无法启动 PowerShell：${error?.message ?? error}`));
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error(`SAPI 合成超时（${timeoutMs}ms）`));
      }, clampNumber(timeoutMs, 20000, 3000, 60000));
      child.on('error', (error) => { clearTimeout(timer); reject(new Error(`SAPI 进程错误：${error?.message ?? error}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`SAPI 合成失败（退出码 ${code}）`));
        else resolve();
      });
    });
    let buffer;
    try { buffer = fs.readFileSync(wavFile); }
    catch (error) { throw new Error(`SAPI 没有生成音频：${error?.message ?? error}`); }
    if (!buffer.length) throw new Error('SAPI 生成的音频为空');
    return { buffer, voice: voice || 'Windows 默认中文语音', format: 'wav' };
  } finally {
    try { fs.unlinkSync(textFile); } catch {}
    try { fs.unlinkSync(wavFile); } catch {}
  }
}

// ── 缓存与对外入口 ──────────────────────────────────────────────────────────

function wavDurationSeconds(buffer) {
  try {
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
    const byteRate = buffer.readUInt32LE(28);
    if (!byteRate) return null;
    return (buffer.length - 44) / byteRate;
  } catch {
    return null;
  }
}

/**
 * 清理 TTS 缓存目录：先按 TTL 删过期的，再按条数上限做 LRU 淘汰。
 *
 * 为什么需要条数上限：把 cacheTtlMs 调到 30 天后，光靠 TTL 几乎不会删东西，
 * 缓存会无限增长（每条 60~90 KB）。上限让它收敛到一个可预期的磁盘占用。
 *
 * 淘汰策略是「最久未使用」而不是「最早创建」：命中缓存时会 touch 一次 mtime
 * （见 synthesizeSpeech 的 cached 分支），所以常用的句子会一直活着，
 * 被挤掉的是那些说过一次就再没提过的。
 *
 * maxFiles <= 0 表示不限制条数（只按 TTL）。
 */
function cleanupTtsDir(dir, ttlMs, maxFiles = 0) {
  try {
    const now = Date.now();
    const survivors = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(mp3|wav)$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > ttlMs) {
          fs.unlinkSync(file);
          continue;
        }
        survivors.push({ file, mtimeMs: stat.mtimeMs });
      } catch {}
    }
    const limit = Number(maxFiles);
    if (Number.isFinite(limit) && limit > 0 && survivors.length > limit) {
      // 按 mtime 升序 = 最久没被碰过的排前面，先删它们。
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of survivors.slice(0, survivors.length - limit)) {
        try { fs.unlinkSync(entry.file); } catch {}
      }
    }
  } catch {}
}

/**
 * 合成一段语音并落盘，返回可直接交给发送链路的路径与元数据。
 *
 * provider:
 *   · 'breeze' —— 只走 BreezeBlue 云端（音色最像人，但要 API Key、按字计费）
 *   · 'edge'   —— 只试 Edge
 *   · 'sapi'   —— 只试 Windows 本地语音
 *   · 'auto'（默认）—— 先 Edge，失败自动回退 SAPI
 *   · 'breeze-first' —— 先 Breeze，失败回退 Edge → SAPI（云端挂了不至于没声音）
 *
 * `breeze` 参数是云端配置 { voiceId, apiKey?, baseUrl?, speed?, timeoutMs?, outputFormat? }，
 * 由 bridge 从 socialV2.voice.tts.breeze 传进来；没配就等同于没装。
 *
 * 结果按「provider + 音色 + 语速 + 文本」做内容哈希缓存（默认 2 小时），
 * 同一句话重复发不会反复打微软/Breeze 接口。缓存里只有音频，不保存聊天原文。
 *
 * cacheMaxFiles 是条数上限（LRU）。配合长 cacheTtlMs 使用时，常用句会长期留着、
 * 冷门句被挤掉，磁盘占用可控。0 = 不限条数。
 */
export async function synthesizeSpeech(input, {
  provider = 'auto',
  voice = '',
  sapiVoice = '',
  breeze = null,
  rate = 0,
  pitch = 0,
  style = '',
  styleDegree = 1.6,
  natural = true,
  humanize = true,
  outDir = null,
  maxChars = 300,
  timeoutMs = 15000,
  cacheTtlMs = 2 * 60 * 60 * 1000,
  cacheMaxFiles = 0
} = {}) {
  const text = humanize !== false
    ? humanizeSpeechText(input, { maxChars })
    : sanitizeSpeechText(input, { maxChars });
  if (!text) throw new Error('要合成的文字是空的（只有表情/链接的句子不适合转语音）');

  const dir = outDir || path.join(os.tmpdir(), 'qq-bridge-tts');
  fs.mkdirSync(dir, { recursive: true });
  const ttl = clampNumber(cacheTtlMs, 2 * 60 * 60 * 1000, 60 * 1000, 7 * 24 * 60 * 60 * 1000);
  const maxFiles = clampNumber(cacheMaxFiles, 0, 0, 200000);
  cleanupTtsDir(dir, ttl, maxFiles);

  const requested = String(provider || 'auto').toLowerCase();
  // breeze 没配置（没有 voiceId）时把它从链路里静默剔除，而不是让整条语音失败。
  const breezeVoice = String(breeze?.voiceId ?? '').trim();
  const breezeReady = Boolean(breezeVoice);
  const chain = (() => {
    if (requested === 'sapi') return ['sapi'];
    if (requested === 'edge') return ['edge'];
    if (requested === 'breeze') return ['breeze'];
    if (requested === 'breeze-first' || requested === 'breeze,edge,sapi') {
      return breezeReady ? ['breeze', 'edge', 'sapi'] : ['edge', 'sapi'];
    }
    // auto：保持历史行为（Edge 优先）。想用云端请显式写 breeze / breeze-first，
    // 避免升级后悄悄开始按字扣钱。
    return ['edge', 'sapi'];
  })();
  const ratePercent = clampNumber(rate, 0, -50, 100);
  const pitchHz = clampNumber(pitch, 0, -50, 50);
  const styleName = String(style ?? '').trim();
  const degree = Math.min(2, Math.max(0.01, Number(styleDegree) || 1.6));
  const speakVoiceOf = (kind) => (kind === 'breeze' ? breezeVoice : (kind === 'edge' ? (voice || DEFAULT_EDGE_VOICE) : (sapiVoice || 'sapi')));
  const digest = crypto.createHash('sha256')
    .update(`${speakVoiceOf(chain[0])}|${sapiVoice}|${ratePercent}|${pitchHz}|${styleName}|${degree}|${natural !== false ? 'n' : 'p'}|${text}`)
    .digest('hex').slice(0, 32);

  const failures = [];
  for (const kind of chain) {
    const ext = kind === 'sapi' ? 'wav' : 'mp3';
    const file = path.join(dir, `${kind}-${digest}.${ext}`);
    const cached = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < cacheTtlMs;
    if (cached) {
      const bytes = fs.statSync(file).size;
      // 命中时 touch 一次 mtime：这是 LRU 的依据。
      // 不 touch 的话淘汰会退化成「按创建时间」，常用的老句子会被冷门的新句子挤掉。
      try { fs.utimesSync(file, new Date(), new Date()); } catch {}
      return {
        file,
        bytes,
        duration: kind === 'sapi' ? wavDurationSeconds(fs.readFileSync(file)) : (bytes * 8) / EDGE_MP3_BITRATE,
        approxDuration: kind !== 'sapi',
        provider: kind,
        voice: speakVoiceOf(kind),
        style: kind === 'edge' ? styleName : '',
        natural: kind === 'edge' ? natural !== false : false,
        format: ext,
        text,
        credits: kind === 'breeze' ? estimateBreezeCredits(text) : 0,
        cached: true,
        warnings: failures.slice()
      };
    }
    try {
      const result = kind === 'breeze'
        ? await synthesizeBreeze(text, {
          voiceId: breezeVoice,
          apiKey: breeze?.apiKey,
          baseUrl: breeze?.baseUrl,
          speed: breeze?.speed,
          outputFormat: breeze?.outputFormat,
          timeoutMs: breeze?.timeoutMs ?? timeoutMs
        })
        : kind === 'edge'
          ? await synthesizeEdge(text, { voice: voice || DEFAULT_EDGE_VOICE, rate: ratePercent, pitch: pitchHz, style: styleName, styleDegree: degree, natural: natural !== false, timeoutMs })
          : await synthesizeSapi(text, {
            voice: sapiVoice,
            rate: Math.round(ratePercent / 10),
            timeoutMs,
            tmpDir: dir
          });
      fs.writeFileSync(file, result.buffer);
      const duration = kind === 'sapi' ? wavDurationSeconds(result.buffer) : (result.buffer.length * 8) / EDGE_MP3_BITRATE;
      return {
        file,
        bytes: result.buffer.length,
        duration,
        approxDuration: kind !== 'sapi',
        provider: kind,
        voice: result.voice,
        style: result.style ?? '',
        natural: result.natural ?? false,
        format: result.format,
        text,
        credits: kind === 'breeze' ? (result.credits ?? estimateBreezeCredits(text)) : 0,
        cached: false,
        warnings: failures.slice()
      };
    } catch (error) {
      failures.push(`${kind === 'breeze' ? 'BreezeBlue' : kind === 'edge' ? 'Edge' : 'SAPI'}：${error?.message ?? error}`);
      try { fs.unlinkSync(file); } catch {}
    }
  }
  throw new Error(`语音合成失败（${failures.join('；')}）`);
}
