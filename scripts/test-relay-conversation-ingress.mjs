import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {parseBilibiliRelayRequest,bilibiliRelayGuidance} from '../src/bilibili-song.js';
import {compactModelData} from '../src/qq-model-view.js';
const text='唱这个给妈妈和1621537368【“身旁的萝莉是 萌萌的Type” |《室内系的TrackMaker》-哔哩哔哩】 https://b23.tv/EfMi8en';
assert.deepEqual(parseBilibiliRelayRequest(text).recipients,['妈妈','1621537368']);
for(const t of ['别'+text,'他说“'+text+'”','https://b23.tv/EfMi8en','不要'+text])assert.equal(parseBilibiliRelayRequest(t),null);
const submitted=[];
const h=await bridgeHarness({config:{allow:{private:['123','789','1621537368'],groups:['456']},socialV2:{aliases:{'789':{name:'妈妈'}},sticker:{enabled:false}}},globals:{createCoverJobService:()=>({submit:async x=>{submitted.push(x);return {job:'fixture-ingress-'+submitted.length};},status:()=>({status:'queued'}),resolveSong:()=>{throw Error('video must not search songs');}})}});
h.setMode('reserved2');const st=h.getSocialV2State('private:123');
const msg={seq:1,messageId:'-2077182222',userId:'123',isSelf:false,text,plain:text,time:Date.now()-20000};st.recentMessages.push(msg);st.unread.push(msg);
const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
const headers={'x-console-token':'fixture-console-token','content-type':'application/json','x-agent-token':st.agentToken};
async function post(route,body){const r=await fetch(base+route,{method:'POST',headers,body:JSON.stringify({key:'private:123',token:st.agentToken,...body})});return {status:r.status,data:await r.json()};}
try{
 for(const route of ['unread','recent']){
  const r=await fetch(base+'/api/socialV2/'+route+'?key=private:123',{headers});assert.equal(r.status,200);const p=compactModelData(await r.json());assert.equal(p.relaySongRequests.length,1);assert.deepEqual(p.relaySongRequests[0].recipients.map(x=>x.candidates),[['private:789'],['private:1621537368']]);
 }
 const wait=await post('/api/socialV2/wait',{purpose:'reply',timeoutMs:20000,quietMs:10000});assert.equal(wait.status,200,JSON.stringify(wait.data));assert.equal(wait.data.relaySongRequests.length,1,'persistent conversation wait must carry routing guidance');
 for(const requestMessageId of [undefined,msg.messageId]){const r=await post('/api/socialV2/sing',{song:'唱这个 https://b23.tv/EfMi8en',mode:'full',requestMessageId});assert.equal(r.status,409);assert.equal(r.data.code,'USE_RELAY_FOR_RECIPIENTS');assert.match(r.data.error,/qq_relay_send/);}
 assert.equal(submitted.length,0);
 for(const target of ['private:789','private:1621537368']){const r=await post('/api/socialV2/relay-send',{target,song:'唱这个 https://b23.tv/EfMi8en',mode:'full'});assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(r.data.sing.job);}
 assert.deepEqual(submitted.map(x=>x.target),['private:789','private:1621537368']);assert.ok(submitted.every(x=>x.notifyKey==='private:123'&&x.videoUrl==='https://b23.tv/EfMi8en'));
 for(const key of ['group:456','private:789'])assert.deepEqual(bilibiliRelayGuidance({key,ownerQQ:'123',messages:[msg],allow:h.cfg.allow}),[]);
 assert.deepEqual(bilibiliRelayGuidance({key:'private:123',ownerQQ:'123',messages:[{...msg,userId:'789'}],allow:h.cfg.allow}),[]);
 const unresolved=bilibiliRelayGuidance({key:'private:123',ownerQQ:'123',messages:[msg],allow:{private:['123']}});assert.ok(unresolved[0].recipients.every(x=>x.candidates.length===0));
 assert.equal(h.calls.sent.length,0);console.log('PASS exact user sentence: wait/recent/unread routing, two whitelisted recipients, ordinary sing redirect with/without message ID, no local submission, owner-only guidance, zero QQ sends');
}finally{await new Promise(r=>server.close(r));await h.close();}
