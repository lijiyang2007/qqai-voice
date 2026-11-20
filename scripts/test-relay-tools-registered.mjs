// 直接拉起 MCP server（stdio JSON-RPC），确认两个代发工具注册成功。
// 不经过 DSH，因此不影响正在运行的会话。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const out = path.join(ROOT, 'state/tmp/mcp-tools.json');

const child = spawn(process.execPath, [path.join(ROOT, 'src/mcp-snowluma-safe.js')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const log = [];
child.stderr.on('data', (d) => log.push(String(d)));

child.stdout.on('data', (d) => {
  buf += String(d);
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    } else if (msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name);
      const relay = names.filter((n) => n.includes('relay'));
      fs.writeFileSync(out, JSON.stringify({
        total: names.length,
        relayTools: relay,
        hasTargets: names.includes('qq_relay_targets'),
        hasSend: names.includes('qq_relay_send'),
        all: names
      }, null, 2), 'utf8');
      child.kill();
      console.log('DONE');
      process.exit(0);
    }
  }
});

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } }
});

setTimeout(() => {
  fs.writeFileSync(out, JSON.stringify({ error: 'timeout', stderr: log.join('').slice(-2000) }, null, 2), 'utf8');
  child.kill();
  process.exit(1);
}, 20000);
