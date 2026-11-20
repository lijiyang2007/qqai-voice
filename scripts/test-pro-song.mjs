// Isolated real bridge + fake resolver/worker. No production QQ, state or GPU.
import assert from 'node:assert/strict';
import {parseProSongRequest,parseProSongMessage} from '../src/pro-song.js';
const txt=text=>({type:'text',data:{text}}), at=qq=>({type:'at',data:{qq:String(qq)}});
assert.equal(parseProSongMessage([at(999),txt(' pro唱罐装毕加索的Let Me Go(共创版)')],999)?.query,'罐装毕加索的Let Me Go(共创版)');
assert.equal(parseProSongMessage([txt(' '),at(999),txt('pro唱雨爱')],999)?.query,'雨爱');
for(const segments of [[at(111),txt('pro唱雨爱')],[at('all'),txt('pro唱雨爱')],[{type:'reply',data:{id:1}},at(999),txt('pro唱雨爱')],[txt('@大肥鱼 pro唱雨爱')],[txt('他说'),at(999),txt('pro唱雨爱')]])assert.equal(parseProSongMessage(segments,999),null);
assert.equal(parseProSongMessage([txt('@大肥鱼 pro唱罐装毕加索的Let Me Go(共创版)')],999,'大肥鱼')?.query,'罐装毕加索的Let Me Go(共创版)');
for(const text of ['@别人 pro唱雨爱','@大肥鱼骗子 pro唱雨爱','他说@大肥鱼 pro唱雨爱','@大肥鱼pro唱雨爱'])assert.equal(parseProSongMessage([txt(text)],999,'大肥鱼'),null);
console.log('PASS real @ and exact current nickname text; other names and discussion rejected');
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createSongIntentService} from '../src/song-intent.js';
for(const text of ['pro唱雨爱','PRO 唱 雨爱','pro点歌《雨爱》','pro翻唱雨爱'])assert.equal(parseProSongRequest(text)?.query,'雨爱');
for(const text of ['pro','pro画雨爱','不要pro唱雨爱','他说pro唱雨爱','pro唱雨爱？','pro唱http://x','pro唱雨爱\n取消'])assert.equal(parseProSongRequest(text),null,text);
console.log('PASS anchored pro command positive and negative parsing');
const resolved=[],submitted=[],notices=[];
const h=await bridgeHarness({config:{ownerQQ:12345678,allow:{private:['12345678','23456789'],groups:['87654321']},socialV2:{sticker:{enabled:false}}},globals:{
 createCoverJobService:()=>({resolveSong:async args=>{resolved.push(args);return {song:'雨爱 Test Artist',title:'雨爱',artist:'Test Artist',trackId:11111,allowVariant:!!args.proQuery};},submit:async args=>{submitted.push(args);return {job:'fixture-pro-'+submitted.length,song:args.song};},status:()=>({status:'queued'})}),
 createSongIntentService:opts=>createSongIntentService({...opts,notify:async n=>notices.push(n)})
}});
h.setSelfIdentity('大肥鱼',999);h.setMode('reserved2');const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
async function incoming(kind,id,userId,messageId,text){await h.handleIncoming(kind,String(id),{self_id:999,user_id:userId,message_id:messageId,message:[{type:'text',data:{text}}],raw_message:text,sender:{nickname:'tester'}},h.cfg);}
async function post(key,song,extra={}){const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/socialV2/sing',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify({key,token:h.getSocialV2State(key).agentToken,song,...extra})});return {status:r.status,json:await r.json()};}
try{
 await incoming('private',12345678,12345678,101,'pro唱雨爱');assert.equal(resolved.at(-1).proQuery,'雨爱');assert.equal(submitted.at(-1).target,'private:12345678');assert.equal(submitted.at(-1).mode,'full');
 await h.handleIncoming('group','87654321',{self_id:999,user_id:12345678,message_id:102,message:[at(999),txt(' pro唱雨爱')],raw_message:'[CQ:at,qq=999] pro唱雨爱',sender:{nickname:'tester'}},h.cfg);assert.equal(resolved.at(-1).proQuery,'雨爱');assert.equal(submitted.at(-1).target,'group:87654321');assert.equal(submitted.length,2);
 assert.equal(submitted[0].allowVariant,true);assert.equal(submitted[1].allowVariant,true);
 console.log('PASS private/group ingress dispatch exact pro request and bind any-version flag');
 let r=await post('group:87654321','pro唱雨爱',{requestMessageId:'102'});assert.equal(r.status,409);assert.equal(submitted.length,2);
 r=await post('group:87654321','雨爱 Test Artist',{requestMessageId:'102'});assert.equal(r.status,409);assert.equal(submitted.length,2);
 const st=h.getSocialV2State('private:23456789');st.recentMessages=[{messageId:'103',userId:'23456789',isSelf:false,text:'唱雨爱'}];
 r=await post('private:23456789','pro唱雨爱',{requestMessageId:'103'});assert.equal(r.status,403);assert.equal(submitted.length,2);
 r=await post('private:23456789','雨爱');assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(resolved.at(-1).autoOriginalQuery,'雨爱');assert.equal(submitted.length,3);
 assert.notEqual(submitted.at(-1).allowVariant,true);
 console.log('PASS no duplicate ingress resubmit; model cannot invent pro; normal policy unchanged');
 await incoming('group',87654321,12345678,105,'@大肥鱼 pro唱罐装毕加索的Let Me Go(共创版)');
 assert.equal(resolved.at(-1).proQuery,'罐装毕加索的Let Me Go(共创版)');assert.equal(submitted.length,4);assert.equal(submitted.at(-1).allowVariant,true);assert.equal(submitted.at(-1).target,'group:87654321');
 console.log('PASS exact latest get_msg text-only group request dispatches pro');
 h.cfg.socialV2.tools.sing=false;await incoming('private',12345678,12345678,104,'pro唱雨爱');assert.equal(submitted.length,4);
 assert.equal(h.calls.sent.length,0);console.log('PASS pro respects disabled singing; zero live messages');
}finally{await new Promise(r=>server.close(r));await h.close();}
