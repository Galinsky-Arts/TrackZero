import test from 'node:test';
import assert from 'node:assert/strict';
import {createDreAlbumVerifier} from '../src/dre-catalog-adapter.mjs';
import {projectCompleteAlbums} from '../src/catalog.mjs';

const album = {id: 'album_123', title: 'Complete album', kind: 'album', trackCount: 2,
  trackIds: ['track:1', 'track:2'], artworkUrl: 'https://assets.example.test/a.jpg'};
const media = id => ({id, tenantId: 'tenant-a', publisherId: 'artist-a',
  title: id, kind: 'music', assetRef: 'ciphertext:' + id});
const project = (candidate, verify) => projectCompleteAlbums([candidate], verify,
  {artworkOrigins: ['https://assets.example.test']});
const makeVerifier = overrides => createDreAlbumVerifier({
  tenantId: 'tenant-a', publisherId: 'artist-a',
  lookupMedia: async query => media(query.id), verifyAlbumRights: async () => true,
  ...overrides
});

test('adapts DRE-04 items and a trusted rights source to a complete album', async () => {
  const calls = [], rights = [];
  const verify = makeVerifier({
    lookupMedia: async query => { calls.push(query); return media(query.id); },
    verifyAlbumRights: async context => { rights.push(context); return true; }
  });
  assert.equal((await project(album, verify))[0].id, album.id);
  assert.deepEqual(calls, [{tenantId: 'tenant-a', id: 'track:1'},
    {tenantId: 'tenant-a', id: 'track:2'}]);
  assert.equal(rights[0].album.artworkUrl, album.artworkUrl);
});

test('fails closed for incomplete sets, duplicate tracks, rights and cross-scope media', async () => {
  for (const candidate of [
    {...album, trackIds: ['track:1']},
    {...album, trackIds: ['track:1', 'track:1']}
  ]) await assert.rejects(project(candidate, makeVerifier()), /not verified/);
  await assert.rejects(project(album,
    makeVerifier({verifyAlbumRights: async () => false})), /not verified/);
  for (const override of [
    {tenantId: 'tenant-b'}, {publisherId: 'listener-a'}, {kind: 'episode'},
    {assetRef: 'https://plain.example/audio.wav'}
  ]) {
    const verify = makeVerifier({lookupMedia: async query => ({...media(query.id), ...override})});
    await assert.rejects(project(album, verify), /not verified/);
  }
});

test('provider interruption rejects the projection without partial output', async () => {
  let calls = 0;
  const verify = makeVerifier({lookupMedia: async query => {
    calls++;
    if (query.id === 'track:2') throw new Error('DRE unavailable');
    return media(query.id);
  }});
  await assert.rejects(project(album, verify), /DRE unavailable/);
  assert.equal(calls, 2);
  await assert.rejects(project(album,
    makeVerifier({verifyAlbumRights: async () => {throw new Error('rights unavailable');}})),
    /rights unavailable/);
});
