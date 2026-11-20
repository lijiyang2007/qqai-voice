// Real @self segments, or an exact current bot nickname text prefix explicitly allowed by owner.
export function parseProSongMessage(segments, selfId, selfName='') {
  if(!Array.isArray(segments) || !segments.length)return null;
  let content='',started=false;
  for(const segment of segments) {
    if(segment?.type==='text') {
      const text=String(segment.data?.text??'');
      content+=text;
      if(text.trim())started=true;
    } else if(segment?.type==='at') {
      if(started || !selfId || String(segment.data?.qq)!==String(selfId))return null;
    } else return null; // reply/forward/image/other content is not a bare command
  }
  let command=content.trimStart();
  const name=String(selfName||'').trim();
  const prefix='@'+name;
  if(name && command.startsWith(prefix) && /^[ \t\u00a0\u3000]/u.test(command.slice(prefix.length))) {
    command=command.slice(prefix.length).trimStart();
  }
  return parseProSongRequest(command);
}

// Explicit anchored command only. Never treat a mention of pro in chat as a request.
export function parseProSongRequest(value) {
  if (typeof value !== 'string' || /[\r\n\u0000-\u001f]|\[CQ:/i.test(value)) return null;
  const match=/^\s*pro\s*(?:唱(?:一首|首|一下)?|点歌|翻唱)\s*[:：]?\s*(.+?)\s*$/iu.exec(value);
  if(!match)return null;
  let query=match[1].trim();
  if(!query || query.length>80 || /[?？]|^(?:不要|别|取消|不唱)|https?:|file:|[\\/]/iu.test(query))return null;
  if((query.startsWith('《')&&query.endsWith('》'))||(query.startsWith('“')&&query.endsWith('”')))query=query.slice(1,-1).trim();
  return query ? {query,mode:'full'} : null;
}
