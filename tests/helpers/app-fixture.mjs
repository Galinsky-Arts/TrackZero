// Boots the composed TrackZero app against a disposable PostgreSQL database.
// TZ_TEST_DATABASE_URL must name a database used only for tests: its public
// schema is dropped and recreated.
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {readConfig} from '../../src/platform/config.mjs';
import {createTrackZeroApp} from '../../src/platform/app.mjs';

export const databaseUrl = process.env.TZ_TEST_DATABASE_URL;
export const OPERATOR_TOKEN = 'operator-token-for-tests-0123456789abcdef';

export async function startApp({env = {}, options = {}} = {}) {
  const admin = new pg.Client({connectionString: databaseUrl});
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  const dir = mkdtempSync(join(tmpdir(), 'tz-app-'));
  // Bind first to learn the port, then configure the matching loopback origin.
  const probe = (await import('node:net')).createServer();
  const port = await new Promise(resolve => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)));
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const config = readConfig({TZ_PUBLIC_ORIGIN: origin, PORT: String(port), TZ_DATA_DIR: join(dir, 'data'),
    TZ_STORAGE_DURABILITY: 'ephemeral', DATABASE_URL: databaseUrl, BETTER_AUTH_SECRET: 'test-secret-'.padEnd(48, 'x'),
    TZ_INTROSPECTION_CLIENT_SECRET: 'introspection-secret-'.padEnd(48, 'y'), TZ_OPERATOR_TOKEN: OPERATOR_TOKEN, ...env});
  const app = await createTrackZeroApp(config, options);
  await app.accounts.migrate();
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  return {app, origin, config, async stop() { await app.close(); rmSync(dir, {recursive: true, force: true}); }};
}

/** Minimal cookie-keeping HTTP client for account flows. */
export function client(origin) {
  const jar = new Map();
  let bearer = null;
  async function call(path, {method = 'GET', body, headers = {}, auth = true, sameOrigin = true} = {}) {
    const merged = {...headers};
    if (sameOrigin && method !== 'GET') merged.origin = origin;
    if (body !== undefined) merged['content-type'] = 'application/json';
    if (jar.size) merged.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (auth && bearer) merged.authorization = `Bearer ${bearer}`;
    const response = await fetch(origin + path, {method, headers: merged, redirect: 'manual',
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return {status: response.status, data, text, headers: response.headers};
  }
  return {
    call, jar,
    async signUp(email, name = 'Test User') {
      const result = await call('/api/auth/sign-up/email', {method: 'POST', auth: false, body: {email, name, password: 'a-strong-password-1'}});
      if (result.status !== 200) throw new Error(`sign-up failed ${result.status} ${result.text}`);
      return this.refreshToken();
    },
    async refreshToken() {
      const result = await call('/api/account/token', {method: 'POST', auth: false});
      bearer = result.data?.access_token ?? null;
      return result;
    },
    get bearer() { return bearer; }, set bearer(value) { bearer = value; }
  };
}

export async function operator(origin, path, body) {
  const response = await fetch(origin + path, {method: 'POST', headers: {authorization: `Bearer ${OPERATOR_TOKEN}`,
    'content-type': 'application/json'}, body: JSON.stringify(body)});
  return {status: response.status, data: await response.json()};
}
