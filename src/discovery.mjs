const SLUG=/^[a-z0-9-]{3,80}$/;
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
function origin(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.hash||url.search)
    throw Error('HTTPS share origin required');
  return value;
}
function validate(stations){
  if(!Array.isArray(stations)||stations.length>100)throw Error('invalid discovery');
  const seen=new Set();
  for(const station of stations){
    if(!station||typeof station.id!=='string'||!SLUG.test(station.id)||seen.has(station.id)||
        typeof station.name!=='string'||!station.name.trim()||station.name.length>160||
        typeof station.description!=='string'||station.description.length>500)
      throw Error('invalid public station');
    seen.add(station.id);
  }
  return stations;
}

/** Public station metadata only. No listener identity, media URL or session key. */
export function renderDiscovery(stations,{publicOrigin}){
  const base=origin(publicOrigin);
  const cards=validate(stations).map(station=>{
    const link=new URL(`/stations/${encodeURIComponent(station.id)}`,base).href;
    return `<li><article><h2>${esc(station.name)}</h2><p>${esc(station.description)}</p>`+
      `<a href="${esc(link)}">Share live station</a></article></li>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Discover stations</title>`+
    `<main><h1>Discover live radio</h1><p>Links join the current broadcast; songs cannot be selected.</p>`+
    `<ul>${cards}</ul></main></html>`;
}

export function createDiscoveryHandler({listStations,authorizePublicStation,publicOrigin}){
  if(typeof listStations!=='function'||typeof authorizePublicStation!=='function')throw Error('Public station provider required');
  origin(publicOrigin);
  return async request=>{
    const url=new URL(request.url);
    if(request.method!=='GET'||url.pathname!=='/v1/discover')
      return new Response('Not found',{status:404});
    try{
      const stations=validate(await listStations()),publicStations=[];
      for(const station of stations)if(await authorizePublicStation(Object.freeze({id:station.id}))===true)publicStations.push(station);
      const html=renderDiscovery(publicStations,{publicOrigin});
      return new Response(html,{status:200,headers:{'content-type':'text/html; charset=utf-8',
        'cache-control':'no-store','content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'x-content-type-options':'nosniff'}});
    }catch{return new Response('Discovery unavailable',{status:503});}
  };
}
