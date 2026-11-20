// DSH 地址热切换：运行期「端口变了」的自愈控制器。
//
// 背景（真实故障形态）：
//   DSH 桌面端**每次启动都换一个随机端口**（实测 63565 → 50132 → 65370），而桥接的
//   `dsh.baseUrl` 来自 config.json。启动时的探测（见 bridge.js）只解决「桥接启动那一刻
//   端口已经变了」；但 DSH 在**运行期间**也会重启换端口（用户手动重启、更新后自动重启、
//   崩溃后被启动器拉起）。那种情况下：
//     桥接进程活着、SnowLuma 活着、QQ 侧也连着，
//     只有 api.baseUrl 指向一个已经没人监听的端口：
//       checkDsh 每 5 秒的 settings/describe 全部失败 → dshReady 恒为 false →
//       QQ 消息全部进补投队列 → 群里表现为「鱼不回话了」。
//   而且**不会自己好**：桥接会一直对着那个死端口重连，除非人工改配置 + 重启桥接。
//
// 本控制器把「探活 → 本机端口扫描 → 热切换」这段逻辑独立出来，好处是它可以被
// `scripts/test-dsh-rebind.mjs` 用假 DSH 精确驱动（不需要真实 DSH，也不发外网请求）。
//
// 三个守卫让它足够便宜、也不会误伤：
//   ① 冷却 + 并发去重 —— 调用方是每 5 秒一次的健康检查，而扫描要跑 netstat 并逐个探测；
//   ② 先探当前地址：**还活着就什么都不做**（此时失败原因不是端口变化，例如鉴权/协议问题，
//      乱改地址只会让问题更难查）；
//   ③ 只对回环地址生效：远程 DSH 的端口扫描没有意义，凭据也不该发往非回环地址。
import { probeDshBase, discoverDshBaseUrl, isLoopbackBase } from './dsh-client.js';

/** 默认值集中在这里，方便测试覆盖与调用方阅读。 */
export const DSH_REBIND_DEFAULTS = Object.freeze({
  cooldownMs: 15_000,
  timeoutMs: 700,
  maxCandidates: 64
});

/**
 * @param options.client - 需要被热切换的 API 客户端（至少要有可写的 `baseUrl`；
 *   有 `invalidateAuth()` 时会一并调用）。
 * @param options.allowRemote - config.json 的 `dsh.allowRemote`；true 时完全不做本机扫描。
 * @param options.excludePorts - 不参与扫描的端口（桥接控制台、SnowLuma 等）。
 * @param options.onAdopt - 切换成功后的回调 `(base, { from, reason }) => void`，
 *   用于把新地址写回 config.json / 同步内存里的配置。抛错只记日志，不影响切换本身。
 * @param options.log - 日志函数。
 * @param options.now / options.probe / options.discover - 可注入，便于测试。
 */
export function createDshRebindController({
  client,
  allowRemote = false,
  excludePorts = [],
  cooldownMs = DSH_REBIND_DEFAULTS.cooldownMs,
  timeoutMs = DSH_REBIND_DEFAULTS.timeoutMs,
  maxCandidates = DSH_REBIND_DEFAULTS.maxCandidates,
  onAdopt = null,
  log = () => {},
  now = () => Date.now(),
  probe = probeDshBase,
  discover = discoverDshBaseUrl
} = {}) {
  if (!client) throw new Error('createDshRebindController: client is required');
  let lastAttemptAt = 0;
  let inFlight = null;

  /** 当前地址（去掉末尾斜杠，便于和发现结果直接比较）。 */
  function currentBase() {
    return String(client.baseUrl ?? '').replace(/\/+$/, '');
  }

  /**
   * 把客户端热切到新地址。
   *
   * 必须连带重新鉴权：会话 Cookie 的名字与签名载荷都绑定 authority（host:port），
   * 换端口后旧 Cookie 必然被 401；`invalidateAuth()` 顺带重读签名密钥、重新发现
   * launch token —— DSH 重启后这两样都可能已经变了。
   */
  function adopt(next, { from = '', reason = '' } = {}) {
    const base = String(next ?? '').replace(/\/+$/, '');
    if (!base) return false;
    client.baseUrl = base;
    client.invalidateAuth?.();
    log(`DSH 地址已热切换：${from || '(未知)'} → ${base}${reason ? `（${reason}）` : ''}，QQ 侧无需重启`);
    try {
      onAdopt?.(base, { from, reason });
    } catch (error) {
      log(`热切换后的收尾回调出错（已忽略）：${error?.message ?? error}`);
    }
    return true;
  }

  /**
   * 健康检查/事件流失败时调用：确认当前地址真的死了，再本机扫一遍端口，找到新地址就热切换。
   *
   * @param reason - 触发原因，只进日志。
   * @returns Promise<boolean> 是否真的换了地址。并发调用会复用同一个 Promise（不会重复扫描）。
   */
  function rebindIfMoved(reason = '') {
    if (inFlight) return inFlight;
    const current = currentBase();
    if (!current) return Promise.resolve(false);
    // 远程 DSH：扫描只对本机有意义，且不该把凭据发往非回环地址。
    if (allowRemote || !isLoopbackBase(current)) return Promise.resolve(false);
    if (now() - lastAttemptAt < cooldownMs) return Promise.resolve(false);
    lastAttemptAt = now();
    inFlight = (async () => {
      try {
        // 地址还活着 ⇒ 失败原因不是端口变化，保持原样。
        if (await probe(current, { timeoutMs })) return false;
        const discovered = await discover({ configured: current, excludePorts, timeoutMs, maxCandidates });
        if (!discovered) return false;
        const next = String(discovered).replace(/\/+$/, '');
        if (!next || next === current) return false;
        return adopt(next, { from: current, reason });
      } catch (error) {
        log(`DSH 端口重探出错（已忽略）：${error?.message ?? error}`);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { rebindIfMoved, adopt, currentBase };
}
