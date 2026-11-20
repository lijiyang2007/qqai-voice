// Offline service regression tests: no GPU, QQ messages or live configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoverJobService, publicCoverStatus } from '../src/cover-job.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cover-unit-'));
const jobsDir = path.join(root, 'jobs'); fs.mkdirSync(jobsDir);
const script = path.join(root, 'worker.cjs');
const config = { socialV2: { sing: { root, jobsDir, python: process.execPath, script, maxPerHourGlobal: 100 } } };
const service = createCoverJobService({ getConfig: () => config });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
try {
  for (const target of ['private:12345678', 'group:87654321']) {
    fs.writeFileSync(script, `const fs=require('fs');const a=process.argv.slice(2);const val=k=>a[a.indexOf(k)+1];const id='test-'+Date.now();const j={id,song:val('--song'),target:val('--target'),mode:val('--mode'),status:'done',created:Date.now()/1000};fs.writeFileSync('jobs/'+id+'.json',JSON.stringify(j));console.log(JSON.stringify({ok:true,job:id,eta_sec:1800}));`);
    await test(target + ' omitted mode defaults to full', async () => {
      const result = await service.submit({ song: '测试歌 测试歌手', target });
      assert.ok(result.job); assert.equal(result.target, target); assert.equal(result.mode, 'full');
      assert.equal(result.raw, undefined);
      assert.equal(service.status({ jobId: result.job, target }).song, '测试歌 测试歌手');
      assert.throws(() => service.status({ jobId: result.job, target: 'private:99999999' }), /不是这个会话/);
    });
  }
  await test('explicit short preview remains opt-in', async () => {
    const result = await service.submit({ song: '明确试听 测试歌手', target: 'group:87654321', mode: 'chorus' });
    assert.equal(result.mode, 'chorus');
  });
  await test('invalid target rejected', async () => assert.rejects(service.submit({ song:'x', target:'../../x' }), /当前群聊或私聊/));
  await test('invalid mode rejected', async () => assert.rejects(service.submit({ song:'x', target:'private:12345678', mode:'evil' }), /mode/));
  await test('configured private target bypasses daily limit only', async () => {
    Object.assign(config.socialV2.sing, {
      maxPerHourPerSession: 0,
      maxPerDayPerSession: 1,
      dailyUnlimitedTargets: ['private:12345678']
    });
    const result = await service.submit({ song:'不限日额测试 测试歌手', target:'private:12345678' });
    assert.ok(result.job);
    await assert.rejects(service.submit({ song:'仍受日额限制 测试歌手', target:'group:87654321' }), /今天已经点满 1 首/);
  });
  fs.writeFileSync(script, 'console.log("not-json");');
  await test('malformed output never reuses old task', async () => assert.rejects(service.submit({ song:'测试歌 测试歌手', target:'private:12345678', mode:'full' }), /无法确认新点歌/));
  fs.writeFileSync(script, 'setTimeout(()=>console.log("invalid"),150);');
  await test('simultaneous submissions serialized', async () => {
    const first = service.submit({ song:'x', target:'private:12345678' });
    await assert.rejects(service.submit({ song:'y', target:'group:87654321' }), /正在提交/);
    await assert.rejects(first, /无法确认/);
  });
  await test('review hold explained without raw diagnostic leaks', () => {
    const r=publicCoverStatus({id:'test-123',status:'failed',quality_hold:true,failure_type:'NeedsVocalReview',error:'secret C:\\internal token=xxx',stage:'held_for_review'});
    assert.equal(r.qualityHold,true); assert.match(r.error,/演唱边界/); assert.ok(!JSON.stringify(r).includes('secret'));
  });
  await test('uncertain sends prohibit retry', () => {
    const r=publicCoverStatus({status:'failed',delivery_uncertain:true});assert.equal(r.retryProhibited,true);assert.match(r.error,/禁止自动重发/);
  });
  await test('no-send is not delivery failure', () => assert.match(publicCoverStatus({status:'done',no_send:true}).error,/没有请求发送/));
  await test('cache hit is not a delivery confirmation', () => {
    const r=publicCoverStatus({status:'running',cache_hit:true,send_ok:false});
    assert.equal(r.cacheHit,true);assert.equal(r.sent,false);assert.match(r.statusHuman,/复用/);
  });
  await test('confirmed delivery', () => assert.equal(publicCoverStatus({status:'done',send_ok:true}).statusHuman,'已发送并回读确认'));
  console.log(`${passed} offline cover-job tests passed`);
} finally {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('qq-cover-unit-')) throw new Error('Unsafe cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}
