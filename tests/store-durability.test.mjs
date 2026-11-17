import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {readConfig} from '../src/platform/config.mjs';
import {createTrackZeroApp} from '../src/platform/app.mjs';
import {createPostgresStoreDurability} from '../src/platform/store-durability.mjs';

const databaseUrl = process.env.TZ_TEST_DATABASE_URL;
const skip = !databaseUrl && 'Set TZ_TEST_DATABASE_URL to a disposable PostgreSQL database';
const ORIGIN = 'https://tz.test';
const OPERATOR = 'operator-token-for-tests-0123456789abcdef';
const env = dataDir => ({TZ_PUBLIC_ORIGIN: ORIGIN, TZ_DATA_DIR: dataDir, TZ_STORAGE_DURABILITY: 'postgres',
  DATABASE_URL: databaseUrl, TZ_IDENTITY: 'external', TZ_INTROSPECTION_ENDPOINT: 'https://idp.test/introspect',
  TZ_ISSUER: 'https://idp.test', TZ_CLIENT_ID: 'trackzero', TZ_CLIENT_SECRET: 'client-secret', TZ_OPERATOR_TOKEN: OPERATOR});
const fetchImpl = async (_url, init) => {
  const token = new URLSearchParams(init.body.toString()).get('token');
  return Response.json({active: true, iss: 'https://idp.test', aud: 'trackzero', sub: token.slice(2), tenant: 'trackzero',
    exp: Math.floor(Date.now() / 1000) + 600});
};

async function fresh(pool) {
  await pool.query('DROP TABLE IF EXISTS trackzero_store_snapshot, trackzero_store_epoch');
}
async function start(t, pool, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tz-durable-'));
  const app = await createTrackZeroApp(readConfig(env(join(dir, 'data'))), {fetchImpl, storePool: pool, ...extra});
  let closed = false;
  const stop = async () => { if (!closed) { closed = true; await app.close(); rmSync(dir, {recursive: true, force: true}); } };
  t.after(stop);
  const call = async (path, {method = 'GET', body, as, operator} = {}) => {
    const headers = {};
    if (as) headers.authorization = `Bearer t-${as}`;
    if (operator) headers.authorization = `Bearer ${OPERATOR}`;
    else if (method !== 'GET') headers.origin = ORIGIN;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.handle(new Request(ORIGIN + path, {method, headers,
      body: body === undefined ? undefined : JSON.stringify(body)}));
    const text = await response.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return {status: response.status, data};
  };
  return {app, call, stop, dir};
}

test('application stores survive a restart with an empty data directory', {skip}, async t => {
  const pool = new pg.Pool({connectionString: databaseUrl});
  t.after(() => pool.end());
  await fresh(pool);
  const first = await start(t, pool);
  assert.equal((await first.call('/v1/onboarding', {method: 'POST', as: 'alice', body: {role: 'listener'}})).status, 201);
  const grant = await first.call('/operator/v1/grants', {method: 'POST', operator: true, body: {subject: 'alice', role: 'rights_reviewer'}});
  assert.equal(grant.status, 200, JSON.stringify(grant.data));
  const ready = await first.call('/readyz');
  assert.equal(ready.data.storage.durability, 'postgres');
  assert.equal(ready.data.checks.storage, 'ok');
  assert.equal(ready.data.storage.persistence.superseded, false);
  const {rows} = await pool.query('SELECT name, generation FROM trackzero_store_snapshot ORDER BY name');
  assert.ok(rows.some(row => row.name === 'grants.sqlite' && Number(row.generation) >= 2));
  assert.ok(rows.some(row => row.name === 'onboarding.sqlite'));
  await first.stop();
  assert.equal(existsSync(first.dir), false);

  const second = await start(t, pool);
  const context = await second.call('/api/context', {as: 'alice'});
  assert.equal(context.status, 200);
  assert.equal(context.data.onboarded, true);
  assert.ok(context.data.roles.includes('rights_reviewer'));
  assert.ok(context.data.roles.includes('listener'));
  assert.equal((await second.call('/readyz')).data.storage.persistence.restoredStores >= 2, true);
});

test('a superseded instance keeps serving reads but can never write', {skip}, async t => {
  const pool = new pg.Pool({connectionString: databaseUrl});
  t.after(() => pool.end());
  await fresh(pool);
  const old = await start(t, pool);
  assert.equal((await old.call('/v1/onboarding', {method: 'POST', as: 'bob', body: {role: 'listener'}})).status, 201);
  const replacement = await start(t, pool);
  assert.equal((await old.call('/api/context', {as: 'bob'})).status, 200);
  const denied = await old.call('/v1/onboarding', {method: 'POST', as: 'carol', body: {role: 'listener'}});
  assert.equal(denied.status, 503);
  assert.equal(denied.data.error, 'STORAGE_SUPERSEDED');
  assert.equal((await old.call('/readyz')).data.checks.storage, 'unavailable');
  assert.equal((await replacement.call('/v1/onboarding', {method: 'POST', as: 'dave', body: {role: 'listener'}})).status, 201);
  await old.stop(); await replacement.stop();
  const third = await start(t, pool);
  assert.equal((await third.call('/api/context', {as: 'dave'})).data.onboarded, true);
  assert.equal((await third.call('/api/context', {as: 'carol'})).data.onboarded, false);
});

test('a failed PostgreSQL write is reported as 503, never acknowledged', {skip}, async t => {
  const pool = new pg.Pool({connectionString: databaseUrl});
  t.after(() => pool.end());
  await fresh(pool);
  let broken = false;
  const flaky = {connect: async () => { if (broken) throw new Error('down'); return pool.connect(); },
    query: (...args) => pool.query(...args)};
  const app = await start(t, pool, {storePool: flaky});
  broken = true;
  const response = await app.call('/v1/onboarding', {method: 'POST', as: 'erin', body: {role: 'listener'}});
  assert.equal(response.status, 503);
  assert.equal(response.data.error, 'STORAGE_NOT_DURABLE');
  assert.equal((await app.call('/readyz')).data.status, 'not_ready');
  broken = false;
  assert.equal((await app.call('/readyz')).data.checks.storage, 'ok');
});

test('a tampered snapshot stops startup', {skip}, async t => {
  const pool = new pg.Pool({connectionString: databaseUrl});
  t.after(() => pool.end());
  await fresh(pool);
  const first = await start(t, pool);
  await first.stop();
  await pool.query(`UPDATE trackzero_store_snapshot SET bytes = bytes || '\\x00'::bytea WHERE name='grants.sqlite'`);
  const dir = mkdtempSync(join(tmpdir(), 'tz-durable-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const durability = createPostgresStoreDurability({pool, dataDir: dir, deployment: 'trackzero/trackzero'});
  await assert.rejects(durability.restore(), /STORE_SNAPSHOT_DIGEST_MISMATCH/);
  assert.throws(() => createPostgresStoreDurability({pool, dataDir: dir, deployment: 'bad deployment'}), /INVALID_DEPLOYMENT/);
});
