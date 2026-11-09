import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,chmodSync,symlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {PrivacyStore,createPrivacyHandler} from '../src/privacy-complaints.mjs';
const alice={tenant:'tenant-a',application:'trackzero',subject:'provider:alice'},moderator={...alice,subject:'moderator'};
const value={target:'station-a',reason:'Please review this private station'},operation='operation-0000000000000001';
// Opaque fixture codec checks associated context. It is not encryption or a production key protocol.
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'tz20-')),filename=join(dir,'privacy.sqlite'),records=new Map();let approved=true;
 const codecs={seal:async(value,context)=>{const token=randomUUID();records.set(token,{value:structuredClone(value),context});return Buffer.from(token);},
  open:async(bytes,context)=>{const record=records.get(Buffer.from(bytes).toString());assert.deepEqual(context,record?.context);return structuredClone(record.value);},
  authorizeDecision:async actor=>approved&&actor.subject==='moderator',now:()=>1000};
 let store=new PrivacyStore(filename,codecs);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,filename,codecs,get store(){return store},deny:()=>{approved=false},reopen(){store.close();store=new PrivacyStore(filename,codecs);}};
}
test('private scoped complaint retries and moderator decisions survive restart without plaintext payloads',async t=>{
 const f=fixture(t);assert.equal((await f.store.own(alice)).publicProfile,false);await f.store.setVisibility(alice,true);
 const result=await f.store.complain(alice,value,operation);assert.equal((await f.store.complain(alice,value,operation)).id,result.id);
 await assert.rejects(f.store.complain(alice,{...value,target:'different'},operation),/CONFLICT/);
 await f.store.recordDecision(moderator,{...alice,outcome:'RESTRICTION',explanation:'Repeated verified rights violations'});f.reopen();
 const own=await f.store.own(alice);assert.equal(own.publicProfile,true);assert.equal(own.complaints.length,1);assert.equal(own.decisions[0].outcome,'RESTRICTION');assert.equal(own.decisions[0].operatorId,undefined);
 for(const other of [{...alice,tenant:'other'},{...alice,subject:'bob'}])assert.equal((await f.store.own(other)).complaints.length,0);
 for(const file of [f.filename,f.filename+'-wal']){
  const bytes=readFileSync(file).toString();assert.ok(!bytes.includes(value.reason));assert.ok(!bytes.includes('Repeated verified rights violations'));assert.ok(!bytes.includes(value.target));
 }
});
test('moderator identity, scoped authorization, byte limits and mandatory codecs fail closed',async t=>{
 const f=fixture(t),input={...alice,outcome:'WARNING',explanation:'Verified policy violation'};
 await assert.rejects(f.store.recordDecision(alice,input),/MODERATOR_DENIED/);
 await assert.rejects(f.store.recordDecision({...moderator,tenant:'other'},input),/MODERATOR_DENIED/);
 f.deny();await assert.rejects(f.store.recordDecision(moderator,input),/MODERATOR_DENIED/);
 await assert.rejects(f.store.complain(alice,{...value,reason:'é'.repeat(501)},operation),/INVALID_COMPLAINT/);
 await assert.rejects(f.store.complain(alice,{...value,subject:'bob'},operation),/INVALID_COMPLAINT/);
 await assert.rejects(f.store.complain(alice,value,'short'),/IDEMPOTENCY/);
 assert.throws(()=>new PrivacyStore(join(f.dir,'other.sqlite')),/codecs/);
 assert.equal((await f.store.own(alice)).decisions.length,0);
});
test('history is bounded and a cursor cannot escape the owner or record kind',async t=>{
 const f=fixture(t);for(let i=0;i<5;i++)await f.store.complain(alice,value,operation+i);
 const page=await f.store.own(alice);assert.equal(page.complaints.length,2);assert.ok(page.nextComplaintId);
 const next=await f.store.own(alice,{afterComplaintId:page.nextComplaintId});assert.equal(next.complaints.length,2);assert.notEqual(next.complaints[0].id,page.complaints[0].id);
 await assert.rejects(f.store.own({...alice,subject:'bob'},{afterComplaintId:page.nextComplaintId}),/INVALID_CURSOR/);
 await assert.rejects(f.store.own(alice,{afterDecisionId:page.nextComplaintId}),/INVALID_CURSOR/);
});
test('payload swaps fail endpoint associated-context authentication',async t=>{
 const f=fixture(t);await f.store.complain(alice,value,operation);await f.store.complain({...alice,subject:'bob'},value,operation);
 const db=new DatabaseSync(f.filename),rows=db.prepare('SELECT id,ciphertext FROM private_cases').all();
 db.prepare('UPDATE private_cases SET ciphertext=? WHERE id=?').run(rows[1].ciphertext,rows[0].id);db.close();
 await assert.rejects(f.store.own(alice));
});
test('legacy plaintext and unsafe database files require explicit migration or private storage',async t=>{
 const f=fixture(t),legacy=join(f.dir,'legacy.sqlite');const db=new DatabaseSync(legacy);db.exec('CREATE TABLE complaints(reason TEXT)');db.close();chmodSync(legacy,0o600);
 assert.throws(()=>new PrivacyStore(legacy,f.codecs),/Legacy plaintext/);
 symlinkSync(f.filename,join(f.dir,'link.sqlite'));assert.throws(()=>new PrivacyStore(join(f.dir,'link.sqlite'),f.codecs));
 chmodSync(f.dir,0o755);assert.throws(()=>new PrivacyStore(join(f.dir,'other.sqlite'),f.codecs),/private/);chmodSync(f.dir,0o700);
});
const packet={body:{version:'1.0.0',scope:{tenantId:'tenant-a',application:'distributed-radio',sessionId:'fixture'},keyId:'key',algorithm:'ALG-ED25519',epoch:1,sequence:1,issuedAtMs:1000,expiresAtMs:10000,action:'privacy',payloadCiphertextBase64:'Zml4dHVyZQ=='},signatureHex:'0'.repeat(128)};
const req=(method,path,body=packet,headers={})=>new Request('https://app.test'+path,{method,headers:{origin:'https://app.test','idempotency-key':operation,...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})});
test('HTTP requires encrypted endpoint codecs, owner identity and same-origin mutations',async t=>{
 const f=fixture(t),encoded=[];let plain=value;
 assert.throws(()=>createPrivacyHandler(f.store,async()=>alice),/codecs/);
 const handler=createPrivacyHandler(f.store,async request=>request.headers.has('no-auth')?null:alice,{
  decodeControl:async()=>plain,encodeResponse:async(_actor,value)=>{encoded.push(value);return packet;}});
 assert.equal((await handler(req('GET','/v1/privacy',undefined,{'no-auth':'1'}))).status,401);
 assert.equal((await handler(req('POST','/v1/complaints',packet,{origin:'https://evil.test'}))).status,403);
 assert.equal((await handler(req('POST','/v1/complaints',value))).status,400);
 const success=await handler(req('POST','/v1/complaints'));assert.equal(success.status,201);assert.deepEqual(await success.json(),packet);assert.equal(encoded.at(-1).reason,value.reason);
 plain={publicProfile:true,subject:'bob'};assert.equal((await handler(req('POST','/v1/privacy/preferences'))).status,400);
 const read=await handler(req('GET','/v1/privacy'));assert.equal(read.status,200);assert.doesNotMatch(await read.text(),/Please review|station-a|provider:alice/);
 const failed=createPrivacyHandler(f.store,async()=>alice,{decodeControl:async()=>value,encodeResponse:async()=>{throw Error(value.reason);}});
 assert.equal((await failed(req('GET','/v1/privacy'))).status,503);
});
