const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const valid=value=>typeof value==='string'&&ID.test(value);
const kinds=new Set(['TIP','ALBUM_GIFT','SPONSOR_SUPPORT']);
export class SupportError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}

/** Initiates only a provider-owned pending intent. The client supplies an
 * explicit amount but cannot assert price, rights, recipient consent or payment.
 */
export function createSupportHandler({authenticate,validateTarget,validateRecipient,commerce}){
  if([authenticate,validateTarget,validateRecipient].some(fn=>typeof fn!=='function')||
      !commerce||typeof commerce.startSupportIntent!=='function')
    throw Error('Trusted support providers required');
  return async request=>{
    const url=new URL(request.url);
    const respond=(status,value)=>new Response(JSON.stringify(value),{status,
      headers:{'content-type':'application/json','cache-control':'no-store'}});
    if(request.method!=='POST'||url.pathname!=='/v1/support/intents')
      return respond(404,{error:'NOT_FOUND'});
    try{
      if(request.headers.get('origin')!==url.origin)throw new SupportError('ORIGIN_DENIED',403);
      const identity=await authenticate(request);
      if(!identity||![identity.tenant,identity.application,identity.userId].every(valid))
        throw new SupportError('AUTH_REQUIRED',401);
      const key=request.headers.get('idempotency-key');
      if(!valid(key)||key.length<20)throw new SupportError('IDEMPOTENCY_KEY_REQUIRED');
      const raw=await request.text();
      if(raw.length>2048)throw new SupportError('BODY_TOO_LARGE',413);
      let body;try{body=JSON.parse(raw)}catch{throw new SupportError('INVALID_JSON')}
      if(!body||typeof body!=='object'||Array.isArray(body)||
          Object.keys(body).sort().join(',')!=='amountMinor,currency,kind,recipientId,targetId'||
          !kinds.has(body.kind)||!valid(body.targetId)||
          !/^[A-Z]{3}$/.test(body.currency)||
          typeof body.amountMinor!=='string'||!/^[1-9][0-9]{0,11}$/.test(body.amountMinor)||
          !(body.recipientId===null||valid(body.recipientId))||
          (body.kind==='ALBUM_GIFT')!==(body.recipientId!==null))
        throw new SupportError('INVALID_SUPPORT_INTENT');
      const scope={tenant:identity.tenant,application:identity.application,userId:identity.userId};
      if(await validateTarget(scope,body)!==true)throw new SupportError('TARGET_UNAVAILABLE',403);
      if(body.kind==='ALBUM_GIFT'&&await validateRecipient(scope,body.recipientId,body.targetId)!==true)
        throw new SupportError('RECIPIENT_NOT_AUTHORIZED',403);
      const result=await commerce.startSupportIntent({...scope,...body,idempotencyKey:key});
      if(!result||!valid(result.intentId)||result.state!=='PENDING')
        throw new SupportError('COMMERCE_RESPONSE_INVALID',503);
      return respond(200,{intentId:result.intentId,state:'PENDING'});
    }catch(error){return error instanceof SupportError?respond(error.status,{error:error.code}):
      respond(503,{error:'SUPPORT_UNAVAILABLE'});}
  };
}
