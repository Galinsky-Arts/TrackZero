import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDreInterstitial, prepareInterstitialDraft} from '../src/interstitial.mjs';

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

test('new interstitial drafts never claim publication approval', () => {
  const item = prepareInterstitialDraft(draft, 2000);
  assert.equal(item.reviewState, 'quarantined');
  assert.equal(item.publishable, false);
  assert.equal(item.assurance, 'unverified-input');
  assert(Object.isFrozen(item));
});

test('DRE-08 records require an opaque encrypted audio reference', () => {
  const item = prepareInterstitialDraft(draft, 2000);
  const record = prepareDreInterstitial(item, 'ciphertext:interstitial-001');
  assert.deepEqual(record, {
    stationId: 'station-one',
    contentRef: 'track:001',
    audioRef: 'ciphertext:interstitial-001',
    kind: 'closing',
    durationMs: 15000
  });
  assert(Object.isFrozen(record));
  for (const audioRef of ['', 'placeholder.wav', 'ciphertext:', 'ciphertext:bad value']) {
    assert.throws(() => prepareDreInterstitial(item, audioRef));
  }
});

test('malformed or privilege-claiming interstitial metadata fails closed', () => {
  for (const item of [
    {...draft, kind: 'unknown'},
    {...draft, origin: 'server'},
    {...draft, mimeType: 'text/html'},
    {...draft, durationMs: 0},
    {...draft, capturedAtMs: 3000},
    {...draft, sha256: 'wrong'},
    {...draft, publishable: true}
  ]) assert.throws(() => prepareInterstitialDraft(item, 2000));
});
