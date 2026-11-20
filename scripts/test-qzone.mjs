// QQ 空间说说（发动态）回归：2026-10-27 新增。
//
// 覆盖四层：
//   1. 工具面：MCP 注册 qq_send_qzone、受 tools.sendQzone 开关控制、走桥接端点；
//   2. 桥接闸门：令牌/白名单/模式/暂停/静默/工具开关/内容审计/字数与频率上限；
//   3. 网关调用：真的用 bot.raw('send_qzone_msg') 发，可见范围只允许 friends/private；
//   4. 配置与文档：config.example 默认值、控制台开关、qq-chat-v2 人设里的使用边界。
//
// 不向真实 QQ / QQ 空间发送任何内容：bot.raw 由 audit-bridge-harness 的 FakeBot 记录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'group:456';
let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

async function withBridge(run, config = {}, globals = {}) {
  const h = await bridgeHarness({
    config: {
      ...config,
      socialV2: {
        sticker: { enabled: false },
        proactive: { enabled: false },
        qzone: { minIntervalMs: 0, maxPerDay: 0 },
        ...config.socialV2
      }
    },
    globals
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { token = st.agentToken, consoleToken = 'fixture-console-token', key = KEY, body = {} } = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ key, ...body });
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (token) headers['x-agent-token'] = token;
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: route.startsWith('/') ? route : `/api/socialV2/${route}`,
      method: 'POST',
      headers
    }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(payload);
  });
  try { await run({ h, st, request }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

const postQzone = (request, body, opts = {}) => request('send-qzone', { body, ...opts });
const getFeed = (request, body = {}, opts = {}) => request('qzone-feed', { body, ...opts });
const commentQzone = (request, body, opts = {}) => request('comment-qzone', { body, ...opts });
const likeQzone = (request, body, opts = {}) => request('like-qzone', { body, ...opts });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 1. 正常发布 ────────────────────────────────────────────────────────────
await test('发说说走 OneBot send_qzone_msg，默认好友可见并返回 tid', async () => {
  await withBridge(async ({ h, request }) => {
    const out = await postQzone(request, { content: '今天的风有点甜。' });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.ok, true);
    assert.equal(out.data.tid, 'fixture-qzone-tid');
    assert.equal(out.data.visibility, 'friends');
    const call = h.calls.raw.find((c) => c.action === 'send_qzone_msg');
    assert.ok(call, '必须调用 send_qzone_msg');
    assert.equal(call.params.content, '今天的风有点甜。');
    assert.equal(call.params.ugc_right, 4);
    assert.equal(h.socialV2.qzoneTimes.length, 1, '成功后要记一次额度');
  });
});

await test('ugcRight=private 映射为仅自己可见（ugc_right=64）', async () => {
  await withBridge(async ({ h, request }) => {
    const out = await postQzone(request, { content: '自己偷偷记一笔。', ugcRight: 'private' });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.visibility, 'private');
    const call = h.calls.raw.find((c) => c.action === 'send_qzone_msg');
    assert.equal(call.params.ugc_right, 64);
  });
});

await test('多行正文保留换行，但去掉控制字符与首尾空白', async () => {
  await withBridge(async ({ h, request }) => {
    const out = await postQzone(request, { content: '\u0000 第一行\r\n第二行\u0007 \n ' });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    const call = h.calls.raw.find((c) => c.action === 'send_qzone_msg');
    assert.equal(call.params.content, '第一行\n第二行');
  });
});

// ── 2. 鉴权与工具开关 ──────────────────────────────────────────────────────
await test('令牌错 / 没令牌 / 非白名单群 都必须拒绝，且不会调用网关', async () => {
  await withBridge(async ({ h, st, request }) => {
    const bad = await postQzone(request, { content: '测试' }, { token: 'deadbeef' });
    assert.equal(bad.status, 403, JSON.stringify(bad.data));
    const none = await postQzone(request, { content: '测试' }, { token: '' });
    assert.equal(none.status, 403, JSON.stringify(none.data));
    const otherGroup = await postQzone(request, { content: '测试' }, { key: 'group:999999', token: st.agentToken });
    assert.equal(otherGroup.status, 403, JSON.stringify(otherGroup.data));
    assert.equal(h.calls.raw.length, 0, '被拒绝的请求不得触达 OneBot');
  });
});

await test('tools.sendQzone=false 时端点拒绝', async () => {
  await withBridge(async ({ h, request }) => {
    const out = await postQzone(request, { content: '测试' });
    assert.equal(out.status, 403);
    assert.match(out.data.error, /qq_send_qzone/);
    assert.equal(h.calls.raw.length, 0);
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, tools: { sendQzone: false } } });
});

await test('非 reserved2 模式拒绝', async () => {
  const h = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0 } } } });
  h.setMode('chat');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const out = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ key: KEY, content: '测试' });
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: '/api/socialV2/send-qzone', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken }
      }, (res) => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
      });
      req.on('error', reject); req.end(payload);
    });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.equal(h.calls.raw.length, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

// ── 3. 内容与频率边界 ──────────────────────────────────────────────────────
await test('空内容 / 含 CQ 码 / 超长 / 非法可见范围 全部拒绝', async () => {
  await withBridge(async ({ h, request }) => {
    const cases = [
      { body: { content: '   ' }, status: 400 },
      { body: { content: 'hi [CQ:at,qq=1]' }, status: 400 },
      { body: { content: 'x'.repeat(1001) }, status: 400 },
      { body: { content: '测试', ugcRight: 'public' }, status: 400 },
    ];
    for (const { body, status } of cases) {
      const out = await postQzone(request, body);
      assert.equal(out.status, status, `${JSON.stringify(body).slice(0, 80)} → ${out.status}: ${JSON.stringify(out.data)}`);
    }
    assert.equal(h.calls.raw.length, 0, '校验失败不得触达 OneBot');
  });
});

await test('敏感信息（本机路径/凭据）整条拒绝', async () => {
  await withBridge(async ({ h, request }) => {
    const out = await postQzone(request, { content: '刚刚看了 C:\\Users\\someone\\secret.txt' });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.match(out.data.error, /敏感信息/);
    assert.equal(h.calls.raw.length, 0);
  });
});

await test('最小间隔与每日上限生效（429），且失败不占用额度', async () => {
  await withBridge(async ({ h, request }) => {
    const first = await postQzone(request, { content: '第一条' });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await postQzone(request, { content: '第二条' });
    assert.equal(second.status, 429, JSON.stringify(second.data));
    assert.match(second.data.error, /再等/);
    assert.equal(h.calls.raw.length, 1, '被限流的请求不得触达 OneBot');
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 10 * 60 * 1000, maxPerDay: 0 } } });

  await withBridge(async ({ h, request }) => {
    for (const text of ['一', '二']) {
      const out = await postQzone(request, { content: text });
      assert.equal(out.status, 200, JSON.stringify(out.data));
    }
    const third = await postQzone(request, { content: '三' });
    assert.equal(third.status, 429, JSON.stringify(third.data));
    assert.match(third.data.error, /24 小时内最多发 2 条/);
    assert.equal(h.calls.raw.length, 2);
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 2 } } });
});

await test('网关失败时回滚额度并返回错误', async () => {
  await withBridge(async ({ h, request }) => {
    // harness 暴露的 bot 就是桥接实际使用的实例：直接替换 raw 让网关调用失败。
    h.bot.raw = async () => { throw new Error('qzone fixture failure'); };
    const out = await postQzone(request, { content: '会失败的一条' });
    assert.equal(out.status, 500, JSON.stringify(out.data));
    assert.match(out.data.error, /qzone fixture failure/);
    assert.equal(h.socialV2.qzoneTimes.length, 0, '失败必须回滚已占用的额度');
    assert.equal(h.calls.raw.length, 0);
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0 } } });
});

// ── 4. 主动发动态机会（低频，AI 自己决定发不发） ──────────────────────────
await test('qzoneProactiveCfg 收敛非法配置，默认 24~48 小时', async () => {
  const h = await bridgeHarness({
    config: { socialV2: { qzone: { proactive: { enabled: true, minIntervalMs: 1000, maxIntervalMs: 2000, probability: 2, quietMs: -5 } } } }
  });
  try {
    const p = h.qzoneProactiveCfg();
    assert.equal(p.enabled, true);
    assert.ok(p.minIntervalMs >= 60 * 1000, `min 至少 1 分钟：${p.minIntervalMs}`);
    assert.ok(p.maxIntervalMs >= p.minIntervalMs, 'max 不能小于 min');
    assert.equal(p.probability, 1, '概率收敛到 1');
    assert.equal(p.quietMs, 30 * 60 * 1000, '非法负数安静阈值回退默认 30 分钟');
  } finally { await h.close(); }
});

await test('主动机会按 24~48 小时窗口排期，并能被取消', async () => {
  await withBridge(async ({ h }) => {
    h.getSocialV2State(KEY);
    const now = Date.now();
    h.scheduleQzoneProactiveCheck();
    assert.ok(h.socialV2.qzoneNextCheckAt > now + 59 * 60 * 1000, '下一次至少在一小时后');
    assert.ok(h.socialV2.qzoneNextCheckAt <= now + 121 * 60 * 1000, '下一次不超过两小时');
    assert.ok(h.socialV2.qzoneProactiveTimer, '应安排定时器');
    h.clearQzoneProactiveTimer();
    assert.equal(h.socialV2.qzoneProactiveTimer, null, '取消后定时器为空');
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, proactive: { enabled: true, minIntervalMs: 3600000, maxIntervalMs: 7200000, probability: 1, quietMs: 0 } } } });
});

await test('夜间窗口外只顺延，不在半夜唤醒', async () => {
  const nowHour = new Date().getHours();
  const start = (nowHour + 2) % 24;
  const end = (start + 1) % 24;
  const h = await bridgeHarness({
    config: {
      socialV2: {
        qzone: {
          proactive: {
            enabled: true, minIntervalMs: 3600000, maxIntervalMs: 7200000,
            probability: 1, quietMs: 0,
            activeStartHour: start, activeEndHour: end
          }
        }
      }
    }
  });
  try {
    const delay = h.msUntilQzoneActiveWindow(h.qzoneProactiveCfg());
    assert.ok(delay > 30 * 60 * 1000, `应顺延到下一个允许时段，实际 ${Math.round(delay / 60000)} 分钟`);
  } finally { await h.close(); }
});

await test('发动态机会的唤醒提示明确写着「不是任务、可以不发」', async () => {
  await withBridge(async ({ h }) => {
    const prompt = h.buildWakePromptV2(KEY, 'qzoneCheck');
    for (const text of ['【发动态机会】', 'qq_send_qzone', '不是任务', '不要硬发', '发不发都由你决定']) {
      assert.ok(prompt.includes(text), `唤醒提示缺少：${text}`);
    }
  });
});

await test('到点且会话空闲时，真的投递一条「发动态机会」唤醒', async () => {
  await withBridge(async ({ h }) => {
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = 0;
    h.clearQzoneProactiveTimer();
    h.runQzoneProactiveCheck();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const delivered = h.calls.prompts.at(-1);
    assert.ok(delivered, '应当投递一次唤醒');
    const text = (delivered.content || []).map((c) => c.text || '').join('');
    assert.match(text, /【发动态机会】/, '投递的 prompt 必须是发动态机会');
    assert.match(text, /qq_send_qzone/, '必须告诉模型用哪个工具');
    assert.ok(h.socialV2.qzoneNextCheckAt > Date.now(), '触发后必须排下一次');
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, proactive: { enabled: true, minIntervalMs: 3600000, maxIntervalMs: 7200000, probability: 1, quietMs: 0, activeStartHour: 0, activeEndHour: 24 } } } });
});

// ── 4b. 好友空间：看动态 / 评论 / 点赞（2026-10-27 新增） ──────────────────
await test('好友动态只返回白名单好友，并缓存 tid/uin 供互动', async () => {
  await withBridge(async ({ h, request }) => {
    const out = await getFeed(request, { limit: 10 });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.count, 3, '只应返回白名单好友（123）的三条说说');
    assert.deepEqual(out.data.posts.map((p) => p.uin), ['123', '123', '123']);
    assert.deepEqual(out.data.posts.map((p) => p.tid), ['fixture-feed-tid-1', 'fixture-feed-tid-2', 'fixture-feed-tid-3']);
    assert.match(out.data.posts[0].content, /爬山/);
    assert.ok(out.data.posts[0].timeText);
    assert.equal(h.socialV2.qzoneFeedSeen.has('fixture-feed-tid-1'), true);
    assert.equal(h.socialV2.qzoneFeedSeen.has('fixture-feed-tid-999'), false, '陌生人的动态不得进缓存/可评名单');
    const call = h.calls.raw.find((c) => c.action === 'get_qzone_feeds');
    assert.ok(call, '必须调用 OneBot get_qzone_feeds');
    assert.equal(call.params.page_num, 1);
  });
});

await test('全局好友动态为空时，逐个好友读空间补位（且跳过仅自己可见）', async () => {
  await withBridge(async ({ h, request }) => {
    const now = Math.floor(Date.now() / 1000);
    h.bot.raw = async (action, params = {}) => {
      h.calls.raw.push({ action, params });
      if (action === 'get_qzone_feeds') return { feeds: [], has_more: true, next_cursor: null };
      if (action === 'get_qzone_msg_list') {
        if (String(params.target_uin) === '123') {
          return {
            total: 2,
            msglist: [
              { tid: 'fixture-friend-tid-1', content: '朋友的说说一', time: now - 600, comment_num: 0, is_private: false, images: [] },
              { tid: 'fixture-friend-tid-2', content: '这条仅自己可见', time: now - 900, comment_num: 0, is_private: true, images: [] }
            ]
          };
        }
        return { total: 0, msglist: [] };
      }
      if (action === 'comment_qzone') return { comment_id: 'fixture-friend-comment-id' };
      return {};
    };
    const out = await getFeed(request, { limit: 10 });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.count, 1, '只应返回公开说说，跳过仅自己可见');
    assert.equal(out.data.posts[0].tid, 'fixture-friend-tid-1');
    assert.equal(out.data.posts[0].uin, '123');
    assert.match(out.data.posts[0].content, /朋友的说说一/);
    const scan = h.calls.raw.find((c) => c.action === 'get_qzone_msg_list');
    assert.ok(scan, '全局 feed 为空时必须逐个好友读');
    assert.equal(scan.params.target_uin, 123);
    const comment = await commentQzone(request, { tid: 'fixture-friend-tid-1', targetUin: '123', content: '接一句' });
    assert.equal(comment.status, 200, JSON.stringify(comment.data));
    const call = h.calls.raw.find((c) => c.action === 'comment_qzone');
    assert.equal(call.params.tid, 'fixture-friend-tid-1');
    assert.equal(call.params.target_uin, 123);
  });
});

await test('评论好友动态走 comment_qzone，并记录额度、tid 去重', async () => {
  await withBridge(async ({ h, request }) => {
    const feed = await getFeed(request);
    assert.equal(feed.status, 200, JSON.stringify(feed.data));
    const out = await commentQzone(request, { tid: 'fixture-feed-tid-1', targetUin: '123', content: '山顶风大，别被吹跑了' });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.ok, true);
    assert.equal(out.data.commentId, 'fixture-comment-id');
    const call = h.calls.raw.find((c) => c.action === 'comment_qzone');
    assert.ok(call, '必须调用 OneBot comment_qzone');
    assert.equal(call.params.tid, 'fixture-feed-tid-1');
    assert.equal(call.params.target_uin, 123, 'target_uin 必须是数字');
    assert.equal(call.params.content, '山顶风大，别被吹跑了');
    assert.equal(h.socialV2.qzoneCommentTimes.length, 1, '成功后要记一次评论额度');
    assert.equal(h.socialV2.qzoneCommentedTids.get('fixture-feed-tid-1') > 0, true);
  });
});

await test('评论闸门：非白名单/未抓到的 tid/过期/重复/过长/CQ/敏感信息全部拒绝且不触达网关', async () => {
  await withBridge(async ({ h, request }) => {
    await getFeed(request);
    const cases = [
      [{ tid: 'fixture-feed-tid-1', targetUin: '999', content: '陌生人' }, 403, /白名单/],
      [{ tid: 'made-up-tid', targetUin: '123', content: '编的' }, 403, /真正抓到过/],
      [{ tid: 'fixture-feed-tid-2', targetUin: '123', content: 'x'.repeat(101) }, 400, /过长/],
      [{ tid: 'fixture-feed-tid-2', targetUin: '123', content: 'hi [CQ:at,qq=1]' }, 400, /CQ/],
      [{ tid: 'fixture-feed-tid-2', targetUin: '123', content: '看了 C:\\Users\\someone\\secret.txt' }, 403, /敏感信息/]
    ];
    for (const [body, status, re] of cases) {
      const out = await commentQzone(request, body);
      assert.equal(out.status, status, `${JSON.stringify(body).slice(0, 80)} → ${out.status}: ${JSON.stringify(out.data)}`);
      assert.match(out.data.error, re);
    }
    assert.equal(h.calls.raw.filter((c) => c.action === 'comment_qzone').length, 0, '被拒绝的评论不得触达 OneBot');

    const ok = await commentQzone(request, { tid: 'fixture-feed-tid-1', targetUin: '123', content: '回一句' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const dup = await commentQzone(request, { tid: 'fixture-feed-tid-1', targetUin: '123', content: '再说一次' });
    assert.equal(dup.status, 409, JSON.stringify(dup.data));
    assert.match(dup.data.error, /已经评论过/);
    assert.equal(h.calls.raw.filter((c) => c.action === 'comment_qzone').length, 1);
  });
});

await test('评论频率上限：最小间隔与 24 小时条数', async () => {
  await withBridge(async ({ h, request }) => {
    await getFeed(request);
    const first = await commentQzone(request, { tid: 'fixture-feed-tid-1', targetUin: '123', content: '第一条' });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await commentQzone(request, { tid: 'fixture-feed-tid-2', targetUin: '123', content: '第二条' });
    assert.equal(second.status, 429, JSON.stringify(second.data));
    assert.match(second.data.error, /再等/);
    assert.equal(h.calls.raw.filter((c) => c.action === 'comment_qzone').length, 1);
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, feed: { commentMinIntervalMs: 30 * 60 * 1000, commentMaxPerDay: 0 } } } });

  await withBridge(async ({ h, request }) => {
    await getFeed(request);
    for (const [tid, text] of [['fixture-feed-tid-1', '一'], ['fixture-feed-tid-2', '二']]) {
      const out = await commentQzone(request, { tid, targetUin: '123', content: text });
      assert.equal(out.status, 200, JSON.stringify(out.data));
    }
    const thirdBody = { tid: 'fixture-feed-tid-1', targetUin: '123', content: '三' };
    const third = await commentQzone(request, thirdBody);
    // tid-1 已经评论过（409）优先于频率；换一条未评过的动态仍应被每日上限挡住。
    const daily = await commentQzone(request, { tid: 'fixture-feed-tid-3', targetUin: '123', content: '三' });
    assert.equal(third.status, 409, JSON.stringify(third.data));
    assert.equal(daily.status, 429, JSON.stringify(daily.data));
    assert.match(daily.data.error, /24 小时内最多评论 2 条/);
    assert.equal(h.calls.raw.filter((c) => c.action === 'comment_qzone').length, 2);
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, feed: { commentMinIntervalMs: 0, commentMaxPerDay: 2 } } } });
});

await test('点赞好友动态走 like_qzone，带 abstime，重复点赞拒绝', async () => {
  await withBridge(async ({ h, request }) => {
    await getFeed(request);
    const out = await likeQzone(request, { tid: 'fixture-feed-tid-1', targetUin: '123' });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    const call = h.calls.raw.find((c) => c.action === 'like_qzone');
    assert.ok(call, '必须调用 OneBot like_qzone');
    assert.equal(call.params.tid, 'fixture-feed-tid-1');
    assert.equal(call.params.target_uin, 123);
    assert.ok(call.params.abstime > 0, '点赞要带说说真实发表时间');
    const dup = await likeQzone(request, { tid: 'fixture-feed-tid-1', targetUin: '123' });
    assert.equal(dup.status, 409, JSON.stringify(dup.data));
    assert.match(dup.data.error, /已经点过赞/);
    assert.equal(h.calls.raw.filter((c) => c.action === 'like_qzone').length, 1);
  });
});

await test('点赞闸门与频率：非白名单/编造 tid/最小间隔', async () => {
  await withBridge(async ({ h, request }) => {
    await getFeed(request);
    const denied = await likeQzone(request, { tid: 'fixture-feed-tid-1', targetUin: '999' });
    assert.equal(denied.status, 403, JSON.stringify(denied.data));
    const fake = await likeQzone(request, { tid: 'made-up-tid', targetUin: '123' });
    assert.equal(fake.status, 403, JSON.stringify(fake.data));
    assert.equal(h.calls.raw.filter((c) => c.action === 'like_qzone').length, 0);
    const first = await likeQzone(request, { tid: 'fixture-feed-tid-1', targetUin: '123' });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await likeQzone(request, { tid: 'fixture-feed-tid-2', targetUin: '123' });
    assert.equal(second.status, 429, JSON.stringify(second.data));
    assert.match(second.data.error, /再等/);
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, feed: { likeMinIntervalMs: 10 * 60 * 1000 } } } });
});

await test('好友动态机会：有新动态才唤醒，提示带 tid/工具且不点名要求评论', async () => {
  await withBridge(async ({ h }) => {
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = 0;
    h.clearQzoneFeedTimer();
    await h.runQzoneFeedCheck();
    await sleep(2000);
    const delivered = h.calls.prompts.at(-1);
    assert.ok(delivered, '应当投递一次好友动态机会');
    const text = (delivered.content || []).map((c) => c.text || '').join('');
    for (const expected of ['【好友动态机会】', 'fixture-feed-tid-1', 'qq_comment_qzone', 'qq_like_qzone', '不是任务', '不用每条都回']) {
      assert.ok(text.includes(expected), `唤醒提示缺少：${expected}`);
    }
    assert.ok(!/必须评论/.test(text), '提示不能把评论写成任务');
    assert.equal(h.socialV2.qzonePendingFeed.length, 0, '投递后应清空 pending，避免重复列同一批动态');
    assert.ok(h.socialV2.qzoneNextFeedCheckAt > Date.now(), '触发后必须排下一次');
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, feed: { enabled: true, proactive: { enabled: true, minIntervalMs: 3600000, maxIntervalMs: 7200000, probability: 1, quietMs: 0, activeStartHour: 0, activeEndHour: 24 } } } } });
});

await test('好友动态机会：没有新动态时不投递唤醒', async () => {
  await withBridge(async ({ h }) => {
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = 0;
    const now = Math.floor(Date.now() / 1000);
    h.rememberQzoneFeedPosts([
      { tid: 'fixture-feed-tid-1', uin: '123', time: now - 300 },
      { tid: 'fixture-feed-tid-2', uin: '123', time: now - 1800 },
      { tid: 'fixture-feed-tid-3', uin: '123', time: now - 3600 }
    ]);
    h.clearQzoneFeedTimer();
    const before = h.calls.prompts.length;
    await h.runQzoneFeedCheck();
    await sleep(500);
    assert.equal(h.calls.prompts.length, before, '全是看过的动态时不应唤醒');
    assert.equal(h.socialV2.qzonePendingFeed.length, 0);
    assert.ok(h.socialV2.qzoneNextFeedCheckAt > Date.now(), '检查后仍要排下一次');
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, feed: { enabled: true, proactive: { enabled: true, minIntervalMs: 3600000, maxIntervalMs: 7200000, probability: 1, quietMs: 0, activeStartHour: 0, activeEndHour: 24 } } } } });
});

await test('requireReplyAll：唤醒要求每条必回，评论后从积压移除且不重复', async () => {
  await withBridge(async ({ h, request }) => {
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = 0;
    h.clearQzoneFeedTimer();
    await h.runQzoneFeedCheck();
    await sleep(2000);
    const delivered = h.calls.prompts.at(-1);
    assert.ok(delivered, '应当投递一次待回复唤醒');
    const text = (delivered.content || []).map((c) => c.text || '').join('');
    for (const expected of ['【待回复动态】', '每一条都必须回复', '一条都不能跳过', 'qq_comment_qzone', '不要重复评']) {
      assert.ok(text.includes(expected), `强制回复提示缺少：${expected}`);
    }
    assert.ok(h.socialV2.qzoneMustReply.size > 0, '未回复的动态必须留在积压里');
    const tid = 'fixture-feed-tid-1';
    const out = await commentQzone(request, { tid, targetUin: '123', content: '回一句' });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(h.socialV2.qzoneMustReply.has(tid), false, '评论成功后要从积压移除');
    assert.ok(h.socialV2.qzoneMustReply.size > 0, '其它未回复的动态仍应留在积压');
    assert.equal(h.socialV2.qzoneMustReplyNudgedAt, 0, '部分完成后要清零 nudgedAt，让下一轮立刻催剩下的');
    const dup = await commentQzone(request, { tid, targetUin: '123', content: '再说一次' });
    assert.equal(dup.status, 409, JSON.stringify(dup.data));
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, feed: { enabled: true, requireReplyAll: true, retryNudgeMs: 7200000, commentMinIntervalMs: 0, commentMaxPerDay: 0, proactive: { enabled: true, minIntervalMs: 900000, maxIntervalMs: 1200000, probability: 1, quietMs: 0, activeStartHour: 0, activeEndHour: 24 } } } } });
});

await test('requireReplyAll：未回复积压会在 retryNudgeMs 后再次唤醒', async () => {
  await withBridge(async ({ h }) => {
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = 0;
    const now = Math.floor(Date.now() / 1000);
    h.rememberQzoneFeedPosts([
      { tid: 'fixture-feed-tid-1', uin: '123', time: now - 300 },
      { tid: 'fixture-feed-tid-2', uin: '123', time: now - 1800 },
      { tid: 'fixture-feed-tid-3', uin: '123', time: now - 3600 }
    ]);
    h.socialV2.qzoneMustReply.set('fixture-feed-tid-1', {
      tid: 'fixture-feed-tid-1', uin: '123', nickname: '管理员', time: now - 300,
      content: '还没回复的动态', images: [], addedAt: now - 10000, attempts: 1
    });
    h.socialV2.qzoneMustReplyNudgedAt = Date.now() - 3 * 3600 * 1000;
    h.clearQzoneFeedTimer();
    await h.runQzoneFeedCheck();
    await sleep(2000);
    const delivered = h.calls.prompts.at(-1);
    assert.ok(delivered, '积压到期后应当再次唤醒');
    const text = (delivered.content || []).map((c) => c.text || '').join('');
    assert.ok(text.includes('fixture-feed-tid-1'), '重试唤醒必须带上未回复的 tid');
  }, { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, qzone: { minIntervalMs: 0, maxPerDay: 0, feed: { enabled: true, requireReplyAll: true, retryNudgeMs: 2 * 3600 * 1000, commentMinIntervalMs: 0, commentMaxPerDay: 0, proactive: { enabled: true, minIntervalMs: 900000, maxIntervalMs: 1200000, probability: 1, quietMs: 0, activeStartHour: 0, activeEndHour: 24 } } } } });
});

await test('qzoneFeedCfg 收敛脏配置，白名单只认合法 QQ 号', async () => {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        qzone: {
          feed: {
            commentMaxChars: 9999,
            commentMaxPerDay: -1,
            maxAgeHours: 0,
            maxPostsPerCheck: 99,
            maxFriendsPerCheck: 99,
            requireReplyAll: true,
            retryNudgeMs: 1000,
            commentAllowedUins: ['22222222', 'bad', '0', 22222222, ''],
            proactive: { minIntervalMs: 1000, maxIntervalMs: 500, probability: 3, quietMs: -5, activeStartHour: 99, activeEndHour: 0 }
          }
        }
      }
    }
  });
  try {
    const f = h.qzoneFeedCfg();
    assert.equal(f.commentMaxChars, 500);
    assert.equal(f.commentMaxPerDay, 0);
    assert.equal(f.maxAgeHours, 1);
    assert.equal(f.maxPostsPerCheck, 20);
    assert.equal(f.maxFriendsPerCheck, 20);
    assert.equal(f.scanFriends, true);
    assert.equal(f.requireReplyAll, true);
    assert.equal(f.retryNudgeMs, 60 * 1000, '重试间隔至少 1 分钟');
    assert.deepEqual([...f.commentAllowedUins], ['22222222'], '非法/重复的 QQ 号要被清掉');
    assert.equal(f.proactive.minIntervalMs, 60 * 1000);
    assert.equal(f.proactive.maxIntervalMs, 60 * 1000);
    assert.equal(f.proactive.probability, 1);
    assert.equal(f.proactive.quietMs, 0);
    assert.equal(f.proactive.activeStartHour, 23);
    assert.equal(f.proactive.activeEndHour, 1);
    assert.equal(h.qzoneFeedAllowedUin('22222222'), true, '额外允许名单要生效');
    assert.equal(h.qzoneFeedAllowedUin('999999999'), false);
  } finally { await h.close(); }
});

// ── 5. 源码/配置契约 ──────────────────────────────────────────────────────
await test('MCP 注册、开关、端点与 qq_get_prompt 工具面都接上了', async () => {
  const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  assert.match(mcp, /'qq_send_qzone'/, 'MCP 必须注册 qq_send_qzone');
  assert.match(mcp, /qq_send_qzone: 'sendQzone'/, '必须登记工具开关');
  assert.match(mcp, /\/api\/socialV2\/send-qzone/, '必须走桥接端点');
  assert.match(mcp, /ugcRight: z\.enum\(\['friends', 'private'\]\)/, '只允许好友可见/仅自己可见');
  const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  assert.match(bridge, /sendQzone: true,/, 'bridge 默认开启发说说');
  assert.match(bridge, /sendQzone: 'qq_send_qzone'/, 'qq_get_prompt 的 toolMap 含发说说');
  assert.match(bridge, /'sendQzone',/, 'config API 的 toolFlags 含 sendQzone');
  assert.match(bridge, /v2ToolEnabled\('sendQzone'\)/, '端点受 tools.sendQzone 控制');
  assert.match(bridge, /bot\.raw\('send_qzone_msg'/, '必须调用 OneBot send_qzone_msg');
  assert.match(bridge, /assertQzoneAuditOk/, '内容审计必须接上');
  assert.match(bridge, /scheduleQzoneProactiveCheck/, '主动发动态机会必须排期');
  assert.match(bridge, /qzoneCheck/, '必须有 qzoneCheck 唤醒原因');
});

await test('config.example / 控制台 / 人设都有对应默认值与说明', async () => {
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(ex.socialV2?.tools?.sendQzone, true);
  assert.equal(ex.socialV2?.qzone?.maxChars, 1000);
  assert.ok(ex.socialV2?.qzone?.maxPerDay > 0);
  assert.equal(ex.socialV2?.qzone?.proactive?.enabled, false, '出厂默认不主动发动态');
  assert.ok(ex.socialV2?.qzone?.proactive?.minIntervalMs >= 24 * 3600 * 1000, '默认间隔 1 天以上');
  const html = fs.readFileSync(path.join(ROOT, 'public/console.html'), 'utf8');
  assert.match(html, /data-v2-tool="sendQzone"/, '控制台要有发说说开关');
  assert.match(html, /id="v2QzoneProactiveEnabled"/, '控制台要有主动发动态开关');
  assert.match(html, /id="v2QzoneIntervalMinH"/, '控制台要有主动发动态间隔');
  const preset = fs.readFileSync(path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');
  assert.match(preset, /qq_send_qzone/, 'qq-chat-v2 人设要说明发说说');
  assert.match(preset, /不要每天发/, '人设里要有频率边界');
});

await test('好友空间：MCP / 端点 / 白名单 / 控制台 / 人设契约都接上了', async () => {
  const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  assert.match(mcp, /'qq_get_qzone_feeds'/, 'MCP 必须注册 qq_get_qzone_feeds');
  assert.match(mcp, /'qq_comment_qzone'/, 'MCP 必须注册 qq_comment_qzone');
  assert.match(mcp, /'qq_like_qzone'/, 'MCP 必须注册 qq_like_qzone');
  assert.match(mcp, /qq_get_qzone_feeds: 'getQzoneFeeds'/, '必须登记工具开关 getQzoneFeeds');
  assert.match(mcp, /qq_comment_qzone: 'commentQzone'/, '必须登记工具开关 commentQzone');
  assert.match(mcp, /qq_like_qzone: 'likeQzone'/, '必须登记工具开关 likeQzone');
  assert.match(mcp, /\/api\/socialV2\/qzone-feed/, '看动态必须走桥接端点');
  assert.match(mcp, /\/api\/socialV2\/comment-qzone/, '评论必须走桥接端点');
  assert.match(mcp, /\/api\/socialV2\/like-qzone/, '点赞必须走桥接端点');
  const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  assert.match(bridge, /getQzoneFeeds: true,/, 'bridge 默认开放看好友动态');
  assert.match(bridge, /commentQzone: true,/, 'bridge 默认开放评论好友动态');
  assert.match(bridge, /likeQzone: true,/, 'bridge 默认开放点赞好友动态');
  assert.match(bridge, /function qzoneFeedAllowedUin/, '必须有好友白名单判断');
  assert.match(bridge, /function qzoneFeedCfg/, '必须有好友空间配置收敛');
  assert.match(bridge, /fetchQzoneFriendPosts/, '全局 feed 为空时要能逐个好友补位');
  assert.match(bridge, /bot\.raw\('get_qzone_msg_list'/, '逐个好友读取必须调用 get_qzone_msg_list');
  assert.match(bridge, /bot\.raw\('comment_qzone'/, '必须调用 OneBot comment_qzone');
  assert.match(bridge, /bot\.raw\('like_qzone'/, '必须调用 OneBot like_qzone');
  assert.match(bridge, /qzoneFeedCheck/, '必须有好友动态机会唤醒原因');
  assert.match(bridge, /qzoneFeedTargetKey/, '必须有好友动态机会的目标会话选择');
  assert.match(bridge, /qzoneMustReply/, '必须有「必须回复」积压，未回复会重试');
  assert.match(bridge, /requireReplyAll/, '必须有每条必回的开关');
  assert.match(bridge, /【待回复动态】/, '强制模式唤醒必须明确标出待回复动态');
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(ex.socialV2?.tools?.getQzoneFeeds, true);
  assert.equal(ex.socialV2?.tools?.commentQzone, true);
  assert.equal(ex.socialV2?.tools?.likeQzone, true);
  assert.equal(ex.socialV2?.qzone?.feed?.enabled, true, '出厂默认允许看好友空间');
  assert.equal(ex.socialV2?.qzone?.feed?.proactive?.enabled, false, '出厂默认不主动看好友空间');
  assert.equal(ex.socialV2?.qzone?.feed?.scanFriends, true, '全局 feed 为空时默认逐个好友补位');
  assert.ok(ex.socialV2?.qzone?.feed?.maxFriendsPerCheck > 0, '逐好友读取要有上限');
  assert.equal(ex.socialV2?.qzone?.feed?.requireReplyAll, false, '出厂默认不强制每条必回');
  assert.ok(ex.socialV2?.qzone?.feed?.retryNudgeMs > 0, '未回复重试间隔要有默认值');
  assert.ok(ex.socialV2?.qzone?.feed?.commentMaxPerDay > 0, '出厂要有评论每日上限');
  assert.ok(ex.socialV2?.qzone?.feed?.commentMinIntervalMs > 0, '出厂要有评论最小间隔');
  const html = fs.readFileSync(path.join(ROOT, 'public/console.html'), 'utf8');
  for (const id of ['getQzoneFeeds', 'commentQzone', 'likeQzone']) {
    assert.match(html, new RegExp(`data-v2-tool="${id}"`), `控制台要有 ${id} 开关`);
  }
  assert.match(html, /id="v2QzoneFeedProactiveEnabled"/, '控制台要有好友动态机会开关');
  assert.match(html, /id="v2QzoneRequireReplyAll"/, '控制台要有每条必回开关');
  assert.match(html, /id="v2QzoneRetryNudgeMin"/, '控制台要有未回复重试间隔');
  assert.match(html, /id="v2QzoneScanFriends"/, '控制台要有逐好友补位开关');
  assert.match(html, /id="v2QzoneCommentMaxPerDay"/, '控制台要有评论每日上限');
  const preset = fs.readFileSync(path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');
  assert.match(preset, /qq_get_qzone_feeds/, '人设要说明看好友空间');
  assert.match(preset, /qq_comment_qzone/, '人设要说明评论好友动态');
  assert.match(preset, /【好友动态机会】/, '人设要说明好友动态机会');
  assert.match(preset, /【待回复动态】/, '人设要说明强制模式标记');
  assert.match(preset, /每一条都必须回复/, '人设要说明强制模式必须逐条回');
  assert.match(preset, /不用每条都回/, '人设里要有“非强制时可选择”的边界');
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
