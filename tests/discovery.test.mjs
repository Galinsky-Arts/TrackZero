import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDiscovery,createDiscoveryHandler} from '../src/discovery.mjs';
const station={id:'station-01',name:'A <Radio>',description:'Live & linear'};
const options={publicOrigin:'https://radio.example.test'};
test('canonical station sharing escapes metadata without media or listener data',()=>{
  const html=renderDiscovery([station],options);
  assert.match(html,/A &lt;Radio&gt;/);
  assert.match(html,/https:\/\/radio\.example\.test\/stations\/station-01/);
  assert.doesNotMatch(html,/playback-token|manifest|<audio|listener-id|event invitation/i);
});
test('hostile station records and untrusted share origin fail closed',()=>{
  for(const item of [{...station,id:'../other'},{...station,name:''},
    {...station,description:'x'.repeat(501)}])assert.throws(()=>renderDiscovery([item],options));
  assert.throws(()=>renderDiscovery([station,station],options));
  assert.throws(()=>renderDiscovery([station],{publicOrigin:'https://radio.example.test.evil.test/path'}));
  assert.throws(()=>renderDiscovery([station],{publicOrigin:'http://radio.example.test'}));
});
test('public handler exposes only a bounded metadata page and fails on provider outage',async()=>{
  const handler=createDiscoveryHandler({listStations:async()=>[station],...options});
  const response=await handler(new Request('https://radio.example.test/v1/discover'));
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal((await handler(new Request('https://radio.example.test/v1/discover',{method:'POST'}))).status,404);
  const down=createDiscoveryHandler({listStations:async()=>{throw Error('offline')},...options});
  assert.equal((await down(new Request('https://radio.example.test/v1/discover'))).status,503);
});
