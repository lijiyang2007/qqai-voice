// Operator-only maintenance: read-only checks, or explicit graceful restart. Never send QQ messages.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const cfg=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const base=`http://127.0.0.1:${cfg.consolePort||3100}`;
const headers={'x-console-token':cfg.consoleToken,'content-type':'application/json'};
if(process.argv.includes('--restart')) {
  const r=await fetch(base+'/api/restart',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(10000)});
  assert.equal(r.status,200);assert.equal((await r.json()).ok,true);console.log('Graceful bridge restart accepted; DSH and GPU workers untouched.');
} else {
  const keys=[`private:${cfg.ownerQQ}`, ...(cfg.allow?.groups||[]).slice(0,1).map(x=>`group:${x}`)];
  assert.equal(keys.length,2,'Need configured private and group target');
  for(const key of keys) {
    const r=await fetch(base+'/api/socialV2/prompt?key='+encodeURIComponent(key),{headers,signal:AbortSignal.timeout(15000)});
    assert.equal(r.status,200);const data=await r.json();
    assert.ok(data.enabledTools.includes('qq_sing / qq_sing_status'));
    assert.equal(data.singing.enabled,true);assert.match(data.singing.guidance,/不是 qq_send_voice/);
    console.log('PASS live '+key.split(':')[0]+' singing discovery and controlled guidance');
    const denied=await fetch(base+'/api/socialV2/sing',{method:'POST',headers,body:JSON.stringify({key,song:'invalid-test-no-token'}),signal:AbortSignal.timeout(10000)});
    assert.equal(denied.status,403);console.log('PASS live '+key.split(':')[0]+' missing agent token rejected');
  }
}
