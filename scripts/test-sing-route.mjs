// Real HTTP handlers with fake worker and isolated state. No QQ or GPU side effects.
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const calls=[];
const h=await bridgeHarness({config:{socialV2:{sticker:{enabled:false}}},globals:{createCoverJobService:()=>({submit:async x=>{calls.push(x);return {job:'test-1234',target:x.target};},status:()=>({status:'queued'})})}});
h.setMode('reserved2');
const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
async function post(body){const r=await fetch(base+'/api/socialV2/sing',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
try{
 for(const key of ['private:123','group:456']){
  const token=h.getSocialV2State(key).agentToken;
  const r=await post({key,token,song:'测试歌 测试歌手',mode:'full',target:'private:999',file:'C:\\not-allowed'});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.ok,true);assert.equal(calls.at(-1).target,key);assert.equal(calls.at(-1).song,'测试歌 测试歌手');assert.equal(calls.at(-1).mode,'full');assert.equal(calls.at(-1).file,undefined);
  console.log('PASS '+key.split(':')[0]+' submits only to token-bound session');
 }
 const before=calls.length;
 assert.equal((await post({key:'group:456',token:h.getSocialV2State('private:123').agentToken,song:'x'})).status,403);
 h.cfg.socialV2.tools.sing=false;
 assert.equal((await post({key:'private:123',token:h.getSocialV2State('private:123').agentToken,song:'x'})).status,403);
 assert.equal(calls.length,before);assert.equal(h.calls.sent.length,0);
 console.log('PASS cross-session token and disabled tool rejected; no QQ messages sent');
}finally{await new Promise(r=>server.close(r));await h.close();}
