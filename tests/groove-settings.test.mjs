import test from 'node:test';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createGrooveSettings,createDreGrooveConfigurationPublisher,renderGrooveSettings,createGrooveSettingsHandler} from '../src/groove-settings.mjs';
const actor={tenantId:'tenant',applicationId:'trackzero',principalId:'artist',role:'creator'};
const settings={stationId:'station',version:1,everyMin:2,everyMax:5,rarityBase:2,recordings:[
 {grooveId:'bonus',recordingId:'alternate',minimumCompletions:0,stock:20,exclusive:true,channel:'groove'},
 {grooveId:'rare',recordingId:'rare_take',minimumCompletions:100,stock:2,exclusive:true,channel:'groove'}]};
const options={skip:!process.env.DRE_PLAYBACK_MODULE&&'Actual DRE module required'};
async function fixture(t){
 const url=pathToFileURL(process.env.DRE_PLAYBACK_MODULE),{RecordingChannelRegistry}=await import(new URL('./recording-channels.mjs',url));
 const {eligibleRarityWeights}=await import(new URL('./rarity-policy.mjs',url)),{transitionOpportunity}=await import(new URL('./transition-opportunity.mjs',url));
 const dir=mkdtempSync(join(tmpdir(),'tz-groove-')),registry=new RecordingChannelRegistry(join(dir,'channels.sqlite'));t.after(()=>{registry.close();rmSync(dir,{recursive:true,force:true});});
 let allowed=true;
 const service=createGrooveSettings({eligibleRarityWeights,transitionOpportunity,recordingRegistry:registry,
  authorizeCreator:async()=>allowed,verifyRecording:async()=>allowed,publishConfiguration:createDreGrooveConfigurationPublisher({registry,
   authorizeConfiguration:(scope,command,proof)=>allowed&&scope.principalId===command.creatorId&&proof==='approved-fixture'})});
 return {registry,service,deny:()=>{allowed=false}};
}
test('creator preview uses actual DRE weights and atomic publication reserves separate bonus stock',options,async t=>{
 const f=await fixture(t),preview=await f.service.preview(actor,settings);assert.deepEqual(preview.tiers.map(x=>x.weight),['2','1']);
 assert.match(preview.disclosure,/Headphones and speakers/);assert.match(renderGrooveSettings(preview),/<caption>Separate bonus catalog/);
 const approval={operationId:'operation-00000000000001',proof:'approved-fixture'};
 assert.equal((await f.service.publish(actor,settings,approval)).committed,true);
 assert.equal(f.registry.readGrooveConfiguration({tenantId:'tenant',applicationId:'trackzero',stationId:'station'}).version,1);
 assert.equal(f.registry.get({tenantId:'tenant',applicationId:'trackzero',recordingId:'alternate'}).channel,'groove');
 assert.equal((await f.service.publish(actor,settings,approval)).committed,true);
});
test('mixed channel, stale authority, invalid cadence and unordered gates cannot publish',options,async t=>{
 const f=await fixture(t);
 for(const change of [{everyMax:1},{recordings:[{...settings.recordings[0],channel:'paid'}]},
  {recordings:[{...settings.recordings[0],minimumCompletions:101},settings.recordings[1]]}])await assert.rejects(f.service.preview(actor,{...settings,...change}));
 f.registry.reserve({tenantId:'tenant',applicationId:'trackzero',creatorId:'artist',recordingId:'alternate',entryId:'paid',channel:'paid'});
 await assert.rejects(f.service.preview(actor,settings),/CONFLICT/);
 await assert.rejects(f.service.preview({...actor,role:'listener'},settings),/CREATOR/);
 f.deny();await assert.rejects(f.service.preview(actor,settings),/DENIED/);
});
test('publication proof is checked at actual atomic DRE commit, not inferred from preview',options,async t=>{
 const f=await fixture(t);await f.service.preview(actor,settings);
 await assert.rejects(f.service.publish(actor,settings,{operationId:'operation-00000000000001',proof:'forged'}),/authorization/);
 assert.equal(f.registry.get({tenantId:'tenant',applicationId:'trackzero',recordingId:'alternate'}),null);
 assert.throws(()=>createGrooveSettingsHandler({settings:f.service,authenticate:async()=>actor}),/codecs/);
});
