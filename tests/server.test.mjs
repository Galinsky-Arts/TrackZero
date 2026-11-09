import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OnboardingStore} from '../src/onboarding.mjs';
import {createIntrospectionAuthenticator} from '../src/authentication.mjs';
import {createOnboardingNodeHandler} from '../src/server.mjs';

test('Node boundary serves scoped accounts and caps input before authentication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tz02-http-'));
  const store = new OnboardingStore(join(dir, 'accounts.sqlite'));
  let introspections = 0;
  const authenticate = createIntrospectionAuthenticator({
    endpoint: 'https://id.example.test/introspect', issuer: 'https://id.example.test/',
    audience: 'trackzero-api', application: 'trackzero', authorize: () => ({authorization: 'Basic fixture'}),
    fetchImpl: () => {
      introspections++;
      return new Response(JSON.stringify({active: true, iss: 'https://id.example.test/',
        aud: 'trackzero-api', exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'provider:alice', tenant: 'tenant-a'}));
    }
  });
  const nodeHandler = createOnboardingNodeHandler({store, authenticate,
    publicOrigin: 'https://app.example.test'});
  const server = createServer(nodeHandler);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1/onboarding`;
    const headers = {origin: 'https://app.example.test', authorization: 'Bearer opaque-token'};
    const created = await fetch(url, {method: 'POST', headers, body: JSON.stringify({role: 'listener'})});
    assert.equal(created.status, 201);
    assert.equal((await created.json()).subject, 'provider:alice');
    assert.equal((await fetch(url, {method: 'POST', headers,
      body: JSON.stringify({role: 'artist'})})).status, 403);
    assert.equal((await fetch(url, {method: 'POST', headers: {...headers, origin: 'https://evil.test'},
      body: JSON.stringify({role: 'listener'})})).status, 403);
    const before = introspections;
    assert.equal((await fetch(url, {method: 'POST', headers, body: 'x'.repeat(5000)})).status, 413);
    assert.equal(introspections, before);
    assert.equal((await fetch(url, {method: 'POST', headers: {origin: 'https://app.example.test'},
      body: JSON.stringify({role: 'listener'})})).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
