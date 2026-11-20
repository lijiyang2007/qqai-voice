#!/usr/bin/env node
// 把本地表情包文件夹批量导入 QQ 收藏表情（走 SnowLuma 的 add_custom_face），
// 并顺手写一句备注（默认用文件名），最后触发桥接重新同步本地表情库。
//
// 用法（在 qq-bridge 目录下）：
//   node scripts/import-stickers.mjs <目录> --dry-run      # 先看会导入哪些、跳过哪些
//   node scripts/import-stickers.mjs <目录>                # 真导（每张间隔 ~1.2s）
//   node scripts/import-stickers.mjs <目录> --limit 30     # 只导前 30 张
//   node scripts/import-stickers.mjs <目录> --no-remark    # 不写备注
//   node scripts/import-stickers.mjs <目录> --recursive    # 连子目录一起扫
//
// 为什么不做成桥接 HTTP 接口：导入是一次性运维动作，走 CLI 不需要常驻攻击面；
// 而且它能直接复用桥接的 config.json 与 state/stickers.json 做去重。
//
// 安全边界：只读本地图片文件；请求只发往 config.json 里的 snowluma.httpUrl，
// 不跟随任何消息里的 URL（与桥接自身的 SSRF 约束保持一致）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STICKER_FILE = path.join(ROOT, 'state', 'stickers.json');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;   // QQ 自定义表情的实际上限附近，超过直接跳过
const MAX_REMARK_CHARS = 20;
const GAP_MS = 1200;

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags.set(k, v);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(k, argv[++i]);
      else flags.set(k, true);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const has = (k) => flags.has(k);
const num = (k, d) => {
  if (!flags.has(k)) return d;
  const n = Number(flags.get(k));
  return Number.isFinite(n) ? n : d;
};

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

const dir = positional[0];
if (!dir) {
  console.log('用法：node scripts/import-stickers.mjs <目录> [--limit N] [--dry-run] [--no-remark] [--recursive]');
  process.exit(1);
}
const absDir = path.resolve(process.cwd(), dir);
if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) fail(`目录不存在：${absDir}`);

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const baseUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const accessToken = String(cfg.snowluma?.accessToken || '');
const headers = { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) };

// 已知 md5：QQ 端收藏的 md5 + 本地库里 AI 记下的 md5，避免重复导入同一张图。
const knownMd5 = new Set();
try {
  const entries = JSON.parse(fs.readFileSync(STICKER_FILE, 'utf8'));
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e?.md5) knownMd5.add(String(e.md5).toUpperCase());
  }
} catch { /* 库不存在/损坏时不做去重，导入后再同步会补上 */ }

function walk(directory, recursive, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) walk(full, recursive, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
    out.push(full);
  }
  return out;
}

function remarkFor(file) {
  const raw = path.basename(file, path.extname(file)).replace(/[\r\n\t]+/g, ' ').trim();
  return raw.slice(0, MAX_REMARK_CHARS);
}

async function onebot(action, params) {
  const res = await fetch(`${baseUrl}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`${action} 失败: ${body.wording || body.retcode || res.status}`);
  }
  return body.data ?? {};
}

const dryRun = has('dry-run');
const recursive = has('recursive');
const noRemark = has('no-remark');
const limit = Math.max(0, Math.floor(num('limit', Infinity)));

const files = walk(absDir, recursive);
if (!files.length) fail(`目录里没有图片：${absDir}`);

// 先按大小/md5 预筛，再按文件名排序，保证同一批的导入顺序可复现。
const seen = new Set();
const picked = [];
const skipped = [];
for (const file of files.sort((a, b) => a.localeCompare(b))) {
  let stat;
  try { stat = fs.statSync(file); } catch { skipped.push([file, '读不到']); continue; }
  if (stat.size === 0) { skipped.push([file, '空文件']); continue; }
  if (stat.size > MAX_FILE_BYTES) { skipped.push([file, `超过 ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB`]); continue; }
  const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').toUpperCase();
  if (seen.has(md5) || knownMd5.has(md5)) { skipped.push([file, '重复（md5 已存在）']); continue; }
  seen.add(md5);
  if (picked.length >= limit) { skipped.push([file, `超过 --limit ${limit}`]); continue; }
  picked.push({ file, md5, size: stat.size });
}

console.log(`\n目录：${absDir}`);
console.log(`图片 ${files.length} 个，待导入 ${picked.length} 个，跳过 ${skipped.length} 个${dryRun ? '（dry-run，不会真的导入）' : ''}\n`);
for (const p of picked) {
  const name = path.basename(p.file);
  const remark = noRemark ? '' : remarkFor(p.file);
  console.log(`  + ${name}  ${(p.size / 1024).toFixed(0)}KB${remark ? `  备注：${remark}` : ''}`);
}
for (const [file, why] of skipped.slice(0, 20)) {
  console.log(`  - ${path.basename(file)}  （${why}）`);
}
if (skipped.length > 20) console.log(`  - …另有 ${skipped.length - 20} 个被跳过`);

if (dryRun || !picked.length) {
  console.log(dryRun ? '\n确认没问题后去掉 --dry-run 再跑一次。\n' : '\n没有需要导入的图片。\n');
  process.exit(0);
}

// 先探一下网关，避免导到一半才发现没登录。
try {
  await onebot('get_login_info', {});
} catch (error) {
  fail(`SnowLuma 网关不可用（${baseUrl}）：${error?.message ?? error}`);
}

let okCount = 0;
const failed = [];
for (const [index, item] of picked.entries()) {
  const tag = `[${index + 1}/${picked.length}] ${path.basename(item.file)}`;
  try {
    const base64 = fs.readFileSync(item.file).toString('base64');
    const data = await onebot('add_custom_face', { file: `base64://${base64}` });
    const emojiId = String(data.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    if (!noRemark) {
      const remark = remarkFor(item.file);
      if (remark) {
        try {
          await onebot('modify_custom_face', { emoji_id: emojiId, desc: remark });
        } catch (error) {
          console.log(`  ⚠️ ${tag} 导入成功但备注失败：${error?.message ?? error}`);
        }
      }
    }
    okCount += 1;
    console.log(`  ✅ ${tag}`);
  } catch (error) {
    failed.push([item.file, String(error?.message ?? error)]);
    console.log(`  ❌ ${tag} ${error?.message ?? error}`);
  }
  if (index < picked.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
}

// 让桥接立刻重建本地表情库（AI 下一轮就能看到新图）；桥接没开也不影响导入本身。
if (okCount > 0) {
  const consolePort = Number(cfg.consolePort) || 3100;
  const consoleToken = String(cfg.consoleToken || '');
  try {
    const res = await fetch(`http://127.0.0.1:${consolePort}/api/stickers/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      body: '{}',
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    if (body?.ok) console.log(`\n已让桥接重新同步：QQ 收藏表情共 ${body.total} 个。`);
    else console.log(`\n⚠️ 桥接同步未成功（${res.status}），可稍后在控制台点一次同步。`);
  } catch {
    console.log('\n⚠️ 桥接没在运行，先启动桥接，下次同步时新表情会自动进来。');
  }
}

console.log(`\n完成：导入 ${okCount} 个，失败 ${failed.length} 个。`);
if (failed.length) {
  for (const [file, why] of failed) console.log(`  - ${path.basename(file)}：${why}`);
  process.exit(1);
}
