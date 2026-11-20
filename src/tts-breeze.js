// BreezeBlue 云端 TTS 后端（可选 provider）。
//
// 为什么要单开一个文件而不是塞进 tts-core.js：
//   · 这是**唯一**一个需要外部账号 + 计费的服务，出问题时要能整块摘掉，
//     把 socialV2.voice.tts.provider 改回 auto 就完全回到 Edge/SAPI；
//   · 密钥读取逻辑只出现在这里，审计面最小。
//
// 接口（2026-10 官方文档 https://docs.breezeblue.ai/guides/text-to-speech）：
//   POST https://api.breeze.blue/v1/text-to-speech/{voice_id}?output_format=mp3
//   header: xi-api-key: <BREEZE_API_KEY>
//   body:   { "text": "...", "voice_settings": { "speed": 1.0 } }
//   返回：  直接是音频二进制（200），失败是 JSON 错误体。
//
// 计费口径：1 credit = 10 计费字符，中文汉字每字计 2 个字符。
// 所以这里**不自己猜**多少钱，只把字数和 credits 一起回传，方便上层记账/告警。
//
// 密钥来源（优先级从高到低）：
//   1. 环境变量 BREEZE_API_KEY（临时覆盖，适合换机/CI）
//   2. state/secrets/breeze.json 里的 { "apiKey": "..." }（state/ 已被 .gitignore 排除）
// 密钥不会出现在日志、错误信息或群消息里 —— 报错只报 HTTP 状态与前 200 字响应体，
// 而响应体本身不含密钥。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

export const BREEZE_BASE_URL = 'https://api.breeze.blue';
export const BREEZE_DEFAULT_OUTPUT = 'mp3';

/** 项目内约定的密钥文件位置（相对项目根）。 */
export function breezeSecretPath(root = PROJECT_ROOT) {
  return path.join(root, 'state', 'secrets', 'breeze.json');
}

/**
 * 读取密钥。找不到就返回空串，让上层决定是「明确报错」还是「静默回退 Edge」。
 * 读文件失败一律吞掉：密钥文件权限/编码问题不该让语音功能整个 500。
 */
export function readBreezeApiKey({ root = PROJECT_ROOT, env = process.env } = {}) {
  const fromEnv = String(env.BREEZE_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(breezeSecretPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.apiKey ?? parsed?.api_key ?? '').trim();
  } catch {
    return '';
  }
}

/** 是否存在可用密钥（给控制台显示「已配置 / 未配置」用，不返回密钥本身）。 */
export function breezeKeyStatus(opts = {}) {
  const key = readBreezeApiKey(opts);
  return { configured: Boolean(key), source: key ? (process.env.BREEZE_API_KEY ? 'env' : 'file') : 'none' };
}

/**
 * 粗略估算 credits：中文汉字按 2、其余字符按 1，再 /10 向上取整。
 * 只用于「这条大概花了多少」的展示，不是官方账单口径。
 */
export function estimateBreezeCredits(text) {
  const s = String(text ?? '');
  let units = 0;
  for (const ch of s) units += /[\u3400-\u9FFF\uF900-\uFAFF]/.test(ch) ? 2 : 1;
  return Math.max(1, Math.ceil(units / 10));
}

function clampTimeout(value, fallback = 15000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(60000, Math.max(3000, Math.round(n)));
}

/**
 * 合成一段语音，返回 { buffer, voice, format:'mp3', credits }。
 *
 * 注意返回的是 **mp3 原始字节**，落盘与时长计算交给 tts-core 的缓存层，
 * 这样 Breeze / Edge 走同一套「同句复用、2 小时后过期」的逻辑，不会重复扣钱。
 */
export async function synthesizeBreeze(text, {
  voiceId,
  apiKey = '',
  baseUrl = BREEZE_BASE_URL,
  outputFormat = BREEZE_DEFAULT_OUTPUT,
  speed = 1,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
  root = undefined
} = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('要合成的文字是空的');
  const voice = String(voiceId ?? '').trim();
  if (!voice) throw new Error('缺少 BreezeBlue voiceId（socialV2.voice.tts.breeze.voiceId）');
  if (!/^voc_[A-Za-z0-9]+$/.test(voice)) {
    // Voice ID 会被拼进 URL，先挡住路径穿越/查询串注入这类误用。
    throw new Error(`voiceId 格式不合法：${voice}（应形如 voc_u3nxkd5578wc）`);
  }
  const key = String(apiKey ?? '').trim() || readBreezeApiKey({ root });
  if (!key) {
    throw new Error('没有 BreezeBlue API Key（设置环境变量 BREEZE_API_KEY，或写入 state/secrets/breeze.json）');
  }
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有 fetch，无法调用 BreezeBlue');

  const budget = clampTimeout(timeoutMs);
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), budget);
  const url = `${String(baseUrl || BREEZE_BASE_URL).replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(outputFormat)}`;

  const requestBody = JSON.stringify({
    text: body,
    // speed 留 1.0：这里不叠二创，语速微调交给上层（tts-core 的 rate）在 SSML 侧做，
    // 云端只负责「音色本身」。想改就改 breeze.speed，别和 Edge 的 rate 混用。
    voice_settings: { speed: Number.isFinite(Number(speed)) ? Math.min(2, Math.max(0.5, Number(speed))) : 1 }
  });

  // 5xx / 502 这类是**上游推理集群整体不可用**（实测 2026-10-31 全站 502 持续数分钟），
  // 不是我们的请求有问题，也不计费。这种值得重试；4xx 里的鉴权/参数/额度类重试只会白等。
  // 退避：5xx 800ms → 1800ms；429 2000ms → 5000ms。最多 3 次；
  // 调用方（tts-core）外面还有 Edge→SAPI 兜底。
  // 429 里的 GENERATION_CAPACITY_EXCEEDED（推理容量暂时耗尽，官方原话 "try again shortly"）
  // 实测等几秒就能成功，所以和 5xx 一样重试；真正的额度用完会走 402，不会被这里拖着重试。
  // 2026-11-08 就是卡在这里：429 不重试 → 直接回退 Edge，用户听到的是朗读腔而不是 breeze 音色。
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  let res;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStart = Date.now();
    let networkRetry = false;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'content-type': 'application/json',
          accept: 'audio/mpeg, application/json'
        },
        body: requestBody,
        signal: controller.signal
      });
    } catch (error) {
      // 诊断用：把「连不上」和「连上了但服务报错」区分开。网络类失败（DNS/重置/超时）
      // 会带 error.cause.code，比如 ENOTFOUND / ECONNRESET / ETIMEDOUT / EAI_AGAIN，
      // 这几类的处理策略完全不同（前者要等或换路，后者重试即可）。
      const cause = error?.cause?.code || error?.cause?.message || '';
      const ms = Date.now() - attemptStart;
      const detail = `attempt ${attempt}/${MAX_ATTEMPTS} after ${ms}ms${cause ? ` cause=${cause}` : ''}`;
      if (process.env.TTS_DEBUG === '1') console.error('[breeze]', detail, error?.message ?? error);
      if (error?.name === 'AbortError') throw new Error(`BreezeBlue 合成超时（${budget}ms，${detail}）`);
      // 网络类失败（ECONNRESET / ETIMEDOUT / EAI_AGAIN / socket hang up …）是**偶发**的，
      // 以前这里第一次就 throw，整条链直接回退 Edge —— 实测 2026-11-09 就是这样丢了一条
      // breeze 语音。现在和 5xx 一样退避重试；只有非网络的编程错误才立即放弃。
      const netFail = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNABORTED|socket hang up|fetch failed/i
        .test(`${cause} ${error?.message ?? ''}`);
      lastError = `网络错误 ${cause || error?.message || error}`;
      if (!netFail || attempt === MAX_ATTEMPTS) {
        throw new Error(`BreezeBlue 连接失败（${detail}）：${error?.message ?? error}`);
      }
      networkRetry = true;
    } finally {
      // 注意：重试时不能在 finally 里清掉计时器——重挂 abort 计时器要等 finally 之后做，
      // 否则重试那一轮就没有超时保护了（曾经踩过）。
      clearTimeout(timer);
    }

    if (networkRetry) {
      await new Promise((r) => setTimeout(r, attempt === 1 ? 1200 : 2500));
      timer = setTimeout(() => controller.abort(), budget);
      continue;
    }

    if (res.ok || !RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
    // 读掉响应体再重试，避免连接池里挂着未消费的响应。
    lastError = res.status;
    try { await res.text(); } catch {}
    // 429 是容量排队，等太短等于白试；5xx 用原来的快速退避。
    const waitMs = res.status === 429
      ? (attempt === 1 ? 2000 : 5000)
      : (attempt === 1 ? 800 : 1800);
    await new Promise((r) => setTimeout(r, waitMs));
    // 上一轮的 AbortController 已经 clearTimeout，重试要重挂计时器，否则总耗时不受 budget 约束。
    timer = setTimeout(() => controller.abort(), budget);
  }
  clearTimeout(timer);
  if (!res) throw new Error(`BreezeBlue 请求失败${lastError ? `（最后一次状态 ${lastError}）` : ''}`);

  const contentType = String(res.headers?.get?.('content-type') ?? '');
  if (!res.ok) {
    // 只截 200 字：错误体有时带请求 id，但不会有密钥；日志里也不需要全文。
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    const hint = res.status === 401 ? '（API Key 无效或已过期）'
      : res.status === 429 ? '（云端推理容量暂时排满，通常几十秒内恢复；不是额度用完）'
        : res.status === 402 ? '（额度不足，检查 credits 与套餐）'
          : res.status === 404 ? '（voiceId 不存在，或该音色未保存到你的账号）' : '';
    throw new Error(`BreezeBlue 返回 ${res.status}${hint}：${detail}`);
  }
  if (contentType && !/audio|octet-stream/i.test(contentType)) {
    // 200 但给的是 JSON，通常是「参数被接受但没生成音频」这类软失败。
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    throw new Error(`BreezeBlue 没有返回音频（content-type=${contentType}）：${detail}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('BreezeBlue 返回了空音频');
  if (buffer[0] === 0x7b) {
    // 防御：极少数情况下 200 + JSON 且 content-type 缺省。
    throw new Error(`BreezeBlue 返回的像是 JSON 而非音频：${buffer.toString('utf8').slice(0, 200)}`);
  }

  return {
    buffer,
    voice,
    format: 'mp3',
    credits: estimateBreezeCredits(body)
  };
}
