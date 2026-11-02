import test from 'node:test';import assert from 'node:assert/strict';
import {prepareInterstitialDraft} from '../src/interstitial.mjs';
const draft={clipId:'clip-001',stationId:'station-one',kind:'station-ident',origin:'recorded',mimeType:'audio/wav',sha256:'a'.repeat(64),durationMs:15000,capturedAtMs:1000};
test('new interstitial drafts never claim publication approval',()=>{
 const item=prepareInterstitialDraft(draft,2000);
 assert.equal(item.reviewState,'quarantined');assert.equal(item.publishable,false);
 assert.equal(item.assurance,'unverified-input');
});
test('malformed or privilege-claiming interstitial metadata fails closed',()=>{
 for(const item of [
  {...draft,kind:'unknown'}, {...draft,origin:'server'}, {...draft,mimeType:'text/html'},
  {...draft,durationMs:0},{...draft,capturedAtMs:3000},
  {...draft,sha256:'wrong'},{...draft,publishable:true}
 ])assert.throws(()=>prepareInterstitialDraft(item,2000));
});
