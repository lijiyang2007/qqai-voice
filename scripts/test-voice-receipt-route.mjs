import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {bridgeHarness} from './audit-bridge-harness.mjs';
let sends=0,reads=0;
const h=await bridgeHarness({config:{sendDelayMs:0,socialV2:{sticker:{enabled:false},voice:{maxPerMinute:0,maxPerHour:0}}},globals:{createCoverJobService:()=>({status:()=>({})}),inspectAudio:async()=>({ok:true,size:4096,duration:1,codec:'mp3',warnings:[]}),fetch:async url=>{const a=new URL(url).pathname.slice(1);if(a==='send_private_msg'||a==='send_group_msg'){sends++;return {ok:true,status:200,json:async()=>({status:'ok',retcode:0,data:{message_id:-123}})};}if(a==='get_msg'){reads++;return {ok:true,status:200,json:async()=>({status:'ok',retcode:0,data:{message:[{type:'record',data:{file:'fixture'}}]}})};}return {ok:true,status:200,json:async()=>({status:'ok',retcode:0,data:{}})};}}});
h.setMode('reserved2');const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));const file=path.join(h.temp,'fixture.mp3');fs.writeFileSync(file,Buffer.alloc(4096,7));const sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function post(route,body){const r=await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',headers:{'x-console-token':'fixture-console-token','content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
try{
 const binding={deliveryId:'fixture-delivery-00001',target:'private:123',sha256};const payload={...binding,file,verify:true,normalize:false,volume:1};
 let r=await post('/api/voice/send',payload);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.verified,true);assert.equal(sends,1);
 r=await post('/api/voice/send',payload);assert.equal(r.data.verified,true);assert.equal(r.data.replayed,true);assert.equal(sends,1);
 r=await post('/api/voice/delivery-status',binding);assert.equal(r.data.receipt.status,'verified');assert.equal(r.data.receipt.messageId,'-123');assert.equal(sends,1);
 r=await post('/api/voice/delivery-status',{...binding,target:'group:456'});assert.equal(r.status,409);assert.equal(sends,1);
 r=await post('/api/voice/send',{...payload,sha256:'0'.repeat(64)});assert.equal(r.status,400);assert.equal(sends,1);
 assert.equal(h.calls.sent.length,0);console.log('PASS real route single gateway send, durable ID, replay query, target/hash binding');
}finally{await new Promise(r=>server.close(r));await h.close();}
