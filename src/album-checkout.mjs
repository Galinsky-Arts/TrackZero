const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class CheckoutError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
function textId(v){return typeof v==='string'&&id.test(v);}
function buyer(value){
  if(!value||![value.userId,value.tenant,value.application].every(textId)||value.role!=='listener')
    throw new CheckoutError('AUTH_REQUIRED',403);
  return {userId:value.userId,tenant:value.tenant,application:value.application};
}
/** No card data or local payment authority. Provider owns price, charge, receipt and payout. */
export function createAlbumCheckout({authenticate,getOffer,commerce}){
  if(typeof authenticate!=='function'||typeof getOffer!=='function'||
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
        const raw=await request.text();if(raw.length>2048)throw new CheckoutError('BODY_TOO_LARGE',413);
        let body;try{body=JSON.parse(raw)}catch{throw new CheckoutError('INVALID_JSON')}
        if(!body||Object.keys(body).sort().join(',')!=='albumId,offerVersion'||
          !textId(body.albumId)||!Number.isSafeInteger(body.offerVersion)||body.offerVersion<1)
          throw new CheckoutError('INVALID_CHECKOUT');
        const offer=await getOffer({...identity,albumId:body.albumId});
        if(!offer||offer.tenant!==identity.tenant||offer.application!==identity.application||
          offer.albumId!==body.albumId||offer.version!==body.offerVersion||
          offer.kind!=='complete_album'||offer.available!==true)
          throw new CheckoutError('OFFER_CHANGED',409);
        const result=await commerce.startCheckout({...identity,albumId:body.albumId,
          offerVersion:body.offerVersion,idempotencyKey:key});
        if(!result||!textId(result.checkoutId)||!['PENDING','COMPLETE'].includes(result.state))
          throw new CheckoutError('COMMERCE_RESPONSE_INVALID',503);
        return respond(200,{checkoutId:result.checkoutId,state:result.state});
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
        return respond(200,{checkoutId,state:receipt.state,albumId:receipt.albumId??null,
          receiptId:receipt.state==='COMPLETE'?receipt.receiptId??null:null});
      }
      return respond(404,{error:'NOT_FOUND'});
    }catch(error){return error instanceof CheckoutError?respond(error.status,{error:error.code}):
      respond(503,{error:'COMMERCE_UNAVAILABLE'});}
  };
}
