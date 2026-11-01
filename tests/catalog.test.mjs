import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCompleteAlbums} from '../src/catalog.mjs';

const album={id:'album_123',title:'A complete album',kind:'album',trackCount:12};
test('projects complete albums only after a trusted verifier approves publication',async()=>{
  const calls=[];
  const result=await projectCompleteAlbums([album],async record=>{calls.push(record.id);return true;});
  assert.deepEqual(result,[{id:'album_123',title:'A complete album',trackCount:12,kind:'complete_album'}]);
  assert.deepEqual(calls,['album_123']);
});
test('client-asserted rights and availability are not authorization',async()=>{
  await assert.rejects(projectCompleteAlbums([{...album,rightsVerified:true,available:true}]),/verifier required/);
  await assert.rejects(projectCompleteAlbums([{...album,rightsVerified:true,available:true}],async()=>false),/not verified/);
});
test('rejects individual tracks, invalid data, and duplicate entries',async()=>{
  for(const invalid of [{...album,kind:'track'},{...album,trackCount:0},{...album,trackCount:501},{...album,id:'?'},null])
    await assert.rejects(projectCompleteAlbums([invalid],async()=>true));
  await assert.rejects(projectCompleteAlbums([album,album],async()=>true),/Invalid complete album/);
});
