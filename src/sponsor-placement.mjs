import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const audioRef = /^ciphertext:[A-Za-z0-9][A-Za-z0-9._:-]{0,117}$/;

export class PlacementError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function principal(value, role) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['tenant', 'application', 'subject'].every(key =>
        typeof value[key] === 'string' && id.test(value[key]))) {
    throw new PlacementError('UNAUTHENTICATED', 401);
  }
  if (!Array.isArray(value.roles) || !value.roles.includes(role)) {
    throw new PlacementError('ROLE_DENIED', 403);
  }
  return Object.freeze({tenant: value.tenant, application: value.application, subject: value.subject});
}
function campaignInput(value, nowMs) {
  const expected = ['audioRef', 'campaignId', 'endsAtMs', 'programDigest', 'rateMinor', 'startsAtMs', 'stationId'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== expected.join(',') ||
      !['stationId', 'campaignId'].every(key =>
        typeof value[key] === 'string' && id.test(value[key])) ||
      typeof value.audioRef !== 'string' || !audioRef.test(value.audioRef) ||
      typeof value.programDigest !== 'string' || !digest.test(value.programDigest) ||
      !Number.isSafeInteger(value.rateMinor) || value.rateMinor < 0 ||
      !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(value.startsAtMs) ||
      !Number.isSafeInteger(value.endsAtMs) || value.startsAtMs <= nowMs ||
      value.endsAtMs <= value.startsAtMs || value.endsAtMs > nowMs + 366 * 86400_000) {
    throw new PlacementError('INVALID_CAMPAIGN');
  }
  return Object.freeze({...value});
}
function dreCampaign(row) {
  return Object.freeze({
    tenantId: row.tenant,
    stationId: row.station_id,
    campaignId: row.campaign_id,
    audioRef: row.audio_ref,
    programDigest: row.program_digest,
    rateMinor: row.rate_minor
  });
}

/** Sponsor metadata and opaque encrypted references only. DRE-09 authorization
 * stays behind the injected trusted adapter. */
export class SponsorPlacementStore {
  constructor(filename, {authorizeSponsor, authorizeStation, authorizeCampaign} = {}) {
    if (typeof filename !== 'string' || !filename ||
        [authorizeSponsor, authorizeStation, authorizeCampaign].some(fn => typeof fn !== 'function')) {
      throw new Error('Store and three trusted adapters required');
    }
    this.authorizeSponsor = authorizeSponsor;
    this.authorizeStation = authorizeStation;
    this.authorizeCampaign = authorizeCampaign;
    this.db = new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sponsor_campaigns(
      tenant TEXT NOT NULL, application TEXT NOT NULL, station_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
      sponsor_subject TEXT NOT NULL, audio_ref TEXT NOT NULL, program_digest TEXT NOT NULL,
      rate_minor INTEGER NOT NULL, starts_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','REVOKED')),
      approved_by TEXT, approved_at_ms INTEGER, revoked_at_ms INTEGER,
      PRIMARY KEY(tenant, application, station_id, campaign_id)
    );
    CREATE TABLE IF NOT EXISTS campaign_events(
      event_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, application TEXT NOT NULL,
      station_id TEXT NOT NULL, campaign_id TEXT NOT NULL, kind TEXT NOT NULL,
      actor_subject TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL
    );`);
  }
  close() { this.db.close(); }
  #row(scope, stationId, campaignId) {
    return this.db.prepare(`SELECT * FROM sponsor_campaigns
      WHERE tenant=? AND application=? AND station_id=? AND campaign_id=?`)
      .get(scope.tenant, scope.application, stationId, campaignId);
  }
  #event(scope, stationId, campaignId, kind, nowMs) {
    const latest = this.db.prepare(`SELECT MAX(occurred_at_ms) AS value FROM campaign_events
      WHERE tenant=? AND application=? AND station_id=? AND campaign_id=?`)
      .get(scope.tenant, scope.application, stationId, campaignId).value;
    if (latest !== null && nowMs < latest) throw new PlacementError('NON_MONOTONIC_EVENT_TIME');
    this.db.prepare(`INSERT INTO campaign_events(
      event_id, tenant, application, station_id, campaign_id, kind, actor_subject, occurred_at_ms
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      randomUUID(), scope.tenant, scope.application, stationId, campaignId, kind, scope.subject, nowMs
    );
  }
  submit(verifiedSponsor, value, nowMs = Date.now()) {
    const scope = principal(verifiedSponsor, 'sponsor');
    const campaign = campaignInput(value, nowMs);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.authorizeSponsor(scope, campaign.stationId) !== true) {
        throw new PlacementError('SPONSOR_ACCESS_DENIED', 403);
      }
      this.db.prepare(`INSERT INTO sponsor_campaigns(
        tenant, application, station_id, campaign_id, sponsor_subject, audio_ref, program_digest,
        rate_minor, starts_at_ms, ends_at_ms, state
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING')`).run(
        scope.tenant, scope.application, campaign.stationId, campaign.campaignId, scope.subject,
        campaign.audioRef, campaign.programDigest, campaign.rateMinor, campaign.startsAtMs, campaign.endsAtMs
      );
      this.#event(scope, campaign.stationId, campaign.campaignId, 'SUBMITTED', nowMs);
      this.db.exec('COMMIT');
      return Object.freeze({campaignId: campaign.campaignId, state: 'PENDING', schedulable: false});
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint/.test(error.message)) {
        throw new PlacementError('CAMPAIGN_EXISTS', 409);
      }
      throw error;
    }
  }
  approve(verifiedBroadcaster, {stationId, campaignId}, nowMs = Date.now()) {
    const scope = principal(verifiedBroadcaster, 'broadcaster');
    if (!id.test(stationId) || !id.test(campaignId) || !Number.isSafeInteger(nowMs)) {
      throw new PlacementError('INVALID_CAMPAIGN');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.authorizeStation(scope, stationId) !== true) {
        throw new PlacementError('STATION_ACCESS_DENIED', 403);
      }
      const row = this.#row(scope, stationId, campaignId);
      if (!row || row.state !== 'PENDING') throw new PlacementError('PENDING_CAMPAIGN_REQUIRED', 409);
      if (row.sponsor_subject === scope.subject) throw new PlacementError('SELF_APPROVAL_DENIED', 403);
      if (row.ends_at_ms <= nowMs || this.authorizeCampaign(scope, dreCampaign(row)) !== true) {
        throw new PlacementError('CAMPAIGN_NOT_AUTHORIZED', 403);
      }
      this.db.prepare(`UPDATE sponsor_campaigns SET state='APPROVED', approved_by=?, approved_at_ms=?
        WHERE tenant=? AND application=? AND station_id=? AND campaign_id=?`).run(
        scope.subject, nowMs, scope.tenant, scope.application, stationId, campaignId
      );
      this.#event(scope, stationId, campaignId, 'APPROVED', nowMs);
      this.db.exec('COMMIT');
      return Object.freeze({campaignId, state: 'APPROVED', schedulable: nowMs >= row.starts_at_ms});
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  revoke(verifiedActor, {stationId, campaignId}, nowMs = Date.now()) {
    if (!verifiedActor || typeof verifiedActor !== 'object' || !Array.isArray(verifiedActor.roles)) {
      throw new PlacementError('UNAUTHENTICATED', 401);
    }
    const role = verifiedActor.roles.includes('broadcaster') ? 'broadcaster' : 'sponsor';
    const scope = principal(verifiedActor, role);
    if (!id.test(stationId) || !id.test(campaignId) || !Number.isSafeInteger(nowMs)) {
      throw new PlacementError('INVALID_CAMPAIGN');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#row(scope, stationId, campaignId);
      if (!row) throw new PlacementError('CAMPAIGN_NOT_FOUND', 404);
      const broadcaster = role === 'broadcaster' && this.authorizeStation(scope, stationId) === true;
      if (!broadcaster && row.sponsor_subject !== scope.subject) {
        throw new PlacementError('REVOCATION_DENIED', 403);
      }
      if (row.state === 'REVOKED') {
        this.db.exec('COMMIT');
        return Object.freeze({campaignId, state: 'REVOKED', replay: true});
      }
      this.db.prepare(`UPDATE sponsor_campaigns SET state='REVOKED', revoked_at_ms=?
        WHERE tenant=? AND application=? AND station_id=? AND campaign_id=?`).run(
        nowMs, scope.tenant, scope.application, stationId, campaignId
      );
      this.#event(scope, stationId, campaignId, 'REVOKED', nowMs);
      this.db.exec('COMMIT');
      return Object.freeze({campaignId, state: 'REVOKED', replay: false});
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  active(verifiedBroadcaster, stationId, nowMs = Date.now()) {
    const scope = principal(verifiedBroadcaster, 'broadcaster');
    if (!id.test(stationId) || this.authorizeStation(scope, stationId) !== true) {
      throw new PlacementError('STATION_ACCESS_DENIED', 403);
    }
    return this.db.prepare(`SELECT * FROM sponsor_campaigns
      WHERE tenant=? AND application=? AND station_id=? AND state='APPROVED'
      AND starts_at_ms<=? AND ends_at_ms>? ORDER BY starts_at_ms, campaign_id`)
      .all(scope.tenant, scope.application, stationId, nowMs, nowMs)
      .map(dreCampaign)
      .filter(campaign => this.authorizeCampaign(scope, campaign) === true);
  }
}

export function createSponsorPlacementHandler(store, authenticate) {
  if (!(store instanceof SponsorPlacementStore) || typeof authenticate !== 'function') {
    throw new Error('Authenticated placement store required');
  }
  return async function handle(request) {
    const url = new URL(request.url);
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    const respond = (status, body) => new Response(JSON.stringify(body), {status, headers});
    try {
      if (request.method === 'GET' && url.pathname === '/v1/sponsor-campaigns/active') {
        return respond(200, {campaigns: store.active(
          await authenticate(request), url.searchParams.get('stationId')
        )});
      }
      if (request.method !== 'POST' || ![
        '/v1/sponsor-campaigns', '/v1/sponsor-campaigns/approve', '/v1/sponsor-campaigns/revoke'
      ].includes(url.pathname)) return respond(404, {error: 'NOT_FOUND'});
      if (request.headers.get('origin') !== url.origin) throw new PlacementError('ORIGIN_DENIED', 403);
      const actor = await authenticate(request);
      const body = await readBody(request);
      if (['tenant', 'application', 'subject', 'roles', 'media', 'plaintext', 'key']
        .some(key => key in body)) throw new PlacementError('CLIENT_IDENTITY_OR_MEDIA_FORBIDDEN', 403);
      const result = url.pathname.endsWith('/approve') ? store.approve(actor, body) :
        url.pathname.endsWith('/revoke') ? store.revoke(actor, body) : store.submit(actor, body);
      return respond(200, result);
    } catch (error) {
      return error instanceof PlacementError
        ? respond(error.status, {error: error.code})
        : respond(503, {error: 'PLACEMENT_UNAVAILABLE'});
    }
  };
}
async function readBody(request) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > 4096) throw new PlacementError('BODY_TOO_LARGE', 413);
  let body;
  try { body = JSON.parse(text); } catch { throw new PlacementError('INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PlacementError('INVALID_JSON');
  return body;
}
