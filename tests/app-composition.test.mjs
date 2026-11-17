import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig, databaseOptions} from '../src/platform/config.mjs';
import {createTrackZeroApp, ENDPOINT_FEATURES} from '../src/platform/app.mjs';
import {createPaymentsStatus} from '../src/platform/payments.mjs';

const ORIGIN = 'https://tz.test';
const OPERATOR = 'operator-token-for-tests-0123456789abcdef';
const baseEnv = dir => ({TZ_PUBLIC_ORIGIN: ORIGIN, TZ_DATA_DIR: join(dir, 'data'), TZ_STORAGE_DURABILITY: 'ephemeral',
  TZ_IDENTITY: 'external', TZ_INTROSPECTION_ENDPOINT: 'https://idp.test/introspect', TZ_ISSUER: 'https://idp.test',
  TZ_CLIENT_ID: 'trackzero', TZ_CLIENT_SECRET: 'client-secret', TZ_OPERATOR_TOKEN: OPERATOR});

/** External-IdP mode with a stub RFC 7662 endpoint: token "t-<subject>" is active. */
async function boot(t, env = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tz-compose-'));
  const introspections = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://idp.test/introspect');
    assert.match(new Headers(init.headers).get('authorization'), /^Basic /);
    const token = new URLSearchParams(init.body.toString()).get('token');
    introspections.push(token);
    const active = token.startsWith('t-');
    return Response.json(active ? {active: true, iss: 'https://idp.test', aud: 'trackzero', sub: token.slice(2),
      tenant: 'trackzero', exp: Math.floor(Date.now() / 1000) + 600} : {active: false});
  };
  const app = await createTrackZeroApp(readConfig({...baseEnv(dir), ...env}), {fetchImpl, ...options});
  t.after(async () => { await app.close(); rmSync(dir, {recursive: true, force: true}); });
  const call = async (path, {method = 'GET', body, as, headers = {}} = {}) => {
    const h = {...headers};
    if (as) h.authorization = `Bearer t-${as}`;
    if (method !== 'GET' && !('origin' in h)) h.origin = ORIGIN;
    if (h.origin === null) delete h.origin;
    if (body !== undefined) h['content-type'] = 'application/json';
    const response = await app.handle(new Request(ORIGIN + path, {method, headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)}));
    const text = await response.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return {status: response.status, data, text, headers: response.headers};
  };
  const op = (path, body) => call(path, {method: 'POST', body, headers: {authorization: `Bearer ${OPERATOR}`, origin: null}});
  return {app, call, op, introspections};
}

test('configuration fails closed without identity, durable path or secure transport', () => {
  const dir = '/tmp/tz-config';
  assert.throws(() => readConfig({}), /TZ_PUBLIC_ORIGIN|RENDER_EXTERNAL_URL/);
  assert.throws(() => readConfig({...baseEnv(dir), TZ_PUBLIC_ORIGIN: 'http://example.com'}), /HTTPS/);
  assert.throws(() => readConfig({...baseEnv(dir), TZ_DATA_DIR: 'relative'}), /absolute/);
  assert.throws(() => readConfig({...baseEnv(dir), TZ_STORAGE_DURABILITY: 'maybe'}), /ephemeral, persistent or postgres/);
  assert.throws(() => readConfig({...baseEnv(dir), TZ_STORAGE_DURABILITY: 'postgres'}), /DATABASE_URL/);
  assert.throws(() => readConfig({...baseEnv(dir), TZ_MAIL_FROM: 'not an address'}), /TZ_MAIL_FROM/);
  assert.throws(() => readConfig({...baseEnv(dir), TZ_IDENTITY: 'builtin'}), /TZ_INTROSPECTION_CLIENT_SECRET/);
  assert.throws(() => readConfig({...baseEnv(dir), TZ_OPERATOR_TOKEN: 'short'}), /TZ_OPERATOR_TOKEN/);
  assert.throws(() => databaseOptions('postgres://u:p@db.example.com/x'), /TLS/);
  const remote = databaseOptions('postgres://u:p@db.example.com/x?sslmode=require&channel_binding=require');
  assert.deepEqual(remote.ssl, {rejectUnauthorized: true, servername: 'db.example.com'});
  assert.doesNotMatch(remote.connectionString, /sslmode/);
  assert.equal(databaseOptions('postgres://u:p@127.0.0.1/x').ssl, undefined);
  const render = readConfig({...baseEnv(dir), TZ_PUBLIC_ORIGIN: '', RENDER_EXTERNAL_URL: 'https://trackzero.onrender.com'});
  assert.equal(render.publicOrigin, 'https://trackzero.onrender.com');
});

test('health, honest readiness and fail-closed endpoint-encrypted routes', async t => {
  const {call} = await boot(t);
  assert.deepEqual((await call('/healthz')).data, {status: 'ok'});
  const ready = await call('/readyz');
  assert.equal(ready.status, 200);
  assert.equal(ready.data.production, false);
  assert.equal(ready.data.storage.durability, 'ephemeral');
  assert.match(ready.data.storage.notice, /EPHEMERAL/);
  assert.match(ready.data.storage.notice, /persistent disk/);
  assert.equal(ready.data.features.payments.state, 'not_configured');
  assert.deepEqual(ready.data.features.payments.missing, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_ACCOUNT_ID']);
  for (const {feature} of ENDPOINT_FEATURES) assert.equal(ready.data.features[feature].state, 'requires_enrolled_endpoint');
  for (const path of ['/v1/album-checkouts', '/v1/album-checkouts/x/receipt', '/v1/support/intents', '/v1/grooves/preview',
    '/v1/grooves/publish', '/v1/reports/artist/a', '/v1/point-redemptions', '/v1/library', '/v1/privacy', '/v1/privacy/preferences', '/v1/complaints']) {
    // A plaintext body is never accepted in place of an endpoint-encrypted envelope.
    const response = await call(path, {method: 'POST', as: 'listener-1', body: {albumId: 'a', offerVersion: 1, plaintext: true}});
    assert.equal(response.status, 503, path);
    assert.equal(response.data.error, 'ENDPOINT_ENROLLMENT_REQUIRED', path);
  }
});

test('web UI, reused browser modules and guest pages are served with a strict CSP', async t => {
  const {call} = await boot(t);
  const index = await call('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.match(index.headers.get('strict-transport-security'), /max-age/);
  assert.match(index.text, /<script type="module" src="\/assets\/app.js">/);
  for (const path of ['/assets/app.js', '/assets/app.css', '/assets/guest.js', '/modules/program-sequence.mjs', '/modules/groove-reveal.mjs'])
    assert.equal((await call(path)).status, 200, path);
  for (const path of ['/modules/station-catalog.mjs', '/modules/../platform/config.mjs', '/assets/../../package.json', '/src/platform/app.mjs'])
    assert.equal((await call(path)).status, 404, path);
  assert.equal((await call('/stations/missing-station')).status, 404);
});

test('end-to-end creator, reviewer, listener and engine flows through one origin', async t => {
  const {call, op, introspections} = await boot(t);
  // Identity is required; a forged token is rejected by introspection.
  assert.equal((await call('/v1/rights/claims', {method: 'POST', body: {}})).status, 401);
  assert.equal((await call('/api/context', {headers: {authorization: 'Bearer forged'}})).status, 401);
  // Operator API is token-guarded.
  assert.equal((await call('/operator/v1/invitations', {method: 'POST', body: {role: 'artist'}})).status, 401);
  assert.equal((await call('/operator/v1/invitations', {method: 'POST', body: {role: 'artist'}, headers: {authorization: 'Bearer wrong-token-wrong-token-wrong-token'}})).status, 401);

  for (const subject of ['artist-1', 'reviewer-1', 'listener-1'])
    assert.equal((await call('/v1/onboarding', {method: 'POST', as: subject, body: {role: 'listener'}})).status, 201);
  assert.equal((await call('/v1/onboarding', {method: 'POST', as: 'artist-1', body: {role: 'artist', subject: 'x'}})).data.error, 'CLIENT_IDENTITY_FORBIDDEN');
  const invite = await op('/operator/v1/invitations', {role: 'artist'});
  assert.equal(invite.status, 200);
  assert.deepEqual((await call('/v1/onboarding', {method: 'POST', as: 'artist-1', body: {role: 'artist', invitation: invite.data.invitation}})).data.roles, ['artist', 'listener']);
  assert.equal((await call('/v1/onboarding', {method: 'POST', as: 'listener-1', body: {role: 'artist', invitation: invite.data.invitation}})).data.error, 'INVITATION_DENIED');

  // Station claims are operator-verified; only the claimant may publish.
  const station = {id: 'night-owl', name: 'Night Owl', description: 'Late sets', offers: []};
  assert.equal((await call('/v1/stations', {method: 'POST', as: 'artist-1', body: station})).data.error, 'STATION_CLAIM_REQUIRED');
  assert.equal((await op('/operator/v1/station-claims', {stationId: 'night-owl', ownerSubject: 'ghost'})).data.error, 'ACCOUNT_NOT_ONBOARDED');
  assert.equal((await op('/operator/v1/station-claims', {stationId: 'night-owl', ownerSubject: 'artist-1'})).status, 200);
  assert.equal((await op('/operator/v1/station-claims', {stationId: 'night-owl', ownerSubject: 'listener-1'})).data.error, 'STATION_ALREADY_CLAIMED');
  assert.equal((await call('/v1/stations', {method: 'POST', as: 'artist-1', body: station})).status, 200);
  assert.equal((await call('/v1/stations', {method: 'POST', as: 'artist-1', body: station, headers: {origin: 'https://evil.test'}})).data.error, 'ORIGIN_DENIED');
  const context = await call('/api/context', {as: 'artist-1'});
  assert.deepEqual(context.data.roles, ['artist', 'broadcaster', 'listener']);
  assert.deepEqual(context.data.stations, [{id: 'night-owl', published: true, name: 'Night Owl'}]);

  // Offers need approved sale rights from a different reviewer.
  const withOffer = {...station, offers: [{id: 'first-album', title: 'First Album', type: 'complete_product', available: true}]};
  assert.equal((await call('/v1/stations', {method: 'POST', as: 'artist-1', body: withOffer})).data.error, 'RIGHTS_NOT_VERIFIED');
  const claim = {itemId: 'first-album', region: 'US', licenseVersion: 'v1', evidenceDigest: 'a'.repeat(64), uses: ['broadcast', 'sale'],
    rightsValidFromMs: Date.now() - 1000, rightsValidUntilMs: Date.now() + 365 * 86400_000};
  assert.equal((await call('/v1/rights/claims', {method: 'POST', as: 'artist-1', body: claim})).data.state, 'PENDING');
  assert.equal((await call('/v1/rights/reviews', {method: 'POST', as: 'reviewer-1', body: {itemId: 'first-album', region: 'US', approved: true, validUntilMs: Date.now() + 86400_000}})).data.error, 'ROLE_DENIED');
  assert.equal((await op('/operator/v1/grants', {subject: 'reviewer-1', role: 'rights_reviewer'})).status, 200);
  assert.equal((await op('/operator/v1/grants', {subject: 'artist-1', role: 'rights_reviewer'})).status, 200);
  assert.equal((await call('/v1/rights/reviews', {method: 'POST', as: 'artist-1', body: {itemId: 'first-album', region: 'US', approved: true, validUntilMs: Date.now() + 86400_000}})).data.error, 'SELF_REVIEW_DENIED');
  assert.equal((await call('/v1/rights/reviews', {method: 'POST', as: 'reviewer-1', body: {itemId: 'first-album', region: 'US', approved: true, validUntilMs: Date.now() + 86400_000}})).data.state, 'APPROVED');
  const decision = await call('/v1/rights/decisions/first-album?tenant=trackzero&application=trackzero&region=US&use=sale');
  assert.equal(decision.data.publishable, true);
  assert.equal((await call('/v1/stations', {method: 'POST', as: 'artist-1', body: withOffer})).data.offers.length, 1);

  // Public guest, album and discovery pages expose public metadata only.
  const guest = await call('/stations/night-owl');
  assert.equal(guest.status, 200);
  assert.match(guest.text, /Night Owl/);
  assert.match(guest.text, /href="\/albums\/first-album"/);
  assert.match(guest.text, /<link rel="stylesheet" href="\/assets\/app.css">/);
  assert.match(guest.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match((await call('/albums/first-album')).text, /First Album/);
  assert.match((await call('/v1/discover')).text, /https:\/\/tz.test\/stations\/night-owl/);
  assert.deepEqual((await call('/api/public/stations')).data.stations, [{id: 'night-owl', name: 'Night Owl', description: 'Late sets'}]);

  // Program sequencing: owner only, rights-gated items, optimistic versions.
  assert.equal((await call('/v1/programs/night-owl', {as: 'listener-1'})).status, 403);
  const denied = await call('/v1/programs/night-owl', {method: 'PUT', as: 'artist-1', body: {expectedVersion: 0, items: [{id: 'unlicensed', kind: 'song'}]}});
  assert.equal(denied.data.error, 'PROGRAM_ITEM_DENIED');
  const saved = await call('/v1/programs/night-owl', {method: 'PUT', as: 'artist-1', body: {expectedVersion: 0,
    items: [{id: 'first-album', kind: 'song'}, {id: 'top-of-hour', kind: 'block'}]}});
  assert.equal(saved.data.version, 1);
  assert.equal((await call('/v1/programs/night-owl', {method: 'PUT', as: 'artist-1', body: {expectedVersion: 0, items: [{id: 'top-of-hour', kind: 'block'}]}})).data.error, 'VERSION_CONFLICT');
  assert.equal((await call('/v1/programs/night-owl', {method: 'PUT', as: 'artist-1', body: {expectedVersion: 1, items: [{id: 'x', kind: 'intro'}]}})).data.error, 'PROGRAM_ITEM_DENIED');

  // Interstitial drafts are metadata only; publication needs an enrolled endpoint upload.
  const draft = {stationId: 'night-owl', clipId: 'hello-clip', contentRef: 'clip-hello', kind: 'opening', origin: 'uploaded',
    mimeType: 'audio/wav', sha256: 'b'.repeat(64), durationMs: 4000, capturedAtMs: Date.now() - 10};
  assert.equal((await call('/v1/interstitials', {method: 'POST', as: 'artist-1', body: draft})).data.reviewState, 'quarantined');
  assert.equal((await call('/v1/interstitials/night-owl/hello-clip/publish', {method: 'POST', as: 'artist-1', body: {audioRef: 'ciphertext:abc'}})).data.error, 'PUBLICATION_DENIED');

  // Sponsors: pending submission, owner approval denied without verified encrypted audio.
  assert.equal((await op('/operator/v1/grants', {subject: 'listener-1', role: 'sponsor'})).status, 200);
  const campaign = {stationId: 'night-owl', campaignId: 'spring', audioRef: 'ciphertext:spring-audio', programDigest: 'sha256:' + 'c'.repeat(64),
    rateMinor: 500, startsAtMs: Date.now() + 60_000, endsAtMs: Date.now() + 86400_000};
  assert.equal((await call('/v1/sponsor-campaigns', {method: 'POST', as: 'listener-1', body: campaign})).data.state, 'PENDING');
  assert.equal((await call('/v1/sponsor-campaigns/approve', {method: 'POST', as: 'artist-1', body: {stationId: 'night-owl', campaignId: 'spring'}})).data.error, 'CAMPAIGN_NOT_AUTHORIZED');
  assert.equal((await call('/v1/sponsor-campaigns/revoke', {method: 'POST', as: 'listener-1', body: {stationId: 'night-owl', campaignId: 'spring'}})).data.state, 'REVOKED');

  // Station engine: operator credential, scoped ingest, owner-only status.
  const engine = await op('/operator/v1/engine-credentials', {engineId: 'engine-1', stationId: 'night-owl'});
  assert.match(engine.data.token, /^tzeng_/);
  const event = {stationId: 'night-owl', sequence: 1, scheduleVersion: 1, mode: 'PRIMARY', observedAtMs: Date.now()};
  assert.equal((await call('/v1/station-engine/events', {method: 'POST', body: event, headers: {authorization: 'Bearer tzeng_forged'}})).status, 403);
  assert.equal((await call('/v1/station-engine/events', {method: 'POST', body: event, headers: {authorization: `Bearer ${engine.data.token}`}})).data.state, 'PRIMARY');
  assert.equal((await call('/v1/stations/night-owl/status', {as: 'artist-1'})).data.state, 'PRIMARY');
  assert.equal((await call('/v1/stations/night-owl/status', {as: 'listener-1'})).status, 403);
  await op('/operator/v1/engine-credentials/revoke', {engineId: 'engine-1'});
  assert.equal((await call('/v1/station-engine/events', {method: 'POST', body: {...event, sequence: 2}, headers: {authorization: `Bearer ${engine.data.token}`}})).status, 403);

  // Reward prices use the pinned DRE ladder and are creator-only.
  assert.equal((await call('/api/reward-prices/preview', {method: 'POST', as: 'listener-1', body: {base: '100', gentleBps: 20, accelerationBps: 2}})).status, 403);
  const prices = await call('/api/reward-prices/preview', {method: 'POST', as: 'artist-1', body: {base: '100', gentleBps: 20, accelerationBps: 2}});
  assert.equal(prices.data.tiers[0].points, '100');
  assert.ok(BigInt(prices.data.tiers.at(-1).points) > 100n);
  assert.ok(introspections.includes('forged'), 'forged bearer was checked by the IdP, not trusted locally');
});

test('Stripe settings are verified through the read-only probe and never echoed', async t => {
  const secret = 'sk_test_' + 'Z'.repeat(24);
  const {call} = await boot(t, {STRIPE_SECRET_KEY: secret, STRIPE_WEBHOOK_SECRET: 'whsec_' + 'q'.repeat(20), STRIPE_ACCOUNT_ID: 'acct_123'},
    {stripeInspect: async ({apiKey}) => { assert.equal(apiKey, secret); return {accountId: 'acct_123'}; }});
  const ready = await call('/readyz');
  assert.equal(ready.data.features.payments.state, 'sandbox_verified');
  assert.doesNotMatch(ready.text, /sk_test|whsec_/);
  const live = createPaymentsStatus({secretKey: 'sk_live_abc', webhookSecret: 'whsec_x', accountId: 'acct_1'});
  assert.equal(live.snapshot().state, 'misconfigured');
  assert.deepEqual(live.snapshot().problems, ['STRIPE_TEST_KEY_REQUIRED']);
  const failing = createPaymentsStatus({secretKey: 'sk_test_abc', webhookSecret: 'whsec_x', accountId: 'acct_1'}, {inspect: async () => { throw new Error('down'); }});
  await failing.verify();
  assert.equal(failing.snapshot().state, 'verification_failed');
});

test('privacy routes mount only with approved endpoint codecs and still reject plaintext', async t => {
  const packet = {body: {version: '1.0.0', scope: {tenantId: 'trackzero', application: 'distributed-radio', sessionId: 's'}, keyId: 'k',
    algorithm: 'ALG-ED25519', epoch: 1, sequence: 1, issuedAtMs: 1, expiresAtMs: 2, action: 'privacy', payloadCiphertextBase64: 'Zml4'}, signatureHex: '0'.repeat(128)};
  const sealed = [];
  const codecs = {seal: async value => { sealed.push(value); return new TextEncoder().encode(JSON.stringify(value).padEnd(16)); },
    open: async bytes => JSON.parse(new TextDecoder().decode(bytes)), decodeControl: async () => ({publicProfile: true}),
    encodeResponse: async () => packet};
  const {call} = await boot(t, {}, {endpointCodecs: codecs});
  assert.equal((await call('/readyz')).data.features.privacy.state, 'available');
  assert.equal((await call('/v1/privacy/preferences', {method: 'POST', as: 'listener-1', body: {publicProfile: true}})).data.error, 'ENCRYPTED_CONTROL_REQUIRED');
  const response = await call('/v1/privacy/preferences', {method: 'POST', as: 'listener-1', body: packet});
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, packet);
});
