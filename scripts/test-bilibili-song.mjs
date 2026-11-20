// No QQ/network/GPU: real bridge fixture with a fake song worker.
import assert from 'node:assert/strict';
import {normalizeBilibiliSongUrl as norm,parseBilibiliSongRequest as parse,parseBilibiliSongMessage as message} from '../src/bilibili-song.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createSongIntentService} from '../src/song-intent.js';
const url='https://www.bilibili.com/video/BV1xx411c7mD';
assert.equal(norm(url+'?p=2&share_source=copy'),url+'?p=2');assert.equal(norm(url),url+'?p=1');assert.equal(norm('https://b23.tv/ABC123'),'https://b23.tv/ABC123');
for(const bad of ['http://b23.tv/ABC123','https://b23.tv.evil.test/ABC123','https://user@b23.tv/ABC123','https://b23.tv:444/ABC123','https://127.0.0.1/video/BV1xx411c7mD',url+'?p=0',url+'?p=1&p=2','https://www.bilibili.com/live/123'])assert.throws(()=>norm(bad),bad);
for(const txt of [url,'别唱 '+url,'他说唱这个 '+url,'唱这个 https://evil.test/video','唱这个 '+url+' 和 '+url])assert.equal(parse(txt),null,txt);
assert.equal(parse('唱这个 '+url+'?p=2').url,url+'?p=2');
assert.equal(parse('唱这个 【【AI翻唱】《只对你有感觉》肥鱼🐳姐妹高甜对唱🐳】https://www.bilibili.com/video/BV1qZ4v6eEA9?vd_source=abc').url,'https://www.bilibili.com/video/BV1qZ4v6eEA9?p=1');
assert.equal(message([{type:'text',data:{text:'@大肥鱼 唱这个 '+url}}],999,'大肥鱼').url,url+'?p=1');
assert.equal(message([{type:'at',data:{qq:'888'}},{type:'text',data:{text:'唱这个 '+url}}],999,'大肥鱼'),null);
console.log('PASS strict B站 URL, selected page, explicit request and negative syntax');
const submitted=[],notices=[];
const h=await bridgeHarness({config:{ownerQQ:12345678,allow:{private:['12345678'],groups:['87654321']},socialV2:{sticker:{enabled:false}}},globals:{createCoverJobService:()=>({resolveSong:async()=>{throw Error('B站 must not search original/hearts');},submit:async x=>{submitted.push(x);return {job:'video-fixture-'+submitted.length};},status:()=>({status:'queued'})}),createSongIntentService:opts=>createSongIntentService({...opts,notify:async n=>notices.push(n)})}});
h.setMode('reserved2');h.setSelfIdentity('大肥鱼',999);const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
async function incoming(kind,id,mid,segments){await h.handleIncoming(kind,id,{self_id:999,user_id:12345678,message_id:mid,message:segments,sender:{nickname:'tester'}},h.cfg);}
try{
 await incoming('private','12345678',201,[{type:'text',data:{text:'唱这个 '+url+'?p=2'}}]);
 await incoming('group','87654321',202,[{type:'at',data:{qq:'999'}},{type:'text',data:{text:' 唱这个 '+url}}]);
 assert.equal(submitted.length,2);assert.equal(submitted[0].videoUrl,url+'?p=2');assert.equal(submitted[1].videoUrl,url+'?p=1');assert.equal(submitted[1].target,'group:87654321');assert.equal(submitted[1].mode,'full');assert.equal(submitted[1].trackId,undefined);assert.ok(notices.every(n=>n.message.includes('视频本身的音质')));
 const key='group:87654321';const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/socialV2/sing',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify({key,token:h.getSocialV2State(key).agentToken,song:'唱这个 '+url,requestMessageId:'202'})});assert.equal(r.status,409);assert.equal(submitted.length,2);
 assert.equal(h.calls.sent.length,0);console.log('PASS private/group video ingress binds new video task without song search; duplicate blocked');
}finally{await new Promise(r=>server.close(r));await h.close();}
