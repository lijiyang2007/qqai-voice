// Real HTTP routes with isolated state, fake QQ and fake worker. No live sends.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {bridgeHarness} from './audit-bridge-harness.mjs';import {createRelaySongScope} from '../src/relay-song-scope.js';import {publicCoverStatus} from '../src/cover-job.js';
let member=true,sends=0;const submissions=[];
const h=await bridgeHarness({config:{socialV2:{sticker:{enabled:false},voice:{maxPerMinute:0,maxPerHour:0}}},globals:{createCoverJobService:()=>({submit:async x=>{submissions.push(x);return {job:'fixture-song-'+submissions.length,song:x.song,status:'queued'};},resolveSong:async()=>({song:'晴天 周杰伦',trackId:12345}),status:()=>({status:'queued'})}),inspectAudio:async()=>({ok:true,size:4096,duration:1,codec:'mp3',warnings:[]}),fetch:async url=>{const a=new URL(url).pathname.slice(1);let data={};if(a==='get_friend_list')data=member?[{user_id:789,nickname:'妈妈'},{user_id:780,nickname:'同名'},{user_id:781,nickname:'同名'}]:[];if(a==='get_group_list')data=member?[{group_id:999,group_name:'未开放聊天群'}]:[];if(a.startsWith('send_')){sends++;data={message_id:-123};}if(a==='get_msg')data={message:[{type:'record',data:{file:'fixture'}}]};return {ok:true,status:200,json:async()=>({status:'ok',retcode:0,data})};}}});
h.setMode('reserved2');h.cfg.socialV2.sing={root:h.temp};const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;const owner={key:'private:123',token:h.getSocialV2State('private:123').agentToken};
async function post(route,body){const r=await fetch(base+route,{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
async function relay(body){return post('/api/socialV2/relay-send',{...owner,target:'private:789',song:'唱这个 https://b23.tv/EfMi8en',...body});}
try{
 const r=await fetch(base+'/api/socialV2/relay-targets?key=private:123',{headers:{'x-console-token':'fixture-console-token','x-agent-token':owner.token}});assert.equal(r.status,200);const list=await r.json();assert.equal(list.private.length,3);assert.equal(list.groups.length,1);assert.ok(list.private.every(x=>x.canRelaySong&&!x.canRelayMessages));assert.equal(list.private.filter(x=>x.name==='同名').length,2);
 for(const target of ['private:789','group:999']){const r=await relay({target,song:target.startsWith('group')?'晴天 周杰伦':'唱这个 https://b23.tv/EfMi8en'});assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(r.data.sing.job);assert.ok(submissions.at(-1).relayGrant);assert.equal(JSON.stringify(r.data).includes(submissions.at(-1).relayGrant),false);}
 assert.equal(sends,0);assert.equal(JSON.stringify(h.cfg.allow.private),'["123"]');assert.equal(JSON.stringify(h.cfg.allow.groups),'["456"]');
 for(const body of [{messages:'不能夹带'},{imagePath:'fixture'},{stickerId:'fixture'},{replyToMessageId:123},{target:'private:777'},{key:'group:456',token:h.getSocialV2State('group:456').agentToken},{token:'wrong'}])assert.equal((await relay(body)).status,403);
 assert.equal(submissions.length,2);
 const grant=submissions[0].relayGrant,job='fixture-song-1',run=path.join(h.temp,'hq_cover','runs',job);fs.mkdirSync(run,{recursive:true});const file=path.join(run,'part.mp3');fs.writeFileSync(file,Buffer.alloc(4096,7));const sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const payload={target:'private:789',file,sha256,relayGrant:grant,deliveryId:'relay-fixture-delivery-1',verify:true,normalize:false,volume:1};
 // Persistent registry can be reloaded, and signature doesn't rely on process memory.
 const scope=createRelaySongScope({getConfig:()=>h.cfg,stateDir:path.join(h.temp,'state'),fetchAction:async()=>({status:'ok',retcode:0,data:[{user_id:789}]})});await scope.authorize(grant,'private:789',{filePath:file});
 assert.equal(JSON.stringify(publicCoverStatus({id:job,relay_grant:grant})).includes(grant),false);
 let v=await post('/api/voice/send',{...payload,dryRun:true});assert.equal(v.status,200,JSON.stringify(v.data));assert.equal(sends,0);
 for(const bad of [{relayGrant:undefined},{relayGrant:grant+'x'},{target:'group:999'},{file:path.join(h.temp,'other.mp3')},{text:'tts'},{normalize:true},{volume:2}]){v=await post('/api/voice/send',{...payload,...bad,dryRun:true});assert.equal(v.status,403,JSON.stringify(v.data));}
 v=await post('/api/voice/send',payload);assert.equal(v.status,200,JSON.stringify(v.data));assert.equal(v.data.verified,true);assert.equal(sends,1);
 v=await post('/api/voice/send',payload);assert.equal(v.data.verified,true);assert.equal(sends,1);
 v=await post('/api/voice/delivery-status',{target:payload.target,sha256,deliveryId:payload.deliveryId,relayGrant:grant});assert.equal(v.data.receipt.status,'verified');
 // Reconcile the fast-cache preflight-before-submit-return race from an existing job.
 const early=await scope.issue({ownerKey:'private:123',target:'private:789'});const jobsDir=path.join(h.temp,'jobs');fs.mkdirSync(jobsDir);
 fs.writeFileSync(path.join(jobsDir,job+'.json'),JSON.stringify({id:job,relay_grant:early,target:'private:789',no_send:false,pipeline:'hq-lossless-uvr-rvc-v2-full-track'}));
 await scope.authorize(early,'private:789',{filePath:file});
 for(const deny of [{private:['789']},{privates:['789']}]){h.cfg.deny=deny;await assert.rejects(scope.authorize(grant,'private:789',{filePath:file}));}h.cfg.deny={};
 const expired=createRelaySongScope({getConfig:()=>h.cfg,stateDir:path.join(h.temp,'state'),fetchAction:async()=>({status:'ok',retcode:0,data:[]}),now:()=>Date.now()+25*3600*1000});await assert.rejects(expired.authorize(grant,'private:789',{filePath:file}));
 member=false;v=await post('/api/voice/send',{...payload,dryRun:true});assert.equal(v.status,403);assert.equal(sends,1);assert.equal((await relay({})).status,403);
 console.log('PASS all-contact song-only owner authorization, live membership, duplicates/names, ordinary/video targets, durable scoped grant, task path/target binding, dryrun+actual fake gateway+receipt, removal refusal, unchanged chat whitelist; no live QQ sends');
}finally{await new Promise(r=>server.close(r));await h.close();}
