import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const ROLES = new Set(['listener', 'artist', 'label']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class OnboardingError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function scope(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw new OnboardingError(`INVALID_${field}`);
  return value;
}

function principal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OnboardingError('UNAUTHENTICATED', 401);
  return {
    tenant: scope(value.tenant, 'TENANT'),
    application: scope(value.application, 'APPLICATION'),
    subject: scope(value.subject, 'SUBJECT')
  };
}

function digest(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) throw new OnboardingError('INVITATION_REQUIRED', 403);
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}

function validRole(role) {
  if (!ROLES.has(role)) throw new OnboardingError('INVALID_ROLE');
  return role;
}

/** Stores only provider-issued subject IDs, scope, roles and invitation hashes.
 * A trusted auth adapter must verify the subject before calling these methods.
 * SQLite is the local durable implementation; production topology must provide
 * durable storage and an independently verified provider before exposure.
 */
export class OnboardingStore {
  constructor(filename) {
    if (typeof filename !== 'string' || !filename) throw new Error('Database filename required');
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, application TEXT NOT NULL,
        subject TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(tenant, application, subject)
      );
      CREATE TABLE IF NOT EXISTS account_roles (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('listener','artist','label')),
        PRIMARY KEY(account_id, role)
      );
      CREATE TABLE IF NOT EXISTS invitations (
        digest TEXT PRIMARY KEY, tenant TEXT NOT NULL, application TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('artist','label')),
        expires_at INTEGER NOT NULL, consumed_by TEXT REFERENCES accounts(id)
      );`);
  }

  close() { this.db.close(); }

  /** Provisioning is deliberately separate from the public HTTP handler. */
  provisionInvitation({tenant, application, role, expiresAt}) {
    tenant = scope(tenant, 'TENANT'); application = scope(application, 'APPLICATION');
    if (role !== 'artist' && role !== 'label') throw new OnboardingError('INVALID_INVITATION_ROLE');
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new OnboardingError('INVALID_EXPIRY');
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO invitations(digest,tenant,application,role,expires_at) VALUES(?,?,?,?,?)')
      .run(digest(token), tenant, application, role, expiresAt);
    return token;
  }

  account(verifiedPrincipal) {
    const p = principal(verifiedPrincipal);
    const row = this.db.prepare('SELECT id,created_at FROM accounts WHERE tenant=? AND application=? AND subject=?')
      .get(p.tenant, p.application, p.subject);
    if (!row) return null;
    const roles = this.db.prepare('SELECT role FROM account_roles WHERE account_id=? ORDER BY role').all(row.id).map(r => r.role);
    return {id: row.id, tenant: p.tenant, application: p.application, subject: p.subject,
      roles, createdAt: row.created_at};
  }

  onboard(verifiedPrincipal, role, token) {
    const p = principal(verifiedPrincipal);
    validRole(role);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let account = this.account(p);
      if (account?.roles.includes(role)) {
        this.db.exec('COMMIT');
        return {...account, replay: true};
      }
      const invitationDigest = role === 'listener' ? null : digest(token);
      if (!account) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO accounts(id,tenant,application,subject,created_at) VALUES(?,?,?,?,?)')
          .run(id, p.tenant, p.application, p.subject, new Date().toISOString());
        account = this.account(p);
      }
      if (invitationDigest) {
        const invite = this.db.prepare('SELECT tenant,application,role,expires_at,consumed_by FROM invitations WHERE digest=?')
          .get(invitationDigest);
        if (!invite || invite.tenant !== p.tenant || invite.application !== p.application ||
            invite.role !== role || invite.expires_at <= Date.now() || invite.consumed_by) {
          throw new OnboardingError('INVITATION_DENIED', 403);
        }
        this.db.prepare('UPDATE invitations SET consumed_by=? WHERE digest=? AND consumed_by IS NULL')
          .run(account.id, invitationDigest);
      }
      this.db.prepare('INSERT INTO account_roles(account_id,role) VALUES(?,?)').run(account.id, role);
      this.db.exec('COMMIT');
      return {...this.account(p), replay: false};
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** No body field can assert an identity or scope. authenticate must validate a
 * real provider session and return its server-derived principal. */
export function createOnboardingHandler(store, authenticate) {
  if (!(store instanceof OnboardingStore) || typeof authenticate !== 'function') throw new Error('Authenticated store required');
  return async function handle(request) {
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    const respond = (status, body) => new Response(JSON.stringify(body), {status, headers});
    try {
      const identity = principal(await authenticate(request));
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/me') {
        const account = store.account(identity);
        return account ? respond(200, account) : respond(404, {error: 'ACCOUNT_NOT_FOUND'});
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/onboarding') return respond(404, {error: 'NOT_FOUND'});
      if (request.headers.get('origin') !== url.origin) throw new OnboardingError('ORIGIN_DENIED', 403);
      const text = await request.text();
      if (text.length > 4096) throw new OnboardingError('BODY_TOO_LARGE', 413);
      let body;
      try { body = JSON.parse(text); } catch { throw new OnboardingError('INVALID_JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OnboardingError('INVALID_BODY');
      if ('subject' in body || 'tenant' in body || 'application' in body) throw new OnboardingError('CLIENT_IDENTITY_FORBIDDEN', 403);
      const account = store.onboard(identity, body.role, body.invitation);
      return respond(account.replay ? 200 : 201, account);
    } catch (error) {
      if (error instanceof OnboardingError) return respond(error.status, {error: error.code});
      return respond(503, {error: 'ONBOARDING_UNAVAILABLE'});
    }
  };
}
