import {DatabaseSync} from 'node:sqlite';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^sha256:[a-f0-9]{64}$/;

export class SponsorError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function actor(value, role) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['tenant', 'application', 'subject'].every(key => typeof value[key] === 'string' && id.test(value[key]))) {
    throw new SponsorError('UNAUTHENTICATED', 401);
  }
  if (!Array.isArray(value.roles) || !value.roles.includes(role)) {
    throw new SponsorError(`${role.toUpperCase()}_ROLE_REQUIRED`, 403);
  }
  return Object.freeze({tenant: value.tenant, application: value.application, subject: value.subject});
}

function draft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SponsorError('INVALID_DRAFT');
  const expected = ['audioRef', 'campaignId', 'durationMs', 'mimeType', 'rateMinor', 'sha256', 'stationId'];
  if (Object.keys(input).sort().join(',') !== expected.join(',')) throw new SponsorError('INVALID_DRAFT');
  if (!id.test(input.campaignId) || !id.test(input.stationId) ||
      typeof input.audioRef !== 'string' || !/^ciphertext:[A-Za-z0-9][A-Za-z0-9._:-]{0,117}$/.test(input.audioRef) ||
      !['audio/mpeg', 'audio/ogg', 'audio/wav'].includes(input.mimeType) ||
      typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !Number.isSafeInteger(input.durationMs) || input.durationMs < 1 || input.durationMs > 300_000 ||
      !Number.isSafeInteger(input.rateMinor) || input.rateMinor < 0) throw new SponsorError('INVALID_DRAFT');
  return Object.freeze({...input, reviewState: 'quarantined', placeable: false});
}

/** Stores sponsor metadata only. The trusted callback must implement the exact
 * DRE-09 campaign authorization contract; TrackZero never infers approval. */
export class SponsorPlacementStore {
  constructor(filename, {authorizeStation, authorizeCampaign} = {}) {
    if (typeof filename !== 'string' || !filename ||
        typeof authorizeStation !== 'function' || typeof authorizeCampaign !== 'function') {
      throw new Error('Store, station authorizer and campaign authorizer required');
    }
    this.authorizeStation = authorizeStation;
    this.authorizeCampaign = authorizeCampaign;
    this.db = new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sponsor_campaigns(
      tenant TEXT NOT NULL, application TEXT NOT NULL, station_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
      sponsor_subject TEXT NOT NULL, draft_json TEXT NOT NULL, placement_json TEXT,
      created_at_ms INTEGER NOT NULL, placed_at_ms INTEGER,
      PRIMARY KEY(tenant, application, station_id, campaign_id)
    );`);
  }
  close() { this.db.close(); }
  #scope(verifiedActor, role, stationId, action) {
    const scope = actor(verifiedActor, role);
    if (typeof stationId !== 'string' || !id.test(stationId) ||
        this.authorizeStation(scope, stationId, action) !== true) {
      throw new SponsorError('STATION_ACCESS_DENIED', 403);
    }
    return scope;
  }
  create(verifiedActor, input, nowMs = Date.now()) {
    if (!Number.isSafeInteger(nowMs)) throw new SponsorError('INVALID_DRAFT');
    const record = draft(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const scope = this.#scope(verifiedActor, 'sponsor', record.stationId, 'upload');
      this.db.prepare(`INSERT INTO sponsor_campaigns(
        tenant,application,station_id,campaign_id,sponsor_subject,draft_json,created_at_ms
      ) VALUES(?,?,?,?,?,?,?)`).run(scope.tenant, scope.application, record.stationId,
        record.campaignId, scope.subject, JSON.stringify(record), nowMs);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint/.test(error.message)) {
        throw new SponsorError('CAMPAIGN_EXISTS', 409);
      }
      throw error;
    }
  }
  place(verifiedActor, stationId, campaignId, programDigest, nowMs = Date.now()) {
    if (!id.test(campaignId) || typeof programDigest !== 'string' || !digest.test(programDigest) ||
        !Number.isSafeInteger(nowMs)) throw new SponsorError('INVALID_PLACEMENT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const scope = this.#scope(verifiedActor, 'broadcaster', stationId, 'place');
      const row = this.db.prepare(`SELECT draft_json,placement_json FROM sponsor_campaigns
        WHERE tenant=? AND application=? AND station_id=? AND campaign_id=?`)
        .get(scope.tenant, scope.application, stationId, campaignId);
      if (!row) throw new SponsorError('CAMPAIGN_NOT_FOUND', 404);
      if (row.placement_json) throw new SponsorError('ALREADY_PLACED', 409);
      const stored = JSON.parse(row.draft_json);
      const campaign = Object.freeze({tenantId: scope.tenant, stationId, campaignId,
        audioRef: stored.audioRef, programDigest, rateMinor: stored.rateMinor});
      if (this.authorizeCampaign(scope, campaign) !== true) throw new SponsorError('PLACEMENT_DENIED', 403);
      this.db.prepare(`UPDATE sponsor_campaigns SET placement_json=?,placed_at_ms=?
        WHERE tenant=? AND application=? AND station_id=? AND campaign_id=?`)
        .run(JSON.stringify(campaign), nowMs, scope.tenant, scope.application, stationId, campaignId);
      this.db.exec('COMMIT');
      return campaign;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(verifiedActor, stationId, campaignId) {
    const scope = this.#scope(verifiedActor, 'broadcaster', stationId, 'place');
    const row = this.db.prepare(`SELECT draft_json,placement_json FROM sponsor_campaigns
      WHERE tenant=? AND application=? AND station_id=? AND campaign_id=?`)
      .get(scope.tenant, scope.application, stationId, campaignId);
    if (!row) throw new SponsorError('CAMPAIGN_NOT_FOUND', 404);
    return Object.freeze({draft: JSON.parse(row.draft_json),
      placement: row.placement_json ? JSON.parse(row.placement_json) : null});
  }
}

export function createSponsorHandler(store, authenticate) {
  if (!(store instanceof SponsorPlacementStore) || typeof authenticate !== 'function') {
    throw new Error('Authenticated sponsor store required');
  }
  return async function handle(request) {
    const url = new URL(request.url), parts = url.pathname.split('/');
    const respond = (status, body) => new Response(JSON.stringify(body), {status,
      headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
    try {
      if (request.method === 'GET' && parts.length === 5 && parts[1] === 'v1' && parts[2] === 'sponsors') {
        return respond(200, store.get(await authenticate(request), parts[3], parts[4]));
      }
      if (request.method === 'POST' && parts.length === 6 && parts[1] === 'v1' &&
          parts[2] === 'sponsors' && parts[5] === 'place') {
        requireOrigin(request, url); const body = await readBody(request);
        if (Object.keys(body).sort().join(',') !== 'programDigest') throw new SponsorError('INVALID_PLACEMENT');
        return respond(200, store.place(await authenticate(request), parts[3], parts[4], body.programDigest));
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/sponsors') return respond(404, {error: 'NOT_FOUND'});
      requireOrigin(request, url); const identity = await authenticate(request); const body = await readBody(request);
      if (['tenant', 'application', 'subject', 'roles', 'media', 'plaintext', 'key', 'approved']
        .some(key => key in body)) throw new SponsorError('CLIENT_IDENTITY_OR_MEDIA_FORBIDDEN', 403);
      return respond(201, store.create(identity, body));
    } catch (error) {
      return error instanceof SponsorError ? respond(error.status, {error: error.code}) :
        respond(503, {error: 'SPONSOR_WORKFLOW_UNAVAILABLE'});
    }
  };
}
function requireOrigin(request, url) {
  if (request.headers.get('origin') !== url.origin) throw new SponsorError('ORIGIN_DENIED', 403);
}
async function readBody(request) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > 4096) throw new SponsorError('BODY_TOO_LARGE', 413);
  let body; try { body = JSON.parse(text); } catch { throw new SponsorError('INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SponsorError('INVALID_JSON');
  return body;
}
