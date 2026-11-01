const token=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const artwork=/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;
function artworkPolicy(origins){
  if(!Array.isArray(origins)||origins.length>8||origins.some(value=>{
    try{const url=new URL(value);return url.protocol!=='https:'||url.origin!==value||
      !!url.username||!!url.password||!!url.port;}catch{return true;}
  }))throw new Error('Trusted artwork origins required');
  return origins;
}
function approvedArtwork(value,origins){
  try{
    const url=new URL(value);
    return artwork.test(value)&&!value.includes('..')&&value.length<=2048&&
      !url.username&&!url.password&&!url.port&&!url.hash&&origins.includes(url.origin);
  }catch{return false;}
}
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class GuestError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
function checkStation(station){
  if(!station||typeof station!=='object'||!token.test(station.id)||
    typeof station.name!=='string'||!station.name.trim()||station.name.length>160||
    typeof station.description!=='string'||station.description.length>2000)
    throw new GuestError('INVALID_STATION');
  return station;
}
function checkAlbum(album,origins){
  if(!album||typeof album!=='object'||!token.test(album.id)||
    typeof album.title!=='string'||!album.title.trim()||album.title.length>200||
    typeof album.artist!=='string'||!album.artist.trim()||album.artist.length>160||
    (album.artworkUrl!==null&&album.artworkUrl!==undefined&&
      (typeof album.artworkUrl!=='string'||!approvedArtwork(album.artworkUrl,origins))))
    throw new GuestError('INVALID_ALBUM');
  return album;
}

/** Public metadata only. Playback tokens, media URLs and private manifests never enter HTML. */
export function renderStationPage(station,albums=[],{artworkOrigins=[]}={}){
  artworkPolicy(artworkOrigins);
  checkStation(station);
  if(!Array.isArray(albums)||albums.length>100)throw new GuestError('INVALID_ALBUMS');
  const seen=new Set();
  const cards=albums.map(item=>{
    const album=checkAlbum(item,artworkOrigins);
    if(seen.has(album.id))throw new GuestError('DUPLICATE_ALBUM');seen.add(album.id);
    const img=album.artworkUrl?`<img src="${esc(album.artworkUrl)}" alt="" loading="lazy">`:'';
    return `<li><article>${img}<h3>${esc(album.title)}</h3><p>${esc(album.artist)}</p>`+
      `<a href="/albums/${encodeURIComponent(album.id)}">Album details</a></article></li>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`+
    `<title>${esc(station.name)} radio</title><main><h1>${esc(station.name)}</h1><p>${esc(station.description)}</p>`+
    `<section aria-labelledby="live-title"><h2 id="live-title">Live radio</h2>`+
    `<button type="button" data-action="play" data-station="${esc(station.id)}">Play live station</button>`+
    `<button type="button" data-action="stop" disabled>Stop</button><p role="status" aria-live="polite">Stopped</p>`+
    `<p>Playback joins the current broadcast. Songs cannot be selected or skipped.</p></section>`+
    `<section aria-labelledby="albums-title"><h2 id="albums-title">Complete albums</h2><ul>${cards}</ul></section></main></html>`;
}
export function renderAlbumPage(album,{artworkOrigins=[]}={}){
  artworkPolicy(artworkOrigins);checkAlbum(album,artworkOrigins);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`+
    `<title>${esc(album.title)} album</title><main><a href="/">Stations</a><h1>${esc(album.title)}</h1><p>By ${esc(album.artist)}</p>`+
    `${album.artworkUrl?`<img src="${esc(album.artworkUrl)}" alt="" loading="lazy">`:''}`+
    `<p>Complete-album information. Live radio playback has no song selection.</p></main></html>`;
}

function closeQuietly(session){
  try{session?.close?.()?.catch?.(()=>{});}catch{}
}

/** Transport is an injected authenticated, endpoint-encrypted DRE playback adapter. */
export class GuestPlayer{
  constructor(adapter,onState){
    if(!adapter||typeof adapter.joinLive!=='function'||typeof onState!=='function')
      throw new Error('Live playback adapter and state callback required');
    this.adapter=adapter;this.onState=onState;this.current=null;this.epoch=0;this.state='STOPPED';
  }
  emit(state){this.state=state;this.onState(state);}
  async play(stationId){
    if(typeof stationId!=='string'||!token.test(stationId))throw new GuestError('INVALID_STATION');
    this.stop();const epoch=this.epoch;const controller=new AbortController();
    this.current={controller,session:null};this.emit('CONNECTING');
    try{
      const session=await this.adapter.joinLive(stationId,{signal:controller.signal});
      if(epoch!==this.epoch){closeQuietly(session);return;}
      if(!session||typeof session.close!=='function'||typeof session.start!=='function')
        throw new GuestError('INVALID_PLAYBACK_SESSION',503);
      this.current.session=session;
      await session.start();
      if(epoch!==this.epoch){closeQuietly(session);return;}
      this.emit('PLAYING');
    }catch(error){
      if(epoch!==this.epoch)return;
      closeQuietly(this.current?.session);this.current=null;
      this.emit('INTERRUPTED');
      throw error;
    }
  }
  stop(){
    ++this.epoch;const current=this.current;this.current=null;
    current?.controller.abort();
    try{
      const closing=current?.session?.close();
      const epoch=this.epoch;
      closing?.then?.(undefined,()=>{if(this.epoch===epoch)this.emit('INTERRUPTED');});
      this.emit('STOPPED');
    }
    catch{this.emit('INTERRUPTED');}
  }
}

/** Attach the transport-neutral controller to the station page's accessible controls. */
export function bindGuestControls(root,adapter){
  const play=root?.querySelector?.('[data-action="play"]');
  const stop=root?.querySelector?.('[data-action="stop"]');
  const status=root?.querySelector?.('[role="status"]');
  if(!play||!stop||!status)throw new Error('Guest controls required');
  const player=new GuestPlayer(adapter,state=>{
    status.textContent={STOPPED:'Stopped',CONNECTING:'Connecting to live radio',
      PLAYING:'Playing live radio',INTERRUPTED:'Playback interrupted'}[state];
    play.disabled=state==='CONNECTING'||state==='PLAYING';
    stop.disabled=state==='STOPPED';
  });
  const onPlay=()=>{player.play(play.dataset.station).catch(()=>{});};
  const onStop=()=>player.stop();
  play.addEventListener('click',onPlay);stop.addEventListener('click',onStop);
  player.emit('STOPPED');
  return ()=>{
    play.removeEventListener('click',onPlay);stop.removeEventListener('click',onStop);
    player.stop();
  };
}

export function createGuestHandler({getStation,getAlbums,getAlbum,artworkOrigins=[]}){
  if(![getStation,getAlbums,getAlbum].every(fn=>typeof fn==='function'))throw new Error('Public metadata providers required');
  artworkPolicy(artworkOrigins);
  return async request=>{
    const url=new URL(request.url);
    if(request.method!=='GET')return new Response('Method not allowed',{status:405});
    try{
      let html;
      if(url.pathname.startsWith('/stations/')){
        const id=decodeURIComponent(url.pathname.slice('/stations/'.length));
        if(!token.test(id))throw new GuestError('INVALID_STATION');
        const station=await getStation(id);
        if(!station||station.id!==id)return new Response('Not found',{status:404});
        html=renderStationPage(station,await getAlbums(id),{artworkOrigins});
      }else if(url.pathname.startsWith('/albums/')){
        const id=decodeURIComponent(url.pathname.slice('/albums/'.length));
        if(!token.test(id))throw new GuestError('INVALID_ALBUM');
        const album=await getAlbum(id);
        if(!album||album.id!==id)return new Response('Not found',{status:404});
        html=renderAlbumPage(album,{artworkOrigins});
      }else return new Response('Not found',{status:404});
      return new Response(html,{headers:{'content-type':'text/html; charset=utf-8',
        'cache-control':'public, max-age=60','content-security-policy':"default-src 'none'; script-src 'self'; img-src "+(artworkOrigins.join(' ')||"'none'")+"; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'}});
    }catch(error){return new Response(error instanceof GuestError?error.code:'Metadata unavailable',
      {status:error instanceof GuestError?error.status:503});}
  };
}
