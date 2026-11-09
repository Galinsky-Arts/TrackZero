import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOnboardingApp} from '../src/app.mjs';

const settings = path => ({databasePath: path, publicOrigin: 'https://app.example.test',
  introspectionEndpoint: 'https://id.example.test/introspect', issuer: 'https://id.example.test/',
  audience: 'trackzero-api', application: 'trackzero', clientId: 'fixture', clientSecret: 'test-only'});

test('application requires configured provider and absolute durable storage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tz02-app-'));
  try {
    const path = join(dir, 'accounts.sqlite');
    assert.throws(() => createOnboardingApp({...settings(path), clientSecret: ''}), /configuration/);
    assert.throws(() => createOnboardingApp({...settings(path), databasePath: ':memory:'}), /database/);
    assert.throws(() => createOnboardingApp({...settings(path), publicOrigin: 'http://app.example.test'}), /HTTPS/);
    assert.equal(existsSync(path), false);
    let authorization;
    const app = createOnboardingApp(settings(path), {fetchImpl: (_url, options) => {
      authorization = options.headers.get('authorization');
      return new Response(JSON.stringify({active: true, iss: 'https://id.example.test/',
        aud: 'trackzero-api', exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'provider:alice', tenant: 'tenant-a'}));
    }});
    assert.equal(existsSync(path), true);
    try {
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/v1/onboarding`,
        {method: 'POST', headers: {origin: 'https://app.example.test', authorization: 'Bearer opaque'},
          body: JSON.stringify({role: 'listener'})});
      assert.equal(response.status, 201);
      assert.equal(authorization, `Basic ${Buffer.from('fixture:test-only').toString('base64')}`);
    } finally {await app.close();}
  } finally {rmSync(dir, {recursive: true, force: true});}
});
