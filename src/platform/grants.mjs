import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG = /^[a-z0-9-]{3,80}$/;
/** Roles an operator may grant outside the invitation-based onboarding roles.
 * station ownership (broadcaster) comes from verified station claims instead. */
export const GRANTABLE_ROLES = Object.freeze(['rights_reviewer', 'sponsor', 'moderator']);
export const ENGINE_TOKEN_PREFIX = 'tzeng_';

export class GrantError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const valid = value => typeof value === 'string' && ID.test(value);
const digest = token => createHash('sha256').update(token).digest('hex');

/** Local authorization grants. Provider identities never carry these roles;
 * only an operator (CLI or operator-token API) can write them. Engine
 * credentials are stored as SHA-256 digests and shown once at creation. */
export class GrantStore {
  constructor(filename) {
    if (typeof filename !== 'string' || !filename) throw new Error('Database filename required');
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS role_grants(
        tenant TEXT NOT NULL, application TEXT NOT NULL, subject TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('rights_reviewer','sponsor','moderator')),
        granted_at TEXT NOT NULL, PRIMARY KEY(tenant,application,subject,role));
      CREATE TABLE IF NOT EXISTS engine_credentials(
        digest TEXT PRIMARY KEY, tenant TEXT NOT NULL, application TEXT NOT NULL,
        engine_id TEXT NOT NULL, station_id TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT,
        UNIQUE(tenant,application,engine_id));`);
  }
  close() { this.db.close(); }

  grant({tenant, application, subject, role}) {
    if (![tenant, application, subject].every(valid) || !GRANTABLE_ROLES.includes(role)) throw new GrantError('INVALID_GRANT');
    this.db.prepare(`INSERT INTO role_grants(tenant,application,subject,role,granted_at) VALUES(?,?,?,?,?)
      ON CONFLICT DO NOTHING`).run(tenant, application, subject, role, new Date().toISOString());
    return {subject, role, granted: true};
  }
  revoke({tenant, application, subject, role}) {
    if (![tenant, application, subject].every(valid) || !GRANTABLE_ROLES.includes(role)) throw new GrantError('INVALID_GRANT');
    const {changes} = this.db.prepare('DELETE FROM role_grants WHERE tenant=? AND application=? AND subject=? AND role=?')
      .run(tenant, application, subject, role);
    return {subject, role, revoked: changes > 0};
  }
  roles({tenant, application, subject}) {
    if (![tenant, application, subject].every(valid)) return [];
    return this.db.prepare('SELECT role FROM role_grants WHERE tenant=? AND application=? AND subject=? ORDER BY role')
      .all(tenant, application, subject).map(row => row.role);
  }

  /** Returns the bearer secret once. Only its digest is stored. */
  issueEngineCredential({tenant, application, engineId, stationId}) {
    if (![tenant, application, engineId].every(valid) || typeof stationId !== 'string' || !SLUG.test(stationId))
      throw new GrantError('INVALID_ENGINE_CREDENTIAL');
    const token = ENGINE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    try {
      this.db.prepare(`INSERT INTO engine_credentials(digest,tenant,application,engine_id,station_id,created_at)
        VALUES(?,?,?,?,?,?)`).run(digest(token), tenant, application, engineId, stationId, new Date().toISOString());
    } catch (error) {
      if (/UNIQUE constraint/.test(error.message)) throw new GrantError('ENGINE_EXISTS', 409);
      throw error;
    }
    return {engineId, stationId, token};
  }
  revokeEngineCredential({tenant, application, engineId}) {
    if (![tenant, application, engineId].every(valid)) throw new GrantError('INVALID_ENGINE_CREDENTIAL');
    const {changes} = this.db.prepare(`UPDATE engine_credentials SET revoked_at=? WHERE tenant=? AND application=?
      AND engine_id=? AND revoked_at IS NULL`).run(new Date().toISOString(), tenant, application, engineId);
    return {engineId, revoked: changes > 0};
  }
  engineStation({tenant, application, engineId}) {
    if (![tenant, application, engineId].every(valid)) return null;
    return this.db.prepare(`SELECT station_id FROM engine_credentials WHERE tenant=? AND application=?
      AND engine_id=? AND revoked_at IS NULL`).get(tenant, application, engineId)?.station_id ?? null;
  }
  engineForToken(token) {
    if (typeof token !== 'string' || !token.startsWith(ENGINE_TOKEN_PREFIX) || token.length > 200) return null;
    const expected = digest(token);
    const row = this.db.prepare(`SELECT digest,tenant,application,engine_id,station_id FROM engine_credentials
      WHERE digest=? AND revoked_at IS NULL`).get(expected);
    if (!row || !timingSafeEqual(Buffer.from(row.digest, 'hex'), Buffer.from(expected, 'hex'))) return null;
    return {tenant: row.tenant, application: row.application, engineId: row.engine_id, stationId: row.station_id};
  }
}
