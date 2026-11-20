// mcp-image-pro.js —— 外接付费生图（OpenAI 兼容 /v1/images/generations）
//
// 为什么要单独一个 MCP：本地 ComfyUI（dsh-qwen-paint 的 draw_image）免费但能力有上限，
// 角色一致性/人脸/手部经常画不准。这里接一个付费模型，用「标记词」触发（见 QQ 预设第 19 条），
// 平时走本地、要精度时才花钱。
//
// 设计要点：
//   · provider 无关：只依赖 OpenAI 的 images/generations 形状（data[0].url 或 data[0].b64_json）。
//     换中转站/换模型只改 config，不改代码。
//   · 落盘到与本地出图**同一个目录**（桌面「千问1生图」），这样 qq_send_image 的目录白名单
//     不用改，两条链路共用一条发图通道。
//   · 有每日额度（默认 20 张），花的是主人的钱，不能给群友刷爆。
//   · API Key 只从 config / 环境变量读，绝不写进日志或返回值。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

let sdk = null;
try {
  // 与其它 MCP server 一致：用 @modelcontextprotocol/sdk
  sdk = require('@modelcontextprotocol/sdk/server/mcp.js');
} catch {
  sdk = null;
}
const { McpServer } = sdk ?? {};
const { z } = require('zod');

function readConfig() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function proCfg() {
  const c = readConfig();
  const p = c.imagePro ?? {};
  const apiKey = String(p.apiKey ?? process.env.IMAGE_PRO_API_KEY ?? '').trim();
  return {
    enabled: p.enabled !== false && apiKey !== '',
    baseUrl: String(p.baseUrl ?? 'https://vulcanapi.com/v1').replace(/\/+$/, ''),
    apiKey,
    model: String(p.model ?? 'gpt-image-1'),
    // quality：gpt-image 系列的关键开关。实测（2026-11-01 vulcanapi）：
    //   low = 63 秒出图；不传/medium/high 会超过 5 分钟被 nginx 504 掐断。
    // 所以默认 low，想要更精细再调 medium（但要接受可能超时）。
    quality: String(p.quality ?? 'low'),
    size: String(p.size ?? '1024x1024'),
    outputDir: String(p.outputDir ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Desktop', '千问1生图')),
    maxPerDay: Number.isFinite(Number(p.maxPerDay)) ? Number(p.maxPerDay) : 20,
    timeoutMs: Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 180000,
    stateFile: p.stateFile ? String(p.stateFile) : path.join(ROOT, 'state', 'image-pro-usage.json')
  };
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readUsage(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j?.day === todayKey()) return j;
  } catch {}
  return { day: todayKey(), count: 0 };
}

function bumpUsage(file) {
  const u = readUsage(file);
  u.count += 1;
  u.day = todayKey();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(u));
  } catch {}
  return u;
}

function safeStem(prompt, max = 28) {
  const cleaned = String(prompt ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned.slice(0, max) || 'image').trim();
}

function uniquePath(dir, stem, ext) {
  let p = path.join(dir, `${stem}_${ext === 'png' ? 'PRO' : ext.toUpperCase()}_01.${ext}`);
  let i = 1;
  while (fs.existsSync(p)) {
    i += 1;
    p = path.join(dir, `${stem}_${ext === 'png' ? 'PRO' : ext.toUpperCase()}_${String(i).padStart(2, '0')}.${ext}`);
  }
  return p;
}

if (!McpServer) {
  console.error('[image-pro] 缺少 @modelcontextprotocol/sdk，无法启动');
  process.exit(1);
}

const server = new McpServer({ name: 'image-pro', version: '1.0.0' });

server.tool(
  'draw_image_pro',
  '用【外接付费模型】出图（比本机 ComfyUI 的 draw_image 更准、更快，但要花钱）。只在 qq 预设里被标记词触发：群友说「精画/精细/高清版/pro」时用这个，普通「画一张」仍然用免费的 draw_image。调用后返回成品绝对路径，必须再发出去才能让对方看到：发到当前会话用 mcp__snowluma__qq_send_image；发到**别的**会话（群/别人）用 mcp__snowluma__qq_relay_send 的 imagePath（qq_send_image 跨会话必报 403）。',
  {
    prompt: z.string().describe('画面描述（中文可以）。写得越具体越好：主体 + 外观 + 环境 + 光线 + 风格'),
    size: z.string().optional().describe('尺寸，如 1024x1024 / 1536x1024 / 1024x1536，默认 1024x1024'),
    model: z.string().optional().describe('可选：覆盖默认模型名（一般不用填）')
  },
  async ({ prompt, size, model }) => {
    const cfg = proCfg();
    const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

    if (!cfg.apiKey) return fail('外接生图未配置：config.json 的 imagePro.apiKey 为空（或未设 IMAGE_PRO_API_KEY）。请让管理员开通后再试，或改用免费的 draw_image。');
    if (!cfg.enabled) return fail('外接生图已关闭（config.json 的 imagePro.enabled = false），请改用免费的 draw_image。');

    const usage = readUsage(cfg.stateFile);
    if (cfg.maxPerDay > 0 && usage.count >= cfg.maxPerDay) {
      return fail(`今天的付费出图额度用完了（${usage.count}/${cfg.maxPerDay} 张）。这是花主人钱的功能，明天再来，或者改用免费的 draw_image。`);
    }

    // ── 自动追加「别自己加字」的兜底（2026-11-01，主人反馈） ────────────────
    //
    // 为什么需要：gpt-image 的 high 档为了让画面「显得专业」，会自作主张往图里塞
    // 品牌字、英文清单、水印式 logo（实测画面里出现了 "Saurabh AI" 和一堆卖课文案）。
    // 用户没要文字，那就是脏东西。这里在提示词尾部统一加一段约束。
    //
    // 但如果用户**明确要文字**（提示词里出现「写」「文字」「标题」「logo」「海报」
    // 「字」等），就不要再加这段 —— 否则会把正常需求也压掉。
    const wantsText = /写|文字|标题|标语|口号|logo|LOGO|海报|字幕|签名|字体|题字|文案|字样|写上|带字/.test(String(prompt ?? ''));
    const noTextSuffix = cfg.suppressText === false || wantsText
      ? ''
      : '。画面中不要出现任何文字、字母、数字、水印、logo 或签名，不要添加未要求的标语和清单文案';
    const finalPrompt = `${prompt}${noTextSuffix}`;

    const useModel = String(model ?? cfg.model);
    const useSize = String(size ?? cfg.size);
    const t0 = Date.now();

    // 上游 503（image_upstream_cooling_down）是"排队冷却"，会在 Retry-After 后恢复，
    // 而且明确说"本次未提交生成任务"= 不扣钱，所以这里值得自动重试一次。
    // 504（nginx 超时）则说明画到一半被掐，重试也没意义，直接如实报错。
    let resp;
    let attempt = 0;
    const maxAttempts = 2;
    for (;;) {
      attempt += 1;
      try {
        resp = await fetch(`${cfg.baseUrl}/images/generations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model: useModel, prompt: finalPrompt, n: 1, size: useSize, quality: cfg.quality }),
          signal: AbortSignal.timeout(cfg.timeoutMs)
        });
      } catch (error) {
        if (attempt < maxAttempts) continue;
        return fail(`请求外接生图失败：${error?.message ?? error}（已重试 ${attempt} 次）`);
      }
      if (resp.status === 503 && attempt < maxAttempts) {
        const ra = Number(resp.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 15000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }

    const text = await resp.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!resp.ok) {
      const msg = json?.error?.message ?? text.slice(0, 300) ?? `HTTP ${resp.status}`;
      return fail(`外接生图被拒绝（HTTP ${resp.status}）：${msg}`);
    }

    const item = json?.data?.[0];
    if (!item) return fail(`外接生图返回异常：${text.slice(0, 300)}`);

    let buf = null;
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      try {
        const r = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
        if (!r.ok) return fail(`下载生成图失败：HTTP ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
      } catch (error) {
        return fail(`下载生成图失败：${error?.message ?? error}`);
      }
    } else {
      return fail(`外接生图返回里既没有 url 也没有 b64_json：${text.slice(0, 200)}`);
    }

    fs.mkdirSync(cfg.outputDir, { recursive: true });
    const dest = uniquePath(cfg.outputDir, safeStem(prompt), 'png');
    fs.writeFileSync(dest, buf);
    const u = bumpUsage(cfg.stateFile);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);

    return {
      content: [
        {
          type: 'text',
          text: `付费出图完成（${useModel}，${seconds} 秒，${Math.round(buf.length / 1024)}KB）\n今日用量 ${u.count}/${cfg.maxPerDay}\n图片绝对路径：${dest}\n下一步：发到**当前会话**用 mcp__snowluma__qq_send_image；如果管理员要你发给**别的**会话（群或别人），改调 mcp__snowluma__qq_relay_send 并把这个路径放进 imagePath，不要用 qq_send_image（跨会话必报 403）。`
        }
      ]
    };
  }
);

// ── paint_status：画图前先看排队情况（2026-11-02 主人要求）──────────────────
//
// 场景：两个人几乎同时要画图。第一个占用 GPU 跑 70~100 秒，第二个的请求会在
// ComfyUI 队列里排队，而它自己完全不知道——表现就是「我明明说了画，它半天不理我」。
// 这个工具让模型在动手前先问一句「现在忙不忙」，忙就如实告诉对方要等多久，
// 并给一个不排队的备选（精画/付费档），别让人白等。
//
// 顺带报今日付费额度，这样模型能判断「要不要提议走付费」。
server.tool(
  'paint_status',
  '【画图前必须先调用这个，别跳过】查当前画图忙不忙：本机 ComfyUI 有没有任务在跑/排队、预计还要等多久、今天付费额度还剩多少。' +
  '为什么要先查：这台机器一次只能画一张（一张约 70~100 秒）。如果前面已经有人在画，你不查就开画，对方会干等好几分钟还不知道为什么——这是我们明确要避免的。' +
  '调用时机：每一次要出图之前（draw_image 或 draw_image_pro 之前），**先调这个**，然后把结果用一句话告诉对方。' +
  '结果怎么用：① busy=true → 必须告诉对方“前面还有人正在画，大概要等 N 分钟”；如果等待超过 3 分钟且付费额度还有，可以问一句要不要走精画（付费、不排队）；② busy=false → 正常说一句就开始画，不用报等待时间；③ 本机离线 → 说一句“后端没开，我先拉起来，约 30 秒”。' +
  '这个工具很轻（不到 1 秒），不算浪费。',
  {},
  async () => {
    const cfg = proCfg();
    const usage = readUsage(cfg.stateFile);
    const remain = cfg.maxPerDay > 0 ? Math.max(0, cfg.maxPerDay - usage.count) : -1;

    // 本机 ComfyUI 的队列（离线 = 需要先拉起，约 30 秒）
    let online = false;
    let running = 0;
    let pending = 0;
    let note = '';
    try {
      const q = await fetch('http://127.0.0.1:8188/queue', { signal: AbortSignal.timeout(4000) });
      if (q.ok) {
        const qj = await q.json();
        online = true;
        running = Array.isArray(qj.queue_running) ? qj.queue_running.length : 0;
        pending = Array.isArray(qj.queue_pending) ? qj.queue_pending.length : 0;
      }
    } catch {
      note = '本机 ComfyUI 当前离线，第一次画要先花约 30 秒把后端拉起来。';
    }

    // 单张约 70~100 秒（RTX 4060 8G 实测）；排队 ETA 按 90 秒/张估
    const PER_IMAGE_SEC = 90;
    const aheadCount = running + pending;
    const etaSec = aheadCount * PER_IMAGE_SEC;

    const busy = aheadCount > 0;
    const lines = [];
    lines.push(`本机状态：${online ? '在线' : '离线'}`);
    if (online) {
      lines.push(`正在画：${running} 个；排队中：${pending} 个`);
      lines.push(busy ? `预计还要等约 ${Math.max(1, Math.round(etaSec / 60))} 分钟才轮到新的请求` : '现在空闲，可以马上开画（约 1~2 分钟出图）');
    } else {
      lines.push('后端没启动，画的时候会自动拉起（+约 30 秒）');
    }
    if (note) lines.push(note);
    lines.push(`付费档额度：${cfg.maxPerDay > 0 ? `今日已用 ${usage.count}/${cfg.maxPerDay}，还剩 ${remain} 张` : '不限量'}（模型 ${cfg.model}，质量 ${cfg.quality}，约 40~50 秒，不占本机 GPU）`);
    lines.push('');
    lines.push(`结论：busy=${busy}` + (busy ? `，建议先跟对方说明要等约 ${Math.max(1, Math.round(etaSec / 60))} 分钟${remain !== 0 ? '，或者问要不要用精画（付费、不排队）' : ''}` : '，可以直接开画'));

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

const transport = new (require('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport)();
await server.connect(transport);
console.error('[image-pro] ready');
