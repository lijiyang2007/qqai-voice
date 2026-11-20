// Read-only: real QQ membership and owner-only bridge discovery; no submissions.
import fs from 'node:fs';import assert from 'node:assert/strict';import {createRelaySongScope} from '../src/relay-song-scope.js';
const root=new URL('../',import.meta.url),cfg=JSON.parse(fs.readFileSync(new URL('config.json',root),'utf8').replace(/^\uFEFF/,''));
async function action(name,params){const r=await fetch(String(cfg.snowluma.httpUrl).replace(/\/$/,'')+'/'+name,{method:'POST',headers:{'content-type':'application/json',...(cfg.snowluma.accessToken?{authorization:'Bearer '+cfg.snowluma.accessToken}:{})},body:JSON.stringify(params),signal:AbortSignal.timeout(15000)});assert.ok(r.ok);return r.json();}
const scope=createRelaySongScope({getConfig:()=>cfg,fetchAction:action,stateDir:new URL('state/',root).pathname.replace(/^\/(\w:)/,'$1')});const contacts=await scope.list();
const outside=x=>{const [kind,id]=x.target.split(':');return !(cfg.allow?.[kind==='group'?'groups':'private']||[]).map(String).includes(id);};
console.log(JSON.stringify({friends:contacts.private.length,groups:contacts.groups.length,outsideChatWhitelist:contacts.private.filter(outside).length+contacts.groups.filter(outside).length,noQQSend:true}));
if(process.argv.includes('--gateway-only'))process.exit(0);
const state=JSON.parse(fs.readFileSync(new URL('state/social-v2.json',root),'utf8'));const key='private:'+cfg.ownerQQ;
function find(o){if(!o||typeof o!=='object')return null;if(o[key]?.agentToken)return o[key].agentToken;for(const v of Object.values(o)){if(v&&typeof v==='object'){const t=find(v);if(t)return t;}}return null;}
const token=find(state);assert.ok(token,'owner token missing');const base='http://127.0.0.1:'+(cfg.consolePort||3100);
const r=await fetch(base+'/api/socialV2/relay-targets?key='+encodeURIComponent(key),{headers:{'x-console-token':cfg.consoleToken,'x-agent-token':token},signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);const live=await r.json();assert.equal(live.private.length,contacts.private.length);assert.equal(live.groups.length,contacts.groups.length);assert.ok([...live.private,...live.groups].every(x=>x.canRelaySong===true&&typeof x.canRelayMessages==='boolean'));
console.log('PASS live owner-only target discovery lists actual friends/groups with separate singing/chat permissions; no task or message sent');
