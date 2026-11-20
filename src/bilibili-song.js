// Strict user-selected Bilibili source. Does not fetch any URL or infer a song identity.
export function normalizeBilibiliSongUrl(value) {
  if(typeof value!=='string'||value.length>2048||/[\s\x00-\x1f\\]/u.test(value))throw new Error('B站视频链接格式无效');
  let u;try{u=new URL(value);}catch{throw new Error('B站视频链接格式无效');}
  if(u.protocol!=='https:'||u.username||u.password||u.port)throw new Error('只接受HTTPS官方B站视频链接');
  const hosts=new Set(['www.bilibili.com','bilibili.com','m.bilibili.com','b23.tv']);
  if(!hosts.has(u.hostname))throw new Error('不是支持的B站视频域名');
  if(u.hostname==='b23.tv'){
    if(!/^\/[A-Za-z0-9]{4,32}\/?$/.test(u.pathname))throw new Error('B站短链接格式无效');
    return 'https://b23.tv'+u.pathname.replace(/\/$/,'');
  }
  const match=/^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,17})\/?$/.exec(u.pathname);
  if(!match)throw new Error('仅支持B站BV/av视频链接，不支持直播或其他页面');
  const pp=u.searchParams.getAll('p');
  if(pp.length>1||(pp.length&&!/^[1-9]\d{0,3}$/.test(pp[0])))throw new Error('B站分P参数无效');
  return 'https://www.bilibili.com/video/'+match[1]+'?p='+(pp[0]||'1');
}
export function parseBilibiliSongRequest(text) {
  if(typeof text!=='string'||text.length>2500||/[\x00-\x1f]/u.test(text))return null;
  const m=/^\s*(?:请(?:你)?\s*)?(?:唱(?:一下|这个|这首|一首|首)?|翻唱(?:一下|这个)?|用这个(?:视频)?唱(?:歌)?|用B站视频唱歌)\s*[:：]?\s*(?:【[^\r\n]{1,300}】\s*)?(https:\/\/\S+)\s*$/iu.exec(text);
  if(!m)return null;
  try{return {url:normalizeBilibiliSongUrl(m[1]),mode:'full'};}catch{return null;}
}
// Only the owner-authorized relay route uses this: the relay tool already expresses
// explicit singing intent, so a bare URL or copied share title is sufficient here.
// Ordinary incoming shares still require parseBilibiliSongRequest's singing verb.
export function parseRelayBilibiliSong(value) {
  const text=String(value??'').trim();
  if(!/(?:https?:\/\/|bilibili\.com|b23\.tv)/iu.test(text))return null;
  if(text.length>2500||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text))throw new Error('B站代点歌分享内容无效或过长');
  const normalized=text.replace(/[\r\n\t]+/gu,' ').trim();
  const direct=parseBilibiliSongRequest(normalized)||parseBilibiliSongRequest('唱这个 '+normalized);
  if(!direct)throw new Error('请提供单个B站视频分享链接（可带【分享标题】），不要混入其他网址或指令');
  return direct;
}

// Recognition only: never submits, never treats a number/name as authorization.
export function parseBilibiliRelayRequest(value) {
  if(typeof value!=='string'||value.length>2500)return null;
  const m=/^\s*(?:请(?:你)?\s*)?(?:唱这个|翻唱这个|唱这首)\s*给\s*([^【\r\n]{1,160}?)(?:\s*【[^\r\n]{1,300}】)?\s*(https:\/\/\S+)\s*$/iu.exec(value);
  if(!m)return null;
  const recipients=m[1].trim().replace(/听$/u,'').trim();
  if(!recipients||/[：:<>\/\\]|https?/iu.test(recipients))return null;
  try {return {url:normalizeBilibiliSongUrl(m[2]),recipients:recipients.split(/\s*(?:和|、|，|,)\s*/u).filter(Boolean)};}catch{return null;}
}

export function bilibiliRelayGuidance({key,ownerQQ,messages,allow={},aliases={},enabled=true}) {
  if(!enabled||!ownerQQ||key!=='private:'+String(ownerQQ))return [];
  return (messages||[]).filter(m=>!m.isSelf&&String(m.userId)===String(ownerQQ)).flatMap(m=>{
    const request=parseBilibiliRelayRequest(m.plain||m.text||'');if(!request)return [];
    const candidates=[...(allow.private||[]).map(id=>({target:'private:'+id,id:String(id),name:String(aliases[String(id)]?.name||'')})),...(allow.groups||[]).map(id=>({target:'group:'+id,id:String(id),name:''}))].filter(t=>t.target!==key);
    const recipients=request.recipients.map(name=>{const matches=candidates.filter(t=>t.id===name||t.target===name||t.name===name);return {name,candidates:matches.map(t=>t.target)};});
    return [{requestMessageId:String(m.messageId||m.seq||''),song:'唱这个 '+request.url,mode:'full',recipients,
      instruction:'这是管理员要求唱给别人，不是唱给当前会话。先调用qq_relay_targets查全部真实QQ好友/已加入群并核对每个收件人；这里的candidates只是旧聊天白名单候选，空数组不代表不能代唱，以实时名单为准。非聊天白名单目标只传song，不夹带文字或图片；同一请求含多个人时逐个调用qq_relay_send，每次target只填一个核实过的目标，song用这里的链接，key/token仍是当前管理员私聊。不要调用qq_sing，不要先唱给管理员再转发。找不到或重名的收件人先问，不能猜；不要重做已有job的目标。此提示仅识别请求，不代表已提交；旧消息只供上下文，不自动补发。'}];
  });
}

export function parseBilibiliSongMessage(segments,selfId,selfName='') {
  if(!Array.isArray(segments)||!segments.length)return null;
  let text='',started=false;
  for(const s of segments){
    if(s?.type==='text'){const t=String(s.data?.text??'');text+=t;if(t.trim())started=true;}
    else if(s?.type==='at'){if(started||!selfId||String(s.data?.qq)!==String(selfId))return null;}
    else return null;
  }
  let command=text.trimStart();const name=String(selfName||'').trim(),prefix='@'+name;
  if(name&&command.startsWith(prefix)&&/^[ \t\u00a0\u3000]/u.test(command.slice(prefix.length)))command=command.slice(prefix.length).trimStart();
  return parseBilibiliSongRequest(command);
}
