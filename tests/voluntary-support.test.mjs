import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupportHandler} from '../src/voluntary-support.mjs';
const identity={tenant:'tenant-a',application:'trackzero',userId:'u1'};
const gift={kind:'ALBUM_GIFT',targetId:'album-a',recipientId:'u2',amountMinor:'1200',currency:'USD'};
const post=(body=gift,headers={})=>new Request('https://app.example.test/v1/support/intents',
  {method:'POST',headers:{origin:'https://app.example.test',
    'idempotency-key':'support-123456789012345',...headers},body:JSON.stringify(body)});
function fixture({recipient=true,target=true,actor=identity}={}){
  const calls=[];
  const handler=createSupportHandler({authenticate:async()=>actor,
    validateTarget:async()=>target,validateRecipient:async()=>recipient,
    commerce:{startSupportIntent:async input=>{calls.push(input);return {intentId:'intent-a',state:'PENDING'}}}});
  return {handler,calls};
}
test('explicit gift creates only a pending provider intent after target and recipient approval',async()=>{
  const f=fixture(),result=await f.handler(post());
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{intentId:'intent-a',state:'PENDING'});
  assert.deepEqual(f.calls,[{...identity,...gift,idempotencyKey:'support-123456789012345'}]);
});
test('tips and sponsor support omit a gift recipient',async()=>{
  for(const kind of ['TIP','SPONSOR_SUPPORT']){
    const f=fixture();
    assert.equal((await f.handler(post({...gift,kind,recipientId:null}))).status,200);
  }
});
test('denies gift without recipient approval, spoofed fields, origin and missing identity',async()=>{
  const denied=fixture({recipient:false});
  assert.equal((await denied.handler(post())).status,403);assert.equal(denied.calls.length,0);
  const unavailable=fixture({target:false});
  assert.equal((await unavailable.handler(post())).status,403);assert.equal(unavailable.calls.length,0);
  for(const body of [{...gift,price:1},{...gift,amountMinor:'0'},
    {...gift,recipientId:null},{...gift,kind:'TIP'}])
    assert.equal((await fixture().handler(post(body))).status,400);
  assert.equal((await fixture().handler(post(gift,{origin:'https://evil.test'}))).status,403);
  assert.equal((await fixture({actor:null}).handler(post())).status,401);
});
