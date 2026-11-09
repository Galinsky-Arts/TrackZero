import test from 'node:test';import assert from 'node:assert/strict';import {mayPublishCatalogItem} from '../src/rights-review.mjs';const good={ownerVerified:true,rightsReviewed:true,rightsApproved:true,regionApproved:true,sourceVerified:true,withdrawn:false,licenseVersion:'v1',reviewedAtMs:1};test('publishing requires explicit approval and provenance',()=>{assert.equal(mayPublishCatalogItem(good),true);for(const key of ['ownerVerified','rightsReviewed','rightsApproved','regionApproved','sourceVerified'])assert.equal(mayPublishCatalogItem({...good,[key]:false}),false);assert.equal(mayPublishCatalogItem({...good,withdrawn:true}),false);assert.equal(mayPublishCatalogItem({...good,licenseVersion:''}),false)});

test('stale, malformed and future rights assertions cannot publish',()=>{
 const clock=1000000;
 for(const record of [
   {...good,withdrawn:'false'},
   {...good,withdrawn:undefined},
   {...good,licenseVersion:'   '},
   {...good,licenseVersion:'v1/../../'},
   {...good,reviewedAtMs:clock+1},
   {...good,reviewedAtMs:1.5},
   {...good,reviewValidUntilMs:clock},
   {...good,reviewValidUntilMs:'tomorrow'}
 ])assert.equal(mayPublishCatalogItem(record,clock),false);
 assert.equal(mayPublishCatalogItem({...good,reviewValidUntilMs:clock+1},clock),true);
});
