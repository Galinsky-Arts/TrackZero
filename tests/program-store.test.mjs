import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProgramStore,createProgramHandler} from '../src/program-store.mjs';

const owner={tenant:'tenant-a',application:'trackzero',subject:'provider:owner',roles:['broadcaster']};
const other={...owner,subject:'provider:other'};
const items=[{id:'intro-1',kind:'intro'},{id:'song-1',kind:'song'}];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'tz06-')),file=join(dir,'program.sqlite');
 const options={authorizeStation:(actor,stationId)=>actor.subject===owner.subject&&actor.tenant===owner.tenant&&
   actor.application===owner.application&&stationId==='station-1',
   authorizeItem:(actor,stationId,item)=>actor.subject===owner.subject&&stationId==='station-1'&&item.id!=='denied'};
 const store=new ProgramStore(file,options);return {store,file,options,cleanup(){this.store.close();rmSync(dir,{recursive:true,force:true});}};}

test('authorized broadcaster saves durable versioned sequence',()=>{
 const f=fixture();try{
  assert.deepEqual(f.store.read(owner,'station-1'),{version:0,items:[]});
  assert.equal(f.store.save(owner,'station-1',{expectedVersion:0,items}).version,1);
  f.store.close();f.store=new ProgramStore(f.file,f.options);
  assert.deepEqual(f.store.read(owner,'station-1').items,items);
  assert.equal(f.store.save(owner,'station-1',{expectedVersion:1,items:[...items].reverse()}).version,2);
  assert.deepEqual(f.store.read(owner,'station-1').items.map(x=>x.id),['song-1','intro-1']);
 }finally{f.cleanup();}
});
test('cross-role, cross-owner and stale-version writes fail closed',()=>{
 const f=fixture();try{
  assert.throws(()=>f.store.save({...owner,roles:['listener']},'station-1',{expectedVersion:0,items}),/BROADCASTER_ROLE_REQUIRED/);
  assert.throws(()=>f.store.save(other,'station-1',{expectedVersion:0,items}),/STATION_ACCESS_DENIED/);
  assert.throws(()=>f.store.save({...owner,tenant:'tenant-b'},'station-1',{expectedVersion:0,items}),/STATION_ACCESS_DENIED/);
  f.store.save(owner,'station-1',{expectedVersion:0,items});
  assert.throws(()=>f.store.save(owner,'station-1',{expectedVersion:0,items:[...items].reverse()}),/VERSION_CONFLICT/);
  assert.throws(()=>f.store.save(owner,'station-1',{expectedVersion:1,items:[items[0],items[0]]}),/INVALID_PROGRAM/);
  assert.throws(()=>f.store.save(owner,'station-1',{expectedVersion:1,items:[{id:'denied',kind:'song'}]}),/PROGRAM_ITEM_DENIED/);
  assert.equal(f.store.read(owner,'station-1').version,1);
 }finally{f.cleanup();}
});
test('interrupted write rolls back the version and sequence',()=>{
 const f=fixture();try{
  f.store.save(owner,'station-1',{expectedVersion:0,items});
  f.store.db.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON programs
    BEGIN SELECT RAISE(ABORT,'injected interruption'); END`);
  assert.throws(()=>f.store.save(owner,'station-1',{expectedVersion:1,items:[...items].reverse()}),/injected interruption/);
  assert.deepEqual(f.store.read(owner,'station-1'),{version:1,items});
  f.store.db.exec('DROP TRIGGER reject_update');
  assert.equal(f.store.save(owner,'station-1',{expectedVersion:1,items:[...items].reverse()}).version,2);
 }finally{f.cleanup();}
});
test('HTTP rejects client identity claims, cross-origin saves and stale versions',async()=>{
 const f=fixture();try{
  const handle=createProgramHandler(f.store,async request=>request.headers.get('x-fixture-auth')==='owner'?owner:other);
  const put=(body,auth='owner',origin='https://app.example.test')=>new Request('https://app.example.test/v1/programs/station-1',
    {method:'PUT',headers:{origin,'x-fixture-auth':auth},body:JSON.stringify(body)});
  const oversized=new Request('https://app.example.test/v1/programs/station-1',{method:'PUT',headers:{origin:'https://app.example.test','x-fixture-auth':'owner'},body:JSON.stringify({note:'😀'.repeat(30_000)})});
  assert.equal((await handle(oversized)).status,413);
  assert.equal((await handle(put({expectedVersion:0,items},'owner','https://evil.test'))).status,403);
  assert.equal((await handle(put({expectedVersion:0,items,subject:owner.subject}))).status,403);
  assert.equal((await handle(put({expectedVersion:0,items},'other'))).status,403);
  assert.equal((await handle(put({expectedVersion:0,items}))).status,200);
  assert.equal((await handle(put({expectedVersion:0,items}))).status,409);
  assert.deepEqual(await (await handle(new Request('https://app.example.test/v1/programs/station-1',{headers:{'x-fixture-auth':'owner'}}))).json(),{version:1,items});
 }finally{f.cleanup();}
});
