import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StationOperations,renderStationStatus,createStationOperationsHandler} from '../src/station-operations.mjs';

const source={tenant:'tenant-a',application:'trackzero',engineId:'engine-1',role:'station_engine'};
const now=1_000_000;
const first={stationId:'station-001',sequence:1,scheduleVersion:2,mode:'PRIMARY',observedAtMs:now};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'tz09-')),file=join(dir,'operations.sqlite');
 const options={authorizeEngine:(engine,station)=>engine.tenant===source.tenant&&engine.application===source.application&&
  engine.engineId===source.engineId&&station===first.stationId,staleAfterMs:10_000};
 const store=new StationOperations(file,options);return {store,file,options,cleanup(){this.store.close();rmSync(dir,{recursive:true,force:true});}};}
test('engine events show primary, fallback, recovery and stale status after restart',()=>{
 const f=fixture();try{
  assert.equal(f.store.status({...source,stationId:first.stationId},now).state,'UNKNOWN');
  assert.equal(f.store.ingest(source,first,now).state,'PRIMARY');
  f.store.ingest(source,{...first,sequence:2,mode:'FALLBACK',observedAtMs:now+1000},now+1000);
  f.store.ingest(source,{...first,sequence:3,mode:'RECOVERING',observedAtMs:now+2000},now+2000);
  f.store.ingest(source,{...first,sequence:4,mode:'PRIMARY',scheduleVersion:3,observedAtMs:now+3000},now+3000);
  assert.equal(f.store.status({...source,stationId:first.stationId},now+3000).state,'PRIMARY');
  f.store.close();f.store=new StationOperations(f.file,f.options);
  assert.equal(f.store.status({...source,stationId:first.stationId},now+20_000).state,'STALE');
  assert.equal(f.store.status({...source,stationId:first.stationId,tenant:'other'},now+3000).state,'UNKNOWN');
 }finally{f.cleanup();}
});
test('replay, out-of-order transitions, schedule regression and wrong engine fail closed',()=>{
 const f=fixture();try{
  f.store.ingest(source,first,now);
  assert.throws(()=>f.store.ingest(source,first,now),/STALE_OR_INVALID_TRANSITION/);
  assert.throws(()=>f.store.ingest(source,{...first,sequence:2,mode:'RECOVERING'},now),/STALE_OR_INVALID_TRANSITION/);
  assert.throws(()=>f.store.ingest(source,{...first,sequence:2,scheduleVersion:1},now),/STALE_OR_INVALID_TRANSITION/);
  assert.throws(()=>f.store.ingest({...source,engineId:'engine-other'},{...first,sequence:2},now),/ENGINE_SCOPE_DENIED/);
  assert.throws(()=>f.store.ingest({...source,role:'creator_phone'},{...first,sequence:2},now),/ENGINE_AUTH_REQUIRED/);
  assert.equal(f.store.status({...source,stationId:first.stationId},now).state,'PRIMARY');
 }finally{f.cleanup();}
});
test('interrupted event update rolls back and later sequence can recover',()=>{
 const f=fixture();try{
  f.store.ingest(source,first,now);
  f.store.db.exec(`CREATE TRIGGER reject_event BEFORE UPDATE ON station_operations
   BEGIN SELECT RAISE(ABORT,'injected interruption'); END`);
  assert.throws(()=>f.store.ingest(source,{...first,sequence:2,mode:'FALLBACK',observedAtMs:now+1},now+1),/injected interruption/);
  assert.equal(f.store.status({...source,stationId:first.stationId},now+1).state,'PRIMARY');
  f.store.db.exec('DROP TRIGGER reject_event');
  assert.equal(f.store.ingest(source,{...first,sequence:2,mode:'FALLBACK',observedAtMs:now+2},now+2).state,'FALLBACK');
 }finally{f.cleanup();}
});
test('status markup is accessible and rejects injected fields',()=>{
 const html=renderStationStatus({stationId:'station-001',state:'STALE',scheduleVersion:3});
 assert.match(html,/aria-live="polite"/);assert.match(html,/Engine report is stale/);
 assert.throws(()=>renderStationStatus({stationId:'<script>',state:'PRIMARY',scheduleVersion:3}));
 assert.throws(()=>renderStationStatus({stationId:'station-001',state:'PRIMARY',scheduleVersion:'<script>'}));
});
test('HTTP accepts only server-authenticated engine events and same-origin writes',async()=>{
 const f=fixture();try{
  const handle=createStationOperationsHandler(f.store,async request=>request.headers.get('x-fixture-engine')==='yes'?source:null,
   {authorizeViewer:(viewer,station)=>viewer.tenant===source.tenant&&station===first.stationId});
  const current=Date.now(),event={...first,observedAtMs:current};
  const post=(body,auth='yes',origin='https://app.example.test')=>new Request('https://app.example.test/v1/station-engine/events',
   {method:'POST',headers:{origin,'x-fixture-engine':auth},body:JSON.stringify(body)});
  assert.equal((await handle(post(event,'yes','https://evil.test'))).status,403);
  assert.equal((await handle(post({...event,engineId:source.engineId}))).status,403);
  assert.equal((await handle(post(event,'no'))).status,403);
  assert.equal((await handle(post(event))).status,200);
  const statusUrl='https://app.example.test/v1/stations/station-001/status';
  assert.equal((await handle(new Request(statusUrl))).status,401);
  assert.equal((await handle(new Request(statusUrl+'?tenant=other',{headers:{'x-fixture-engine':'yes'}}))).status,403);
  const response=await handle(new Request(statusUrl,{headers:{'x-fixture-engine':'yes'}}));
  assert.equal((await response.json()).state,'PRIMARY');
 }finally{f.cleanup();}
});

test('invalid clock never accepts events or reports fresh state',()=>{
 const f=fixture();try{
  for(const clock of [NaN,Infinity,-1,1.2]){
   assert.throws(()=>f.store.ingest(source,first,clock),/INVALID_CLOCK/);
   assert.throws(()=>f.store.status({...source,stationId:first.stationId},clock),/INVALID_CLOCK/);
  }
 }finally{f.cleanup();}
});
