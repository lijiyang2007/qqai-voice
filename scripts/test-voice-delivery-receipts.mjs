// Isolated temp files only; never reads production state, sends QQ, or restarts processes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createVoiceDeliveryReceipts} from '../src/voice-delivery-receipts.js';
const input=(n=1)=>({deliveryId:'voice_delivery_'+String(n).padStart(5,'0'),target:'private:12345678',sha256:'a'.repeat(64)});
let passed=0;
async function test(name,fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-receipt-test-'));try{await fn(root);passed++;console.log('PASS',name);}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('voice-receipt-test-'));fs.rmSync(root,{recursive:true,force:true});}}
const store=r=>path.join(r,'voice-delivery-receipts.json');
const read=r=>JSON.parse(fs.readFileSync(store(r),'utf8'));
const status=(code,fn)=>assert.throws(fn,e=>e.statusCode===code);
await test('claim persists before created=true and defaults forbid retry',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root,now:()=>100});const r=s.begin(input());
 assert.equal(r.created,true);assert.equal(r.record.status,'pending');assert.equal(r.record.retryable,false);assert.deepEqual(read(root).records[input().deliveryId],r.record);
});
await test('concurrent sequential promises receive exactly one new claim',async root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});const r=await Promise.all(Array.from({length:25},()=>Promise.resolve().then(()=>s.begin(input()))));
 assert.equal(r.filter(x=>x.created).length,1);assert.equal(Object.keys(read(root).records).length,1);
});
await test('same ID target or hash mismatch rejected on begin and get',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());
 for(const modified of [{...input(),target:'group:12345678'},{...input(),sha256:'b'.repeat(64)}]){status(409,()=>s.begin(modified));status(409,()=>s.get(modified));}
});
await test('multiple IDs are independent and cross-target reads require binding',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());const other={...input(2),target:'group:87654321'};s.begin(other);s.markSent(other.deliveryId,{messageId:-123});
 assert.equal(s.get(input()).status,'pending');assert.equal(s.get(other).messageId,'-123');assert.equal(s.get(input(3)),null);status(400,()=>s.get({deliveryId:other.deliveryId}));
});
await test('sent persisted before verification and verified persists restart',root=>{
 let s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());s.markSent(input().deliveryId,{messageId:123});assert.equal(read(root).records[input().deliveryId].status,'sent');
 s=createVoiceDeliveryReceipts({stateDir:root});assert.equal(s.get(input()).status,'sent');assert.equal(s.begin(input()).created,false);
 s.markVerified(input().deliveryId,{messageId:'123'});s=createVoiceDeliveryReceipts({stateDir:root});assert.equal(s.get(input()).verified,true);assert.equal(s.begin(input()).created,false);
});
await test('pending restart becomes uncertain and never grants resend',root=>{
 let s=createVoiceDeliveryReceipts({stateDir:root,now:()=>100});s.begin(input());s=createVoiceDeliveryReceipts({stateDir:root,now:()=>200});
 assert.equal(s.get(input()).status,'uncertain');assert.equal(read(root).records[input().deliveryId].status,'uncertain');assert.equal(s.begin(input()).created,false);status(409,()=>s.markRejected(input().deliveryId,{preSend:true}));
});
await test('uncertain with message ID can be verified by readback not resent',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());s.markSent(input().deliveryId,{messageId:123});s.markUncertain(input().deliveryId);assert.equal(s.get(input()).messageId,'123');
 status(409,()=>s.markVerified(input().deliveryId,{messageId:456}));s.markVerified(input().deliveryId);assert.equal(s.get(input()).verified,true);
});
await test('late definite response can attach ID without starting another send',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());s.markUncertain(input().deliveryId);s.markSent(input().deliveryId,{messageId:'-99'});assert.equal(s.begin(input()).created,false);assert.equal(s.get(input()).status,'sent');
});
await test('no verification without durable message and IDs cannot change',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());status(409,()=>s.markVerified(input().deliveryId));s.markSent(input().deliveryId,{messageId:77});
 status(409,()=>s.markSent(input().deliveryId,{messageId:88}));s.markVerified(input().deliveryId);s.markUncertain(input().deliveryId);assert.equal(s.get(input()).status,'verified');
});
await test('definite pre-send rejection remains terminal across restart',root=>{
 let s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());status(409,()=>s.markRejected(input().deliveryId));s.markRejected(input().deliveryId,{preSend:true});
 s=createVoiceDeliveryReceipts({stateDir:root});assert.equal(s.begin(input()).created,false);assert.equal(s.get(input()).retryable,false);status(409,()=>s.markSent(input().deliveryId,{messageId:1}));
});
await test('post-send rejection forbidden',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());s.markSent(input().deliveryId,{messageId:1});status(409,()=>s.markRejected(input().deliveryId,{preSend:true}));
});
await test('path traversal and malformed inputs have no persistent effects',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});
 for(const id of ['../'.repeat(8),'a'.repeat(15),'a'.repeat(101),'a/b'.repeat(8),''])status(400,()=>s.begin({...input(),deliveryId:id}));
 for(const target of ['private:0','private:-1','group:1/../../x','private:001','other:123'])status(400,()=>s.begin({...input(),target}));
 for(const sha256 of ['a'.repeat(63),'z'.repeat(64),null])status(400,()=>s.begin({...input(),sha256}));
 assert.equal(fs.existsSync(store(root)),false);
});
await test('nonzero safe QQ ID required; negative IDs supported',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());for(const messageId of [0,'0','01',1.5,NaN,Number.MAX_SAFE_INTEGER+1,'../../x'])status(400,()=>s.markSent(input().deliveryId,{messageId}));
 s.markSent(input().deliveryId,{messageId:'-123456'});assert.equal(s.get(input()).messageId,'-123456');
});
await test('hash case normalized and returned snapshots cannot change binding',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});const r=s.begin({...input(),sha256:'A'.repeat(64),path:'SECRET'});r.record.target='group:999';const got=s.get(input());got.status='verified';
 assert.equal(s.get(input()).status,'pending');assert.equal(s.get(input()).target,input().target);assert.ok(!fs.readFileSync(store(root),'utf8').includes('SECRET'));
});
await test('corrupt store fails closed without replacement',root=>{
 fs.writeFileSync(store(root),'broken');status(503,()=>createVoiceDeliveryReceipts({stateDir:root}));assert.equal(fs.readFileSync(store(root),'utf8'),'broken');
});
await test('invalid persisted shapes and impossible states rejected',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());const base=read(root);
 for(const patch of [{status:'sent'},{status:'verified',verified:true},{target:'file:bad'},{path:'SECRET'},{retryable:true},{updatedAt:-1}]){
  const doc=structuredClone(base);Object.assign(doc.records[input().deliveryId],patch);fs.writeFileSync(store(root),JSON.stringify(doc));status(503,()=>createVoiceDeliveryReceipts({stateDir:root}));
 }
});
await test('no TTL deletes claims; capacity rejects only new IDs',root=>{
 let t=100;const s=createVoiceDeliveryReceipts({stateDir:root,now:()=>t,maxRecords:2});s.begin(input());s.begin(input(2));t+=365*86400000;
 status(507,()=>s.begin(input(3)));assert.equal(s.begin(input()).created,false);s.markSent(input().deliveryId,{messageId:100});s.markVerified(input().deliveryId);assert.equal(Object.keys(read(root).records).length,2);
});
await test('byte limit refuses new claims while state transitions retain room',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root,maxBytes:1024});let n=1;while(true){try{s.begin(input(n));n++;}catch(e){assert.equal(e.statusCode,507);break;}}
 assert.ok(n>1);for(let i=1;i<n;i++){s.markSent(input(i).deliveryId,{messageId:'-99999999999999999999'});s.markVerified(input(i).deliveryId);}assert.equal(Object.keys(read(root).records).length,n-1);
});
await test('rename failure poisons service and never authorizes a send',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});const rename=fs.renameSync;fs.renameSync=()=>{throw Error('SECRET filesystem problem');};
 try{status(503,()=>s.begin(input()));}finally{fs.renameSync=rename;}
 status(503,()=>s.begin(input()));status(503,()=>s.get(input()));assert.equal(fs.existsSync(store(root)),false);
});
await test('transition persistence failure leaves durable pending for uncertain recovery',root=>{
 const s=createVoiceDeliveryReceipts({stateDir:root});s.begin(input());const rename=fs.renameSync;fs.renameSync=()=>{throw Error('disk failure');};
 try{status(503,()=>s.markSent(input().deliveryId,{messageId:99}));}finally{fs.renameSync=rename;}
 assert.equal(read(root).records[input().deliveryId].status,'pending');const recovered=createVoiceDeliveryReceipts({stateDir:root});assert.equal(recovered.get(input()).status,'uncertain');assert.equal(recovered.begin(input()).created,false);
});
console.log(`${passed} voice delivery receipt tests passed; no QQ/network or production state touched`);
