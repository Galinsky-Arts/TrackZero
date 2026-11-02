import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SponsorPlacementStore, createSponsorHandler} from '../src/sponsor-store.mjs';

const sponsor = {tenant:'tenant-a',application:'trackzero',subject:'provider:sponsor',roles:['sponsor']};
const broadcaster = {...sponsor,subject:'provider:broadcaster',roles:['broadcaster']};
const digest = 'sha256:' + 'a'.repeat(64);
const campaign = {campaignId:'campaign-001',stationId:'station-one',audioRef:'ciphertext:sponsor-001',
  mimeType:'audio/mpeg',sha256:'b'.repeat(64),durationMs:30000,rateMinor:450};
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'tz08-')), file=join(dir,'sponsors.sqlite');
  const options={
    authorizeStation:(actor,station,action)=>actor.tenant==='tenant-a'&&actor.application==='trackzero'&&
      station==='station-one'&&((action==='upload'&&actor.subject===sponsor.subject)||
      (action==='place'&&actor.subject===broadcaster.subject)),
    authorizeCampaign:(actor,record)=>actor.subject===broadcaster.subject&&record.programDigest===digest
  };
  const store=new SponsorPlacementStore(file,options);
  return {store,file,options,cleanup(){this.store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('sponsor metadata remains quarantined and survives restart',()=>{
  const f=fixture(); try {
    const created=f.store.create(sponsor,campaign,1000); assert.equal(created.placeable,false);
    f.store.close(); f.store=new SponsorPlacementStore(f.file,f.options);
    assert.equal(f.store.get(broadcaster,campaign.stationId,campaign.campaignId).placement,null);
    assert.throws(()=>f.store.create(sponsor,campaign,1001),/CAMPAIGN_EXISTS/);
    assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM sponsor_campaigns').all()),/private key|plaintext|audio bytes/i);
  } finally {f.cleanup();}
});

test('verified broadcaster places exact DRE-09 campaign against approved program',()=>{
  const f=fixture(); try {
    f.store.create(sponsor,campaign,1000);
    assert.throws(()=>f.store.place(broadcaster,campaign.stationId,campaign.campaignId,
      'sha256:'+'c'.repeat(64),2000),/PLACEMENT_DENIED/);
    assert.equal(f.store.get(broadcaster,campaign.stationId,campaign.campaignId).placement,null);
    const placed=f.store.place(broadcaster,campaign.stationId,campaign.campaignId,digest,2000);
    assert.deepEqual(placed,{tenantId:'tenant-a',stationId:'station-one',campaignId:'campaign-001',
      audioRef:'ciphertext:sponsor-001',programDigest:digest,rateMinor:450});
    assert.throws(()=>f.store.place(broadcaster,campaign.stationId,campaign.campaignId,digest,3000),/ALREADY_PLACED/);
  } finally {f.cleanup();}
});

test('cross-role, cross-station and raw upload claims fail closed',()=>{
  const f=fixture(); try {
    assert.throws(()=>f.store.create(broadcaster,campaign,1000),/SPONSOR_ROLE_REQUIRED/);
    assert.throws(()=>f.store.create(sponsor,{...campaign,stationId:'other-station'},1000),/STATION_ACCESS_DENIED/);
    for(const invalid of [{...campaign,audioRef:'https://example.test/ad.mp3'},{...campaign,media:'bytes'},
      {...campaign,rateMinor:-1},{...campaign,durationMs:300001}])
      assert.throws(()=>f.store.create(sponsor,invalid,1000),/INVALID_DRAFT/);
    f.store.create(sponsor,campaign,1000);
    assert.throws(()=>f.store.place(sponsor,campaign.stationId,campaign.campaignId,digest,2000),/BROADCASTER_ROLE_REQUIRED/);
  } finally {f.cleanup();}
});

test('interrupted draft and placement writes roll back completely',()=>{
  const f=fixture(); try {
    f.store.db.exec(`CREATE TRIGGER reject_campaign BEFORE INSERT ON sponsor_campaigns
      BEGIN SELECT RAISE(ABORT,'injected interruption'); END`);
    assert.throws(()=>f.store.create(sponsor,campaign,1000),/injected interruption/);
    f.store.db.exec('DROP TRIGGER reject_campaign'); f.store.create(sponsor,campaign,1000);
    f.store.db.exec(`CREATE TRIGGER reject_placement BEFORE UPDATE ON sponsor_campaigns
      BEGIN SELECT RAISE(ABORT,'injected placement interruption'); END`);
    assert.throws(()=>f.store.place(broadcaster,campaign.stationId,campaign.campaignId,digest,2000),/injected placement interruption/);
    f.store.db.exec('DROP TRIGGER reject_placement');
    assert.equal(f.store.get(broadcaster,campaign.stationId,campaign.campaignId).placement,null);
  } finally {f.cleanup();}
});

test('HTTP boundary rejects origin, identity, raw media and oversized requests',async()=>{
  const f=fixture(); try {
    const handle=createSponsorHandler(f.store,async request=>request.headers.get('x-auth')==='sponsor'?sponsor:
      request.headers.get('x-auth')==='broadcaster'?broadcaster:null);
    const post=(body,auth='sponsor',origin='https://app.example.test',path='/v1/sponsors')=>
      new Request('https://app.example.test'+path,{method:'POST',headers:{origin,'x-auth':auth},body:JSON.stringify(body)});
    assert.equal((await handle(post(campaign,'sponsor','https://evil.test'))).status,403);
    assert.equal((await handle(post({...campaign,media:'bytes'}))).status,403);
    assert.equal((await handle(post({...campaign,sha256:'d'.repeat(5000)}))).status,413);
    assert.equal((await handle(post(campaign))).status,201);
    const path='/v1/sponsors/station-one/campaign-001/place';
    assert.equal((await handle(post({programDigest:digest},'sponsor',undefined,path))).status,403);
    assert.equal((await handle(post({programDigest:digest},'broadcaster',undefined,path))).status,200);
    const read=await handle(new Request('https://app.example.test/v1/sponsors/station-one/campaign-001',
      {headers:{'x-auth':'broadcaster'}})); assert.equal(read.status,200);
  } finally {f.cleanup();}
});
