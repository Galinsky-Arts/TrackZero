import test from 'node:test';import assert from 'node:assert/strict';
import {createAlbumCheckout} from '../src/album-checkout.mjs';
const scope={tenant:'tenant-a',application:'trackzero'};
const offer={...scope,albumId:'a1',version:2,kind:'complete_album',available:true};
const packet={body:{version:'1.0.0',scope:{tenantId:'tenant-a',application:'distributed-radio',sessionId:'fixture'},keyId:'key',algorithm:'ALG-ED25519',epoch:1,sequence:1,issuedAtMs:1000,expiresAtMs:10000,action:'album-checkout',payloadCiphertextBase64:'Zml4dHVyZQ=='},signatureHex:'0'.repeat(128)};
let decodedBody;const encoded=[];
const validReceipt={...scope,userId:'u1',checkoutId:'c1',albumId:'a1',state:'COMPLETE',receiptId:'r1'};
function setup(identity={...scope,userId:'u1',role:'listener'},current=offer,receipt=validReceipt){
  const calls=[];
  const handler=createAlbumCheckout({authenticate:async()=>identity,getOffer:async()=>current,
    decodeControl:async()=>decodedBody,encodeResponse:async(_identity,plain)=>{encoded.push(plain);return packet;},authorizePurchase:async()=> 'fixture-consent',
    commerce:{startCheckout:async request=>{calls.push(request);return {checkoutId:'c1',state:'PENDING'}},
      getReceipt:async()=>receipt}});
  return {handler,calls};
}
const post=(headers={},body={albumId:'a1',offerVersion:2})=>{decodedBody=body;return new Request('https://example.test/v1/album-checkouts',
  {method:'POST',headers:{origin:'https://example.test','idempotency-key':'request-123456789012345',...headers},body:JSON.stringify(packet)});};
test('verified complete album starts idempotent provider checkout without card data',async()=>{
  const {handler,calls}=setup(),res=await handler(post());assert.equal(res.status,200);
  assert.deepEqual(calls,[{userId:'u1',...scope,albumId:'a1',offerVersion:2,idempotencyKey:'request-123456789012345',proof:'fixture-consent'}]);
  assert.deepEqual(encoded.at(-1),{checkoutId:'c1',state:'PENDING',fulfillmentPending:false,checkoutUrl:null});assert.deepEqual(await res.json(),packet);
});
test('rejects stale offer, forged price/card fields, origin and cross-role',async()=>{
  assert.equal((await setup().handler(post({}, {albumId:'a1',offerVersion:1}))).status,409);
  assert.equal((await setup().handler(post({}, {albumId:'a1',offerVersion:2,price:1}))).status,400);
  assert.equal((await setup().handler(post({origin:'https://evil.test'}))).status,403);
  assert.equal((await setup({...scope,userId:'artist',role:'artist'}).handler(post())).status,403);
  assert.equal((await setup({...scope,userId:'u1',role:'listener'}, {...offer,tenant:'tenant-b'}).handler(post())).status,409);
  assert.equal((await setup({userId:'u1',role:'listener'}).handler(post())).status,403);
});
test('receipt requires authenticated owner and rejects inconsistent provider response',async()=>{
  const request=new Request('https://example.test/v1/album-checkouts/c1/receipt');
  const good=await setup().handler(request);assert.equal(good.status,200);
  assert.equal(encoded.at(-1).receiptId,'r1');assert.deepEqual(await good.json(),packet);
  const wrong=await setup({...scope,userId:'u2',role:'listener'}).handler(request);
  assert.equal(wrong.status,503);
  for(const receipt of [{...validReceipt,tenant:'tenant-b'},
    {...validReceipt,application:'other'}, {...validReceipt,receiptId:null},
    {...validReceipt,albumId:'../other'}])
    assert.equal((await setup(undefined,offer,receipt).handler(request)).status,503);
});

test('private checkout never accepts a plaintext control or exposes an unencrypted receipt',async()=>{
 const {handler}=setup();
 const raw=new Request('https://example.test/v1/album-checkouts',{method:'POST',headers:{origin:'https://example.test','idempotency-key':'request-123456789012345'},body:JSON.stringify({albumId:'a1',offerVersion:2})});
 assert.equal((await handler(raw)).status,400);
 const response=await handler(post());assert.equal(response.status,200);
 const payload=await response.text();assert.doesNotMatch(payload,/checkoutId|receiptId|fulfillmentPending/);
});

test('hosted Stripe URL stays inside the encrypted buyer response and rejects untrusted payment origins',async()=>{
 const options={authenticate:async()=>({...scope,userId:'u1',role:'listener'}),getOffer:async()=>offer,
  decodeControl:async()=>({albumId:'a1',offerVersion:2}),encodeResponse:async(_actor,value)=>{encoded.push(value);return packet;},authorizePurchase:async()=> 'fixture-consent'};
 let url='https://checkout.stripe.com/c/pay/cs_test_fixture';
 const handler=createAlbumCheckout({...options,commerce:{startCheckout:async()=>({checkoutId:'c1',state:'PENDING',checkoutUrl:url}),getReceipt:async()=>null}});
 const response=await handler(post());assert.equal(response.status,200);assert.equal(encoded.at(-1).checkoutUrl,url);
 assert.doesNotMatch(await response.text(),/checkout.stripe.com|cs_test_fixture/);
 url='https://checkout.stripe.com.evil.test/steal';assert.equal((await handler(post())).status,503);
});
