// 把 config.json 里的 dsh.baseUrl 改成指定端口，并校验 JSON 仍然合法。
// 单独做成脚本是为了绕开 PowerShell 5.1 的默认编码：中文配置用 PS 读写会被写成乱码，
// Node 的 utf8 读写则是无损的。
import fs from 'node:fs';

const [, , cfgPath, port] = process.argv;
if (!cfgPath || !port) {
  console.error('usage: node set-dsh-port.mjs <config.json> <port>');
  process.exit(2);
}
const text = fs.readFileSync(cfgPath, 'utf8');
const next = text.replace(/"baseUrl"\s*:\s*"[^"]*"/, `"baseUrl": "http://127.0.0.1:${port}"`);
if (next !== text) fs.writeFileSync(cfgPath, next, 'utf8');
JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
console.log(next === text ? 'unchanged' : 'updated');
