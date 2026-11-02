import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SponsorPlacementStore,createSponsorPlacementHandler} from '../src/sponsor-placement.mjs';

const sponsor={tenant:'tenant-a',application:'trackzero',subject:'provider:sponsor',roles:['sponsor']};
const broadcaster={...sponsor,subject:'provider:broadcaster',roles:['broadcaster']};
const other={...sponsor,subject:'provider:other'};
const now=1_000_000;
const placement={stationId:'station-001',placementId:'placement-001',mediaDigest:'a'.repeat(64),
 durationMs:30000,startsAtMs:now+1000,endsAtMs:now+10000};
function fixture(mediaApproved=true){
 const dir=mkdtempSync(join(tmpdir(),'tz08-')),file=join(dir,'placements.sqlite');
 const options={authorizeSponsor:(actor,station)=>actor.tenant===sponsor.tenant&&actor.application===sponsor.application&&actor.subject===sponsor.subject&&station===placement.stationId,
  authorizeStation:(actor,station)=>actor.tenant===broadcaster.tenant&&actor.application===broadcaster.application&&actor.subject===broadcaster.subject&&station===placement.stationId,
  verifyMedia:()=>mediaApproved};
 const store=new SponsorPlacementStore(file,options);return {store,file,options,cleanup(){this.store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('revoked external media verification immediately withholds an approved placement',()=>{
 let verified=true;
 const f=fixture();f.store.verifyMedia=()=>verified;
 try{
  f.store.submit(sponsor,placement,now);f.store.approve(broadcaster,placement,now+1);
  assert.equal(f.store.active({...sponsor,stationId:placement.stationId},now+1000).length,1);
  verified=false;
  assert.deepEqual(f.store.active({...sponsor,stationId:placement.stationId},now+1000),[]);
 }finally{f.cleanup();}
});
test('separate broadcaster approval activates only the scoped time window and survives restart',()=>{
 const f=fixture();try{
  assert.equal(f.store.submit(sponsor,placement,now).schedulable,false);
  assert.deepEqual(f.store.active({...sponsor,stationId:placement.stationId},now+1000),[]);
  f.store.approve(broadcaster,placement,now+1);
  assert.deepEqual(f.store.active({...sponsor,stationId:placement.stationId},now+1000).map(x=>x.placementId),[placement.placementId]);
  assert.deepEqual(f.store.active({...sponsor,stationId:placement.stationId},placement.endsAtMs),[]);
  assert.deepEqual(f.store.active({...sponsor,stationId:'other-station'},now+1000),[]);
  f.store.close();f.store=new SponsorPlacementStore(f.file,f.options);
  assert.equal(f.store.active({...sponsor,stationId:placement.stationId},now+1000).length,1);
 }finally{f.cleanup();}
});
test('role, tenant, media and self-approval denials cannot schedule an ad',()=>{
 const f=fixture(false);try{
  assert.throws(()=>f.store.submit({...sponsor,roles:['listener']},placement,now),/ROLE_DENIED/);
  assert.throws(()=>f.store.submit({...sponsor,tenant:'tenant-b'},placement,now),/SPONSOR_ACCESS_DENIED/);
  for(const invalid of [{...placement,mediaDigest:'bad'},{...placement,media:'plaintext'},
    {...placement,durationMs:0},{...placement,endsAtMs:placement.startsAtMs}])
    assert.throws(()=>f.store.submit(sponsor,invalid,now));
  f.store.submit(sponsor,placement,now);
  assert.throws(()=>f.store.approve({...sponsor,roles:['broadcaster']},placement,now+1),/STATION_ACCESS_DENIED/);
  assert.throws(()=>f.store.approve(broadcaster,placement,now+1),/MEDIA_OR_WINDOW_NOT_VERIFIED/);
  assert.deepEqual(f.store.active({...sponsor,stationId:placement.stationId},now+1000),[]);
 }finally{f.cleanup();}
});
test('sponsor revocation is idempotent and an interrupted approval rolls back',()=>{
 const f=fixture();try{
  f.store.submit(sponsor,placement,now);
  f.store.db.exec(`CREATE TRIGGER reject_approval BEFORE INSERT ON placement_events WHEN NEW.kind='APPROVED'
   BEGIN SELECT RAISE(ABORT,'injected interruption'); END`);
  assert.throws(()=>f.store.approve(broadcaster,placement,now+1),/injected interruption/);
  assert.deepEqual(f.store.active({...sponsor,stationId:placement.stationId},now+1000),[]);
  f.store.db.exec('DROP TRIGGER reject_approval');
  f.store.approve(broadcaster,placement,now+2);
  assert.throws(()=>f.store.revoke(other,placement,now+3),/REVOCATION_DENIED/);
  assert.equal(f.store.revoke(sponsor,placement,now+3).replay,false);
  assert.equal(f.store.revoke(sponsor,placement,now+4).replay,true);
  assert.deepEqual(f.store.active({...sponsor,stationId:placement.stationId},now+1000),[]);
  assert.deepEqual(f.store.db.prepare('SELECT kind FROM placement_events ORDER BY occurred_at_ms').all().map(x=>x.kind),
   ['SUBMITTED','APPROVED','REVOKED']);
 }finally{f.cleanup();}
});
test('HTTP boundary rejects forged identity, cross-origin writes and unverified roles',async()=>{
 const f=fixture();try{
  const future={...placement,startsAtMs:Date.now()+1000,endsAtMs:Date.now()+10000};
  const handle=createSponsorPlacementHandler(f.store,async request=>
   request.headers.get('x-fixture-auth')==='sponsor'?sponsor:
   request.headers.get('x-fixture-auth')==='broadcaster'?broadcaster:null);
  const post=(path,body,auth='sponsor',origin='https://app.example.test')=>new Request('https://app.example.test'+path,
   {method:'POST',headers:{origin,'x-fixture-auth':auth},body:JSON.stringify(body)});
  assert.equal((await handle(post('/v1/sponsor-placements',future,'sponsor','https://evil.test'))).status,403);
  assert.equal((await handle(post('/v1/sponsor-placements',{...future,roles:['broadcaster']}))).status,403);
  assert.equal((await handle(post('/v1/sponsor-placements',future,'none'))).status,401);
  assert.equal((await handle(post('/v1/sponsor-placements',future))).status,200);
  assert.equal((await handle(post('/v1/sponsor-placements/approve',placement,'sponsor'))).status,403);
  assert.equal((await handle(post('/v1/sponsor-placements/approve',placement,'broadcaster'))).status,200);
  const url='https://app.example.test/v1/sponsor-placements/active?tenant=tenant-a&application=trackzero&stationId=station-001';
  assert.equal((await (await handle(new Request(url))).json()).placements.length,0);
 }finally{f.cleanup();}
});
