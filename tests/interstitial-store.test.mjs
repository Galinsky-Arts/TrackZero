import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InterstitialDraftStore, createInterstitialHandler} from '../src/interstitial-store.mjs';

const owner = {tenant: 'tenant-a', application: 'trackzero', subject: 'provider:owner', roles: ['broadcaster']};
const other = {...owner, subject: 'provider:other'};
const draft = {
  clipId: 'clip-001',
  stationId: 'station-one',
  contentRef: 'track:001',
  kind: 'closing',
  origin: 'recorded',
  mimeType: 'audio/wav',
  sha256: 'a'.repeat(64),
  durationMs: 15000,
  capturedAtMs: 1000
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tz07-'));
  const file = join(dir, 'drafts.sqlite');
  const options = {
    authorizeStation: (actor, station) => actor.tenant === owner.tenant &&
      actor.application === owner.application && actor.subject === owner.subject &&
      station === 'station-one',
    authorizeInterstitial: (actor, record) => actor.subject === owner.subject &&
      record.audioRef === 'ciphertext:interstitial-001'
  };
  const store = new InterstitialDraftStore(file, options);
  return {
    store, file, options,
    cleanup() { this.store.close(); rmSync(dir, {recursive: true, force: true}); }
  };
}

test('station owner stores quarantined metadata and recovers it after restart', () => {
  const f = fixture();
  try {
    const created = f.store.create(owner, draft, 2000);
    assert.equal(created.publishable, false);
    f.store.close();
    f.store = new InterstitialDraftStore(f.file, f.options);
    assert.deepEqual(f.store.get(owner, draft.stationId, draft.clipId), {draft: created, published: null});
    assert.throws(() => f.store.create(owner, draft, 2000), /DRAFT_EXISTS/);
    const raw = JSON.stringify(f.store.db.prepare('SELECT * FROM interstitial_drafts').all());
    assert.doesNotMatch(raw, /audio data|private key|plaintext/i);
  } finally { f.cleanup(); }
});

test('trusted DRE-08 authorization publishes only an encrypted audio reference', () => {
  const f = fixture();
  try {
    f.store.create(owner, draft, 2000);
    assert.throws(
      () => f.store.publish(owner, draft.stationId, draft.clipId, 'ciphertext:unapproved', 3000),
      /PUBLICATION_DENIED/
    );
    assert.equal(f.store.get(owner, draft.stationId, draft.clipId).published, null);
    const record = f.store.publish(
      owner, draft.stationId, draft.clipId, 'ciphertext:interstitial-001', 3000
    );
    assert.equal(record.audioRef, 'ciphertext:interstitial-001');
    assert.deepEqual(f.store.get(owner, draft.stationId, draft.clipId).published, record);
    assert.throws(
      () => f.store.publish(owner, draft.stationId, draft.clipId, 'ciphertext:interstitial-001', 4000),
      /ALREADY_PUBLISHED/
    );
  } finally { f.cleanup(); }
});

test('cross-role, cross-station and client publication claims fail closed', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.create({...owner, roles: ['listener']}, draft, 2000), /BROADCASTER_ROLE_REQUIRED/);
    assert.throws(() => f.store.create(other, draft, 2000), /STATION_ACCESS_DENIED/);
    assert.throws(() => f.store.create(owner, {...draft, stationId: 'other-station'}, 2000), /STATION_ACCESS_DENIED/);
    for (const injected of [
      {...draft, publishable: true},
      {...draft, media: 'plaintext'},
      {...draft, key: 'secret'},
      {...draft, sha256: 'invalid'}
    ]) assert.throws(() => f.store.create(owner, injected, 2000), /INVALID_DRAFT/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM interstitial_drafts').get().n, 0);
  } finally { f.cleanup(); }
});

test('interrupted insert and publication cannot leave partial state', () => {
  const f = fixture();
  try {
    f.store.db.exec(`CREATE TRIGGER reject_draft BEFORE INSERT ON interstitial_drafts
      BEGIN SELECT RAISE(ABORT,'injected interruption'); END`);
    assert.throws(() => f.store.create(owner, draft, 2000), /injected interruption/);
    f.store.db.exec('DROP TRIGGER reject_draft');
    f.store.create(owner, draft, 2000);
    f.store.db.exec(`CREATE TRIGGER reject_publish BEFORE UPDATE ON interstitial_drafts
      BEGIN SELECT RAISE(ABORT,'injected publication interruption'); END`);
    assert.throws(
      () => f.store.publish(owner, draft.stationId, draft.clipId, 'ciphertext:interstitial-001', 3000),
      /injected publication interruption/
    );
    f.store.db.exec('DROP TRIGGER reject_publish');
    assert.equal(f.store.get(owner, draft.stationId, draft.clipId).published, null);
    assert.equal(
      f.store.publish(owner, draft.stationId, draft.clipId, 'ciphertext:interstitial-001', 3000).kind,
      'closing'
    );
  } finally { f.cleanup(); }
});

test('HTTP boundary rejects unauthenticated, cross-origin, raw media and oversized requests', async () => {
  const f = fixture();
  try {
    const handle = createInterstitialHandler(f.store, async request =>
      request.headers.get('x-fixture-auth') === 'owner' ? owner : null);
    const post = (body, auth = 'owner', origin = 'https://app.example.test', path = '/v1/interstitials') =>
      new Request(`https://app.example.test${path}`, {
        method: 'POST',
        headers: {origin, 'x-fixture-auth': auth},
        body: JSON.stringify(body)
      });
    assert.equal((await handle(post(draft, 'owner', 'https://evil.test'))).status, 403);
    assert.equal((await handle(post({...draft, media: 'plaintext'}))).status, 403);
    assert.equal((await handle(post(draft, 'none'))).status, 401);
    assert.equal((await handle(post({...draft, contentRef: 'e'.repeat(5000)}))).status, 413);
    assert.equal((await handle(post(draft))).status, 201);
    const publishPath = '/v1/interstitials/station-one/clip-001/publish';
    assert.equal((await handle(post({audioRef: 'placeholder.wav'}, 'owner', undefined, publishPath))).status, 400);
    assert.equal((await handle(post(
      {audioRef: 'ciphertext:interstitial-001'}, 'owner', undefined, publishPath
    ))).status, 200);
    const get = path => handle(new Request(`https://app.example.test${path}`, {
      headers: {'x-fixture-auth': 'owner'}
    }));
    assert.equal((await get('/v1/interstitials/station-one/clip-001')).status, 200);
  } finally { f.cleanup(); }
});
