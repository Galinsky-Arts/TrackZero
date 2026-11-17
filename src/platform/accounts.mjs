import {betterAuth} from 'better-auth';
import {getMigrations} from 'better-auth/db/migration';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {passwordResetMessage} from './mail.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const CLIENT_IP_HEADER = 'x-trackzero-client-ip';

export function loopbackOrHttps(value, code) {
  let url;
  try { url = new URL(value); } catch { throw new Error(code); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new Error(code);
  return url;
}
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {status,
  headers: {'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', ...extra}});
const digest = token => createHash('sha256').update(token).digest('hex');
function sameSecret(a, b) {
  const left = createHash('sha256').update(String(a)).digest(), right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right) && String(a).length === String(b).length;
}

/** First-party account service: Better Auth owns passwords, cookies, sessions
 * and rate limits in PostgreSQL. Browsers exchange their HttpOnly session for
 * a short-lived opaque access token (memory only) and resource handlers verify
 * it through RFC 7662 introspection, exactly as with an external IdP.
 * Provider data never grants roles: local TrackZero grants stay authoritative. */
export const RESET_TOKEN_MINUTES = 30;

export function createAccountService({pool, baseURL, secret, tenant, issuer, audience, clients,
  accessTokenTtlSeconds = 600, mailer = null}) {
  const base = loopbackOrHttps(baseURL, 'ACCOUNT_SERVICE_HTTPS_REQUIRED');
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) throw new Error('ACCOUNT_SERVICE_SECRET_REQUIRED');
  if (![tenant, audience].every(value => typeof value === 'string' && ID.test(value)) ||
      typeof issuer !== 'string' || !issuer) throw new Error('ACCOUNT_SERVICE_SCOPE_REQUIRED');
  if (!Array.isArray(clients) || clients.length < 1 || clients.some(client => !ID.test(client?.id ?? '') ||
      typeof client.secret !== 'string' || client.secret.length < 32)) throw new Error('INTROSPECTION_CLIENT_REQUIRED');
  if (!Number.isSafeInteger(accessTokenTtlSeconds) || accessTokenTtlSeconds < 30 || accessTokenTtlSeconds > 3600)
    throw new Error('INVALID_ACCESS_TOKEN_TTL');
  const configuration = {
    appName: 'TrackZero', baseURL: base.origin, secret, database: pool, trustedOrigins: [base.origin],
    emailAndPassword: {enabled: true, minPasswordLength: 10, maxPasswordLength: 128,
      // Password recovery is OFF unless a mailer is configured (RESEND_API_KEY + TZ_MAIL_FROM).
      // Sending is not awaited so response timing does not reveal whether an account exists.
      ...(mailer?.configured ? {
        resetPasswordTokenExpiresIn: RESET_TOKEN_MINUTES * 60, revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({user, token}) => {
          const message = passwordResetMessage({origin: base.origin, token, minutes: RESET_TOKEN_MINUTES});
          mailer.send({to: user.email, ...message}).catch(error =>
            console.error(`TrackZero password-reset email not sent (${String(error?.message ?? 'error').slice(0, 40)})`));
        }} : {})},
    session: {expiresIn: 86400, updateAge: 3600, cookieCache: {enabled: false}},
    rateLimit: {enabled: true, window: 60, max: 60, storage: 'database'},
    advanced: {cookiePrefix: 'trackzero', useSecureCookies: base.protocol === 'https:',
      ipAddress: {ipAddressHeaders: [CLIENT_IP_HEADER]}},
    logger: {level: 'error'}, telemetry: {enabled: false}
  };
  let instance;
  const auth = () => instance ??= betterAuth(configuration);

  async function currentSession(request) {
    const value = await auth().api.getSession({headers: request.headers});
    if (!value || new Date(value.session.expiresAt).getTime() <= Date.now() || !ID.test(value.user.id)) return null;
    return value;
  }

  async function mint(request) {
    if (request.headers.get('origin') !== base.origin) return json(403, {error: 'origin_denied'});
    const current = await currentSession(request);
    if (!current) return json(401, {error: 'sign_in_required'});
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(Date.now() + accessTokenTtlSeconds * 1000,
      new Date(current.session.expiresAt).getTime()));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM trackzero_access_token WHERE session_id=$1 AND expires_at<=now()', [current.session.id]);
      // Bound live tokens per session; the oldest are dropped first.
      await client.query(`DELETE FROM trackzero_access_token WHERE digest IN (SELECT digest FROM trackzero_access_token
        WHERE session_id=$1 ORDER BY created_at DESC OFFSET 9)`, [current.session.id]);
      await client.query('INSERT INTO trackzero_access_token(digest,user_id,session_id,expires_at) VALUES($1,$2,$3,$4)',
        [digest(token), current.user.id, current.session.id, expiresAt]);
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
    return json(200, {access_token: token, token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000))});
  }

  async function introspect(request) {
    const header = request.headers.get('authorization') ?? '';
    const match = /^Basic ([A-Za-z0-9+/=]{1,1024})$/.exec(header);
    let caller = null;
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8'), split = decoded.indexOf(':');
      const id = decodeURIComponent(decoded.slice(0, split)), provided = decodeURIComponent(decoded.slice(split + 1));
      if (split > 0) for (const client of clients)
        if (sameSecret(client.id, id) && sameSecret(client.secret, provided)) caller = client;
    }
    if (!caller) return json(401, {error: 'invalid_client'}, {'www-authenticate': 'Basic realm="trackzero-introspection"'});
    if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded'))
      return json(400, {error: 'invalid_request'});
    const text = await request.text();
    if (text.length > 4096) return json(400, {error: 'invalid_request'});
    const token = new URLSearchParams(text).get('token');
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return json(200, {active: false});
    const found = await pool.query(`SELECT t.user_id, t.expires_at, t.created_at FROM trackzero_access_token t
      JOIN "session" s ON s.id=t.session_id WHERE t.digest=$1 AND t.expires_at>now() AND s."expiresAt">now()`, [digest(token)]);
    const row = found.rows[0];
    if (!row || !ID.test(row.user_id)) return json(200, {active: false});
    return json(200, {active: true, iss: issuer, aud: audience, sub: row.user_id, tenant, client_id: caller.id,
      token_type: 'Bearer', exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
      iat: Math.floor(new Date(row.created_at).getTime() / 1000)});
  }

  async function handle(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/auth/')) {
        // The emailed link targets the web UI (#/reset/<token>); the server-side
        // redirect endpoint would place the token in a query string, so it is closed.
        if (url.pathname.startsWith('/api/auth/reset-password/')) return json(404, {error: 'not_found'});
        if (!mailer?.configured && url.pathname === '/api/auth/request-password-reset')
          return json(503, {error: 'password_recovery_not_configured', needs: 'RESEND_API_KEY and TZ_MAIL_FROM'});
        return await auth().handler(request);
      }
      if (url.pathname === '/api/account/token' && request.method === 'POST') return await mint(request);
      if (url.pathname === '/api/account/session' && request.method === 'GET') {
        const current = await currentSession(request);
        return current ? json(200, {signedIn: true, userId: current.user.id, email: current.user.email, name: current.user.name})
          : json(200, {signedIn: false});
      }
      if (url.pathname === '/oauth2/introspect' && request.method === 'POST') return await introspect(request);
      return null;
    } catch {
      return json(503, {error: 'account_service_unavailable'});
    }
  }

  return {
    handle, introspect, passwordRecovery: Boolean(mailer?.configured),
    get auth() { return auth(); },
    async ping() { await pool.query('SELECT 1 FROM "user","session",trackzero_access_token LIMIT 0'); },
    async migrate() {
      const migration = await getMigrations(configuration);
      if (migration.unsafeChanges?.length || migration.schemaProblems?.length) throw Error('ACCOUNT_SCHEMA_REVIEW_REQUIRED');
      await migration.runMigrations();
      await pool.query(`CREATE TABLE IF NOT EXISTS trackzero_access_token(
        digest TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES "session"(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
        CREATE INDEX IF NOT EXISTS trackzero_access_token_session ON trackzero_access_token(session_id, created_at);`);
    }
  };
}
