import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createCoverJobService} from '../src/cover-job.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cover-fifo-'));const jobs=path.join(root,'jobs');fs.mkdirSync(jobs);const script=path.join(root,'fake.cjs');
fs.writeFileSync(script,`const fs=require('fs');const a=process.argv.slice(2),v=k=>a[a.indexOf(k)+1];const j={id:'new-task',song:v('--song'),target:v('--target'),mode:v('--mode'),status:'queued',created:Date.now()/1000,queue_version:1,queue_seq:2};fs.writeFileSync('jobs/new-task.json',JSON.stringify(j));console.log(JSON.stringify({ok:true,job:j.id,queue_position:1}));`);
const svc=createCoverJobService({getConfig:()=>({socialV2:{sing:{root,jobsDir:jobs,python:process.execPath,script,maxPerHourGlobal:100}}})});
try{
 fs.writeFileSync(path.join(jobs,'old.json'),JSON.stringify({id:'old',status:'running',created:1,no_send:true}));
 const r=await svc.submit({song:'song artist',target:'private:12345678'});assert.equal(r.status,'queued');assert.equal(r.etaSec,undefined);assert.equal(r.queuePosition,1);
 const s=svc.status({jobId:r.job,target:'private:12345678'});assert.equal(s.queuePosition,1);assert.equal(s.runningCount,1);
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(jobs,`extra${i}.json`),JSON.stringify({id:`extra${i}`,status:'queued',created:1}));
 await assert.rejects(svc.submit({song:'other artist',target:'group:87654321'}),/队列已满/);
 console.log('PASS busy task accepts FIFO; queue status truthful; total capacity enforced');
}finally{const p=path.resolve(root);if(path.dirname(p)!==path.resolve(os.tmpdir())||!path.basename(p).startsWith('cover-fifo-'))throw Error('unsafe cleanup');fs.rmSync(p,{recursive:true,force:true});}
