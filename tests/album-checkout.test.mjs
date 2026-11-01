import test from 'node:test';import assert from 'node:assert/strict';
import {createAlbumCheckout} from '../src/album-checkout.mjs';
const scope={tenant:'tenant-a',application:'trackzero'};
const offer={...scope,albumId:'a1',version:2,kind:'complete_album',available:true};
const validReceipt={...scope,userId:'u1',checkoutId:'c1',albumId:'a1',state:'COMPLETE',receiptId:'r1'};
function setup(identity={...scope,userId:'u1',role:'listener'},current=offer,receipt=validReceipt){
  const calls=[];
  const handler=createAlbumCheckout({authenticate:async()=>identity,getOffer:async()=>current,
    commerce:{startCheckout:async request=>{calls.push(request);return {checkoutId:'c1',state:'PENDING'}},
      getReceipt:async()=>receipt}});
  return {handler,calls};
}
const post=(headers={},body={albumId:'a1',offerVersion:2})=>new Request('https://example.test/v1/album-checkouts',
  {method:'POST',headers:{origin:'https://example.test','idempotency-key':'request-123456789012345',...headers},body:JSON.stringify(body)});
test('verified complete album starts idempotent provider checkout without card data',async()=>{
  const {handler,calls}=setup(),res=await handler(post());assert.equal(res.status,200);
  assert.deepEqual(calls,[{userId:'u1',...scope,albumId:'a1',offerVersion:2,idempotencyKey:'request-123456789012345'}]);
  assert.deepEqual(await res.json(),{checkoutId:'c1',state:'PENDING'});
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
  assert.equal((await good.json()).receiptId,'r1');
  const wrong=await setup({...scope,userId:'u2',role:'listener'}).handler(request);
  assert.equal(wrong.status,503);
  for(const receipt of [{...validReceipt,tenant:'tenant-b'},
    {...validReceipt,application:'other'}, {...validReceipt,receiptId:null},
    {...validReceipt,albumId:'../other'}])
    assert.equal((await setup(undefined,offer,receipt).handler(request)).status,503);
});
