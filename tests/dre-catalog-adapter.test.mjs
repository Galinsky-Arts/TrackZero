import test from 'node:test';
import assert from 'node:assert/strict';
import {createDreAlbumVerifier} from '../src/dre-catalog-adapter.mjs';
import {projectCompleteAlbums} from '../src/catalog.mjs';

const album = {id: 'album_123', title: 'Complete album', kind: 'album', trackCount: 2,
  trackIds: ['track:1', 'track:2']};
const media = id => ({id, tenantId: 'tenant-a', publisherId: 'artist-a',
  title: id, kind: 'music', assetRef: 'ciphertext:' + id});

test('adapts tenant-scoped DRE-04 encrypted music items to a complete album', async () => {
  const calls = [];
  const verify = createDreAlbumVerifier({tenantId: 'tenant-a', publisherId: 'artist-a',
    lookupMedia: async query => { calls.push(query); return media(query.id); }});
  assert.equal((await projectCompleteAlbums([album], verify))[0].id, album.id);
  assert.deepEqual(calls, [{tenantId: 'tenant-a', id: 'track:1'},
    {tenantId: 'tenant-a', id: 'track:2'}]);
});

test('fails closed for incomplete sets, duplicate tracks and cross-scope media', async () => {
  for (const candidate of [
    {...album, trackIds: ['track:1']},
    {...album, trackIds: ['track:1', 'track:1']}
  ]) {
    const verify = createDreAlbumVerifier({tenantId: 'tenant-a', publisherId: 'artist-a',
      lookupMedia: async query => media(query.id)});
    await assert.rejects(projectCompleteAlbums([candidate], verify), /not verified/);
  }
  for (const override of [
    {tenantId: 'tenant-b'}, {publisherId: 'listener-a'}, {kind: 'episode'},
    {assetRef: 'https://plain.example/audio.wav'}
  ]) {
    const verify = createDreAlbumVerifier({tenantId: 'tenant-a', publisherId: 'artist-a',
      lookupMedia: async query => ({...media(query.id), ...override})});
    await assert.rejects(projectCompleteAlbums([album], verify), /not verified/);
  }
});

test('provider interruption rejects the projection without partial output', async () => {
  let calls = 0;
  const verify = createDreAlbumVerifier({tenantId: 'tenant-a', publisherId: 'artist-a',
    lookupMedia: async query => {
      calls++;
      if (query.id === 'track:2') throw new Error('DRE unavailable');
      return media(query.id);
    }});
  await assert.rejects(projectCompleteAlbums([album], verify), /DRE unavailable/);
  assert.equal(calls, 2);
});
