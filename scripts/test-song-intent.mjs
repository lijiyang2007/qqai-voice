// Isolated deterministic tests: no live state, QQ, GPU or wall-clock timers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSongIntentService, parseTitleOnlySongRequest, SONG_ARTIST_WAIT_MS, SONG_INTENT_STALE_MS } from '../src/song-intent.js';
const GROUP='group:12345678', OWNER='11111111', OTHER='22222222';
let passed=0;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function test(name,fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'song-intent-test-'));try{await fn(root);passed++;console.log('PASS',name);}finally{const p=path.resolve(root);assert.equal(path.dirname(p),path.resolve(os.tmpdir()));assert.ok(path.basename(p).startsWith('song-intent-test-'));fs.rmSync(p,{recursive:true,force:true});}}
function fixture(root,overrides={}){
 let time=1000000;const notices=[],resolves=[],submits=[];
 const options={stateDir:root,now:()=>time,allowed:()=>true,resolve:async(...args)=>{resolves.push(args);return {song:'Test Song Test Artist',trackId:123,artist:'Test Artist',title:'Test Song',token:'never-save'};},submit:async x=>{submits.push(x);return {job:'job-1234',token:'never-save'};},notify:async x=>{notices.push(x);return {ok:true};},...overrides};
 return {options,service:createSongIntentService(options),notices,resolves,submits,setTime:t=>time=t,advance:n=>time+=n};
}
const start=s=>s.begin({key:GROUP,title:'Test Song',requesterId:OWNER});
await test('private explicit title-only parser is narrow and deterministic',async()=>{
  for (const [text,title] of [['唱 Heatbeat','Heatbeat'],['那你给我唱一首失眠好不好','失眠'],['来翻唱《我怀念的》','我怀念的'],['来首晴天','晴天'],['来一首晴天','晴天'],['点歌：Heartbeat','Heartbeat']]) assert.equal(parseTitleOnlySongRequest(text)?.title,title,text);
  for (const text of ['你会唱啥歌','唱歌不行','别唱了','唱Childish Gambino的Heartbeat','来唱一首方大同的麦恩莉','给我唱歌手是周杰伦：晴天','https://example.com/song']) assert.equal(parseTitleOnlySongRequest(text),null,text);
});
await test('question claim persisted before callback and default full',async root=>{
 let seen;const f=fixture(root,{notify:async()=>{seen=JSON.parse(fs.readFileSync(path.join(root,'song-intents.json'),'utf8')).records[GROUP];}});
 const r=await start(f.service);assert.equal(seen.status,'asking');assert.equal(seen.claims[0].kind,'notify_ask_artist');assert.equal(r.status,'pending');assert.equal(r.mode,'full');assert.equal(r.deadline-r.created,120000);
});
await test('automatic album-original selection submits immediately exactly once',async root=>{
 const f=fixture(root);const result=await f.service.autoSelect({key:GROUP,title:'Test Song',requesterId:OWNER});assert.equal(f.submits.length,1);assert.deepEqual(f.resolves[0].slice(0,3),['Test Song',undefined,true]);assert.equal(result.status,'submitted');assert.match(f.notices.at(-1).message,/Test Artist.*job-1234/);
 const disk=fs.readFileSync(path.join(root,'song-intents.json'),'utf8');assert.ok(!disk.includes('never-save'));assert.ok(!disk.includes('token'));
});
await test('artist reply uses exact selection and claims submit before effect',async root=>{
 let disk;const f=fixture(root,{submit:async x=>{disk=JSON.parse(fs.readFileSync(path.join(root,'song-intents.json'),'utf8')).records[GROUP];assert.equal(x.key,GROUP);assert.equal(x.target,GROUP);assert.equal(x.trackId,123);return {job:'job-1234'};}});await start(f.service);await f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});assert.equal(f.resolves[0][1],'Artist');assert.equal(f.resolves[0][2],false);assert.equal(disk.status,'submitting');assert.ok(disk.claims.some(x=>x.kind==='submit'));
});
await test('group other person cannot modify cancel or replace',async root=>{
 const f=fixture(root);await start(f.service);
 for(const action of ['provideArtist','replace','cancel'])assert.throws(()=>f.service[action]({key:GROUP,requesterId:OTHER,artist:'Wrong',title:'Wrong'}),/原点歌者/);
 assert.equal((await f.service.observeMessage({key:GROUP,requesterId:OTHER,text:'歌手是Wrong'})).handled,false);assert.equal(f.service.get(GROUP).status,'pending');
});
await test('reply and timeout race single winner',async root=>{
 const gate=deferred();let calls=0;const f=fixture(root,{resolve:async()=>{calls++;return gate.promise;}});await start(f.service);f.advance(120000);
 const reply=f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});await f.service.tick();gate.resolve({song:'Test Song Artist',trackId:123,artist:'Artist',title:'Test Song'});await reply;assert.equal(calls,1);assert.equal(f.submits.length,1);
});
await test('timeout wins then artist cannot overwrite',async root=>{
 const gate=deferred();const f=fixture(root,{resolve:()=>gate.promise});await start(f.service);f.advance(120000);const tick=f.service.tick();assert.throws(()=>f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Other'}),/已开始/);gate.resolve({song:'Test Song Artist',trackId:123,artist:'Artist',title:'Test Song'});await tick;assert.equal(f.submits.length,1);
});
await test('cancel during resolve prevents later submit',async root=>{
 const gate=deferred();const f=fixture(root,{resolve:()=>gate.promise});await start(f.service);const p=f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});await Promise.resolve();assert.equal(f.service.cancel({key:GROUP,requesterId:OWNER}).cancelled,true);gate.resolve({song:'Test Song Artist',trackId:123,artist:'Artist',title:'Test Song'});await p;assert.equal(f.submits.length,0);
});
await test('cannot claim cancellation after submission starts',async root=>{
 const gate=deferred();const f=fixture(root,{submit:()=>gate.promise});await start(f.service);const p=f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});for(let n=0;n<5;n++)await Promise.resolve();assert.equal(f.service.cancel({key:GROUP,requesterId:OWNER}).cancelled,false);gate.resolve({job:'job-1234'});await p;
});
await test('replace invalidates old resolver and auto-selects replacement',async root=>{
 const first=deferred();let calls=0;const f=fixture(root,{resolve:async(title)=>{calls++;if(calls===1)return first.promise;return {song:title+' Auto Artist',trackId:456,artist:'Auto Artist',title};}});const old=await start(f.service);const p=f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});await Promise.resolve();const next=await f.service.replace({key:GROUP,requesterId:OWNER,title:'New Song'});assert.notEqual(next.id,old.id);assert.equal(next.status,'submitted');first.resolve({song:'Test Song Artist',trackId:123,artist:'Artist',title:'Test Song'});await p;assert.equal(f.submits.length,1);assert.equal(f.submits[0].trackId,456);assert.equal(f.service.get(GROUP).title,'New Song');assert.throws(()=>f.service.cancel({key:GROUP,requesterId:OWNER,intentId:old.id}),/已被替换/);
});
await test('restart resumes pending but does not reask',async root=>{
 const f=fixture(root);await start(f.service);f.advance(60000);const recovered=createSongIntentService(f.options);assert.equal(recovered.get(GROUP).status,'pending');assert.equal(f.notices.length,1);f.advance(60000);await recovered.tick();assert.equal(f.submits.length,1);
});
await test('stale restart request expires without resurrection',async root=>{
 const f=fixture(root);await start(f.service);f.advance(SONG_ARTIST_WAIT_MS+SONG_INTENT_STALE_MS+1);const recovered=createSongIntentService(f.options);assert.equal(recovered.get(GROUP).status,'expired');await recovered.tick();assert.equal(f.submits.length,0);
});
await test('all in-flight phases are uncertain on recovery',async root=>{
 for(const status of ['asking','resolving','submitting','notifying']){
  const dir=path.join(root,status);const f=fixture(dir);await start(f.service);const file=path.join(dir,'song-intents.json'),disk=JSON.parse(fs.readFileSync(file,'utf8'));disk.records[GROUP].status=status;fs.writeFileSync(file,JSON.stringify(disk));const recovered=createSongIntentService(f.options);assert.equal(recovered.get(GROUP).status,'uncertain');await recovered.tick();assert.equal(f.submits.length,0);assert.throws(()=>start(recovered),/不确定/);
 }
});
await test('submit uncertainty never replays or claims success',async root=>{
 const f=fixture(root,{submit:async()=>{throw new Error('private token secret');}});await start(f.service);await f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});assert.equal(f.service.get(GROUP).status,'uncertain');assert.ok(!fs.readFileSync(path.join(root,'song-intents.json'),'utf8').includes('secret'));assert.equal(f.notices.at(-1).type,'submission_uncertain');await f.service.tick();
});
await test('question notification uncertainty keeps timer without replaying question',async root=>{
 const types=[];const f=fixture(root,{notify:async x=>{types.push(x.type);throw new Error('network');}});await start(f.service);assert.equal(f.service.get(GROUP).status,'pending');const recovered=createSongIntentService(f.options);f.advance(120000);await recovered.tick();assert.equal(f.submits.length,1);assert.deepEqual(types,['ask_artist','submitted']);assert.equal(recovered.get(GROUP).reason,'notification_uncertain_no_replay');
});
await test('permission checked again before submit',async root=>{
 let allow=true;const f=fixture(root,{allowed:()=>allow,resolve:async()=>{allow=false;return {song:'Test Song Artist',trackId:123,artist:'Artist',title:'Test Song'};}});await start(f.service);await f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});assert.equal(f.submits.length,0);assert.equal(f.service.get(GROUP).status,'cancelled');
});
await test('explicit observer only, no bare chat or other requesters',async root=>{
 const f=fixture(root);await start(f.service);for(const text of ['孙燕姿','吃饭了','是吗？'])assert.equal((await f.service.observeMessage({key:GROUP,requesterId:OWNER,text})).handled,false);assert.equal((await f.service.observeMessage({key:GROUP,requesterId:OWNER,text:'歌手是孙燕姿'})).handled,true);assert.equal(f.resolves[0][1],'孙燕姿');
});
await test('strict key requester and path rejection',async root=>{
 const f=fixture(root);for(const key of ['../x','group:0','private:12345/x'])assert.throws(()=>f.service.begin({key,title:'song',requesterId:OWNER}));assert.throws(()=>f.service.begin({key:'private:33333333',title:'song',requesterId:OWNER}),/不一致/);assert.throws(()=>f.service.begin({key:GROUP,title:'C:\\private.wav',requesterId:OWNER}),/格式无效/);
});
await test('resolver failure gives one sanitized failure notice',async root=>{
 const f=fixture(root,{resolve:async()=>{throw new Error('secret path');}});await start(f.service);await f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});assert.equal(f.service.get(GROUP).status,'failed');assert.equal(f.submits.length,0);assert.equal(f.notices.at(-1).type,'failed');assert.ok(!JSON.stringify(f.service.list()).includes('secret'));
});
await test('permission revoked after submit never claims task cancelled',async root=>{
 let allow=true;const f=fixture(root,{allowed:()=>allow,submit:async()=>{allow=false;return {job:'job-1234'};}});await start(f.service);await f.service.provideArtist({key:GROUP,requesterId:OWNER,artist:'Artist'});assert.equal(f.service.get(GROUP).status,'submitted');assert.equal(f.service.get(GROUP).job,'job-1234');assert.equal(f.notices.length,1);
});
await test('restore strips nested extra fields and snapshots are isolated',async root=>{
 const f=fixture(root);await start(f.service);const file=path.join(root,'song-intents.json'),disk=JSON.parse(fs.readFileSync(file,'utf8'));disk.records[GROUP].claims[0].token='SECRET';disk.records[GROUP].token='SECRET';fs.writeFileSync(file,JSON.stringify(disk));const recovered=createSongIntentService(f.options);assert.ok(!fs.readFileSync(file,'utf8').includes('SECRET'));const r=recovered.get(GROUP);r.status='submitted';assert.equal(recovered.get(GROUP).status,'pending');
});
console.log(`${passed} song-intent tests passed; zero live QQ/GPU operations`);
