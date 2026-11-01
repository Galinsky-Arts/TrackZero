import {DatabaseSync} from 'node:sqlite';
import {validateStationStorefront, renderStorefrontHtml} from './storefront.mjs';

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class CatalogError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function verifiedPublisher(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CatalogError('UNAUTHENTICATED', 401);
  for (const key of ['tenant', 'application', 'subject'])
    if (typeof value[key] !== 'string' || !identityPattern.test(value[key])) throw new CatalogError('UNAUTHENTICATED', 401);
  if (!Array.isArray(value.roles) || !value.roles.some(role => role === 'artist' || role === 'label'))
    throw new CatalogError('PUBLISHER_ROLE_REQUIRED', 403);
  return {tenant: value.tenant, application: value.application, subject: value.subject,
    roles: value.roles.filter(role => role === 'artist' || role === 'label')};
}

/** Persists public metadata only. A trusted adapter supplies verified identities
 * and independently checks offer rights before each publication. */
export class StationCatalog {
  constructor(filename, {artworkOrigins = [], verifyOfferRights} = {}) {
    if (typeof filename !== 'string' || !filename) throw new Error('Database filename required');
    if (!Array.isArray(artworkOrigins) || artworkOrigins.length > 8 ||
        artworkOrigins.some(origin => {
          try { const parsed = new URL(origin); return parsed.protocol !== 'https:' || parsed.origin !== origin ||
            !!parsed.username || !!parsed.password || !!parsed.port; } catch { return true; }
        }) || typeof verifyOfferRights !== 'function')
      throw new Error('Rights verifier and artwork policy required');
    this.artworkOrigins = artworkOrigins;
    this.verifyOfferRights = verifyOfferRights;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS stations (
        tenant TEXT NOT NULL, application TEXT NOT NULL, id TEXT NOT NULL,
        owner_subject TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        artwork_url TEXT, published_at TEXT NOT NULL,
        PRIMARY KEY(tenant, application, id)
      );
      CREATE TABLE IF NOT EXISTS station_claims (
        tenant TEXT NOT NULL, application TEXT NOT NULL, station_id TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        PRIMARY KEY(tenant, application, station_id)
      );
      CREATE TABLE IF NOT EXISTS station_offers (
        tenant TEXT NOT NULL, application TEXT NOT NULL, station_id TEXT NOT NULL,
        id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL CHECK(type='complete_product'),
        PRIMARY KEY(tenant, application, station_id, id),
        FOREIGN KEY(tenant, application, station_id) REFERENCES stations(tenant, application, id) ON DELETE CASCADE
      );`);
  }
  close() { this.db.close(); }

  /** An operator must verify station ownership out of band before first
   * publication. This is deliberately absent from the public HTTP handler.
   * Claims cannot be silently transferred by re-provisioning.
   */
  provisionStationClaim({tenant, application, id, ownerSubject}) {
    if (![tenant, application, ownerSubject].every(value =>
      typeof value === 'string' && identityPattern.test(value)) ||
      typeof id !== 'string' || !/^[a-z0-9-]{3,80}$/.test(id))
      throw new CatalogError('INVALID_STATION_CLAIM');
    this.db.prepare(`INSERT INTO station_claims(tenant,application,station_id,owner_subject)
      VALUES(?,?,?,?)`).run(tenant, application, id, ownerSubject);
  }

  get({tenant, application, id}) {
    if (![tenant, application, id].every(value => typeof value === 'string' && identityPattern.test(value)))
      throw new CatalogError('INVALID_STATION');
    const row = this.db.prepare('SELECT name,description,artwork_url FROM stations WHERE tenant=? AND application=? AND id=?')
      .get(tenant, application, id);
    if (!row) return null;
    const offers = this.db.prepare('SELECT id,title,type FROM station_offers WHERE tenant=? AND application=? AND station_id=? ORDER BY id')
      .all(tenant, application, id).map(offer => ({...offer, available: true}));
    return validateStationStorefront({id, name: row.name, description: row.description,
      ...(row.artwork_url ? {artworkUrl: row.artwork_url} : {}), offers},
      {artworkOrigins: this.artworkOrigins});
  }

  async publish(verifiedIdentity, record) {
    const publisher = verifiedPublisher(verifiedIdentity);
    let station;
    try { station = validateStationStorefront(record, {artworkOrigins: this.artworkOrigins}); }
    catch { throw new CatalogError('INVALID_PUBLIC_METADATA'); }
    const priorClaim = this.db.prepare(`SELECT owner_subject FROM station_claims
      WHERE tenant=? AND application=? AND station_id=?`)
      .get(publisher.tenant, publisher.application, station.id);
    if (!priorClaim || priorClaim.owner_subject !== publisher.subject)
      throw new CatalogError('STATION_CLAIM_REQUIRED', 403);
    if (station.offers.length && await this.verifyOfferRights(publisher, station) !== true)
      throw new CatalogError('RIGHTS_NOT_VERIFIED', 403);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claim = this.db.prepare(`SELECT owner_subject FROM station_claims
        WHERE tenant=? AND application=? AND station_id=?`)
        .get(publisher.tenant, publisher.application, station.id);
      if (!claim || claim.owner_subject !== publisher.subject)
        throw new CatalogError('STATION_CLAIM_REQUIRED', 403);
      const owner = this.db.prepare('SELECT owner_subject FROM stations WHERE tenant=? AND application=? AND id=?')
        .get(publisher.tenant, publisher.application, station.id);
      if (owner && owner.owner_subject !== publisher.subject) throw new CatalogError('STATION_OWNER_MISMATCH', 403);
      this.db.prepare(`INSERT INTO stations(tenant,application,id,owner_subject,name,description,artwork_url,published_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant,application,id) DO UPDATE SET
        name=excluded.name,description=excluded.description,artwork_url=excluded.artwork_url,published_at=excluded.published_at`)
        .run(publisher.tenant, publisher.application, station.id, publisher.subject,
          station.name, station.description, station.artworkUrl, new Date().toISOString());
      this.db.prepare('DELETE FROM station_offers WHERE tenant=? AND application=? AND station_id=?')
        .run(publisher.tenant, publisher.application, station.id);
      const add = this.db.prepare('INSERT INTO station_offers(tenant,application,station_id,id,title,type) VALUES(?,?,?,?,?,?)');
      for (const offer of station.offers)
        add.run(publisher.tenant, publisher.application, station.id, offer.id, offer.title, offer.type);
      this.db.exec('COMMIT');
      return this.get({...publisher, id: station.id});
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

/** A framework-neutral HTTP boundary. authenticate must verify a real session
 * and derive tenant/application/subject/roles server-side. */
export function createStationCatalogHandler(catalog, authenticate) {
  if (!(catalog instanceof StationCatalog) || typeof authenticate !== 'function') throw new Error('Authenticated catalog required');
  return async function handle(request) {
    const url = new URL(request.url);
    const json = (status, body) => new Response(JSON.stringify(body), {status,
      headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
    try {
      if (request.method === 'GET' && url.pathname.startsWith('/v1/stations/')) {
        const id = url.pathname.slice('/v1/stations/'.length);
        const tenant = url.searchParams.get('tenant'), application = url.searchParams.get('application');
        const record = catalog.get({tenant, application, id});
        return record ? new Response(renderStorefrontHtml(record, {artworkOrigins: catalog.artworkOrigins}),
          {status: 200, headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; img-src " + catalog.artworkOrigins.join(' ') + "; style-src 'none'; base-uri 'none'; form-action 'none'"}})
          : json(404, {error: 'STATION_NOT_FOUND'});
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/stations') return json(404, {error: 'NOT_FOUND'});
      if (request.headers.get('origin') !== url.origin) throw new CatalogError('ORIGIN_DENIED', 403);
      const identity = verifiedPublisher(await authenticate(request));
      const bodyText = await request.text();
      if (bodyText.length > 8192) throw new CatalogError('BODY_TOO_LARGE', 413);
      let body;
      try { body = JSON.parse(bodyText); } catch { throw new CatalogError('INVALID_JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          ['tenant', 'application', 'subject', 'owner'].some(key => key in body))
        throw new CatalogError('CLIENT_IDENTITY_FORBIDDEN', 403);
      return json(200, await catalog.publish(identity, body));
    } catch (error) {
      return error instanceof CatalogError ? json(error.status, {error: error.code}) : json(503, {error: 'CATALOG_UNAVAILABLE'});
    }
  };
}
