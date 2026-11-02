import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SponsorPlacementStore, createSponsorPlacementHandler} from '../src/sponsor-placement.mjs';

const sponsor = {tenant: 'tenant-a', application: 'trackzero', subject: 'provider:sponsor', roles: ['sponsor']};
const broadcaster = {...sponsor, subject: 'provider:broadcaster', roles: ['broadcaster']};
const other = {...sponsor, subject: 'provider:other'};
const now = 1_000_000;
const campaign = {
  stationId: 'station-001',
  campaignId: 'campaign-001',
  audioRef: 'ciphertext:sponsor-audio-001',
  programDigest: 'sha256:' + 'a'.repeat(64),
  rateMinor: 450,
  startsAtMs: now + 1000,
  endsAtMs: now + 10000
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tz08-'));
  const file = join(dir, 'campaigns.sqlite');
  let campaignApproved = true;
  const options = {
    authorizeSponsor: (actor, station) => actor.tenant === sponsor.tenant &&
      actor.application === sponsor.application && actor.subject === sponsor.subject &&
      station === campaign.stationId,
    authorizeStation: (actor, station) => actor.tenant === broadcaster.tenant &&
      actor.application === broadcaster.application && actor.subject === broadcaster.subject &&
      station === campaign.stationId,
    authorizeCampaign: (_actor, record) => campaignApproved &&
      record.audioRef === campaign.audioRef && record.programDigest === campaign.programDigest
  };
  const store = new SponsorPlacementStore(file, options);
  return {
    store, file, options,
    denyCampaign() { campaignApproved = false; },
    cleanup() { this.store.close(); rmSync(dir, {recursive: true, force: true}); }
  };
}

test('approved placement emits the exact DRE-09 campaign and survives restart', () => {
  const f = fixture();
  try {
    assert.equal(f.store.submit(sponsor, campaign, now).schedulable, false);
    f.store.approve(broadcaster, campaign, now + 1);
    const active = f.store.active(broadcaster, campaign.stationId, now + 1000);
    assert.deepEqual(active, [{
      tenantId: 'tenant-a',
      stationId: campaign.stationId,
      campaignId: campaign.campaignId,
      audioRef: campaign.audioRef,
      programDigest: campaign.programDigest,
      rateMinor: 450
    }]);
    assert.equal('listenerCount' in active[0], false);
    f.store.close();
    f.store = new SponsorPlacementStore(f.file, f.options);
    assert.equal(f.store.active(broadcaster, campaign.stationId, now + 1000).length, 1);
    assert.deepEqual(f.store.active(broadcaster, campaign.stationId, campaign.endsAtMs), []);
  } finally { f.cleanup(); }
});

test('later DRE-09 denial immediately withholds an approved campaign', () => {
  const f = fixture();
  try {
    f.store.submit(sponsor, campaign, now);
    f.store.approve(broadcaster, campaign, now + 1);
    assert.equal(f.store.active(broadcaster, campaign.stationId, now + 1000).length, 1);
    f.denyCampaign();
    assert.deepEqual(f.store.active(broadcaster, campaign.stationId, now + 1000), []);
  } finally { f.cleanup(); }
});

test('role, tenant, encryption, program and self-approval denials fail closed', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.submit({...sponsor, roles: ['listener']}, campaign, now), /ROLE_DENIED/);
    assert.throws(() => f.store.submit({...sponsor, tenant: 'tenant-b'}, campaign, now), /SPONSOR_ACCESS_DENIED/);
    for (const invalid of [
      {...campaign, audioRef: 'sponsor.wav'},
      {...campaign, programDigest: 'a'.repeat(64)},
      {...campaign, rateMinor: -1},
      {...campaign, media: 'plaintext'},
      {...campaign, endsAtMs: campaign.startsAtMs}
    ]) assert.throws(() => f.store.submit(sponsor, invalid, now));
    f.store.submit(sponsor, campaign, now);
    assert.throws(
      () => f.store.approve({...sponsor, roles: ['broadcaster']}, campaign, now + 1),
      /STATION_ACCESS_DENIED/
    );
    assert.throws(
      () => f.store.active({...broadcaster, subject: 'provider:other'}, campaign.stationId, now + 1000),
      /STATION_ACCESS_DENIED/
    );
  } finally { f.cleanup(); }
});

test('revocation is idempotent and interrupted approval rolls back campaign state and audit', () => {
  const f = fixture();
  try {
    f.store.submit(sponsor, campaign, now);
    f.store.db.exec(`CREATE TRIGGER reject_approval BEFORE INSERT ON campaign_events WHEN NEW.kind='APPROVED'
      BEGIN SELECT RAISE(ABORT,'injected interruption'); END`);
    assert.throws(() => f.store.approve(broadcaster, campaign, now + 1), /injected interruption/);
    assert.deepEqual(f.store.active(broadcaster, campaign.stationId, now + 1000), []);
    f.store.db.exec('DROP TRIGGER reject_approval');
    f.store.approve(broadcaster, campaign, now + 2);
    assert.throws(() => f.store.revoke(other, campaign, now + 3), /REVOCATION_DENIED/);
    assert.equal(f.store.revoke(sponsor, campaign, now + 3).replay, false);
    assert.equal(f.store.revoke(sponsor, campaign, now + 4).replay, true);
    assert.deepEqual(f.store.active(broadcaster, campaign.stationId, now + 1000), []);
    assert.deepEqual(
      f.store.db.prepare('SELECT kind FROM campaign_events ORDER BY occurred_at_ms').all().map(x => x.kind),
      ['SUBMITTED', 'APPROVED', 'REVOKED']
    );
  } finally { f.cleanup(); }
});

test('HTTP boundary authenticates reads and rejects forged identity, raw media and oversized bodies', async () => {
  const f = fixture();
  try {
    const future = {
      ...campaign,
      startsAtMs: Date.now() + 1000,
      endsAtMs: Date.now() + 10000
    };
    const handle = createSponsorPlacementHandler(f.store, async request =>
      request.headers.get('x-fixture-auth') === 'sponsor' ? sponsor :
      request.headers.get('x-fixture-auth') === 'broadcaster' ? broadcaster : null);
    const post = (path, body, auth = 'sponsor', origin = 'https://app.example.test') =>
      new Request('https://app.example.test' + path, {
        method: 'POST',
        headers: {origin, 'x-fixture-auth': auth},
        body: JSON.stringify(body)
      });
    assert.equal((await handle(post('/v1/sponsor-campaigns', future, 'sponsor', 'https://evil.test'))).status, 403);
    assert.equal((await handle(post('/v1/sponsor-campaigns', {...future, media: 'plaintext'}))).status, 403);
    assert.equal((await handle(post('/v1/sponsor-campaigns', future, 'none'))).status, 401);
    assert.equal((await handle(post('/v1/sponsor-campaigns', {
      ...future, campaignId: 'e'.repeat(5000)
    }))).status, 413);
    assert.equal((await handle(post('/v1/sponsor-campaigns', future))).status, 200);
    assert.equal((await handle(post('/v1/sponsor-campaigns/approve', {
      stationId: future.stationId, campaignId: future.campaignId
    }, 'broadcaster'))).status, 200);
    const activeUrl = 'https://app.example.test/v1/sponsor-campaigns/active?stationId=station-001';
    assert.equal((await handle(new Request(activeUrl))).status, 401);
    const response = await handle(new Request(activeUrl, {headers: {'x-fixture-auth': 'broadcaster'}}));
    assert.equal(response.status, 200);
  } finally { f.cleanup(); }
});
