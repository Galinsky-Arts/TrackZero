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

/** Transport requires start() readiness, close() completion and optional terminal subscription. */
export class GuestPlayer{
  constructor(adapter,onState){
    if(!adapter||typeof adapter.joinLive!=='function'||typeof onState!=='function')
      throw new Error('Live playback adapter and state callback required');
    this.adapter=adapter;this.onState=onState;this.current=null;this.epoch=0;
    this.state='STOPPED';this.closing=null;this.sealed=false;
  }
  emit(state){this.state=state;try{this.onState(state);}catch{}}
  closeSession(session){
    try{
      const result=session?.close?.();
      if(!result||typeof result.then!=='function')return null;
      const task=Promise.resolve(result).catch(()=>{this.sealed=true;this.emit('INTERRUPTED');});
      this.closing=task;
      task.finally(()=>{if(this.closing===task)this.closing=null;});
      return task;
    }catch{this.sealed=true;this.emit('INTERRUPTED');return null;}
  }
  async play(stationId){
    if(typeof stationId!=='string'||!token.test(stationId))throw new GuestError('INVALID_STATION');
    this.stop();const epoch=this.epoch;
    if(this.closing)await this.closing;
    if(epoch!==this.epoch)return;
    if(this.sealed)throw new GuestError('PLAYBACK_CLEANUP_FAILED',503);
    const controller=new AbortController();
    this.current={controller,session:null};this.emit('CONNECTING');
    try{
      const session=await this.adapter.joinLive(stationId,{signal:controller.signal});
      if(epoch!==this.epoch){this.closeSession(session);return;}
      if(!session||typeof session.close!=='function'||typeof session.start!=='function')
        throw new GuestError('INVALID_PLAYBACK_SESSION',503);
      this.current.session=session;
      if(typeof session.subscribe==='function')this.current.unsubscribe=session.subscribe(state=>{
        if(epoch===this.epoch&&state==='INTERRUPTED'){this.emit('INTERRUPTED');this.current?.controller.abort();}
      });
      await session.start();
      if(epoch!==this.epoch)return;
      if(controller.signal.aborted)throw new GuestError('PLAYBACK_INTERRUPTED',503);
      this.emit('PLAYING');
    }catch(error){
      if(epoch!==this.epoch)return;
      this.current?.controller.abort();this.current?.unsubscribe?.();
      this.closeSession(this.current?.session);this.current=null;
      this.emit('INTERRUPTED');
      throw new GuestError('PLAYBACK_INTERRUPTED',503);
    }
  }
  stop(){
    ++this.epoch;const current=this.current;this.current=null;
    current?.unsubscribe?.();current?.controller.abort();
    if(!this.sealed)this.emit('STOPPED');
    if(current?.session)this.closeSession(current.session);
    return this.closing;
  }
}

/** Bridge the DRE-11 lifetime-promise SDK to UI readiness and terminal reports.
 * createPlayback and optionsForStation are trusted application integrations.
 */
export function createDreGuestAdapter({createPlayback,optionsForStation}){
  if(typeof createPlayback!=='function'||typeof optionsForStation!=='function')
    throw new Error('DRE factory and station adapters required');
  return {async joinLive(stationId,{signal}){
    if(typeof stationId!=='string'||!token.test(stationId))throw new GuestError('INVALID_STATION');
    const options=await optionsForStation(stationId),listeners=new Set();
    let readyResolve,readyReject,run,closing,closed=false,ready=false;
    const readiness=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    readiness.catch(()=>{});
    if(typeof options?.station?.read!=='function'||typeof options?.station?.verify!=='function')
      throw new GuestError('INVALID_STATION_ADAPTER',503);
    const station={...options.station,read:async context=>{
      const snapshot=await options.station.read(context);
      if(snapshot?.program?.stationId!==stationId)throw new GuestError('STATION_SCOPE_MISMATCH',403);
      return snapshot;
    }};
    const sdk=createPlayback({...options,station,onStatus:status=>{
      if(status.state==='playing'&&!closed){ready=true;readyResolve();}
      if(status.state==='unavailable'){
        if(!ready)readyReject(new GuestError('PLAYBACK_UNAVAILABLE',503));
        for(const listener of listeners)listener('INTERRUPTED');
      }
    }});
    const close=()=>{
      if(closing)return closing;
      closed=true;readyReject(new GuestError('PLAYBACK_STOPPED',503));
      signal.removeEventListener('abort',onAbort);
      closing=Promise.resolve().then(()=>sdk.stop()).then(async status=>{
        if(run)await run;
        if(status.sealed||sdk.status().sealed)throw new GuestError('PLAYBACK_CLEANUP_FAILED',503);
      });
      return closing;
    };
    const onAbort=()=>{close().catch(()=>{});};
    signal.addEventListener('abort',onAbort,{once:true});
    if(signal.aborted)onAbort();
    return {subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
      start(){
        if(closed)return Promise.reject(new GuestError('PLAYBACK_STOPPED',503));
        if(!run){
          run=sdk.start();
          run.then(()=>{if(!ready)readyReject(new GuestError('PLAYBACK_UNAVAILABLE',503));},()=>{
            readyReject(new GuestError('PLAYBACK_UNAVAILABLE',503));
            for(const listener of listeners)listener('INTERRUPTED');
          });
        }
        return readiness;
      },close};
  }};
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
