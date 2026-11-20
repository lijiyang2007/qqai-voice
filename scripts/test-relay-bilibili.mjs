// Real relay HTTP handler, isolated state, fake worker/gateway: never sends QQ.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { parseRelayBilibiliSong, parseBilibiliSongRequest } from '../src/bilibili-song.js';
const short='https://b23.tv/YJbX9Tr', long='https://www.bilibili.com/video/BV1mThC6LEbA';
let checks=0;
function eq(a,b){assert.equal(a,b);checks++;}
eq(parseBilibiliSongRequest(short),null);
eq(parseRelayBilibiliSong('晴天 周杰伦'),null);
eq(parseRelayBilibiliSong('【分享标题】\n'+short).url,short);
for(const s of ['https://example.com/video/BV1mThC6LEbA','http://b23.tv/YJbX9Tr',short+' '+short,long+'?p=1&p=2','https://127.0.0.1/song','https://b23.tv.evil.test/YJbX9Tr',short+' 给其他人也发']){
 assert.throws(()=>parseRelayBilibiliSong(s));checks++;
}
const submissions=[],resolutions=[];
let invalidResult=false;
const h=await bridgeHarness({config:{allow:{private:['123','789'],groups:['456']},socialV2:{sticker:{enabled:false}}},globals:{createCoverJobService:()=>({
 submit:async x=>{submissions.push(x);return invalidResult?{ok:false}:{job:'fixture-relay-'+submissions.length,song:x.song,mode:x.mode,status:'queued'};},
 resolveSong:async x=>{resolutions.push(x);return {song:'晴天 周杰伦',trackId:12345};},
 status:()=>({status:'queued'})
})}});
h.setMode('reserved2');const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
const owner={key:'private:123',token:h.getSocialV2State('private:123').agentToken};
async function post(body){const r=await fetch(base+'/api/socialV2/relay-send',{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify({...owner,target:'private:789',...body})});return {status:r.status,data:await r.json()};}
try {
 for(const target of ['private:789','group:456']){
  for(const song of [short,'唱这个 '+short,'【复制的B站标题】\n'+short,long+'?p=2&vd_source='+'a'.repeat(150)]){
   const r=await post({target,song});assert.equal(r.status,200,JSON.stringify(r.data));checks++;
   eq(r.data.sing.sourceKind,'bilibili');eq(r.data.sent,0);eq(submissions.at(-1).target,target);eq(submissions.at(-1).notifyKey,owner.key);eq(submissions.at(-1).mode,'full');
   eq(submissions.at(-1).videoUrl,song.includes('/video/')?long+'?p=2':short);
   eq(submissions.at(-1).trackId,undefined);eq(submissions.at(-1).allowVariant,undefined);
  }
 }
 eq(resolutions.length,0);
 let r=await post({song:short,mode:'chorus'});eq(r.status,200);eq(submissions.at(-1).mode,'chorus');
 r=await post({song:'晴天 周杰伦'});eq(r.status,200);eq(resolutions.length,1);eq(submissions.at(-1).trackId,12345);eq(submissions.at(-1).videoUrl,undefined);eq(submissions.at(-1).mode,'full');
 const before=submissions.length;
 for(const song of [short+' '+short,'https://example.com/audio',long+'?p=0',short+'\n另一首歌','C:\\secret.txt']){r=await post({song});assert.ok(r.status>=400);checks++;}
 for(const body of [
  {key:'private:789',token:h.getSocialV2State('private:789').agentToken},
  {key:'group:456',token:h.getSocialV2State('group:456').agentToken},
  {token:'wrong'}, {target:'private:999'}, {target:owner.key}, {mode:'bad'}
 ]){r=await post({song:short,...body});assert.ok(r.status>=400);checks++;}
 for(const tool of ['sing','relaySend']){h.cfg.socialV2.tools[tool]=false;eq((await post({song:short})).status,403);h.cfg.socialV2.tools[tool]=true;}
 h.socialV2.paused=true;eq((await post({song:short})).status,403);h.socialV2.paused=false;
 eq(submissions.length,before);
 invalidResult=true;eq((await post({song:short})).status,502);
 // Terminal notification ownership is persisted on the real notifier, not only a mock argument.
 const files=fs.readdirSync(path.join(h.temp,'state')).filter(f=>f.includes('song')&&f.endsWith('.json'));
 assert.ok(files.some(f=>fs.readFileSync(path.join(h.temp,'state',f),'utf8').includes('"notifyKey": "private:123"')));checks++;
 eq(h.calls.sent.length,0);eq(h.calls.http.filter(x=>!/(get_friend_list|get_group_list)$/.test(x.url)).length,0);
 console.log(`PASS ${checks} assertions: owner-only relay, private/group binding, Bilibili long/short/share/P, full default, preview opt-in, no resolver for video, failures to owner, no real QQ/GPU`);
} finally {await new Promise(r=>server.close(r));await h.close();}
