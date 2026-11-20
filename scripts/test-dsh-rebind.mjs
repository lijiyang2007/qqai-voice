// DSH 地址热切换回归测试：DSH **运行期间**重启换了随机端口时，桥接必须自己跟过去。
//
// 背景（真实故障形态，已修）：DSH 桌面端每次启动换一个随机端口，而 `dsh.baseUrl` 是
// config.json 里的写死值。启动时的探测只覆盖「桥接启动那一刻端口已经变了」；如果端口是在
// 桥接**运行期间**变的，`checkDsh` 每 5 秒的 `settings/describe` 会一直失败 → `dshReady`
// 恒为 false → QQ 消息全部进补投队列，群里表现为「鱼不回话了」，而且不会自己好：
// 除非人工改配置 + 重启桥接。
//
// 本测试用**假 DSH**（一个只认 `settings/describe` 的本地 HTTP 服务）精确复现
// 「旧端口死掉、新端口起来」，全程只走回环地址、不发任何外网请求。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 本测试若从 DSH 的 shell 里启动，环境里会带着 DSH_WEB_URL / DSH_WEB_PORT（指向**真实** DSH）。
// discoverDshBaseUrl 会优先探这些环境变量候选，于是「发现」到的永远是真实 DSH 而不是假 DSH，
// 测试就失去意义了。这里先摘掉，让发现逻辑只看 configured + 端口扫描。
for (const name of ['DSH_WEB_URL', 'DSH_BASE_URL', 'DSH_WEB_PORT']) delete process.env[name];

const { probeDshBase, listeningLoopbackPorts } = await import(pathToFileURL(path.join(ROOT, 'src/dsh-client.js')).href);
const { createDshRebindController } = await import(pathToFileURL(path.join(ROOT, 'src/dsh-rebind.js')).href);

let failed = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};

/** 一个只认 POST /api/settings/describe 的假 DSH：返回标准 server-response 信封。 */
function startFakeDsh() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let rpcId = 'x';
      try { rpcId = JSON.parse(body).rpcId ?? 'x'; } catch { /* 非 JSON 也照样回信封 */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: {} } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
const closeServer = (server) => new Promise((resolve) => server.close(resolve));
/** 拿一个「确定没人监听」的端口：开一个再关掉。 */
async function freePort() {
  const { server, port } = await startFakeDsh();
  await closeServer(server);
  return port;
}
/**
 * 只留 `port` 一个候选：把本机其它所有 LISTENING 端口都排除掉。
 * 少了这一步，端口扫描会扫到**真实 DSH**（它也在监听，且端口更小会先命中）。
 */
const excludeAllExcept = (port) => listeningLoopbackPorts().filter((p) => p !== port);

/** 最小可用的假客户端：只需要可写的 baseUrl 与 invalidateAuth。 */
function fakeClient(baseUrl) {
  return {
    baseUrl,
    invalidateAuthCalls: 0,
    invalidateAuth() { this.invalidateAuthCalls += 1; }
  };
}

// ── 1. 地址还活着：什么都不做（这是最重要的「不误伤」保证）─────────────────────
{
  const live = await startFakeDsh();
  const base = `http://127.0.0.1:${live.port}`;
  const client = fakeClient(base);
  let adopted = null;
  let probes = 0;
  const ctl = createDshRebindController({
    client,
    probe: async (b, o) => { probes += 1; return probeDshBase(b, o); },
    log: () => {},
    onAdopt: (b) => { adopted = b; }
  });
  const moved = await ctl.rebindIfMoved('测试');
  check('地址活着时不切换', moved === false && client.baseUrl === base && adopted === null);
  check('地址活着时确实探过活', probes === 1);
  check('地址活着时不动鉴权', client.invalidateAuthCalls === 0);
  await closeServer(live.server);
}

// ── 2. 旧端口死掉、新端口起来：必须热切换过去 ─────────────────────────────────
{
  const deadPort = await freePort();
  const deadBase = `http://127.0.0.1:${deadPort}`;
  const moved = await startFakeDsh();
  const newBase = `http://127.0.0.1:${moved.port}`;
  const client = fakeClient(deadBase);
  const adopted = [];
  const logs = [];
  const ctl = createDshRebindController({
    client,
    excludePorts: excludeAllExcept(moved.port),
    log: (msg) => logs.push(String(msg)),
    onAdopt: (b, info) => adopted.push({ base: b, ...info })
  });
  const switched = await ctl.rebindIfMoved('settings/describe 失败');
  check('旧地址死了就热切换到新地址', switched === true && client.baseUrl === newBase,
    `baseUrl=${client.baseUrl}`);
  check('切换后重新鉴权（Cookie 绑定 authority，必须重铸）', client.invalidateAuthCalls === 1);
  check('onAdopt 收到新地址与来源', adopted.length === 1 && adopted[0].base === newBase
    && adopted[0].from === deadBase, JSON.stringify(adopted[0] ?? null));
  check('日志里有可读的热切换记录', logs.some((l) => l.includes('DSH 地址已热切换')), logs.join(' | '));
  check('切换后的新地址真的可用', (await probeDshBase(client.baseUrl, { timeoutMs: 700 })) === newBase);
  await closeServer(moved.server);
}

// ── 3. 冷却：同一轮故障里不反复跑 netstat ────────────────────────────────────
{
  let clock = 1_000_000;
  let probes = 0;
  const client = fakeClient('http://127.0.0.1:1');
  const ctl = createDshRebindController({
    client,
    cooldownMs: 15_000,
    now: () => clock,
    probe: async () => { probes += 1; return null; },
    discover: async () => null,
    log: () => {}
  });
  const first = await ctl.rebindIfMoved('第一次');
  const second = await ctl.rebindIfMoved('冷却期内');
  check('冷却期内不重复探测', first === false && second === false && probes === 1, `probes=${probes}`);
  clock += 15_001;
  await ctl.rebindIfMoved('冷却结束后');
  check('冷却结束后恢复探测', probes === 2, `probes=${probes}`);
}

// ── 4. 并发去重：checkDsh 与事件流可能同时触发 ────────────────────────────────
{
  let probes = 0;
  const client = fakeClient('http://127.0.0.1:1');
  const ctl = createDshRebindController({
    client,
    cooldownMs: 0,
    probe: async () => { probes += 1; await new Promise((r) => setTimeout(r, 30)); return null; },
    discover: async () => null,
    log: () => {}
  });
  const p1 = ctl.rebindIfMoved('健康检查');
  const p2 = ctl.rebindIfMoved('事件流');
  check('并发调用复用同一个 Promise', p1 === p2);
  await Promise.all([p1, p2]);
  check('并发只探测一次', probes === 1, `probes=${probes}`);
}

// ── 5. 扫不到 DSH：不切换、不报错（DSH 就是关掉了而已）───────────────────────
{
  const deadPort = await freePort();
  const deadBase = `http://127.0.0.1:${deadPort}`;
  const client = fakeClient(deadBase);
  const ctl = createDshRebindController({
    client,
    excludePorts: excludeAllExcept(-1), // 排除掉全部真实端口 ⇒ 扫描结果为空
    log: () => {}
  });
  const switched = await ctl.rebindIfMoved('DSH 关掉了');
  check('扫不到 DSH 时保持原地址', switched === false && client.baseUrl === deadBase);
}

// ── 6. 远程 DSH：完全不做本机扫描 ───────────────────────────────────────────
{
  let probes = 0;
  const client = fakeClient('http://10.0.0.5:3080');
  const ctl = createDshRebindController({
    client,
    probe: async () => { probes += 1; return null; },
    discover: async () => { throw new Error('远程地址不该触发本机扫描'); },
    log: () => {}
  });
  check('非回环地址直接返回', (await ctl.rebindIfMoved('远程')) === false && probes === 0);
  const ctlRemote = createDshRebindController({
    client: fakeClient('http://127.0.0.1:1'),
    allowRemote: true,
    probe: async () => { probes += 1; return null; },
    discover: async () => { throw new Error('allowRemote 时不该触发本机扫描'); },
    log: () => {}
  });
  check('allowRemote=true 时直接返回', (await ctlRemote.rebindIfMoved('远程')) === false && probes === 0);
}

console.log(failed === 0 ? '\n✅ DSH 地址热切换回归测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
