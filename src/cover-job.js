// 点歌通道：把「有人要听 AI 唱歌」变成一次本地翻唱任务提交。
//
// 为什么要有这个模块（而不是让 QQ 会话自己跑 pwsh）：
//   QQ 仿真会话的工具面被 plugins/qq-agent-presets/qq-tool-restrict.mjs 锁死成白名单
//   （只有 QQ MCP 工具 + 无害模型侧工具），没有 pwsh / skill / read / schedule_create。
//   而翻唱流水线（<AI-Song 安装目录>\cover_job.py + Seed-VC）恰恰需要本地进程。
//   所以真正需要开放给模型的只有「提交一首歌」**这一个动作**：
//     · 参数收窄 —— 只有歌名与模式，没有路径、没有命令、没有参数拼接；
//     · 目标会话由桥接按会话令牌强制绑定 —— 模型无法把歌发到别的会话；
//     · 跑完由 cover_job.py 自己经控制台操作员通道发回原会话。
//   模型因此**拿不到**本地执行能力，只拿到一次受控的任务提交。
//
// 限频不用内存计数器，而是直接扫 <root>/jobs/*.json：
//   · 跨桥接重启有效（内存计数器会丢）；
//   · 把 GUI 侧手动提交的任务也算进来 —— GPU 只有一块，谁提交的都该占额度；
//   · 并发闸门同理：有 queued/running 就不接新单，避免 8 GB 显存被两个任务互相拖死。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { normalizeBilibiliSongUrl } from './bilibili-song.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const SUBMIT_TIMEOUT_MS = 30000;
const MAX_SONG_CHARS = 80;
const MAX_SCAN_JOBS = 300;

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 歌名清洗：去掉控制字符与多余空白，长度封顶。命令行参数走 spawn 数组，不经 shell。 */
export function cleanSong(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, MAX_SONG_CHARS);
}

/** 任务 id 白名单：cover_job.py 生成的是「月日-时分秒-4位hex」，只放行这套字符。 */
export function isSafeJobId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(id);
}

// A model-facing projection: never expose local paths, transport credentials or raw tracebacks.
export function publicCoverStatus(job) {
  const status = String(job?.status ?? 'unknown');
  const uncertain = job.delivery_uncertain === true;
  const hold = job.quality_hold === true;
  const stage = /^[a-z_]{1,50}$/.test(String(job.stage ?? '')) ? job.stage : undefined;
  const out = {
    job: job.id, song: job.song || '', mode: job.mode, status, stage,
    sent: job.send_ok === true,
    noSend: job.no_send === true,
    cacheHit: job.cache_hit === true,
    qualityHold: hold, deliveryUncertain: uncertain,
    retryProhibited: uncertain || job.retry_prohibited === true,
    statusHuman: uncertain ? '发送结果待核实，禁止重发' : hold ? '质量检查暂停，需管理员复核'
      : ({ queued: '排队中', running: '正在进行高质量处理', done: '制作完成', failed: '处理未完成' }[status] || '状态待核实')
  };
  if (uncertain) out.error = '发送可能已受理或已发出，尚未回读确认；请管理员核对当前会话，禁止自动重发。';
  else if (job.failure_type === 'NeedsReview') out.error = '歌名、歌手或发行版本需要确认；请确认准确歌曲版本后再点。';
  else if (job.failure_type === 'BilibiliSourceError') out.error = '指定B站视频的访问、完整音轨或解码检查未通过；未继续制作，请检查链接、分P或视频访问限制。';
  else if (job.failure_type === 'SourceError') out.error = '未取得通过校验的无损音源，已暂停；不会改用低音质来源。';
  else if (job.failure_type === 'DeliveryHeld') out.error = '成品交付检查未通过，已保留母带；请管理员检查，勿自动重发。';
  else if (stage === 'queue_expired') out.error = '排队等待已达到上限，尚未启动制作或发送；请稍后重新点歌。';
  else if (job.queue_blocked === true) out.error = '监督进程清理结果待核实，队列已暂停；请管理员检查，禁止自动重放任务。';
  else if (status === 'failed') out.error = '高质量任务未完成；请管理员查看本地诊断，不要自动重提。';
  else if (status === 'done' && job.send_ok !== true) out.error = job.no_send === true ? '仅制作测试，没有请求发送。' : '成品已生成，但尚未确认发送成功。';
  if (job.cache_hit === true && status !== 'failed') out.statusHuman = '已复用校验通过的完整成品，等待发送确认';
  if (job.send_ok === true) out.statusHuman = '已发送并回读确认';
  return out;
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * @param {object} options
 * @param {() => object} options.getConfig 返回当前配置对象（桥接会热更新 cfg）
 * @param {string} options.stateDir  state 目录
 * @param {(msg: string) => void} [options.log]
 */
export function createCoverJobService({ getConfig, stateDir, log = () => {} }) {
  // Serialize the check+submit window as well as persisted active jobs.
  let submitting = false;
  function cfgOf() {
    const s = getConfig()?.socialV2?.sing ?? {};
    const root = String(s.root ?? 'D:/AI-Song').replace(/[\\/]+$/, '') || 'D:/AI-Song';
    return {
      enabled: s.enabled !== false,
      root,
      python: String(s.python ?? '').trim() || path.join(root, 'runtime', 'venv-seedvc', 'Scripts', 'python.exe'),
      script: String(s.script ?? '').trim() || path.join(root, 'cover_job.py'),
      jobsDir: String(s.jobsDir ?? '').trim() || path.join(root, 'jobs'),
      maxPerHourPerSession: num(s.maxPerHourPerSession, 3, 0, 50),
      maxPerDayPerSession: num(s.maxPerDayPerSession, 8, 0, 200),
      dailyUnlimitedTargets: new Set((Array.isArray(s.dailyUnlimitedTargets) ? s.dailyUnlimitedTargets : [])
        .map((target) => String(target ?? '').trim())
        .filter((target) => /^(group|private):[1-9]\d{4,19}$/.test(target))),
      maxPerHourGlobal: num(s.maxPerHourGlobal, 6, 0, 100),
      maxQueuedTotal: num(s.maxQueuedTotal, 5, 1, 5),
      etaChorusSec: num(s.etaChorusSec, 300, 10, 3600),
      etaFullSec: num(s.etaFullSec, 1500, 10, 7200)
    };
  }

  /** 读最近的任务 JSON（按 mtime 取最新 N 个）。读不到就当空，不抛。 */
  function recentJobs(jobsDir) {
    let names = [];
    try {
      names = fs.readdirSync(jobsDir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const rows = [];
    for (const name of names) {
      const file = path.join(jobsDir, name);
      try {
        rows.push({ file, mtime: fs.statSync(file).mtimeMs });
      } catch {}
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    const out = [];
    for (const row of rows.slice(0, MAX_SCAN_JOBS)) {
      try {
        out.push(JSON.parse(fs.readFileSync(row.file, 'utf8')));
      } catch {}
    }
    return out;
  }

  function createdAtMs(job) {
    const t = Number(job?.created);
    return Number.isFinite(t) ? t * 1000 : 0;
  }

  /** 当前正在跑（含排队）的任务数：GPU 闸门。 */
  function activeJobs(jobsDir) {
    return recentJobs(jobsDir).filter((j) => j?.status === 'queued' || j?.status === 'running');
  }

  function quotaError(c, jobs, target) {
    const now = Date.now();
    const mine = jobs.filter((j) => String(j?.target ?? '') === target);
    const mineHour = mine.filter((j) => now - createdAtMs(j) < HOUR).length;
    const mineDay = mine.filter((j) => now - createdAtMs(j) < DAY).length;
    const globalHour = jobs.filter((j) => now - createdAtMs(j) < HOUR).length;
    if (c.maxPerHourPerSession > 0 && mineHour >= c.maxPerHourPerSession) {
      return `这个会话一小时最多点 ${c.maxPerHourPerSession} 首，等会儿再来点吧`;
    }
    if (!c.dailyUnlimitedTargets.has(target) && c.maxPerDayPerSession > 0 && mineDay >= c.maxPerDayPerSession) {
      return `这个会话今天已经点满 ${c.maxPerDayPerSession} 首了，明天再唱`;
    }
    if (c.maxPerHourGlobal > 0 && globalHour >= c.maxPerHourGlobal) {
      return `现在唱歌排队太多了（一小时上限 ${c.maxPerHourGlobal} 首），过会儿再点`;
    }
    return null;
  }

  /**
   * 同一会话「正在排队 / 正在制作」的同一首歌只受理一次。
   *
   * 为什么只在 active 窗口内拦：已经唱完并且发成功的歌，过一阵子再点一次是
   * 正常需求（想再听一遍），不该被永久拒绝；真正要防的是同一首歌被连点两遍，
   * 白占一块 GPU、还往群里发两条一样的语音。失败/不确定的任务不在此列 ——
   * 那种情况本来就该允许重新点。
   *
   * 识别同时用 track_id 与归一化歌名：前者能抓住「换个歌名写法点同一首歌」，
   * 后者兜住解析失败、没有 track_id 的提交。
   */
  function normalizeSongKey(song) {
    return String(song ?? '')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[（）()【】\[\]『』「」《》<>·・,，.。!！?？~～\-—_]/g, '');
  }

  function duplicateActiveJob(jobs, target, song, trackId) {
    const wantName = normalizeSongKey(song);
    const wantTrack = Number.isSafeInteger(trackId) && trackId > 0 ? trackId : null;
    return activeJobs0(jobs).find((j) => {
      if (String(j?.target ?? '') !== target) return false;
      const otherTrack = Number.isSafeInteger(Number(j?.track_id)) && Number(j?.track_id) > 0 ? Number(j.track_id) : null;
      if (wantTrack !== null && otherTrack !== null) return wantTrack === otherTrack;
      return wantName.length > 0 && normalizeSongKey(j?.song) === wantName;
    }) ?? null;
  }

  /** 同 activeJobs，但直接对已读到的 jobs 数组过滤，避免二次扫盘。 */
  function activeJobs0(jobs) {
    return (jobs ?? []).filter((j) => j?.status === 'queued' || j?.status === 'running');
  }

  /**
   * 提交一首翻唱。
   * @param {{song: string, mode?: 'chorus'|'full', target: string, callerLabel?: string}} input
   *        target 必须由桥接按会话令牌算出，绝不接受模型自报。
   */
  async function submit(input) {
    if (submitting) throw httpError('正在提交上一首点歌，请稍后查看进度，不要重复提交', 429);
    submitting = true;
    try { return await submitOnce(input); }
    finally { submitting = false; }
  }

  async function submitOnce({ song, mode = 'full', target, trackId, allowVariant=false, videoUrl, relayGrant }) {
    if (!/^(group|private):[1-9]\d{4,19}$/.test(String(target ?? ''))) {
      throw httpError('点歌目标必须是桥接绑定的当前群聊或私聊', 400);
    }
    const c = cfgOf();
    if (!c.enabled) throw httpError('点歌功能已关闭（socialV2.sing.enabled=false）', 403);

    const wanted = cleanSong(song);
    if (!wanted) throw httpError('歌名不能为空：请给我一个具体歌名（可以带歌手）', 400);

    const m = String(mode ?? 'full').toLowerCase();
    if (m !== 'chorus' && m !== 'full') {
      throw httpError('mode 只能是 full（整首，默认）或 chorus（明确要求短试听时使用）', 400);
    }

    if (!fs.existsSync(c.python)) {
      throw httpError('翻唱运行时不可用，请管理员检查安装配置', 503);
    }
    if (!fs.existsSync(c.script)) {
      throw httpError('翻唱处理入口不可用，请管理员检查安装配置', 503);
    }

    const jobs = recentJobs(c.jobsDir);

    // 去重优先于配额：同一首已经在排队/制作中，就别再建第二个任务。
    const dup = duplicateActiveJob(jobs, target, wanted, trackId);
    if (dup) {
      const where = dup.status === 'running' ? '正在制作' : '正在排队';
      throw httpError(
        `这首歌${where}了（任务 ${dup.id}），不用重复点，做完会直接发到这个会话；要看进度可以查任务状态`,
        409
      );
    }

    const quota = quotaError(c, jobs, target);
    if (quota) throw httpError(quota, 429);

    const active = activeJobs(c.jobsDir);
    if (active.length >= c.maxQueuedTotal) {
      throw httpError(`点歌队列已满（制作中和等待共 ${c.maxQueuedTotal} 首），请稍后再点；未提交新任务`, 429);
    }

    if (trackId !== undefined && (!Number.isSafeInteger(trackId) || trackId <= 0)) throw httpError('解析后的歌曲标识无效', 400);
    const args = [c.script, 'submit', '--song', wanted, '--target', target, '--mode', m];
    if(relayGrant!==undefined){
      if(typeof relayGrant!=='string'||!relayGrant||relayGrant.length>4096)throw httpError('代唱授权无效',400);
      args.push('--relay-grant',relayGrant);
    }
    if(videoUrl) {
      if(trackId!==undefined || allowVariant) throw httpError('视频来源不能混用歌曲ID或版本许可',400);
      args.push('--video-url',normalizeBilibiliSongUrl(videoUrl));
    }
    if (trackId !== undefined) args.push('--track-id', String(trackId));
    if (allowVariant===true) {
      if(!Number.isSafeInteger(trackId)||trackId<=0) throw httpError('pro选版必须绑定准确歌曲标识',400);
      args.push('--allow-variant');
    }
    const started = Date.now();
    const result = await runSubmit(c, args, wanted, target, m);
    const etaSec = m === 'full' ? c.etaFullSec : c.etaChorusSec;
    log(`[sing] 提交 ${target} 《${wanted}》 mode=${m} → job=${result.job ?? '?'} (${Date.now() - started}ms)`);
    return {
      job: result.job ?? null,
      song: wanted,
      mode: m,
      target,
      queuePosition: result.queuePosition ?? null,
      queueCapacity: 5,
      etaHuman: '高质量处理耗时不固定，短试听也需要完整处理，不承诺完成时间',
      note: '仅表示任务已提交，不代表正在制作或发送成功。先根据返回status如实说明；用户问进度必须查qq_sing_status，不凭旧提交结果说还在做。失败/暂停会由桥接主动通知，发送不确定禁止重发。',
      ...publicCoverStatus(recentJobs(c.jobsDir).find(j=>j.id===result.job) || {id:result.job,song:wanted,mode:m,status:'queued'})
    };
  }

  function runSubmit(c, args, song, target, mode) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(c.python, args, {
          cwd: c.root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // Windows 控制台默认 cp936：不强制 UTF-8 的话中文歌名回传会变成乱码，
            // 下面解析 stdout JSON 就会失败。
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            // 让 cover_job.py 用桥接当前的控制台端口/令牌（配置改了也不用改脚本）。
            QQ_CONSOLE_TOKEN: String(getConfig()?.consoleToken ?? ''),
            QQ_CONSOLE_PORT: String(getConfig()?.consolePort ?? 3100)
          }
        });
      } catch (error) {
        reject(httpError('启动翻唱任务失败，请管理员检查本机运行环境', 500));
        return;
      }

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });

      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(httpError('提交结果不确定（30 秒未返回）；后台可能已创建任务，请核对任务记录，禁止自动重提', 504));
      }, SUBMIT_TIMEOUT_MS);
      timer.unref?.();

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(httpError('启动翻唱任务失败，请管理员检查本机运行环境', 500));
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // Child diagnostics can contain local paths or signed source URLs.
          reject(httpError(`提交翻唱任务未确认成功（exit ${code}）；请管理员核对后台记录，不要自动重提`, 500));
          return;
        }
        let parsed = null;
        const text = stdout.trim();
        if (text) {
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start >= 0 && end > start) {
            try { parsed = JSON.parse(text.slice(start, end + 1)); } catch {}
          }
        }
        if (parsed?.ok === true && isSafeJobId(parsed.job)) {
          const job = recentJobs(c.jobsDir).find((j) => j.id === parsed.job);
          if (job && job.target === target && job.song === song && job.mode === mode) {
            resolve({ job: parsed.job, queuePosition: Number.isInteger(parsed.queue_position) && parsed.queue_position > 0 ? parsed.queue_position : null });
            return;
          }
        }
        // Never mistake an old task for this submission when stdout is malformed.
        reject(httpError('无法确认新点歌任务的身份；请管理员核对后台记录，禁止自动重提', 502));
      });
    });
  }

  /**
   * 查任务状态。只允许查**本会话**提交的任务（防跨会话窥探）。
   */
  function status({ jobId, target }) {
    const c = cfgOf();
    if (!isSafeJobId(jobId)) throw httpError('job id 格式不对', 400);
    const file = path.join(c.jobsDir, `${jobId}.json`);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw httpError(`找不到这个任务：${jobId}`, 404);
    }
    if (String(job?.target ?? '') !== target) {
      throw httpError('这个任务不是这个会话点的，看不了', 403);
    }
    const out = publicCoverStatus(job);
    if (job.status === 'queued') {
      const all = activeJobs(c.jobsDir);
      const queued = all.filter(j => j.status === 'queued').sort((a,b) => Number(a.queue_version === 1)-Number(b.queue_version === 1) || Number(a.queue_seq || 0)-Number(b.queue_seq || 0) || Number(a.created)-Number(b.created) || String(a.id).localeCompare(String(b.id)));
      out.queuePosition = queued.findIndex(j => j.id === job.id) + 1 || null;
      out.runningCount = all.filter(j => j.status === 'running').length;
      out.queueWaitDeadline = job.queue_deadline ? new Date(job.queue_deadline * 1000).toISOString() : null;
      out.note = '按先后顺序串行处理；等待资源不占制作执行时限。不估算开始时间，旧任务状态不明需管理员核实。';
    }
    return out;
  }

  async function resolveSong({ title, artist, autoSelect = false, query, autoOriginalQuery, proQuery }) {
    const c = cfgOf();
    const args = ['-B', '-m', 'hq_cover.song_resolver', 'resolve'];
    if (proQuery) args.push('--pro-query', cleanSong(proQuery));
    else if (autoOriginalQuery) args.push('--auto-original-query', cleanSong(autoOriginalQuery));
    else if (query) args.push('--query', cleanSong(query));
    else {
      if (!cleanSong(title)) throw httpError('请提供具体歌名', 400);
      args.push('--title', cleanSong(title));
      if (artist) args.push('--artist', cleanSong(artist));
      if (autoSelect) args.push('--auto-select');
    }
    return new Promise((resolve, reject) => {
      const child = spawn(c.python, args, { cwd:c.root, windowsHide:true, stdio:['ignore','pipe','pipe'], env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'} });
      let output='';
      child.stdout.on('data', d => { output+=d.toString('utf8'); if(output.length>65536) child.kill(); });
      child.stderr.on('data', () => {});
      const timer=setTimeout(()=>{child.kill();reject(httpError('选歌查询超时，尚未提交制作任务',504));},55000);timer.unref?.();
      child.on('error',()=>{clearTimeout(timer);reject(httpError('选歌服务暂不可用',503));});
      child.on('exit',code=>{
        clearTimeout(timer);
        try {
          const result=JSON.parse(output.trim());
          if(result?.ok===true && Number.isSafeInteger(result.track_id) && result.track_id>0 && typeof result.song==='string') {
            resolve({ song:cleanSong(result.song),trackId:result.track_id,title:cleanSong(result.title),artist:(Array.isArray(result.artists)?result.artists.map(x=>typeof x==='string'?x:x.name).join(' / '):String(result.artists||'')),source:result.source,allowVariant:!!proQuery && result.allow_variant===true });return;
          }
          if(query && result?.code==='catalog_miss') {resolve(null);return;}
          reject(httpError(proQuery ? 'pro未找到歌名准确匹配且具有完整无损音源的可用版本；未跳过授权或音频校验' : autoOriginalQuery ? '没有找到可按原唱徽标或红心收藏数安全确定且可用的录音室版本' : '无法确定可用的准确歌曲版本，请补充歌手或稍后再试',409));
        } catch {reject(httpError('选歌服务未返回有效结果，尚未提交制作任务',502));}
      });
    });
  }

  return { cfgOf, submit, status, recentJobs, activeJobs, resolveSong };
}
