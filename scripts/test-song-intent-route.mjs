// Real bridge routes, fake resolver/QQ, temporary persistent state only.
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createSongIntentService } from '../src/song-intent.js';
const submitted=[],notices=[],resolved=[];let service;
const h=await bridgeHarness({config:{ownerQQ:12345678,allow:{private:['12345678','23456789'],groups:['87654321']},socialV2:{sticker:{enabled:false}}},globals:{
 createCoverJobService:()=>({resolveSong:async args=>{resolved.push(args);const title=args.autoOriginalQuery||args.title||'Heartbeat';return {song:title+' Auto Artist',title,artist:'Auto Artist',trackId:11111};},submit:async input=>{submitted.push(input);return {job:'fixture-job-'+submitted.length};}}),
 createSongIntentService:opts=>(service=createSongIntentService({...opts,notify:async message=>{notices.push(message);}}))
}});
h.setMode('reserved2');const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
async function post(key,song,extra={}){const token=h.getSocialV2State(key).agentToken;const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/socialV2/sing',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify({key,token,song,...extra})});return {status:r.status,json:await r.json()};}
try{
 const key='private:12345678';let r=await post(key,'等歌手：Heartbeat');assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.waitingForArtist,false);assert.match(r.json.job,/fixture-job/);assert.equal(submitted.length,1);assert.equal(resolved[0].autoOriginalQuery,'Heartbeat');assert.equal(submitted[0].mode,'full');assert.equal(submitted[0].target,key);
 console.log('PASS legacy wait_artist action now immediately selects explicitly labeled original');
 r=await post(key,'Heartbeat Childish Gambino');assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(resolved.at(-1).autoOriginalQuery,'Heartbeat Childish Gambino');console.log('PASS direct song query uses album-original resolver');
 const autoKey='private:23456789';
 await h.handleIncoming('private','23456789',{self_id:999,user_id:23456789,message_id:9,message:[{type:'text',data:{text:'来首晴天'}}],raw_message:'来首晴天',sender:{nickname:'点歌者'}},h.cfg);
 assert.equal(service.get(autoKey).title,'晴天');assert.equal(service.get(autoKey).status,'submitted');assert.equal(submitted.at(-1).target,autoKey);assert.equal(h.calls.prompts.length,0);console.log('PASS private ingress immediately selects explicitly labeled original without model tool call');
 const group='group:87654321';const st=h.getSocialV2State(group);st.recentMessages=[{messageId:'10',userId:'12345678',text:'唱晴天',isSelf:false}];
 r=await post(group,'晴天',{action:'wait_artist',requestMessageId:'10'});assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.waitingForArtist,false);assert.match(r.json.job,/fixture-job/);
 console.log('PASS group legacy action also immediately auto-selects');
 assert.equal(h.calls.sent.length,0);assert.ok(notices.every(x=>x.type!=='ask_artist'));
}finally{await new Promise(r=>server.close(r));await h.close();}
