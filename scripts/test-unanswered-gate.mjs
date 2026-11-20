// 「对方一直不理就别再发」硬闸门的回归。
//
// 这条规则以前只写在提示词里（qq-chat-v2 的「同一件事主动追问最多 2 次」），
// 属于软约束；桥接侧唯一能起作用的是概率衰减（×0.5/×0.3），压到 0.09 也不是 0。
// 现在改成记账：连续 N 次主动开口没人接就闭麦，等对方先说话再恢复。
//
// 钉住四件事：
//   G1 连续 maxUnanswered 次没人接 → 闭麦（allowed=false）
//   G2 有人说话 → 立刻解除闭麦、计数清零
//   G3 闭麦后对方一直不说话，安静超过 reopenAfterMs → 重新给一次机会
//   G4 关掉开关（enabled=false）时完全不拦
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 每个用例一个干净的桥接实例（状态文件是独立的临时目录）。
const withBridge = async (config, run) => {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        sticker: { enabled: false },
        proactive: { enabled: true, ...config }
      }
    }
  });
  try { await run(h); }
  finally { await h.close(); }
};

await test('G1 连续主动开口没人接 → 闭麦', async () => {
  await withBridge({ unansweredGate: { enabled: true, maxUnanswered: 2 } }, async (h) => {
    h.getSocialV2State(KEY);
    assert.equal(h.proactiveGateStateV2(KEY).allowed, true, '一开始应该允许开口');

    h.noteProactiveOpenV2(KEY);
    assert.equal(h.proactiveGateStateV2(KEY).allowed, true, '第 1 次还没到上限，应该允许');

    // 绕开「同一轮去重」：把 lastWakeAt 往前挪，模拟隔了一段时间又开一次口。
    const st = h.getSocialV2State(KEY);
    st.proactiveGate.lastWakeAt = Date.now() - 5 * 60 * 1000;
    h.noteProactiveOpenV2(KEY);

    const gate = h.proactiveGateStateV2(KEY);
    assert.equal(gate.allowed, false, '连续 2 次没人接之后必须闭麦');
    assert.equal(gate.reason, 'blocked');
  });
});

await test('G2 有人说话 → 解除闭麦、计数清零', async () => {
  await withBridge({ unansweredGate: { enabled: true, maxUnanswered: 1 } }, async (h) => {
    h.getSocialV2State(KEY);
    h.noteProactiveOpenV2(KEY);
    assert.equal(h.proactiveGateStateV2(KEY).allowed, false, '先闭麦');

    // 真人说话了：走真实的入站消息路径（而不是直接改字段）。
    h.appendSocialV2Message(KEY, '小明', '在吗', '在吗', false, false, 'msg-1', [], '111', []);

    const st = h.getSocialV2State(KEY);
    assert.equal(st.proactiveGate.count, 0, '有人说话后计数必须清零');
    assert.equal(st.proactiveGate.blockedAt, 0, '有人说话后必须解除闭麦');
    assert.equal(h.proactiveGateStateV2(KEY).allowed, true, '解除后应该允许再次主动开口');
  });
});

await test('G3 闭麦后一直没人说话 → 安静够久重新给一次机会', async () => {
  await withBridge({ unansweredGate: { enabled: true, maxUnanswered: 1, reopenAfterMs: 60 * 1000 } }, async (h) => {
    h.getSocialV2State(KEY);
    h.noteProactiveOpenV2(KEY);
    assert.equal(h.proactiveGateStateV2(KEY).allowed, false, '先闭麦');

    // 把「上次开口」和「闭麦时刻」都推到 reopenAfterMs 之外。
    const st = h.getSocialV2State(KEY);
    st.proactiveGate.lastProactiveAt = Date.now() - 2 * 60 * 1000;
    st.proactiveGate.blockedAt = Date.now() - 2 * 60 * 1000;

    const gate = h.proactiveGateStateV2(KEY);
    assert.equal(gate.allowed, true, '安静够久之后必须放一次');
    assert.equal(gate.reason, 'reopened');
    assert.equal(st.proactiveGate.blockedAt, 0, '放行后闭麦标记要清掉');
    assert.equal(st.proactiveGate.count, 0, '放行后计数要清零');
  });
});

await test('G4 关掉开关时完全不拦', async () => {
  await withBridge({ unansweredGate: { enabled: false, maxUnanswered: 1 } }, async (h) => {
    h.getSocialV2State(KEY);
    for (let i = 0; i < 5; i++) {
      const st = h.getSocialV2State(KEY);
      if (st.proactiveGate) st.proactiveGate.lastWakeAt = 0;
      h.noteProactiveOpenV2(KEY);
    }
    const gate = h.proactiveGateStateV2(KEY);
    assert.equal(gate.allowed, true, '关掉开关后不该闭麦');
    assert.equal(gate.reason, 'disabled');
  });
});

if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('全部通过');
