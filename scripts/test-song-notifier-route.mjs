// Exercise actual route registration -> terminal watcher; fake QQ and worker only.
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createSongJobNotifier } from '../src/song-job-notifier.js';
let notifier;const notices=[];let state='queued';
const h=await bridgeHarness({config:{socialV2:{sticker:{enabled:false}}},globals:{createCoverJobService:()=>({resolveSong:async()=>({song:'Heartbeat Childish Gambino',trackId:2632671277}),submit:async()=>({job:'fixture-job-001',song:'Heartbeat Childish Gambino',status:'queued'}),status:({target})=>({status:state,target,qualityHold:true,error:'歌名、歌手或发行版本需要确认；请确认准确歌曲版本后再点。',sent:false})}),createSongJobNotifier:opts=>(notifier=createSongJobNotifier({...opts,notify:async n=>notices.push(n)}))}});
h.setMode('reserved2');const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
try{
 const key='private:123';const token=h.getSocialV2State(key).agentToken;
 const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/socialV2/sing',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify({key,token,song:'Heartbeat - Childish Gambino (Camp, 2011)',mode:'full'})});
 assert.equal(r.status,200);assert.ok(notifier.get('fixture-job-001'));await notifier.tick();assert.equal(notices.length,0);
 state='failed';await notifier.tick();await notifier.tick();assert.equal(notices.length,1);assert.equal(notices[0].key,key);assert.match(notices[0].message,/暂停|版本|完成/);assert.equal(h.calls.sent.length,0);
 console.log('PASS actual submit route registers bound watcher; terminal failure notified once');
}finally{await new Promise(r=>server.close(r));await h.close();}
