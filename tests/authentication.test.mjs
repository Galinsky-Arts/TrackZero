import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIntrospectionAuthenticator} from '../src/authentication.mjs';
import {OnboardingStore, createOnboardingHandler} from '../src/onboarding.mjs';

const claims = () => ({active: true, iss: 'https://id.example.test/', aud: 'trackzero-api',
  exp: Math.floor(Date.now() / 1000) + 60, sub: 'provider:alice', tenant: 'tenant-a',
  role: 'admin'});
const request = header => new Request('https://app.example.test/v1/me',
  {headers: header === undefined ? {} : {authorization: header}});
function adapter(fetchImpl) {
  return createIntrospectionAuthenticator({endpoint: 'https://id.example.test/introspect',
    issuer: 'https://id.example.test/', audience: 'trackzero-api', application: 'trackzero',
    authorize: () => ({authorization: 'Basic fixture'}), fetchImpl});
}
const response = value => new Response(JSON.stringify(value),
  {status: 200, headers: {'content-type': 'application/json'}});

test('introspection derives only verified provider scope and does not adopt provider roles', async () => {
  let calls = 0;
  const auth = adapter(async (url, options) => {
    calls++;
    assert.equal(url, 'https://id.example.test/introspect');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.get('authorization'), 'Basic fixture');
    assert.equal(options.body.get('token'), calls === 1 ? 'opaque.token' : 'padded.token==');
    return response(claims());
  });
  assert.deepEqual(await auth(request('Bearer opaque.token')),
    {tenant: 'tenant-a', application: 'trackzero', subject: 'provider:alice'});
  assert.deepEqual(await auth(request('Bearer padded.token==')),
    {tenant: 'tenant-a', application: 'trackzero', subject: 'provider:alice'});
  assert.equal(calls, 2);
});

test('missing and malformed bearer tokens never reach provider', async () => {
  const auth = adapter(() => {throw new Error('provider called');});
  for (const header of [undefined, 'Basic token', 'Bearer ', 'Bearer two tokens', 'Bearer a,b']) {
    await assert.rejects(auth(request(header)), {code: 'UNAUTHENTICATED', status: 401});
  }
});

test('inactive, expired, wrong audience, issuer and malformed scope fail closed', async () => {
  const invalid = [{active: false}, {exp: 0}, {aud: 'other'}, {iss: 'https://evil.test/'},
    {tenant: '../other'}, {sub: ''}];
  for (const patch of invalid) {
    const auth = adapter(() => response({...claims(), ...patch}));
    await assert.rejects(auth(request('Bearer token')), {code: 'UNAUTHENTICATED', status: 401});
  }
});

test('provider errors, redirect, invalid response and failed client auth are unavailable', async () => {
  for (const impl of [() => {throw new Error('offline');},
    () => new Response(null, {status: 302, headers: {location: 'https://evil.test/'}}),
    () => new Response('invalid json')]) {
    await assert.rejects(adapter(impl)(request('Bearer token')),
      {code: 'AUTH_PROVIDER_UNAVAILABLE', status: 503});
  }
  const auth = createIntrospectionAuthenticator({endpoint: 'https://id.example.test/introspect',
    issuer: 'https://id.example.test/', audience: 'trackzero-api', application: 'trackzero',
    authorize: () => {throw new Error('secret unavailable');}, fetchImpl: () => response(claims())});
  await assert.rejects(auth(request('Bearer token')),
    {code: 'AUTH_PROVIDER_UNAVAILABLE', status: 503});
});

test('introspection endpoint must be HTTPS and cannot embed credentials', () => {
  for (const endpoint of ['http://id.example.test/introspect', 'https://user:pass@id.example.test/']) {
    assert.throws(() => createIntrospectionAuthenticator({endpoint, issuer: 'issuer',
      audience: 'aud', application: 'trackzero', authorize: () => ({})}));
  }
});

test('HTTP onboarding binds accounts to introspected identity across tenants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tz02-provider-'));
  const store = new OnboardingStore(join(dir, 'accounts.sqlite'));
  try {
    const auth = adapter(async (_url, options) => response({...claims(),
      tenant: options.body.get('token') === 'tenant-b-token' ? 'tenant-b' : 'tenant-a'}));
    const handle = createOnboardingHandler(store, auth);
    const post = (token, body) => new Request('https://app.example.test/v1/onboarding',
      {method: 'POST', headers: {origin: 'https://app.example.test', authorization: `Bearer ${token}`},
        body: JSON.stringify(body)});
    const first = await handle(post('tenant-a-token', {role: 'listener'}));
    assert.equal(first.status, 201);
    const accountA = await first.json();
    assert.equal(accountA.tenant, 'tenant-a');
    assert.equal((await handle(post('tenant-b-token',
      {role: 'artist', tenant: 'tenant-a', subject: accountA.subject}))).status, 403);
    const second = await handle(post('tenant-b-token', {role: 'listener'}));
    assert.equal(second.status, 201);
    assert.notEqual((await second.json()).id, accountA.id);
    assert.equal((await handle(post('tenant-a-token', {role: 'artist'}))).status, 403);
    assert.equal((await handle(post('invalid,token', {role: 'listener'}))).status, 401);
  } finally {store.close(); rmSync(dir, {recursive: true, force: true});}
});
