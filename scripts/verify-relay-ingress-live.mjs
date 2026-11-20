// Read-only production query; never submits or sends a message.
import fs from 'node:fs';import assert from 'node:assert/strict';
const cfg=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const base=`http://127.0.0.1:${cfg.consolePort||3100}`;
const r=await fetch(base+'/api/socialV2/recent?key='+encodeURIComponent('private:'+cfg.ownerQQ)+'&limit=100',{headers:{'x-console-token':cfg.consoleToken},signal:AbortSignal.timeout(15000)});
assert.equal(r.status,200);const p=await r.json();assert.ok(Array.isArray(p.relaySongRequests),'new runtime response absent');
const request=p.relaySongRequests.find(x=>x.requestMessageId==='-2077182222');assert.ok(request,'original request missing from recent messages');
assert.equal(request.recipients.length,2);assert.ok(request.recipients.every(x=>x.candidates.length===1),'recipient unresolved/ambiguous');
assert.match(request.instruction,/qq_relay_send/);console.log('PASS live original failed message now carries relay routing, both recipients uniquely matched in current whitelist; zero task submission/QQ sends');
