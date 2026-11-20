// Read-only live discovery and MCP schema check. No song submission or QQ sends.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=new URL('../',import.meta.url);
const cfg=JSON.parse(fs.readFileSync(new URL('config.json',root),'utf8').replace(/^\uFEFF/,''));
const client=new Client({name:'relay-bilibili-discovery-check',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[new URL('src/mcp-snowluma-safe.js',root).pathname.replace(/^\/(\w:)/,'$1')],stderr:'ignore'});
try {
 await client.connect(transport);
 const {tools}=await client.listTools();
 const relay=tools.find(t=>t.name==='qq_relay_send');assert.ok(relay);
 assert.match(relay.description,/B站分享链接/);assert.match(relay.inputSchema.properties.song.description,/b23\.tv/);assert.match(relay.inputSchema.properties.mode.description,/默认/);
 assert.ok(tools.some(t=>t.name==='qq_relay_targets'));
 console.log('PASS real MCP discovery: relay tools, Bilibili song input, full default');
}finally{await client.close();}
if(!process.argv.includes('--schema-only')){
 const base=`http://127.0.0.1:${cfg.consolePort||3100}`;
 const headers={'x-console-token':cfg.consoleToken,'content-type':'application/json'};
 const key=`private:${cfg.ownerQQ}`;
 const r=await fetch(base+'/api/socialV2/prompt?key='+encodeURIComponent(key),{headers,signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200);const p=await r.json();assert.match(p.singing.guidance,/管理员私聊代唱给别人/);assert.match(p.singing.guidance,/qq_relay_send/);
 assert.ok(p.enabledTools.some(s=>s.includes('qq_relay_send')));
 console.log('PASS live bridge exposes updated owner-relay Bilibili guidance');
 const denied=await fetch(base+'/api/socialV2/relay-send',{method:'POST',headers,body:JSON.stringify({key}),signal:AbortSignal.timeout(10000)});
 assert.equal(denied.status,403);console.log('PASS live relay rejects missing token before any action; no task submitted');
}
