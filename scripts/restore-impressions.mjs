// 一次性修复：把 state/tmp/restore-impressions.json 里的 memberImpression 通过
// 控制台 API 写回**运行中的**桥接进程。
//
// 为什么不直接改 state/social-v2.json：桥接内存里那份才是真相，它在每次保存时
// 会把内存态整体落盘，手改文件会被下一次 saveSocialV2State() 覆盖掉。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const token = fs.readFileSync(path.join(root, 'state', 'console-token'), 'utf8').trim();
const items = JSON.parse(fs.readFileSync(path.join(root, 'state', 'tmp', 'restore-impressions.json'), 'utf8'));

const post = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:3100${p}`, {
    method: 'POST',
    headers: { 'x-console-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
};

let ok = 0;
let fail = 0;
for (const it of items) {
  try {
    const r = await post('/api/socialV2/memory-append', {
      key: it.key,
      category: 'memberImpression',
      content: it.trait,
      extra: { target: it.name }
    });
    if (r.ok) ok++;
    else { fail++; console.log('FAIL', it.key, r.error); }
  } catch (error) {
    fail++;
    console.log('ERR', it.key, error?.message ?? error);
  }
}
console.log(`恢复成功 ${ok} 条，失败 ${fail} 条`);

// 回读确认：/api/socialV2/state 不返回 memberImpressions（那是给 AI 看的状态摘要），
// 所以直接读桥接落盘的文件 —— 它刚刚被 saveSocialV2State() 写过。
const saved = JSON.parse(fs.readFileSync(path.join(root, 'state', 'social-v2.json'), 'utf8'));
let total = 0;
for (const key of [...new Set(items.map((i) => i.key))]) {
  const names = Object.keys(saved?.conversations?.[key]?.memberImpressions || {});
  total += names.length;
  console.log(' ', key, '->', names.length ? names.join(' / ') : '(空)');
}
console.log('印象总数:', total);
