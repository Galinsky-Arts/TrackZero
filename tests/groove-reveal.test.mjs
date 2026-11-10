import test from 'node:test';import assert from 'node:assert/strict';import {GrooveReveal} from '../src/groove-reveal.mjs';
const scope={tenantId:'tenant',applicationId:'app',stationId:'station',listenerId:'listener'};
const marker={stationId:'station',opportunityId:'opportunity',atMs:4000,eligible:true,afterOutro:true,beforeNextIntro:true};
const result={state:'granted',...marker,listenerId:'listener',grooveId:'bonus',grant:{...scope,grooveId:'bonus',grantId:'grant'}};
function setup(options={}){let time=3999;const changes=[],seen=new Set();
 const config={scope,verifyTransition:async()=>true,verifyGrant:async()=>true,now:()=>time,onChange:change=>changes.push(change),
  claimReveal:async request=>{if(seen.has(request.opportunityId))return false;seen.add(request.opportunityId);return true;},...options};
 return {changes,config,setTime:value=>{time=value},reveal:new GrooveReveal(config)};
}
test('exact shared boundary locks then unlocks once, without holding any playback reference',async()=>{
 const f=setup();await f.reveal.arm(marker);f.reveal.advance();assert.equal(f.changes.length,0);
 assert.equal(await f.reveal.accept(result),false);f.setTime(4000);f.reveal.advance();assert.deepEqual(f.changes,[{phase:'LOCKED',label:'LOCKED GROOVE'}]);
 assert.equal(await f.reveal.accept(result),true);assert.equal(await f.reveal.accept(result),false);assert.equal(f.changes[1].label,'UNLOCKED GROOVE');
 const reconnected=new GrooveReveal(f.config);await reconnected.arm(marker);assert.equal(await reconnected.accept(result),false);
});
test('wrong listener, forged timing, missing grant and failed source authentication cannot reveal',async()=>{
 const f=setup();await f.reveal.arm(marker);f.setTime(4000);
 for(const change of [{listenerId:'other'},{atMs:4001},{state:'stock-exhausted'},{grant:{...result.grant,tenantId:'other'}}])await assert.rejects(f.reveal.accept({...result,...change}),/Authenticated/);
 const denied=setup({verifyTransition:async()=>false});await assert.rejects(denied.reveal.arm(marker),/Authenticated/);
 const bad=setup({verifyGrant:async()=>false});await bad.reveal.arm(marker);bad.setTime(4000);await assert.rejects(bad.reveal.accept(result),/Authenticated/);
});
test('late grants, concurrent duplicate delivery, closed or replaced views never replay animation',async()=>{
 const f=setup();await f.reveal.arm(marker);f.setTime(9001);assert.equal(await f.reveal.accept(result),false);assert.equal(f.changes.length,0);
 f.setTime(4000);const values=await Promise.all([f.reveal.accept(result),f.reveal.accept(result)]);assert.equal(values.filter(Boolean).length,1);
 f.reveal.close();assert.equal(await f.reveal.accept(result),false);
 let resolve;const deferred=setup({claimReveal:()=>new Promise(done=>{resolve=done})});await deferred.reveal.arm(marker);deferred.setTime(4000);
 const pending=deferred.reveal.accept(result);await new Promise(done=>setImmediate(done));deferred.reveal.close();resolve(true);assert.equal(await pending,false);
});
test('actual DRE compiler, completion issuer and durable reveal checkpoint compose for headphone listening',
 {skip:!process.env.DRE_PLAYBACK_MODULE&&'Actual DRE build required'},async t=>{
 const {pathToFileURL}=await import('node:url'),{mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const base=pathToFileURL(process.env.DRE_PLAYBACK_MODULE),load=name=>import(new URL('./'+name+'.mjs',base));
 const [{compileEditorialRevision},{compileRadioProgram},{verifiedStationTransition},{RecordingChannelRegistry},{GrooveGrantIssuer,radioOccurrenceId},{DurableListenerCompletion}]=await Promise.all(['editorial','program','transition-opportunity','recording-channels','groove-grants','listener-history'].map(load));
 const dir=mkdtempSync(join(tmpdir(),'tz-reveal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const registry=new RecordingChannelRegistry(join(dir,'registry.sqlite'));t.after(()=>registry.close());
 registry.publishGrooveConfiguration({...scope,creatorId:'artist',operationId:'operation-00000000000001',version:1,expectedPreviousVersion:0,everyMin:1,everyMax:1,rarityBase:2,
  recordings:[{grooveId:'bonus',recordingId:'alternate',minimumCompletions:0,stock:5,exclusive:true,channel:'groove'}]},()=>true);
 const revision=compileEditorialRevision({...scope,version:1,program:[{kind:'identification',ref:'intro'},{kind:'media',ref:'song'},{kind:'identification',ref:'outro'},{kind:'marker',ref:'shared'}]});
 const program=compileRadioProgram({revision,approval:{digest:revision.digest,stationId:'station',version:1},durations:{intro:1000,song:1000,outro:1000},verifyPublishingRight:()=>true});
 const transition=verifiedStationTransition({program,cycle:0,completedOccurrenceId:1,stationStartedAtMs:1000,verifyProgram:()=>true});
 const history=new DurableListenerCompletion(join(dir,'history.sqlite'),{scope,now:()=>4000,verifyCompletion:()=>true,authorizeRead:()=>true});t.after(()=>history.close());
 history.complete({...scope,creatorId:'artist',occurrenceId:radioOccurrenceId({...scope,...transition}),programDigest:program.digest,route:'headphones',foreground:true,unmuted:true,startedAtMs:1000,completedAtMs:4000,requiredStartMs:1000,requiredEndMs:4000,proof:'fixture'});
 const issuer=new GrooveGrantIssuer({scope,registry,history,policy:{version:1,creatorId:'artist',grooveIds:['bonus'],minimumCompletions:[0]},seed:new Uint8Array(32).fill(7),issuerId:'issuer',verifyOpportunity:()=>true,verifyPolicy:()=>true,authorizeAccess:()=>true,territory:'US',now:()=>4000,
  resolveRights:()=>({tenantId:'tenant',assetRef:'alternate',uses:['reward'],territories:['US'],validFrom:'1970-01-01T00:00:00Z',validUntil:'2030-01-01T00:00:00Z'}),deliverToEndpoint:async()=>true});
 const granted=issuer.claim({opportunity:transition,proof:'fixture'}),changes=[];
 const options={scope,verifyTransition:async candidate=>candidate.opportunityId===transition.opportunityId,verifyGrant:async candidate=>candidate.grant.grantId===granted.grant.grantId,
  claimReveal:async request=>registry.claimGrooveReveal(request,()=>true),onChange:change=>changes.push(change),now:()=>4000};
 const view=new GrooveReveal(options);await view.arm(transition);assert.equal(await view.accept(granted),true);assert.deepEqual(changes.map(x=>x.phase),['LOCKED','UNLOCKED']);
 const reconnected=new GrooveReveal(options);await reconnected.arm(transition);assert.equal(await reconnected.accept(granted),false);
});

test('expired presentation clears without focus changes or a second grant',async()=>{
 const f=setup();await f.reveal.arm(marker);f.setTime(4000);await f.reveal.accept(result);
 f.setTime(9001);f.reveal.advance();assert.equal(f.changes.at(-1).phase,'HIDDEN');
 const count=f.changes.length;f.reveal.advance();assert.equal(f.changes.length,count);
});
