import test from 'node:test';import assert from 'node:assert/strict';
import {renderFanLibrary,createFanLibraryHandler} from '../src/fan-library.mjs';
const viewer={userId:'u1',tenant:'tenant-a',application:'trackzero'};
const packet={body:{version:'1.0.0',scope:{tenantId:'tenant-a',application:'distributed-radio',sessionId:'fixture'},keyId:'key',algorithm:'ALG-ED25519',epoch:1,sequence:1,issuedAtMs:1000,expiresAtMs:10000,action:'fan-library',payloadCiphertextBase64:'Zml4dHVyZQ=='},signatureHex:'0'.repeat(128)};
const encoded=[];const encodeResponse=async(_identity,plain)=>{encoded.push(plain);return packet;};
const grant={...viewer,id:'g1',title:'Rare <Take>',kind:'UNLOCKED_GROOVE',state:'ACTIVE',downloadAllowed:false};
test('renders escaped, distinct purchase and Groove entitlements without media URLs',()=>{
  const html=renderFanLibrary(viewer,[grant,{...grant,id:'g2',kind:'PURCHASE',title:'Complete Album'}]);
  assert.match(html,/Rare &lt;Take&gt;/);assert.match(html,/unlocked groove/);
  assert.match(html,/live linear station/);assert.doesNotMatch(html,/https:|<audio/);
});
test('rejects cross-user, duplicate and revoked download grants',()=>{
  assert.throws(()=>renderFanLibrary({...viewer,userId:'u2'},[grant]));
  assert.throws(()=>renderFanLibrary({...viewer,tenant:'tenant-b'},[grant]));
  assert.throws(()=>renderFanLibrary({...viewer,application:'other'},[grant]));
  assert.throws(()=>renderFanLibrary(viewer,[grant,grant]));
  assert.throws(()=>renderFanLibrary(viewer,[{...grant,state:'REVOKED',downloadAllowed:true}]));
});
test('authenticated library endpoint derives scope and fails closed on cross-tenant data',async()=>{
  const request=new Request('https://app.example.test/v1/library?tenant=tenant-b');
  let scope;
  const handler=createFanLibraryHandler({encodeResponse,authenticate:async()=>({...viewer,roles:['listener']}),
    getGrants:async viewer=>{scope=viewer;return [grant]}});
  const result=await handler(request);
  assert.equal(result.status,200);assert.deepEqual(scope,viewer);
  assert.match(result.headers.get('content-security-policy'),/default-src 'none'/);
  assert.match(encoded.at(-1).html,/Rare &lt;Take&gt;/);assert.doesNotMatch(await result.text(),/Rare|Take|UNLOCKED/);
  const wrong=createFanLibraryHandler({encodeResponse,authenticate:async()=>({...viewer,roles:['listener']}),
    getGrants:async()=>[{...grant,tenant:'tenant-b'}]});
  assert.equal((await wrong(request)).status,503);
  const artist=createFanLibraryHandler({encodeResponse,authenticate:async()=>({...viewer,roles:['artist']}),
    getGrants:async()=>{throw Error('must not read')}});
  assert.equal((await artist(request)).status,403);
});
