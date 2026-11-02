import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RightsRegistry,createRightsHandler} from '../src/rights-registry.mjs';

const artist={tenant:'tenant-a',application:'trackzero',subject:'provider:artist',roles:['artist']};
const reviewer={...artist,subject:'provider:reviewer',roles:['rights_reviewer']};
const other={...artist,subject:'provider:other'};
const claim={itemId:'album-001',region:'US',licenseVersion:'v1',evidenceDigest:'a'.repeat(64),uses:['broadcast'],rightsValidFromMs:1,rightsValidUntilMs:Number.MAX_SAFE_INTEGER};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'tz05-')),file=join(dir,'rights.sqlite');
 const registry=new RightsRegistry(file);return {registry,file,cleanup(){this.registry.close();rmSync(dir,{recursive:true,force:true});}};}

test('separate review permits only the exact scoped album and expires',()=>{
 const f=fixture(),now=1_000_000;
 try{
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now),false);
  f.registry.submitClaim(artist,claim,now);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now),false);
  f.registry.review(reviewer,{itemId:claim.itemId,region:claim.region,approved:true,validUntilMs:now+1000},now+1);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now+2),true);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'sale'},now+2),false);
  assert.equal(f.registry.canPublish({...artist,...claim,tenant:'tenant-b',use:'broadcast'},now+2),false);
  assert.equal(f.registry.canPublish({...artist,...claim,application:'other',use:'broadcast'},now+2),false);
  assert.equal(f.registry.canPublish({...artist,...claim,region:'CA',use:'broadcast'},now+2),false);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now+1000),false);
  f.registry.close();f.registry=new RightsRegistry(f.file);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now+2),true);
 }finally{f.cleanup();}
});

test('listener, self-review, unrelated owner and malformed claim fail closed',()=>{
 const f=fixture(),now=2_000_000;
 try{
  assert.throws(()=>f.registry.submitClaim({...artist,roles:['listener']},claim,now),/ROLE_DENIED/);
  assert.throws(()=>f.registry.submitClaim(artist,{...claim,evidenceDigest:'not-a-digest'},now),/INVALID_CLAIM/);
  assert.throws(()=>f.registry.submitClaim(artist,{...claim,itemId:'album-uses',uses:['broadcast','broadcast']},now),/INVALID_CLAIM/);
  assert.throws(()=>f.registry.submitClaim(artist,{...claim,itemId:'album-window',rightsValidUntilMs:1},now),/INVALID_CLAIM/);
  f.registry.submitClaim(artist,claim,now);
  assert.throws(()=>f.registry.review({...artist,roles:['artist','rights_reviewer']},{itemId:claim.itemId,region:claim.region,approved:true,validUntilMs:now+1000},now+1),/SELF_REVIEW_DENIED/);
  assert.throws(()=>f.registry.review(other,{itemId:claim.itemId,region:claim.region,approved:true,validUntilMs:now+1000},now+1),/ROLE_DENIED/);
  assert.throws(()=>f.registry.withdraw(other,claim,now+1),/OWNER_OR_REVIEWER_REQUIRED/);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now+2),false);
 }finally{f.cleanup();}
});

test('review denial and takedown never leave a publishable item',()=>{
 const f=fixture(),now=3_000_000;
 try{
  f.registry.submitClaim(artist,claim,now);
  assert.throws(()=>f.registry.review(reviewer,{itemId:claim.itemId,region:claim.region,approved:false},now-1),/NON_MONOTONIC_EVENT/);
  f.registry.review(reviewer,{itemId:claim.itemId,region:claim.region,approved:false},now+1);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now+2),false);
  assert.throws(()=>f.registry.review(reviewer,{itemId:claim.itemId,region:claim.region,approved:true,validUntilMs:now+1000},now+2),/PENDING_CLAIM_REQUIRED/);
  const second={...claim,itemId:'album-002'};
  f.registry.submitClaim(artist,second,now);
  f.registry.review(reviewer,{itemId:second.itemId,region:second.region,approved:true,validUntilMs:now+1000},now+1);
  assert.equal(f.registry.canPublish({...artist,...second,use:'broadcast'},now+2),true);
  assert.throws(()=>f.registry.withdraw(artist,second,now),/NON_MONOTONIC_EVENT/);
  assert.equal(f.registry.withdraw(artist,second,now+3).replay,false);
  assert.equal(f.registry.withdraw(artist,second,now+4).replay,true);
  assert.equal(f.registry.canPublish({...artist,...second,use:'broadcast'},now+4),false);
  const events=f.registry.db.prepare('SELECT kind FROM rights_events WHERE item_id=? ORDER BY occurred_at_ms').all(second.itemId);
  assert.deepEqual(events.map(row=>row.kind),['SUBMITTED','APPROVED','WITHDRAWN']);
  assert.ok(!JSON.stringify(events).includes(claim.evidenceDigest));
 }finally{f.cleanup();}
});

test('interrupted review write rolls back both decision and audit event',()=>{
 const f=fixture(),now=4_000_000;
 try{
  f.registry.submitClaim(artist,claim,now);
  f.registry.db.exec(`CREATE TRIGGER reject_review BEFORE INSERT ON rights_events WHEN NEW.kind='APPROVED'
    BEGIN SELECT RAISE(ABORT,'injected interruption'); END`);
  assert.throws(()=>f.registry.review(reviewer,{itemId:claim.itemId,region:claim.region,approved:true,validUntilMs:now+1000},now+1),/injected interruption/);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now+2),false);
  assert.equal(f.registry.db.prepare('SELECT state FROM rights_cases WHERE item_id=?').get(claim.itemId).state,'PENDING');
  f.registry.db.exec('DROP TRIGGER reject_review');
  f.registry.review(reviewer,{itemId:claim.itemId,region:claim.region,approved:true,validUntilMs:now+1000},now+2);
  assert.equal(f.registry.canPublish({...artist,...claim,use:'broadcast'},now+3),true);
 }finally{f.cleanup();}
});

test('HTTP boundary rejects client role claims, cross-origin writes and unverified reviewers',async()=>{
 const f=fixture();
 try{
  const handler=createRightsHandler(f.registry,async request=>
   request.headers.get('x-fixture-auth')==='artist'?artist:
   request.headers.get('x-fixture-auth')==='reviewer'?reviewer:null);
  const post=(path,body,auth='artist',origin='https://app.example.test')=>new Request('https://app.example.test'+path,
   {method:'POST',headers:{origin,'x-fixture-auth':auth},body:JSON.stringify(body)});
  const oversized=new Request('https://app.example.test/v1/rights/claims',{method:'POST',headers:{origin:'https://app.example.test','x-fixture-auth':'artist'},body:JSON.stringify({note:'😀'.repeat(1500)})});
  assert.equal((await handler(oversized)).status,413);
  assert.equal((await handler(post('/v1/rights/claims',claim,'none'))).status,401);
  assert.equal((await handler(post('/v1/rights/claims',claim,'artist','https://other.test'))).status,403);
  assert.equal((await handler(post('/v1/rights/claims',{...claim,roles:['rights_reviewer']}))).status,403);
  assert.equal((await handler(post('/v1/rights/claims',claim))).status,200);
  const review={itemId:claim.itemId,region:claim.region,approved:true,validUntilMs:Date.now()+60_000};
  assert.equal((await handler(post('/v1/rights/reviews',review,'artist'))).status,403);
  assert.equal((await handler(post('/v1/rights/reviews',review,'reviewer'))).status,200);
  const query=new Request('https://app.example.test/v1/rights/decisions/album-001?tenant=tenant-a&application=trackzero&region=US&use=broadcast');
  assert.deepEqual(await (await handler(query)).json(),{publishable:true});
  assert.equal((await handler(post('/v1/rights/withdrawals',{itemId:claim.itemId,region:claim.region}))).status,200);
  assert.deepEqual(await (await handler(query)).json(),{publishable:false});
 }finally{f.cleanup();}
});
