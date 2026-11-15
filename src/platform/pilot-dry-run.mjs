// TZ-23 integrated pilot DRY RUN. This is software evidence only.
//
// It composes the real TrackZero application (real SQLite stores, real HTTP
// handlers, real DRE reward ladder) in-process and walks the pilot workflow:
// onboarding, verified station claim, independent rights review, offer and
// program publication, engine interruption/recovery, public listening pages,
// cross-role denials, the endpoint-gated commerce boundary and restart
// persistence. Identity comes from a FIXTURE RFC 7662 introspection stub, and
// no endpoint enrollment, encrypted media, Stripe account, phone, speaker or
// person is involved. The report says so explicitly and can never mark the
// TZ-23 field pilot complete.
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from './config.mjs';
import {createTrackZeroApp} from './app.mjs';

export const DRY_RUN_LABEL = Object.freeze({
  evidenceKind: 'software-dry-run-with-fixture-verifiers',
  fieldEvidence: false,
  pilotComplete: false,
  fixtureVerifiers: Object.freeze([
    'identity: in-process RFC 7662 introspection stub (token "t-<subject>"), not a real IdP or real accounts',
    'station engine: operator-issued credential driven by this script, not a deployed DRE station engine',
    'clock: host wall clock; no trusted time source',
  ]),
  notExercised: Object.freeze([
    'enrolled DAE endpoints, key/codec provisioning and encrypted media intake',
    'actual audio playback, phones, speakers or loudspeaker contribution evidence',
    'Stripe sandbox checkout (no STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET/STRIPE_ACCOUNT_ID)',
    'real pilot artists and listeners, consent or field measurements',
  ]),
});

const ORIGIN = 'https://pilot-dry-run.invalid';
const OPERATOR = 'pilot-dry-run-operator-token-0123456789';

async function boot(dataDir) {
  const fetchImpl = async (url, init) => {
    if (url !== 'https://idp.pilot-dry-run.invalid/introspect') throw new Error('UNEXPECTED_FETCH');
    const token = new URLSearchParams(init.body.toString()).get('token') ?? '';
    return Response.json(token.startsWith('t-') ? {active: true, iss: 'https://idp.pilot-dry-run.invalid', aud: 'trackzero',
      sub: token.slice(2), tenant: 'trackzero', exp: Math.floor(Date.now() / 1000) + 600} : {active: false});
  };
  const config = readConfig({TZ_PUBLIC_ORIGIN: ORIGIN, TZ_DATA_DIR: dataDir, TZ_STORAGE_DURABILITY: 'ephemeral',
    TZ_IDENTITY: 'external', TZ_INTROSPECTION_ENDPOINT: 'https://idp.pilot-dry-run.invalid/introspect',
    TZ_ISSUER: 'https://idp.pilot-dry-run.invalid', TZ_CLIENT_ID: 'trackzero', TZ_CLIENT_SECRET: 'fixture-client-secret',
    TZ_OPERATOR_TOKEN: OPERATOR});
  const app = await createTrackZeroApp(config, {fetchImpl});
  const call = async (path, {method = 'GET', body, as, headers = {}} = {}) => {
    const h = {...headers};
    if (as) h.authorization = `Bearer t-${as}`;
    if (method !== 'GET' && !('origin' in h)) h.origin = ORIGIN;
    if (h.origin === null) delete h.origin;
    if (body !== undefined) h['content-type'] = 'application/json';
    const response = await app.handle(new Request(ORIGIN + path, {method, headers: h, body: body === undefined ? undefined : JSON.stringify(body)}));
    const text = await response.text(); let data = null; try { data = JSON.parse(text); } catch { /* HTML page */ }
    return {status: response.status, data, text};
  };
  const op = (path, body) => call(path, {method: 'POST', body, headers: {authorization: `Bearer ${OPERATOR}`, origin: null}});
  return {app, call, op};
}

/** Runs every stage, recording pass/fail and the observed status/error codes
 * (never tokens or private values). Returns a labelled report. */
export async function runPilotDryRun({now = () => new Date()} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tz-pilot-dry-run-'));
  const dataDir = join(dir, 'data');
  const stages = [];
  const stage = async (name, fn) => {
    try { const observed = await fn(); stages.push({name, passed: true, observed}); }
    catch (error) { stages.push({name, passed: false, failure: error instanceof Error ? error.message : 'UNKNOWN'}); }
  };
  const expect = (condition, code) => { if (!condition) throw new Error(code); };
  let session = await boot(dataDir);
  try {
    const {call, op} = session;
    await stage('identity required and forged tokens rejected', async () => {
      const anonymous = await call('/v1/rights/claims', {method: 'POST', body: {}});
      const forged = await call('/api/context', {headers: {authorization: 'Bearer forged'}});
      expect(anonymous.status === 401 && forged.status === 401, 'AUTH_NOT_ENFORCED');
      return {anonymous: anonymous.status, forged: forged.status};
    });
    await stage('creator, reviewer and listener onboarding with operator invitation', async () => {
      for (const subject of ['pilot-artist', 'pilot-reviewer', 'pilot-listener'])
        expect((await call('/v1/onboarding', {method: 'POST', as: subject, body: {role: 'listener'}})).status === 201, 'ONBOARDING_FAILED');
      const invite = await op('/operator/v1/invitations', {role: 'artist'});
      const artist = await call('/v1/onboarding', {method: 'POST', as: 'pilot-artist', body: {role: 'artist', invitation: invite.data.invitation}});
      const reuse = await call('/v1/onboarding', {method: 'POST', as: 'pilot-listener', body: {role: 'artist', invitation: invite.data.invitation}});
      expect(artist.data?.roles?.includes('artist') && reuse.data?.error === 'INVITATION_DENIED', 'INVITATION_NOT_ENFORCED');
      return {artistRoles: artist.data.roles, invitationReuse: reuse.data.error};
    });
    const station = {id: 'pilot-station', name: 'Pilot Station', description: 'Dry-run station', offers: []};
    await stage('verified station claim and owner-only publication', async () => {
      const unclaimed = await call('/v1/stations', {method: 'POST', as: 'pilot-artist', body: station});
      expect((await op('/operator/v1/station-claims', {stationId: station.id, ownerSubject: 'pilot-artist'})).status === 200, 'CLAIM_FAILED');
      const published = await call('/v1/stations', {method: 'POST', as: 'pilot-artist', body: station});
      const crossOrigin = await call('/v1/stations', {method: 'POST', as: 'pilot-artist', body: station, headers: {origin: 'https://evil.invalid'}});
      expect(unclaimed.data?.error === 'STATION_CLAIM_REQUIRED' && published.status === 200 && crossOrigin.data?.error === 'ORIGIN_DENIED', 'STATION_GATES');
      return {unclaimed: unclaimed.data.error, published: published.status, crossOrigin: crossOrigin.data.error};
    });
    const offerStation = {...station, offers: [{id: 'pilot-album', title: 'Pilot Album', type: 'complete_product', available: true}]};
    await stage('independent rights review gates complete-album offers', async () => {
      const before = await call('/v1/stations', {method: 'POST', as: 'pilot-artist', body: offerStation});
      const t = Date.now();
      await call('/v1/rights/claims', {method: 'POST', as: 'pilot-artist', body: {itemId: 'pilot-album', region: 'US', licenseVersion: 'v1',
        evidenceDigest: 'a'.repeat(64), uses: ['broadcast', 'sale'], rightsValidFromMs: t - 1000, rightsValidUntilMs: t + 365 * 86400_000}});
      const review = {itemId: 'pilot-album', region: 'US', approved: true, validUntilMs: t + 86400_000};
      const ungranted = await call('/v1/rights/reviews', {method: 'POST', as: 'pilot-reviewer', body: review});
      await op('/operator/v1/grants', {subject: 'pilot-reviewer', role: 'rights_reviewer'});
      await op('/operator/v1/grants', {subject: 'pilot-artist', role: 'rights_reviewer'});
      const self = await call('/v1/rights/reviews', {method: 'POST', as: 'pilot-artist', body: review});
      const approved = await call('/v1/rights/reviews', {method: 'POST', as: 'pilot-reviewer', body: review});
      const after = await call('/v1/stations', {method: 'POST', as: 'pilot-artist', body: offerStation});
      expect(before.data?.error === 'RIGHTS_NOT_VERIFIED' && ungranted.data?.error === 'ROLE_DENIED' &&
        self.data?.error === 'SELF_REVIEW_DENIED' && approved.data?.state === 'APPROVED' && after.data?.offers?.length === 1, 'RIGHTS_GATES');
      return {beforeReview: before.data.error, ungrantedReviewer: ungranted.data.error, selfReview: self.data.error, offers: after.data.offers.length};
    });
    await stage('owner-only, rights-gated program sequencing with optimistic versions', async () => {
      const listener = await call('/v1/programs/pilot-station', {as: 'pilot-listener'});
      const denied = await call('/v1/programs/pilot-station', {method: 'PUT', as: 'pilot-artist', body: {expectedVersion: 0, items: [{id: 'unlicensed', kind: 'song'}]}});
      const saved = await call('/v1/programs/pilot-station', {method: 'PUT', as: 'pilot-artist', body: {expectedVersion: 0,
        items: [{id: 'pilot-album', kind: 'song'}, {id: 'top-of-hour', kind: 'block'}]}});
      const stale = await call('/v1/programs/pilot-station', {method: 'PUT', as: 'pilot-artist', body: {expectedVersion: 0, items: [{id: 'top-of-hour', kind: 'block'}]}});
      expect(listener.status === 403 && denied.data?.error === 'PROGRAM_ITEM_DENIED' && saved.data?.version === 1 && stale.data?.error === 'VERSION_CONFLICT', 'PROGRAM_GATES');
      return {listener: listener.status, unlicensed: denied.data.error, version: saved.data.version, stale: stale.data.error};
    });
    await stage('station engine interruption and recovery are reported, never inferred', async () => {
      const engine = await op('/operator/v1/engine-credentials', {engineId: 'pilot-engine', stationId: 'pilot-station'});
      const auth = {authorization: `Bearer ${engine.data.token}`};
      const send = (sequence, mode) => call('/v1/station-engine/events', {method: 'POST', headers: auth,
        body: {stationId: 'pilot-station', sequence, scheduleVersion: 1, mode, observedAtMs: Date.now()}});
      const modes = [];
      for (const [sequence, mode] of [[1, 'PRIMARY'], [2, 'FALLBACK'], [3, 'RECOVERING'], [4, 'PRIMARY']]) modes.push((await send(sequence, mode)).data?.state);
      const replay = await send(2, 'FALLBACK');
      const listenerStatus = await call('/v1/stations/pilot-station/status', {as: 'pilot-listener'});
      await op('/operator/v1/engine-credentials/revoke', {engineId: 'pilot-engine'});
      const revoked = await send(5, 'PRIMARY');
      expect(modes.join() === 'PRIMARY,FALLBACK,RECOVERING,PRIMARY' && replay.status === 409 && listenerStatus.status === 403 && revoked.status === 403, 'ENGINE_GATES');
      return {modes, replay: replay.status, listenerStatus: listenerStatus.status, revokedCredential: revoked.status};
    });
    await stage('public listening pages and discovery expose public metadata only', async () => {
      const guest = await call('/stations/pilot-station'); const album = await call('/albums/pilot-album');
      const discover = await call('/v1/discover'); const list = await call('/api/public/stations');
      expect(guest.status === 200 && /Pilot Station/.test(guest.text) && /Pilot Album/.test(album.text) &&
        discover.text.includes(ORIGIN + '/stations/pilot-station') && list.data?.stations?.length === 1 &&
        !/pilot-artist|evidenceDigest/.test(guest.text + list.text), 'PUBLIC_PAGES');
      return {guest: guest.status, album: album.status, publicStations: list.data.stations.length};
    });
    await stage('commerce, rewards and privacy stay fail-closed without enrolled endpoints or Stripe', async () => {
      const ready = await call('/readyz');
      const checkout = await call('/v1/album-checkouts', {method: 'POST', as: 'pilot-listener', body: {albumId: 'pilot-album', offerVersion: 1}});
      const redemption = await call('/v1/point-redemptions', {method: 'POST', as: 'pilot-listener', body: {}});
      const prices = await call('/api/reward-prices/preview', {method: 'POST', as: 'pilot-listener', body: {base: '100', gentleBps: 20, accelerationBps: 2}});
      expect(ready.data?.features?.payments?.state === 'not_configured' && checkout.data?.error === 'ENDPOINT_ENROLLMENT_REQUIRED' &&
        redemption.data?.error === 'ENDPOINT_ENROLLMENT_REQUIRED' && prices.status === 403 && ready.data?.production === false, 'COMMERCE_GATES');
      return {payments: ready.data.features.payments.state, checkout: checkout.data.error, redemption: redemption.data.error, listenerRewardPreview: prices.status};
    });
  } finally { await session.app.close(); }
  await stage('restart preserves stations, rights and programs in the same data directory', async () => {
    session = await boot(dataDir);
    try {
      const program = await session.call('/v1/programs/pilot-station', {as: 'pilot-artist'});
      const list = await session.call('/api/public/stations');
      expect(list.data?.stations?.[0]?.id === 'pilot-station' && program.data?.version === 1, 'RESTART_LOST_STATE');
      return {stations: list.data.stations.length, programVersion: program.data.version};
    } finally { await session.app.close(); }
  });
  rmSync(dir, {recursive: true, force: true});
  return {...DRY_RUN_LABEL, unit: 'TZ-23', generatedAt: now().toISOString(),
    softwarePassed: stages.every(entry => entry.passed), stages};
}
