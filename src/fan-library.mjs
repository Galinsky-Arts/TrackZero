const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/** Renders only trusted, viewer-scoped entitlements. No client-side grant or raw media URL. */
export function renderFanLibrary(viewer,grants){
  if(!viewer||![viewer.userId,viewer.tenant,viewer.application].every(v=>typeof v==='string'&&id.test(v))||
    !Array.isArray(grants)||grants.length>500)
    throw Error('invalid library');
  const seen=new Set();
  const cards=grants.map(grant=>{
    if(!grant||grant.userId!==viewer.userId||grant.tenant!==viewer.tenant||
      grant.application!==viewer.application||typeof grant.id!=='string'||!id.test(grant.id)||
      typeof grant.title!=='string'||!grant.title.trim()||grant.title.length>200||
      !['PURCHASE','POINT_REDEMPTION','UNLOCKED_GROOVE'].includes(grant.kind)||
      !['ACTIVE','REVOKED'].includes(grant.state)||typeof grant.downloadAllowed!=='boolean'||
      (grant.state!=='ACTIVE'&&grant.downloadAllowed)||seen.has(grant.id))
      throw Error('invalid or cross-user entitlement');
    seen.add(grant.id);
    return `<li><article><h3>${esc(grant.title)}</h3><p>${esc(grant.kind.replaceAll('_',' ').toLowerCase())}</p>`+
      `<p>${grant.state==='ACTIVE'?'Available in your library':'Access revoked'}</p>`+
      `<p>${grant.downloadAllowed?'Creator-authorized download available':'Download unavailable'}</p></article></li>`;
  }).join('');
  return `<main><h1>Your library</h1><p>Radio listening remains a live linear station.</p>`+
    `<ul>${cards}</ul></main>`;
}

/** Trusted account lookup and entitlement issuer are injected by the host.
 * This endpoint discloses no media URL or download capability.
 */
export function createFanLibraryHandler({authenticate,getGrants}){
  if(typeof authenticate!=='function'||typeof getGrants!=='function')
    throw Error('Trusted identity and entitlement providers required');
  return async request=>{
    const url=new URL(request.url);
    if(request.method!=='GET'||url.pathname!=='/v1/library')
      return new Response('Not found',{status:404});
    const headers={'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options':'nosniff'};
    try{
      const account=await authenticate(request);
      if(!account||![account.userId,account.tenant,account.application].every(v=>
        typeof v==='string'&&id.test(v))||!Array.isArray(account.roles)||
        !account.roles.includes('listener'))return new Response('Unauthorized',{status:403});
      const viewer={userId:account.userId,tenant:account.tenant,application:account.application};
      const grants=await getGrants(viewer);
      const body=renderFanLibrary(viewer,grants);
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Your library</title>${body}</html>`,
        {status:200,headers});
    }catch{return new Response('Library unavailable',{status:503,
      headers:{'cache-control':'no-store'}});}
  };
}
