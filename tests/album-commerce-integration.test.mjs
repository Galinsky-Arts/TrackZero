import test from 'node:test';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAlbumCheckout,createDreAlbumCommerce} from '../src/album-checkout.mjs';
const audio=process.env.AUDIO_ENGINE_MODULE;
test('actual DAE settlement and DRE whole-work purchase compose through the scoped TrackZero boundary',
 {skip:!audio&&'Set AUDIO_ENGINE_MODULE to the pinned actual DAE build'},async t=>{
 const core=await import(pathToFileURL(audio)),node=await import(new URL('./node/index.js',pathToFileURL(audio)));
 const {WholeWorkCommerce}=await import(new URL('./whole-work-commerce.mjs',pathToFileURL(process.env.DRE_PLAYBACK_MODULE)));
 const dir=mkdtempSync(join(tmpdir(),'tz-album-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new node.SqliteCommerceStore(join(dir,'commerce.sqlite')),entitlementStore=new node.SqliteEntitlementStore(join(dir,'entitlements.sqlite'));
 t.after(()=>{store.close();entitlementStore.close();});
 const scope={tenantId:'tenant',application:'distributed-radio',identityId:'merchant'};
 const manager={...scope,deviceId:'device',expiresAtMs:100000,permissions:['commerce:manage','rights:write','entitlements:manage']};
 const buyer={...manager,identityId:'buyer',permissions:['commerce:buy','assets:read']};
 const rights=new core.RightsCatalog(scope);rights.add(manager,{id:'right',assetId:'complete-recording',layer:'recording',
  uses:['sale','download'],territories:['US'],validFromMs:0,validUntilMs:100000,authorizationEvidenceRef:'sha256:'+'a'.repeat(64),revoked:false},1);
 let event,requests=0,now=1000;
 const engine=new core.CheckoutEngine(scope,rights,{providerId:'fixture',merchantAccountId:'account',createIntent:async request=>{
  requests++;return {providerId:'fixture',merchantAccountId:'account',providerPaymentId:'payment',currency:request.currency,amountMinor:request.amountMinor};
 }},{verify:async()=>event},store);
 const ledger=new core.EntitlementLedger(scope,entitlementStore);
 const whole=new WholeWorkCommerce({scope:{tenantId:'tenant',applicationId:'trackzero',merchantId:'merchant'},checkout:engine,entitlements:ledger,
  commerceDigest:core.commerceDigest,resolveCompleteWork:async()=>({kind:'complete-album',creatorId:'artist',completeAssetIds:['complete-recording'],
   product:{id:'album',revision:1,assets:[{assetId:'complete-recording',rightsLayers:['recording']}],currency:{code:'USD',minorUnit:2},priceMinor:'1000',validUntilMs:100000}}),
  verifyCompleteWork:async()=>true,resolveBuyer:async()=>buyer,resolveMerchant:async()=>manager,authorizePurchase:async()=>true,
  authorizeRead:async()=>true,verifyFulfillment:async()=>true,territory:'US',now:()=>now});
 // Fixture envelope/codec only. Production must bind actual approved E2EE endpoint adapters.
 const packet={body:{version:'1.0.0',scope:{tenantId:'tenant',application:'distributed-radio',sessionId:'fixture'},keyId:'key',algorithm:'ALG-ED25519',
  epoch:1,sequence:1,issuedAtMs:1000,expiresAtMs:10000,action:'album-checkout',payloadCiphertextBase64:'Zml4dHVyZQ=='},signatureHex:'0'.repeat(128)};
 const receipts=[];const identity={tenant:'tenant',application:'trackzero',userId:'buyer',role:'listener'};
 const handler=createAlbumCheckout({authenticate:async()=>identity,getOffer:async()=>({...identity,albumId:'album',version:1,kind:'complete_album',available:true}),
  commerce:createDreAlbumCommerce(whole),decodeControl:async()=>({albumId:'album',offerVersion:1}),authorizePurchase:async()=> 'fixture-consent',
  encodeResponse:async(_identity,plain)=>{receipts.push(plain);return packet;}});
 const post=()=>new Request('https://app.test/v1/album-checkouts',{method:'POST',headers:{origin:'https://app.test','idempotency-key':'operation-000000000000000001'},body:JSON.stringify(packet)});
 assert.equal((await handler(post())).status,200);const checkoutId=receipts.at(-1).checkoutId;
 assert.equal(receipts.at(-1).state,'PENDING');assert.equal(requests,1);await handler(post());assert.equal(requests,1);
 const order=engine.readOrder(buyer,checkoutId,now);now=1500;
 event={scope,eventId:'settlement',providerId:'fixture',merchantAccountId:'account',checkoutId,buyerId:'buyer',
  productDigestHex:order.productDigestHex,providerPaymentId:'payment',currency:order.currency,amountMinor:order.amountMinor,occurredAtMs:now,status:'settled'};
 await whole.settle(new Uint8Array([1]),'fixture-auth');
 const response=await handler(new Request('https://app.test/v1/album-checkouts/'+checkoutId+'/receipt'));
 assert.equal(response.status,200);assert.equal(receipts.at(-1).state,'COMPLETE');assert.equal(receipts.at(-1).albumId,'album');
 assert.ok(receipts.at(-1).receiptId);assert.equal(ledger.access(buyer,'complete-recording','download',now).allowed,true);
 assert.doesNotMatch(await response.text(),/receiptId|albumId|priceMinor/);
 });
