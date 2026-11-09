import {BoundaryError,readBoundedJson,encryptedControlEnvelope} from './http-boundary.mjs';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** User-approved DRE-18 redemption; the UI cannot declare price, identity or grants. */
export function createPointRedemptionHandler({authenticate,decodeControl,encodeResponse,authorizeRequest,rewardsForPrincipal}){
  if(![authenticate,decodeControl,encodeResponse,authorizeRequest,rewardsForPrincipal].every(fn=>typeof fn==='function'))
    throw Error('Identity, transaction authorization and atomic reward factory required');
  return async request=>{
    const url=new URL(request.url),headers={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'};
    const respond=(status,value)=>new Response(JSON.stringify(value),{status,headers});
    try{
      if(url.pathname!=='/v1/point-redemptions')return respond(404,{error:'NOT_FOUND'});
      if(request.method!=='POST')return respond(405,{error:'METHOD_NOT_ALLOWED'});
      if(request.headers.get('origin')!==url.origin)throw new BoundaryError('ORIGIN_DENIED',403);
      const actor=await authenticate(request);
      if(!actor||!['tenant','application','subject'].every(k=>id(actor[k]))||!Array.isArray(actor.roles)||!actor.roles.includes('listener'))
        throw new BoundaryError('AUTH_REQUIRED',403);
      const operationId=request.headers.get('idempotency-key');
      if(!id(operationId)||operationId.length<20)throw new BoundaryError('IDEMPOTENCY_KEY_REQUIRED');
      const identity=Object.freeze({tenant:actor.tenant,application:actor.application,subject:actor.subject});
      const packet=encryptedControlEnvelope(await readBoundedJson(request,8192));
      // The mandatory approved endpoint decoder authenticates/decrypts, checks
      // action, actor scope, counters, expiry and device membership. No plaintext fallback.
      const body=await decodeControl(identity,packet,{action:'redeem-points',operationId});
      if(!body||typeof body!=='object'||Array.isArray(body))throw new BoundaryError('INVALID_REDEMPTION');
      if(Object.keys(body).sort().join(',')!=='creatorId,offerId,offerVersion'||!id(body.creatorId)||!id(body.offerId)||
        !Number.isSafeInteger(body.offerVersion)||body.offerVersion<1)throw new BoundaryError('INVALID_REDEMPTION');
      const operation=Object.freeze({...body,operationId});
      const proof=await authorizeRequest(identity,operation,request);
      if(typeof proof!=='string'||!proof||proof.length>8192)throw new BoundaryError('TRANSACTION_NOT_AUTHORIZED',403);
      const rewards=await rewardsForPrincipal(identity);
      if(typeof rewards?.redeem!=='function')throw new BoundaryError('REWARDS_UNAVAILABLE',503);
      let result;try{result=await rewards.redeem({...operation,proof});}
      catch{throw new BoundaryError('REWARD_NOT_GRANTED',409);}
      const r=result?.receipt;
      if(typeof result?.applied!=='boolean'||!r||r.tenantId!==actor.tenant||r.applicationId!==actor.application||
        r.principalId!==actor.subject||r.creatorId!==body.creatorId||r.offerId!==body.offerId||
        !id(r.operationId)||!Number.isSafeInteger(r.offerVersion)||r.offerVersion<1||
        !['recording','coupon','fan-reward'].includes(r.kind)||
        (r.kind==='recording'?!id(r.recordingId):r.recordingId!==null)||
        typeof r.points!=='string'||!/^[1-9][0-9]{0,999}$/.test(r.points)||r.unit!=='micro-reference-seconds')
        throw new BoundaryError('ISSUER_RESPONSE_INVALID',503);
      const receipt={applied:result.applied,offerId:r.offerId,offerVersion:r.offerVersion,
        operationId:r.operationId,kind:r.kind,recordingId:r.recordingId,points:r.points,unit:r.unit};
      return respond(200,encryptedControlEnvelope(await encodeResponse(identity,receipt,{action:'point-redemption-receipt',operationId})));
    }catch(error){return error instanceof BoundaryError?respond(error.status,{error:error.code}):respond(503,{error:'REWARDS_UNAVAILABLE'});}
  };
}
