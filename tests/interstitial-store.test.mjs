import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InterstitialDraftStore,createInterstitialHandler} from '../src/interstitial-store.mjs';

const owner={tenant:'tenant-a',application:'trackzero',subject:'provider:owner',roles:['broadcaster']};
const other={...owner,subject:'provider:other'};
const draft={clipId:'clip-001',stationId:'station-one',kind:'station-ident',origin:'recorded',
 mimeType:'audio/wav',sha256:'a'.repeat(64),durationMs:15000,capturedAtMs:1000};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'tz07-')),file=join(dir,'drafts.sqlite');
 const options={authorizeStation:(actor,station)=>actor.tenant===owner.tenant&&actor.application===owner.application&&
   actor.subject===owner.subject&&station==='station-one'};
 const store=new InterstitialDraftStore(file,options);return {store,file,options,cleanup(){this.store.close();rmSync(dir,{recursive:true,force:true});}};}

test('station owner stores only quarantined metadata and recovers it after restart',()=>{
 const f=fixture();try{
  const created=f.store.create(owner,draft,2000);
  assert.equal(created.publishable,false);assert.equal(created.reviewState,'quarantined');
  f.store.close();f.store=new InterstitialDraftStore(f.file,f.options);
  assert.deepEqual(f.store.get(owner,draft.stationId,draft.clipId),created);
  assert.throws(()=>f.store.create(owner,draft,2000),/DRAFT_EXISTS/);
  const raw=JSON.stringify(f.store.db.prepare('SELECT * FROM interstitial_drafts').all());
  assert.doesNotMatch(raw,/audio data|private key|plaintext/i);
 }finally{f.cleanup();}
});
test('cross-role, cross-station and client publication claims fail closed',()=>{
 const f=fixture();try{
  assert.throws(()=>f.store.create({...owner,roles:['listener']},draft,2000),/BROADCASTER_ROLE_REQUIRED/);
  assert.throws(()=>f.store.create(other,draft,2000),/STATION_ACCESS_DENIED/);
  assert.throws(()=>f.store.create(owner,{...draft,stationId:'other-station'},2000),/STATION_ACCESS_DENIED/);
  for(const injected of [{...draft,publishable:true},{...draft,media:'plaintext'},
    {...draft,key:'secret'},{...draft,sha256:'invalid'}])
    assert.throws(()=>f.store.create(owner,injected,2000),/INVALID_DRAFT/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM interstitial_drafts').get().n,0);
 }finally{f.cleanup();}
});
test('interrupted insert cannot leave a partial draft',()=>{
 const f=fixture();try{
  f.store.db.exec(`CREATE TRIGGER reject_draft BEFORE INSERT ON interstitial_drafts
   BEGIN SELECT RAISE(ABORT,'injected interruption'); END`);
  assert.throws(()=>f.store.create(owner,draft,2000),/injected interruption/);
  f.store.db.exec('DROP TRIGGER reject_draft');
  assert.equal(f.store.create(owner,draft,2000).reviewState,'quarantined');
 }finally{f.cleanup();}
});
test('HTTP boundary rejects unauthenticated, cross-origin and raw media requests',async()=>{
 const f=fixture();try{
  const handle=createInterstitialHandler(f.store,async request=>
    request.headers.get('x-fixture-auth')==='owner'?owner:null);
  const post=(body,auth='owner',origin='https://app.example.test')=>new Request('https://app.example.test/v1/interstitials',
   {method:'POST',headers:{origin,'x-fixture-auth':auth},body:JSON.stringify(body)});
  assert.equal((await handle(post(draft,'owner','https://evil.test'))).status,403);
  assert.equal((await handle(post({...draft,media:'plaintext'}))).status,403);
  assert.equal((await handle(post(draft,'none'))).status,401);
  assert.equal((await handle(post(draft))).status,201);
  assert.equal((await handle(new Request('https://app.example.test/v1/interstitials/station-one/clip-001',
    {headers:{'x-fixture-auth':'owner'}}))).status,200);
  assert.equal((await handle(new Request('https://app.example.test/v1/interstitials/station-one/clip-001',
    {headers:{'x-fixture-auth':'none'}}))).status,401);
 }finally{f.cleanup();}
});
