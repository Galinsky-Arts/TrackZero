import test from 'node:test';import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPointRedemptionHandler} from '../src/point-redemption.mjs';
const base=pathToFileURL(process.env.DRE_PLAYBACK_MODULE);
const {PointRewards}=await import(new URL('./point-rewards.mjs',base));
const {SqlitePointStore}=await import(new URL('./sqlite-point-store.mjs',base));
const {RecordingChannelRegistry}=await import(new URL('./recording-channels.mjs',base));
const {createRewardPricePolicy,createOfferPriceSnapshot}=await import(new URL('./reward-ladder.mjs',base));
const actor={tenant:'tenant',application:'app',subject:'listener',roles:['listener']};
const operation={creatorId:'artist',offerId:'offer',offerVersion:1};
const packet={body:{payloadCiphertextBase64:'Zml4dHVyZQ=='},signatureHex:'fixture-only'};
const req=(body=packet,origin='https://app.test')=>new Request('https://app.test/v1/point-redemptions',{
 method:'POST',headers:{origin,'idempotency-key':'operation-000000000000000001'},body:JSON.stringify(body)});
test('actual DRE atomic redemption composes with authenticated scoped endpoint control handling',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'tz-redeem-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new SqlitePointStore(join(dir,'points.sqlite')),registry=new RecordingChannelRegistry(join(dir,'channels.sqlite'));
 t.after(()=>{store.close();registry.close();});const scope={tenantId:'tenant',applicationId:'app',principalId:'listener'};
 const wallet=JSON.stringify(['tenant','app','listener','artist']);
 store.apply(wallet,{kind:'vest',operationId:'credit',amount:'100',sourceId:JSON.stringify(['tenant','app','listener','artist','occurrence']),
  sourceBinding:'fixture',referenceId:null,metadata:'digest'},1000);
 const rewards=new PointRewards({scope,store,recordingRegistry:registry,authorizeCreator:()=>true,authorizeRedemption:()=>true,
  verifyPriceSnapshot:()=>true,resolveRights:()=>null,territory:'US',now:()=>2000});
 const priceSnapshot=createOfferPriceSnapshot({offerId:'offer',offerVersion:1,level:0n,
  policy:createRewardPricePolicy({creatorId:'artist',version:1,basePoints:30n}),verifyApproval:()=>true});
 rewards.publish({offerId:'offer',expectedVersion:0,kind:'coupon',title:'Creator coupon',stock:1,expiresAtMs:10000,priceSnapshot,proof:'fixture'});
 const handle=createPointRedemptionHandler({authenticate:async()=>actor,
  // Explicit fixture decoder. Production requires the pinned authenticated E2EE endpoint.
  decodeControl:async(identity,_packet,context)=>{assert.equal(identity.subject,'listener');assert.equal(context.action,'redeem-points');return operation;},
  authorizeRequest:async()=> 'fixture-consent',rewardsForPrincipal:async()=>rewards});
 const first=await handle(req());assert.equal(first.status,200);assert.equal((await first.json()).applied,true);
 assert.equal(store.balance(wallet).balance,70n);
 assert.equal((await (await handle(req())).json()).applied,false);assert.equal(store.balance(wallet).balance,70n);
 assert.equal((await handle(req(operation))).status,400); // No raw transaction control is accepted.
 assert.equal((await handle(req(packet,'https://evil.test'))).status,403);
 const oversized=await handle(req({...packet,padding:'x'.repeat(9000)}));assert.equal(oversized.status,413);
});
test('missing approval, wrong role and unbound issuer receipts cannot be treated as a grant',async()=>{
 const options={authenticate:async()=>actor,decodeControl:async()=>operation,
  authorizeRequest:async()=>null,rewardsForPrincipal:async()=>({redeem(){throw Error('private token');}})};
 assert.equal((await createPointRedemptionHandler(options)(req())).status,403);
 assert.equal((await createPointRedemptionHandler({...options,authenticate:async()=>({...actor,roles:['sponsor']})})(req())).status,403);
 const malformed=createPointRedemptionHandler({...options,authorizeRequest:async()=> 'fixture',rewardsForPrincipal:async()=>({redeem:()=>({applied:true,receipt:{principalId:'other'}})})});
 const response=await malformed(req());assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private token/);
 assert.throws(()=>createPointRedemptionHandler({...options,decodeControl:null}));
});
