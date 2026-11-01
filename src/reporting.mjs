const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCES={output:'OUTPUT_ISSUER',transactions:'PAYMENT_PROCESSOR',campaign:'CAMPAIGN_ISSUER'};
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const validId=value=>typeof value==='string'&&ID.test(value);

/** Presentation of scoped, issuer-backed counts only. An absent metric remains
 * unavailable, never zero. No browser field can assert output or settlement.
 */
export function renderReport(report){
  if(!report||!['artist','sponsor'].includes(report.kind)||
      ![report.tenant,report.application,report.subjectId].every(validId)||
      typeof report.title!=='string'||!report.title.trim()||report.title.length>160||
      !report.metrics||typeof report.metrics!=='object'||Array.isArray(report.metrics))
    throw Error('invalid report');
  const rows=[];
  for(const [name,label] of [['output','Verified output contributions'],
    ['transactions','Processor transactions'],['campaign','Campaign deliveries']]){
    const metric=report.metrics[name];
    if(metric==null){rows.push(`<li>${label}: unavailable</li>`);continue;}
    if(typeof metric!=='object'||metric.source!==SOURCES[name]||
        !validId(metric.evidenceId)||typeof metric.count!=='string'||
        !/^(0|[1-9][0-9]*)$/.test(metric.count)||metric.count.length>40||
        typeof metric.observedAt!=='string'||!Number.isFinite(Date.parse(metric.observedAt)))
      throw Error('unverified metric');
    rows.push(`<li>${label}: ${esc(metric.count)} (verified ${esc(metric.observedAt)})</li>`);
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(report.title)} report</title>`+
    `<main><h1>${esc(report.title)}</h1><p>Issuer and processor evidence only; unavailable means no verified result.</p>`+
    `<ul>${rows.join('')}</ul></main></html>`;
}

/** The host must authenticate a local account, authorize this report's exact
 * subject scope, and load evidence from trusted issuers. */
export function createReportHandler({authenticate,authorizeReport,loadReport}){
  if([authenticate,authorizeReport,loadReport].some(fn=>typeof fn!=='function'))
    throw Error('Trusted identity, authorization and report providers required');
  return async request=>{
    const url=new URL(request.url);
    const match=/^\/v1\/reports\/(artist|sponsor)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
    if(request.method!=='GET'||!match)return new Response('Not found',{status:404});
    try{
      const identity=await authenticate(request);
      if(!identity||![identity.tenant,identity.application,identity.userId].every(validId))
        return new Response('Unauthorized',{status:401,headers:{'cache-control':'no-store'}});
      const [_,kind,subjectId]=match;
      const scope={tenant:identity.tenant,application:identity.application,kind,subjectId};
      if(await authorizeReport(identity,scope)!==true)
        return new Response('Forbidden',{status:403,headers:{'cache-control':'no-store'}});
      const report=await loadReport(scope);
      if(!report||report.tenant!==scope.tenant||report.application!==scope.application||
          report.kind!==kind||report.subjectId!==subjectId)throw Error('report scope mismatch');
      return new Response(renderReport(report),{status:200,headers:{
        'content-type':'text/html; charset=utf-8','cache-control':'no-store',
        'content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'x-content-type-options':'nosniff'}});
    }catch{return new Response('Report unavailable',{status:503,headers:{'cache-control':'no-store'}});}
  };
}
