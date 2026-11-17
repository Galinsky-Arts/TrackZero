import {createServer} from 'node:http';
import {mkdirSync, chmodSync, readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import pg from 'pg';
import {OnboardingStore, createOnboardingHandler} from '../onboarding.mjs';
import {createIntrospectionAuthenticator} from '../authentication.mjs';
import {StationCatalog, createStationCatalogHandler} from '../station-catalog.mjs';
import {createCatalogPublisherAuthenticator} from '../catalog-account-auth.mjs';
import {RightsRegistry, createRightsHandler} from '../rights-registry.mjs';
import {ProgramStore, createProgramHandler} from '../program-store.mjs';
import {InterstitialDraftStore, createInterstitialHandler} from '../interstitial-store.mjs';
import {SponsorPlacementStore, createSponsorPlacementHandler} from '../sponsor-placement.mjs';
import {StationOperations, createStationOperationsHandler} from '../station-operations.mjs';
import {createGuestHandler} from '../guest-radio.mjs';
import {createDiscoveryHandler} from '../discovery.mjs';
import {PrivacyStore, createPrivacyHandler} from '../privacy-complaints.mjs';
import {createRewardPricing} from '../reward-prices.mjs';
import {createAccountService} from './accounts.mjs';
import {GrantStore} from './grants.mjs';
import {createIdentity} from './identity.mjs';
import {createOperatorHandler, createOperatorOperations} from './operator.mjs';
import {createPaymentsStatus} from './payments.mjs';
import {createNodeListener} from './node-adapter.mjs';
import {createMailer} from './mail.mjs';
import {createPostgresStoreDurability} from './store-durability.mjs';

const PUBLIC_DIR = resolve(import.meta.dirname, '../../public');
const SRC_DIR = resolve(import.meta.dirname, '..');
/** Pure browser modules reused by the web UI; nothing with server secrets. */
const BROWSER_MODULES = new Set(['program-sequence.mjs', 'contribute-sound.mjs', 'groove-reveal.mjs',
  'live-points.mjs', 'reward-prices.mjs', 'guest-radio.mjs']);
const STATIC_TYPES = {'.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8',
  '.webmanifest': 'application/manifest+json'};
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** Features that exchange endpoint-encrypted payloads. TrackZero never offers a
 * plaintext fallback: without an approved enrolled-endpoint codec they answer
 * ENDPOINT_ENROLLMENT_REQUIRED and the UI shows that state. */
export const ENDPOINT_FEATURES = Object.freeze([
  {feature: 'albumCheckout', prefixes: ['/v1/album-checkouts'], needs: 'approved endpoint codec, DAE/DRE commerce composition and Stripe sandbox keys'},
  {feature: 'voluntarySupport', prefixes: ['/v1/support/'], needs: 'approved endpoint codec and a provider support-intent integration'},
  {feature: 'grooveSettings', prefixes: ['/v1/grooves/'], needs: 'approved endpoint codec and DRE atomic Groove publisher'},
  {feature: 'reports', prefixes: ['/v1/reports/'], needs: 'approved endpoint codec and issuer/processor evidence feeds'},
  {feature: 'pointRedemption', prefixes: ['/v1/point-redemptions'], needs: 'approved endpoint codec and DRE point issuer'},
  {feature: 'fanLibrary', prefixes: ['/v1/library'], needs: 'approved endpoint codec and entitlement issuer'},
  {feature: 'privacy', prefixes: ['/v1/privacy', '/v1/complaints'], needs: 'approved endpoint seal/open storage codecs'}
]);

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {status,
  headers: {'content-type': 'application/json', 'cache-control': 'no-store', ...headers}});

function privateDirectory(path) {
  mkdirSync(path, {recursive: true, mode: 0o700});
  chmodSync(path, 0o700);
  if (!statSync(path).isDirectory()) throw new Error('TZ_DATA_DIR must be a directory');
}

/** Wrap the dependency-free server-rendered guest HTML with the shared
 * stylesheet and the guest player script; the page content is unchanged. */
function decorateGuestHtml(html) {
  return html.replace(/<\/title>/, '</title><link rel="stylesheet" href="/assets/app.css">' +
    '<script type="module" src="/assets/guest.js"></script>')
    .replace('<main>', '<header class="site"><a class="brand" href="/">TrackZero</a><nav aria-label="Primary"><a href="/#/discover">Discover</a></nav></header><main id="main" class="guest">');
}

/**
 * Compose every TrackZero handler on one origin with shared durable stores
 * under config.dataDir. Returns {handle, server, ready, close, ...}.
 * Options exist for tests: pool, fetchImpl, accountService, endpointCodecs, now.
 */
export async function createTrackZeroApp(config, {pool, storePool, fetchImpl = fetch, endpointCodecs = null, stripeInspect,
  mailFetch} = {}) {
  const scope = {tenant: config.tenant, application: config.application};
  privateDirectory(config.dataDir);
  const file = name => join(config.dataDir, name);
  const closers = [];
  const open = store => { closers.push(() => store.close()); return store; };
  try {
    // ---- identity -------------------------------------------------------
    let accounts = null, ownPool = null, authenticate;
    const mailer = createMailer(config.mail ?? {}, mailFetch ? {fetchImpl: mailFetch} : {});
    const basic = () => ({authorization: 'Basic ' + Buffer.from(
      `${encodeURIComponent(config.identity.clientId)}:${encodeURIComponent(config.identity.clientSecret)}`).toString('base64')});
    if (config.identity.mode === 'builtin') {
      if (!pool) { ownPool = pool = new pg.Pool(config.identity.database); closers.push(() => ownPool.end()); }
      accounts = createAccountService({pool, baseURL: config.publicOrigin + '/', secret: config.identity.secret,
        tenant: config.tenant, issuer: config.identity.issuer, audience: config.identity.audience,
        clients: [{id: config.identity.clientId, secret: config.identity.clientSecret}], mailer});
      // RFC 7662 over an in-process call: same contract and client authentication
      // as an external IdP, without a network round trip to our own origin.
      const internal = new URL('/oauth2/introspect', config.publicOrigin);
      internal.protocol = 'https:';
      const local = internal.href;
      authenticate = createIntrospectionAuthenticator({endpoint: local, issuer: config.identity.issuer,
        audience: config.identity.audience, application: config.application, authorize: basic,
        fetchImpl: (target, init) => target === local ? accounts.introspect(new Request(target, init)) : fetchImpl(target, init)});
    } else {
      authenticate = createIntrospectionAuthenticator({endpoint: config.identity.introspectionEndpoint,
        issuer: config.identity.issuer, audience: config.identity.audience, application: config.application,
        authorize: basic, fetchImpl});
    }

    // ---- durable stores -------------------------------------------------
    // postgres mode: rebuild the working SQLite files from PostgreSQL before any
    // store opens, then persist every committed change before each response.
    let durability = null;
    if (config.durability === 'postgres') {
      if (!storePool) { const own = storePool = new pg.Pool({...config.storeDatabase, max: 3}); closers.push(() => own.end()); }
      durability = createPostgresStoreDurability({pool: storePool, dataDir: config.dataDir,
        deployment: `${config.tenant}/${config.application}`});
      await durability.restore();
    }
    const onboarding = open(new OnboardingStore(file('onboarding.sqlite')));
    const rights = open(new RightsRegistry(file('rights.sqlite')));
    const grants = open(new GrantStore(file('grants.sqlite')));
    const canPublish = (itemId, use) => rights.canPublish({...scope, itemId, region: config.region, use});
    const catalog = open(new StationCatalog(file('catalog.sqlite'), {artworkOrigins: config.artworkOrigins,
      verifyOfferRights: async (_publisher, station) => station.offers.every(offer => canPublish(offer.id, 'sale'))}));
    const identity = createIdentity({authenticate, onboarding, catalog, grants});
    const interstitials = open(new InterstitialDraftStore(file('interstitials.sqlite'), {
      authorizeStation: identity.ownsStation,
      // DRE-08 publication needs a verified endpoint-encrypted upload; none is enrolled.
      authorizeInterstitial: () => false}));
    const sponsors = open(new SponsorPlacementStore(file('sponsors.sqlite'), {
      authorizeSponsor: (_scope, stationId) => { try { return catalog.get({...scope, id: stationId}) !== null; } catch { return false; } },
      authorizeStation: identity.ownsStation,
      // DRE-09 campaign authorization needs verified encrypted sponsor audio; none is enrolled.
      authorizeCampaign: () => false}));
    const programs = open(new ProgramStore(file('programs.sqlite'), {
      authorizeStation: identity.ownsStation,
      authorizeItem: (actor, stationId, item) => {
        if (item.kind === 'song') return canPublish(item.id, 'broadcast');
        if (item.kind === 'block') return true;
        if (item.kind === 'ad') return sponsors.db.prepare(`SELECT 1 FROM sponsor_campaigns WHERE tenant=? AND application=?
          AND station_id=? AND campaign_id=? AND state='APPROVED' AND ends_at_ms>?`)
          .get(actor.tenant, actor.application, stationId, item.id, Date.now()) !== undefined;
        return interstitials.db.prepare(`SELECT 1 FROM interstitial_drafts WHERE tenant=? AND application=?
          AND station_id=? AND clip_id=? AND published_json IS NOT NULL`)
          .get(actor.tenant, actor.application, stationId, item.id) !== undefined;
      }}));
    const operations = open(new StationOperations(file('operations.sqlite'), {
      authorizeEngine: (source, stationId) => grants.engineStation(source) === stationId}));
    let privacy = null;
    if (endpointCodecs?.seal && endpointCodecs?.open) privacy = open(new PrivacyStore(file('privacy.sqlite'), {
      seal: endpointCodecs.seal, open: endpointCodecs.open,
      authorizeDecision: actor => grants.roles(actor).includes('moderator')}));

    if (durability) { closers.push(() => durability.close()); durability.attach(); await durability.flush(); }

    // ---- handlers ---------------------------------------------------------
    const onboardingHandler = createOnboardingHandler(onboarding, authenticate);
    const catalogHandler = createStationCatalogHandler(catalog,
      createCatalogPublisherAuthenticator(identity.principal, principal => onboarding.account(principal)));
    const rightsHandler = createRightsHandler(rights, identity.actor);
    const programHandler = createProgramHandler(programs, identity.actor);
    const interstitialHandler = createInterstitialHandler(interstitials, identity.actor);
    const sponsorHandler = createSponsorPlacementHandler(sponsors, identity.actor);
    const operationsHandler = createStationOperationsHandler(operations, identity.operations,
      {authorizeViewer: (viewer, stationId) => typeof viewer.subject === 'string' && identity.ownsStation(viewer, stationId)});
    const publicStation = id => { try { return catalog.get({...scope, id}); } catch { return null; } };
    const guestHandler = createGuestHandler({artworkOrigins: config.artworkOrigins,
      getStation: async id => { const s = publicStation(id); return s && {id: s.id, name: s.name, description: s.description}; },
      getAlbums: async id => (publicStation(id)?.offers ?? []).map(offer => ({id: offer.id, title: offer.title,
        artist: publicStation(id).name, artworkUrl: null})),
      getAlbum: async id => { const o = catalog.findOffer({...scope, offerId: id}); return o && {id: o.id, title: o.title, artist: o.stationName, artworkUrl: null}; }});
    const https = config.publicOrigin.startsWith('https:');
    const discoveryHandler = https ? createDiscoveryHandler({publicOrigin: config.publicOrigin,
      listStations: async () => catalog.list(scope), authorizePublicStation: async () => true}) : null;
    const privacyHandler = privacy && createPrivacyHandler(privacy, identity.actor,
      {decodeControl: endpointCodecs.decodeControl, encodeResponse: endpointCodecs.encodeResponse});
    const operatorOps = createOperatorOperations({scope, onboarding, catalog, grants});
    const operatorHandler = createOperatorHandler({token: config.operatorToken, publicOrigin: config.publicOrigin, operations: operatorOps});
    const rewardLadder = await import('@neophilism/distributed-radio-engine/reward-prices');
    const quote = createRewardPricing(rewardLadder);
    const payments = createPaymentsStatus(config.stripe, {inspect: stripeInspect ??
      (async options => (await import('@neophilism/distributed-radio-engine/stripe')).inspectStripeSandboxAccount(options))});
    payments.verify().catch(() => {});

    // ---- readiness ------------------------------------------------------
    function features() {
      const result = {
        accounts: {state: 'available', identity: config.identity.mode},
        onboarding: {state: 'available'}, stationCatalog: {state: 'available'}, rights: {state: 'available'},
        programSequence: {state: 'available'}, interstitialDrafts: {state: 'available'},
        interstitialPublication: {state: 'requires_enrolled_endpoint', needs: 'verified endpoint-encrypted clip upload (DRE-08)'},
        sponsorCampaigns: {state: 'available'},
        sponsorApproval: {state: 'requires_enrolled_endpoint', needs: 'verified endpoint-encrypted sponsor audio (DRE-09)'},
        stationOperations: {state: 'available', needs: 'an enrolled station engine reporting with an operator-issued credential'},
        guestPages: {state: 'available'}, discovery: {state: https ? 'available' : 'requires_https_origin'},
        livePlayback: {state: 'requires_enrolled_endpoint', needs: 'an enrolled DRE station engine with authorized encrypted media'},
        rewardPricePreview: {state: 'available'},
        contributeSound: {state: 'requires_enrolled_endpoint', needs: 'verified speaker-route evidence from a native DAE endpoint'},
        payments: payments.snapshot(),
        passwordRecovery: config.identity.mode !== 'builtin' ? {state: 'external_identity_provider'} : mailer.snapshot(),
        operatorApi: {state: config.operatorToken ? 'available' : 'disabled'}
      };
      for (const {feature, needs} of ENDPOINT_FEATURES)
        result[feature] = feature === 'privacy' && privacyHandler ? {state: 'available'} : {state: 'requires_enrolled_endpoint', needs};
      return result;
    }
    const storageNotice = config.durability === 'postgres'
      ? 'Application stores (stations, rights, programs, grants) are written to PostgreSQL before every response and restored on start.'
      : config.durability === 'persistent'
      ? 'Application SQLite stores are on a volume the operator declared persistent.'
      : 'Preview only: application SQLite data (stations, rights, programs, grants) is EPHEMERAL and is lost on every restart or redeploy. Production requires a persistent disk (a paid hosting decision).';
    async function readiness() {
      const checks = {storage: 'ok', accounts: 'ok'};
      try { onboarding.db.prepare('SELECT 1').get(); grants.db.prepare('SELECT 1').get(); } catch { checks.storage = 'unavailable'; }
      if (durability) { try { await durability.flush(); } catch {} if (!durability.healthy()) checks.storage = 'unavailable'; }
      if (accounts) { try { await accounts.ping(); } catch { checks.accounts = 'unavailable'; } }
      const ok = Object.values(checks).every(value => value === 'ok');
      return {status: ok ? 'ready' : 'not_ready', production: false, checks,
        storage: {durability: config.durability, notice: storageNotice, ...(durability ? {persistence: durability.status()} : {})},
        features: features(),
        notice: 'Development preview. Endpoint-encrypted features stay disabled until approved endpoints are enrolled; no field, device or pilot qualification is implied.'};
    }

    // ---- small JSON APIs used by the web UI ---------------------------------
    async function contextApi(request) {
      const actor = await identity.actor(request);
      if (!actor) return json(401, {error: 'UNAUTHENTICATED'});
      return json(200, {subject: actor.subject, roles: actor.roles, onboarded: actor.account !== null,
        tenant: actor.tenant, application: actor.application, region: config.region, stations: catalog.claimsFor(actor)});
    }
    async function rewardPreviewApi(request) {
      const actor = await identity.actor(request);
      if (!actor) return json(401, {error: 'UNAUTHENTICATED'});
      if (!actor.roles.some(role => role === 'artist' || role === 'label')) return json(403, {error: 'CREATOR_ROLE_REQUIRED'});
      if (request.headers.get('origin') !== config.publicOrigin) return json(403, {error: 'ORIGIN_DENIED'});
      let body;
      try { body = JSON.parse(await request.text()); } catch { return json(400, {error: 'INVALID_JSON'}); }
      const tiers = [0, 1, 5, 10, 25, 50, 100];
      try {
        const rows = tiers.map(tier => {
          const result = quote({artistId: actor.subject, base: String(body?.base), gentleBps: body?.gentleBps,
            accelerationBps: body?.accelerationBps, tier});
          return {tier, kind: result.kind, points: result.points === null ? null : result.points.toString()};
        });
        return json(200, {artistId: actor.subject, tiers: rows,
          notice: 'Preview computed with the pinned DRE reward ladder. Publishing a price policy to the DRE point issuer requires an enrolled endpoint.'});
      } catch { return json(400, {error: 'INVALID_PRICE_SETTINGS'}); }
    }
    function publicApi(url) {
      if (url.pathname === '/api/public/stations') return json(200, {stations: catalog.list(scope)});
      const match = /^\/api\/public\/stations\/([a-z0-9-]{3,80})$/.exec(url.pathname);
      if (match) { const station = publicStation(match[1]); return station ? json(200, station) : json(404, {error: 'STATION_NOT_FOUND'}); }
      return json(404, {error: 'NOT_FOUND'});
    }
    function serveStatic(url) {
      let path = null;
      if (url.pathname === '/' || url.pathname === '/index.html') path = join(PUBLIC_DIR, 'index.html');
      else if (url.pathname === '/favicon.ico') path = join(PUBLIC_DIR, 'assets/icon.svg');
      else if (/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|svg|webmanifest)$/.test(url.pathname)) path = join(PUBLIC_DIR, url.pathname.slice(1));
      else if (url.pathname.startsWith('/modules/') && BROWSER_MODULES.has(url.pathname.slice(9))) path = join(SRC_DIR, url.pathname.slice(9));
      if (!path) return null;
      let bytes;
      try { bytes = readFileSync(path); } catch { return null; }
      const type = STATIC_TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';
      return new Response(bytes, {status: 200, headers: {'content-type': type,
        'cache-control': path.endsWith('index.html') ? 'no-store' : 'no-cache'}});
    }

    async function route(request) {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) return json(200, {status: 'ok'});
      if (path === '/readyz' && method === 'GET') { const body = await readiness(); return json(body.status === 'ready' ? 200 : 503, body); }
      if (accounts && (path.startsWith('/api/auth/') || path.startsWith('/api/account/') || path === '/oauth2/introspect')) {
        const response = await accounts.handle(request);
        if (response) return response;
      }
      if (path === '/api/context' && method === 'GET') return contextApi(request);
      if (path === '/api/reward-prices/preview' && method === 'POST') return rewardPreviewApi(request);
      if (path.startsWith('/api/public/') && method === 'GET') return publicApi(url);
      if (path.startsWith('/operator/v1/')) return operatorHandler(request);
      if (path === '/v1/me' || path === '/v1/onboarding') return onboardingHandler(request);
      if (path === '/v1/station-engine/events' || (path.startsWith('/v1/stations/') && path.endsWith('/status'))) return operationsHandler(request);
      if (path === '/v1/stations' || path.startsWith('/v1/stations/')) return catalogHandler(request);
      if (path.startsWith('/v1/rights/')) return rightsHandler(request);
      if (path.startsWith('/v1/programs/')) return programHandler(request);
      if (path === '/v1/interstitials' || path.startsWith('/v1/interstitials/')) return interstitialHandler(request);
      if (path === '/v1/sponsor-campaigns' || path.startsWith('/v1/sponsor-campaigns/')) return sponsorHandler(request);
      if (path === '/v1/discover') return discoveryHandler ? discoveryHandler(request) : json(503, {error: 'HTTPS_ORIGIN_REQUIRED'});
      if (privacyHandler && (path.startsWith('/v1/privacy') || path === '/v1/complaints')) return privacyHandler(request);
      const gated = ENDPOINT_FEATURES.find(entry => entry.prefixes.some(prefix => path === prefix || path.startsWith(prefix)));
      if (gated) return json(503, {error: 'ENDPOINT_ENROLLMENT_REQUIRED', feature: gated.feature, needs: gated.needs});
      if (path.startsWith('/stations/') || path.startsWith('/albums/')) {
        const response = await guestHandler(request);
        if (response.status !== 200) return response;
        return new Response(decorateGuestHtml(await response.text()), {status: 200, headers: {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache',
          'content-security-policy': response.headers.get('content-security-policy')}});
      }
      if (method === 'GET' || method === 'HEAD') { const response = serveStatic(url); if (response) return response; }
      return json(404, {error: 'NOT_FOUND'});
    }

    async function handle(request) {
      let response;
      try { response = await route(request); }
      catch { response = json(503, {error: 'SERVICE_UNAVAILABLE'}); }
      // No change is acknowledged before it is durable in PostgreSQL. Reads are
      // still answered (readiness reports the failed persistence); a write
      // request whose changes could not be stored answers 503.
      if (durability) {
        try { await durability.flush(); }
        catch (error) {
          if (request.method === 'GET' || request.method === 'HEAD') return finish(response);
          try { await response.body?.cancel(); } catch {}
          response = json(503, {error: error?.code === 'STORE_SUPERSEDED' ? 'STORAGE_SUPERSEDED' : 'STORAGE_NOT_DURABLE'});
        }
      }
      return finish(response);
    }
    function finish(response) {
      const headers = new Headers(response.headers);
      headers.set('x-content-type-options', 'nosniff');
      headers.set('referrer-policy', 'no-referrer');
      headers.set('x-frame-options', 'DENY');
      headers.set('cross-origin-opener-policy', 'same-origin');
      headers.set('permissions-policy', 'microphone=(self), camera=(), geolocation=(), payment=()');
      if (https) headers.set('strict-transport-security', 'max-age=31536000');
      if ((headers.get('content-type') ?? '').startsWith('text/html') && !headers.has('content-security-policy'))
        headers.set('content-security-policy', UI_CSP);
      return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
    }

    const server = createServer(createNodeListener(handle, {publicOrigin: config.publicOrigin,
      trustedProxyHops: config.trustedProxyHops}));
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    let closed = false;
    return {
      handle, server, readiness, accounts, durability, mailer, operator: operatorOps, stores: {onboarding, catalog, rights, grants, programs,
        interstitials, sponsors, operations, privacy},
      async close() {
        if (closed) return;
        closed = true;
        if (server.listening) await new Promise(done => { server.close(() => done()); server.closeAllConnections?.(); });
        for (const close of closers.reverse()) { try { await close(); } catch {} }
      }
    };
  } catch (error) {
    for (const close of closers.reverse()) { try { await close(); } catch {} }
    throw error;
  }
}
