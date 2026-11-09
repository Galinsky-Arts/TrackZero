import {DatabaseSync} from 'node:sqlite';
import {prepareDreInterstitial, prepareInterstitialDraft} from './interstitial.mjs';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class InterstitialError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function actor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['tenant', 'application', 'subject'].every(key => typeof value[key] === 'string' && id.test(value[key]))) {
    throw new InterstitialError('UNAUTHENTICATED', 401);
  }
  if (!Array.isArray(value.roles) || !value.roles.includes('broadcaster')) {
    throw new InterstitialError('BROADCASTER_ROLE_REQUIRED', 403);
  }
  return Object.freeze({tenant: value.tenant, application: value.application, subject: value.subject});
}

/** Drafts hold metadata only. Publication requires a trusted DRE-08 adapter. */
export class InterstitialDraftStore {
  constructor(filename, {authorizeStation, authorizeInterstitial} = {}) {
    if (typeof filename !== 'string' || !filename ||
        typeof authorizeStation !== 'function' || typeof authorizeInterstitial !== 'function') {
      throw new Error('Store, station authorizer and interstitial authorizer required');
    }
    this.authorizeStation = authorizeStation;
    this.authorizeInterstitial = authorizeInterstitial;
    this.db = new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS interstitial_drafts(
      tenant TEXT NOT NULL, application TEXT NOT NULL, station_id TEXT NOT NULL, clip_id TEXT NOT NULL,
      owner_subject TEXT NOT NULL, metadata_json TEXT NOT NULL, published_json TEXT,
      created_at_ms INTEGER NOT NULL, published_at_ms INTEGER,
      PRIMARY KEY(tenant, application, station_id, clip_id)
    );`);
  }
  close() { this.db.close(); }
  #scope(verifiedActor, stationId) {
    const scope = actor(verifiedActor);
    if (typeof stationId !== 'string' || !id.test(stationId) ||
        this.authorizeStation(scope, stationId) !== true) {
      throw new InterstitialError('STATION_ACCESS_DENIED', 403);
    }
    return scope;
  }
  #owned(scope, stationId, clipId) {
    if (typeof clipId !== 'string' || !id.test(clipId)) throw new InterstitialError('INVALID_CLIP');
    const row = this.db.prepare(`SELECT owner_subject, metadata_json, published_json
      FROM interstitial_drafts WHERE tenant=? AND application=? AND station_id=? AND clip_id=?`)
      .get(scope.tenant, scope.application, stationId, clipId);
    if (!row || row.owner_subject !== scope.subject) throw new InterstitialError('DRAFT_NOT_FOUND', 404);
    return row;
  }
  create(verifiedActor, input, nowMs = Date.now()) {
    let draft;
    try { draft = prepareInterstitialDraft(input, nowMs); } catch { throw new InterstitialError('INVALID_DRAFT'); }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const scope = this.#scope(verifiedActor, draft.stationId);
      this.db.prepare(`INSERT INTO interstitial_drafts(
        tenant, application, station_id, clip_id, owner_subject, metadata_json, created_at_ms
      ) VALUES(?,?,?,?,?,?,?)`).run(
        scope.tenant, scope.application, draft.stationId, draft.clipId,
        scope.subject, JSON.stringify(draft), nowMs
      );
      this.db.exec('COMMIT');
      return draft;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint/.test(error.message)) {
        throw new InterstitialError('DRAFT_EXISTS', 409);
      }
      throw error;
    }
  }
  publish(verifiedActor, stationId, clipId, audioRef, nowMs = Date.now()) {
    if (!Number.isSafeInteger(nowMs)) throw new InterstitialError('INVALID_PUBLICATION');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const scope = this.#scope(verifiedActor, stationId);
      const row = this.#owned(scope, stationId, clipId);
      if (row.published_json) throw new InterstitialError('ALREADY_PUBLISHED', 409);
      let record;
      try { record = prepareDreInterstitial(JSON.parse(row.metadata_json), audioRef); }
      catch { throw new InterstitialError('INVALID_PUBLICATION'); }
      if (this.authorizeInterstitial(scope, record) !== true) {
        throw new InterstitialError('PUBLICATION_DENIED', 403);
      }
      this.db.prepare(`UPDATE interstitial_drafts SET published_json=?, published_at_ms=?
        WHERE tenant=? AND application=? AND station_id=? AND clip_id=?`).run(
        JSON.stringify(record), nowMs, scope.tenant, scope.application, stationId, clipId
      );
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(verifiedActor, stationId, clipId) {
    const scope = this.#scope(verifiedActor, stationId);
    const row = this.#owned(scope, stationId, clipId);
    return Object.freeze({
      draft: JSON.parse(row.metadata_json),
      published: row.published_json ? JSON.parse(row.published_json) : null
    });
  }
}

export function createInterstitialHandler(store, authenticate) {
  if (!(store instanceof InterstitialDraftStore) || typeof authenticate !== 'function') {
    throw new Error('Authenticated draft store required');
  }
  return async function handle(request) {
    const url = new URL(request.url);
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    const respond = (status, body) => new Response(JSON.stringify(body), {status, headers});
    try {
      const parts = url.pathname.split('/');
      if (request.method === 'GET' && parts.length === 5 && parts[1] === 'v1' && parts[2] === 'interstitials') {
        return respond(200, store.get(await authenticate(request), parts[3], parts[4]));
      }
      if (request.method === 'POST' && parts.length === 6 && parts[1] === 'v1' &&
          parts[2] === 'interstitials' && parts[5] === 'publish') {
        if (request.headers.get('origin') !== url.origin) throw new InterstitialError('ORIGIN_DENIED', 403);
        const body = await readBody(request);
        if (Object.keys(body).sort().join(',') !== 'audioRef') throw new InterstitialError('INVALID_PUBLICATION');
        return respond(200, store.publish(await authenticate(request), parts[3], parts[4], body.audioRef));
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/interstitials') {
        return respond(404, {error: 'NOT_FOUND'});
      }
      if (request.headers.get('origin') !== url.origin) throw new InterstitialError('ORIGIN_DENIED', 403);
      const identity = await authenticate(request);
      const body = await readBody(request);
      if (['tenant', 'application', 'subject', 'roles', 'media', 'plaintext', 'key', 'publishable']
        .some(key => key in body)) throw new InterstitialError('CLIENT_IDENTITY_OR_MEDIA_FORBIDDEN', 403);
      return respond(201, store.create(identity, body));
    } catch (error) {
      return error instanceof InterstitialError
        ? respond(error.status, {error: error.code})
        : respond(503, {error: 'INTERSTITIAL_UNAVAILABLE'});
    }
  };
}

async function readBody(request) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > 4096) throw new InterstitialError('BODY_TOO_LARGE', 413);
  let body;
  try { body = JSON.parse(text); } catch { throw new InterstitialError('INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InterstitialError('INVALID_JSON');
  return body;
}
