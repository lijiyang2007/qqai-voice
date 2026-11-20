// 每日上下文清理（socialV2.dailyReset）的纯逻辑自测。
//
// 为什么从 bridge.js 里「抠」函数出来测，而不是 import：
// bridge.js 是单文件 16k 行的主程序，函数都在 main() 闭包里、还带着 MCP/DSH 的副作用，
// 没法直接 import。这里按源码文本抓取三个纯函数（只依赖 Date 和一个时间戳助手），
// 在 vm 里跑 —— 测的是**文件里真正的那份代码**，不是复制粘贴的副本。
//
// 运行：node scripts/test-daily-reset.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'bridge.js'), 'utf8');

/** 从源码里抓一个函数（按大括号配平，忽略字符串/模板里的括号足够用）。 */
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到 function ${name}`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} 的大括号没配平（起点 ${from}）`);
}

const code = [grab('dailyResetCutoff'), grab('dailyResetMsgTime'), grab('pruneConversationV2')].join('\n\n');
const ctx = vm.createContext({ Date, Number, Array, Object, String, Math, console });
vm.runInContext(code, ctx);
const { dailyResetCutoff, pruneConversationV2 } = ctx;

let failed = 0;
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
};

const day = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

// ── 保留窗口起点 ────────────────────────────────────────────────────────
// 5:00 跑、保留 2 天 → 起点是「昨天 00:00」，于是昨天和今天两天都在窗口里。
eq('keepDays=2 @05:00 → 昨天 00:00', dailyResetCutoff(2, day(2026, 11, 10, 5, 0)), day(2026, 11, 9, 0, 0));
// 保留 1 天 → 只留今天。
eq('keepDays=1 @05:00 → 今天 00:00', dailyResetCutoff(1, day(2026, 11, 10, 5, 0)), day(2026, 11, 10, 0, 0));
// 跨月：11/1 的「昨天」是 10/31。
eq('跨月 keepDays=2', dailyResetCutoff(2, day(2026, 11, 1, 5, 0)), day(2026, 10, 31, 0, 0));
// 跨年：1/1 的「昨天」是 12/31。
eq('跨年 keepDays=2', dailyResetCutoff(2, day(2027, 1, 1, 5, 0)), day(2026, 12, 31, 0, 0));
// 深夜跑（23:59）不能把「今天」算丢。
eq('keepDays=2 @23:59', dailyResetCutoff(2, day(2026, 11, 10, 23, 59)), day(2026, 11, 9, 0, 0));

// ── 裁剪：最近消息 / 未读 ────────────────────────────────────────────────
const cutoff = day(2026, 11, 9, 0, 0);
const mk = (t, extra = {}) => ({ seq: 0, time: t, text: String(t), ...extra });
const st = {
  recentMessages: [
    mk(day(2026, 11, 7, 10)), // 前天 → 裁
    mk(day(2026, 11, 8, 23, 59)), // 前天深夜 → 裁
    mk(day(2026, 11, 9, 0, 1)), // 昨天刚过 0 点 → 留
    mk(day(2026, 11, 10, 4, 59)), // 今天 → 留
    { seq: 9, text: 'no-time' } // 没有时间戳的脏数据 → 按最老处理，裁掉
  ],
  unread: [mk(day(2026, 11, 8, 12)), mk(day(2026, 11, 10, 3))],
  activeTopics: [
    { text: '旧话题', lastMentionAt: day(2026, 11, 7, 9) },
    { text: '新话题', lastMentionAt: day(2026, 11, 10, 1) },
    { text: '没时间戳', lastMentionAt: 0 } // 缺时间戳 → 保留（不敢删）
  ],
  pendingThoughts: [
    { text: '过期想法', createdAt: day(2026, 11, 6, 9) },
    { text: '新想法', createdAt: day(2026, 11, 10, 2) }
  ],
  memberImpressions: {
    老爸: { traits: ['x'], lastSeenAt: day(2026, 11, 10, 1) },
    老友: { traits: ['y'], lastSeenAt: day(2026, 11, 1, 1) },
    无记录: { traits: ['z'], lastSeenAt: 0 }
  }
};
const recentRef = st.recentMessages;
const unreadRef = st.unread;
const r = pruneConversationV2('private:10001', st, cutoff);

eq('recentMessages 保留 2 条', st.recentMessages.length, 2);
eq('recentMessages 内容', st.recentMessages.map((m) => m.time), [day(2026, 11, 9, 0, 1), day(2026, 11, 10, 4, 59)]);
// 原地裁剪：不能换成新数组（别处可能正握着同一个引用）
eq('recentMessages 是原地修改', st.recentMessages === recentRef, true);
eq('unread 是原地修改', st.unread === unreadRef, true);
eq('unread 保留 1 条', st.unread.length, 1);
eq('activeTopics 保留 2 条（新话题 + 无时间戳）', st.activeTopics.map((t) => t.text), ['新话题', '没时间戳']);
eq('pendingThoughts 保留 1 条', st.pendingThoughts.map((t) => t.text), ['新想法']);
// memberImpressions 是长期身份记忆（「这个人是爸爸」），不是每日上下文 ——
// 无论多久没见都必须原样保留。实测教训：第一版按 lastSeenAt 裁，一次删掉 9 条。
eq('memberImpressions 一条都不能少', Object.keys(st.memberImpressions).sort(), ['无记录', '老友', '老爸'].sort());
eq('统计：最近裁掉 3 条', r.recent, 3);
eq('统计：未读裁掉 1 条', r.unread, 1);
eq('统计：话题裁掉 1 条', r.topics, 1);
eq('统计：想说裁掉 1 条', r.thoughts, 1);
eq('统计：印象裁掉 0 个', r.impressions, 0);

// ── 幂等：同一份数据再跑一次什么都不该变 ──────────────────────────────
const snapshot = JSON.stringify(st);
const r2 = pruneConversationV2('private:10001', st, cutoff);
eq('第二次运行不改变数据', JSON.stringify(st), snapshot);
eq('第二次运行统计全为 0', [r2.recent, r2.unread, r2.topics, r2.thoughts, r2.impressions], [0, 0, 0, 0, 0]);

// ── 全是今天的消息：一条都不能少 ────────────────────────────────────────
const fresh = { recentMessages: [mk(day(2026, 11, 10, 1)), mk(day(2026, 11, 10, 2))], unread: [mk(day(2026, 11, 10, 2))] };
pruneConversationV2('group:20002', fresh, cutoff);
eq('今天的数据完整保留', [fresh.recentMessages.length, fresh.unread.length], [2, 1]);

// ── 空/残缺会话不能炸 ──────────────────────────────────────────────────
const weird = { recentMessages: null, unread: undefined, activeTopics: 'x', memberImpressions: null };
const r3 = pruneConversationV2('group:20003', weird, cutoff);
eq('残缺会话不抛错且统计为 0', [r3.recent, r3.unread, r3.topics, r3.thoughts, r3.impressions], [0, 0, 0, 0, 0]);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
