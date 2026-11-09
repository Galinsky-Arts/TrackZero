import {BoundaryError,readBoundedJson,encryptedControlEnvelope} from './http-boundary.mjs';
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class CheckoutError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
function textId(v){return typeof v==='string'&&id.test(v);}
function paymentUrl(value){
  if(value===null||value===undefined)return null;
  let url;try{url=new URL(value);}catch{throw new CheckoutError('COMMERCE_RESPONSE_INVALID',503);}
  if(typeof value!=='string'||value.length>4096||url.origin!=='https://checkout.stripe.com'||url.username||url.password)throw new CheckoutError('COMMERCE_RESPONSE_INVALID',503);
  return value;
}
function buyer(value){
  if(!value||![value.userId,value.tenant,value.application].every(textId)||value.role!=='listener')
    throw new CheckoutError('AUTH_REQUIRED',403);
  return {userId:value.userId,tenant:value.tenant,application:value.application};
}
/** No card data or local payment authority. Provider owns price, charge, receipt and payout. */
export function createAlbumCheckout({authenticate,getOffer,commerce,decodeControl,encodeResponse,authorizePurchase}){
  if(![authenticate,getOffer,decodeControl,encodeResponse,authorizePurchase].every(fn=>typeof fn==='function')||
    !commerce||typeof commerce.startCheckout!=='function'||typeof commerce.getReceipt!=='function')
    throw Error('Trusted identity, offer and commerce providers required');
  return async request=>{
    const url=new URL(request.url),headers={'content-type':'application/json','cache-control':'no-store'};
    const respond=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    try{
      if(request.method==='POST'&&url.pathname==='/v1/album-checkouts'){
        if(request.headers.get('origin')!==url.origin)throw new CheckoutError('ORIGIN_DENIED',403);
        const identity=buyer(await authenticate(request));
        const key=request.headers.get('idempotency-key');
        if(!textId(key)||key.length<20)throw new CheckoutError('IDEMPOTENCY_KEY_REQUIRED');
        const packet=encryptedControlEnvelope(await readBoundedJson(request,8192));
        const body=await decodeControl(identity,packet,{action:'album-checkout',operationId:key});
        if(!body||Object.keys(body).sort().join(',')!=='albumId,offerVersion'||
          !textId(body.albumId)||!Number.isSafeInteger(body.offerVersion)||body.offerVersion<1)
          throw new CheckoutError('INVALID_CHECKOUT');
        const offer=await getOffer({...identity,albumId:body.albumId});
        if(!offer||offer.tenant!==identity.tenant||offer.application!==identity.application||
          offer.albumId!==body.albumId||offer.version!==body.offerVersion||
          offer.kind!=='complete_album'||offer.available!==true)
          throw new CheckoutError('OFFER_CHANGED',409);
        const proof=await authorizePurchase(identity,Object.freeze({...body,idempotencyKey:key}),request);
        if(typeof proof!=='string'||!proof||proof.length>8192)throw new CheckoutError('TRANSACTION_NOT_AUTHORIZED',403);
        const result=await commerce.startCheckout({...identity,proof,albumId:body.albumId,
          offerVersion:body.offerVersion,idempotencyKey:key});
        if(!result||!textId(result.checkoutId)||!['PENDING','COMPLETE'].includes(result.state))
          throw new CheckoutError('COMMERCE_RESPONSE_INVALID',503);
        return respond(200,encryptedControlEnvelope(await encodeResponse(identity,{checkoutId:result.checkoutId,state:result.state,
          fulfillmentPending:result.fulfillmentPending===true,checkoutUrl:result.state==='PENDING'?paymentUrl(result.checkoutUrl):null},{action:'album-checkout-result',operationId:key})));
      }
      if(request.method==='GET'&&url.pathname.startsWith('/v1/album-checkouts/')&&url.pathname.endsWith('/receipt')){
        const checkoutId=url.pathname.slice('/v1/album-checkouts/'.length,-'/receipt'.length);
        if(!textId(checkoutId))throw new CheckoutError('INVALID_CHECKOUT');
        const identity=buyer(await authenticate(request));
        const receipt=await commerce.getReceipt({...identity,checkoutId});
        if(!receipt)return respond(404,{error:'NOT_FOUND'});
        if(receipt.userId!==identity.userId||receipt.tenant!==identity.tenant||
          receipt.application!==identity.application||receipt.checkoutId!==checkoutId||
          !textId(receipt.albumId)||
          (receipt.state==='COMPLETE'&&!textId(receipt.receiptId))||
          !['PENDING','COMPLETE','FAILED'].includes(receipt.state))
          throw new CheckoutError('COMMERCE_RESPONSE_INVALID',503);
        return respond(200,encryptedControlEnvelope(await encodeResponse(identity,{checkoutId,state:receipt.state,albumId:receipt.albumId,
          receiptId:receipt.state==='COMPLETE'?receipt.receiptId:null,fulfillmentPending:receipt.fulfillmentPending===true,
          checkoutUrl:receipt.state==='PENDING'?paymentUrl(receipt.checkoutUrl):null},
          {action:'album-purchase-receipt',operationId:checkoutId})));
      }
      return respond(404,{error:'NOT_FOUND'});
    }catch(error){return (error instanceof CheckoutError||error instanceof BoundaryError)?respond(error.status,{error:error.code}):
      respond(503,{error:'COMMERCE_UNAVAILABLE'});}
  };
}

/** Music-oriented DTO bridge; general whole-work commerce remains in DRE. */
export function createDreAlbumCommerce(wholeWorkCommerce){
  if(typeof wholeWorkCommerce?.startCheckout!=='function'||typeof wholeWorkCommerce?.getReceipt!=='function')
    throw Error('Actual DRE whole-work commerce required');
  const scope=input=>({tenantId:input.tenant,applicationId:input.application,principalId:input.userId});
  const receipt=(result,input)=>{
    if(!result)return null;
    if(result.tenantId!==input.tenant||result.applicationId!==input.application||result.principalId!==input.userId)
      throw new CheckoutError('COMMERCE_RESPONSE_INVALID',503);
    return {tenant:result.tenantId,application:result.applicationId,userId:result.principalId,checkoutId:result.checkoutId,
      albumId:result.productId,state:result.state,receiptId:result.receiptId,fulfillmentPending:result.fulfillmentPending,checkoutUrl:paymentUrl(result.checkoutUrl)};
  };
  return {async startCheckout(input){
    return receipt(await wholeWorkCommerce.startCheckout({...scope(input),productId:input.albumId,productRevision:input.offerVersion,
      operationId:input.idempotencyKey,proof:input.proof}),input);
  },async getReceipt(input){return receipt(await wholeWorkCommerce.getReceipt({...scope(input),checkoutId:input.checkoutId}),input);}};
}
