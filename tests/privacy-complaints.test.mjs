import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrivacyStore,createPrivacyHandler} from '../src/privacy-complaints.mjs';
const alice={tenant:'tenant-a',application:'trackzero',subject:'provider:alice'};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'tz20-'));
  const store=new PrivacyStore(join(dir,'privacy.sqlite'));
  return {store,cleanup(){store.close();rmSync(dir,{recursive:true,force:true})}};}
const req=(method,path,body,headers={})=>new Request('https://app.example.test'+path,
  {method,headers:{origin:'https://app.example.test',...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});

test('privacy preference and own complaint history persist with scoped decisions',()=>{
  const f=fixture();try{
    assert.equal(f.store.own(alice).publicProfile,false);
    f.store.setVisibility(alice,true);
    const complaint=f.store.complain(alice,{target:'station-a',reason:'Please review this station'});
    f.store.recordDecision({...alice,outcome:'RESTRICTION',explanation:'Repeated verified rights violations'});
    const own=f.store.own(alice);
    assert.equal(own.publicProfile,true);
    assert.equal(own.complaints[0].id,complaint.id);
    assert.equal(own.decisions[0].outcome,'RESTRICTION');
    assert.deepEqual(f.store.own({...alice,tenant:'tenant-b'}),{publicProfile:false,complaints:[],decisions:[]});
    assert.deepEqual(f.store.own({...alice,subject:'provider:bob'}),{publicProfile:false,complaints:[],decisions:[]});
  }finally{f.cleanup()}
});
test('HTTP denies identity claims, cross-origin mutation and unauthenticated reads',async()=>{
  const f=fixture();try{
    const handle=createPrivacyHandler(f.store,async request=>
      request.headers.get('x-auth')==='none'?null:alice);
    assert.equal((await handle(req('GET','/v1/privacy',undefined,{'x-auth':'none'}))).status,401);
    assert.equal((await handle(req('POST','/v1/privacy/preferences',{publicProfile:true},
      {origin:'https://evil.test'}))).status,403);
    assert.equal((await handle(req('POST','/v1/privacy/preferences',
      {publicProfile:true,subject:'provider:bob'}))).status,400);
    assert.equal((await handle(req('POST','/v1/complaints',
      {target:'station-a',reason:'Please review this station'}))).status,201);
    assert.equal((await handle(req('GET','/v1/privacy'))).status,200);
    assert.equal(f.store.own(alice).complaints.length,1);
  }finally{f.cleanup()}
});
test('malformed complaint and unexplained operator decision do not persist',()=>{
  const f=fixture();try{
    assert.throws(()=>f.store.complain(alice,{target:'../bad',reason:'short'}));
    assert.throws(()=>f.store.recordDecision({...alice,outcome:'RESTRICTION',explanation:'none'}));
    assert.equal(f.store.own(alice).complaints.length,0);
    assert.equal(f.store.own(alice).decisions.length,0);
  }finally{f.cleanup()}
});
