// Narrow capability for owner-requested HQ singing, not a global allowlist change.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const fail=message=>Object.assign(new Error(message),{statusCode:403});
export function createRelaySongScope({getConfig,fetchAction,stateDir,now=Date.now}) {
 const file=path.join(stateDir,'relay-song-grants.json');
 let grants={};if(fs.existsSync(file)){grants=JSON.parse(fs.readFileSync(file,'utf8'));if(!grants||typeof grants!=='object'||Array.isArray(grants))throw Error('Invalid relay grant registry');}
 function save(next){const temp=file+'.'+crypto.randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);grants=next;}
 function denied(target){const [kind,id]=target.split(':');const c=getConfig();return (c.deny?.[kind]??c.deny?.[kind+'s']??[]).map(String).includes(id);}
 async function list(kind=null){
  const c=getConfig(),aliases=c.socialV2?.aliases||{};
  async function get(action){const r=await fetchAction(action,{});if(r?.status!=='ok'||r?.retcode!==0||!Array.isArray(r.data))throw fail('无法核实QQ好友/群名单，未授权代唱');return r.data;}
  const friends=kind==='group'?[]:await get('get_friend_list');const groups=kind==='private'?[]:await get('get_group_list');
  return {private:friends.filter(x=>/^\d+$/.test(String(x.user_id))).map(x=>({target:'private:'+x.user_id,qq:String(x.user_id),name:String(aliases[String(x.user_id)]?.name||x.remark||x.nickname||''),nickname:String(x.nickname||''),remark:String(x.remark||'')})).filter(x=>x.qq!==String(c.ownerQQ)&&!denied(x.target)),groups:groups.filter(x=>/^\d+$/.test(String(x.group_id))).map(x=>({target:'group:'+x.group_id,group:String(x.group_id),name:String(x.group_name||'')})).filter(x=>!denied(x.target))};
 }
 async function assertMember(target){const m=/^(private|group):[1-9]\d*$/.exec(target);if(!m||denied(target))throw fail('目标无代唱权限');const l=await list(m[1]);if(![...l.private,...l.groups].some(x=>x.target===target))throw fail('代唱目标不是当前QQ好友或已加入的群');}
 function sign(data){const secret=String(getConfig().consoleToken||'');if(!secret)throw fail('缺少代唱授权签名配置');return crypto.createHmac('sha256',secret).update(data).digest('base64url');}
 async function issue({ownerKey,target}){if(ownerKey!=='private:'+String(getConfig().ownerQQ))throw fail('仅管理员私聊能授权代唱');await assertMember(target);const data=Buffer.from(JSON.stringify({v:1,purpose:'hq-owner-relay-song',ownerKey,target,nonce:crypto.randomUUID(),expires:now()+24*3600*1000})).toString('base64url');return data+'.'+sign(data);}
 function decode(token,target){if(typeof token!=='string'||token.length>4096)throw fail('代唱授权无效');const [data,mac,extra]=token.split('.');const expected=sign(data||'');if(extra||!mac||mac.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))throw fail('代唱授权校验失败');let p;try{p=JSON.parse(Buffer.from(data,'base64url').toString());}catch{throw fail('代唱授权无效');}if(p.v!==1||p.purpose!=='hq-owner-relay-song'||p.target!==target||p.ownerKey!=='private:'+String(getConfig().ownerQQ)||!Number.isFinite(p.expires)||p.expires<=now())throw fail('代唱授权已失效或目标不符');return p;}
 function bind(token,target,job){const p=decode(token,target);if(!/^[\w-]{4,64}$/.test(String(job||'')))throw fail('代唱任务号无效');if(grants[p.nonce]&&grants[p.nonce].job!==job)throw fail('代唱授权不能绑定多个任务');save({...grants,[p.nonce]:{job,target,expires:p.expires}});}
 // A cached worker can reach preflight before submit returns. Reconcile only the
 // exact signed grant already persisted by Python; this never launches/replays work.
 function reconcile(token,target){
  const c=getConfig(),jobsDir=c.socialV2?.sing?.jobsDir||path.join(c.socialV2?.sing?.root||'','jobs');
  const found=[];for(const name of fs.readdirSync(jobsDir)){if(!/^[\w-]{4,64}\.json$/.test(name))continue;let j;try{j=JSON.parse(fs.readFileSync(path.join(jobsDir,name),'utf8'));}catch{continue;}
   if(j.relay_grant===token&&j.target===target&&j.no_send===false&&j.pipeline==='hq-lossless-uvr-rvc-v2-full-track'&&name===j.id+'.json')found.push(j.id);
  }
  if(found.length!==1)throw fail('无法唯一核实代唱任务授权');bind(token,target,found[0]);
 }
 async function authorize(token,target,{filePath=null,receipt=false}={}){const c=getConfig();if(c.socialV2?.sing?.enabled===false||c.socialV2?.tools?.sing===false||c.socialV2?.tools?.relaySend===false)throw fail('管理员代唱已关闭');const p=decode(token,target);if(!grants[p.nonce])reconcile(token,target);const g=grants[p.nonce];if(!g||g.target!==target)throw fail('代唱授权尚未绑定任务');if(!receipt){const root=getConfig().socialV2?.sing?.root||'';const run=path.resolve(root,'hq_cover','runs',g.job);const candidate=path.resolve(String(filePath||''));if(!candidate.startsWith(run+path.sep))throw fail('代唱授权仅限该任务成品');const realRun=fs.realpathSync(run),realFile=fs.realpathSync(candidate);if(!realFile.startsWith(realRun+path.sep))throw fail('代唱成品路径越界');}
  await assertMember(target);return true;
 }
 return {list,assertMember,issue,bind,authorize};
}
