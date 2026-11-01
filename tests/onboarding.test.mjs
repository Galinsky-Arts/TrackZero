import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OnboardingStore, createOnboardingHandler} from '../src/onboarding.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tz02-'));
  const file = join(dir, 'accounts.sqlite');
  const store = new OnboardingStore(file);
  return {store, file, cleanup() {this.store.close(); rmSync(dir, {recursive: true, force: true});}};
}
const alice = {tenant: 'tenant-a', application: 'trackzero', subject: 'provider:alice'};
const bob = {...alice, subject: 'provider:bob'};

test('listener onboarding is scoped, durable and idempotent after restart', () => {
  const f = fixture();
  try {
    const first = f.store.onboard(alice, 'listener');
    assert.equal(first.replay, false);
    assert.deepEqual(first.roles, ['listener']);
    assert.equal(f.store.onboard(alice, 'listener').id, first.id);
    f.store.close();
    f.store = new OnboardingStore(f.file);
    assert.equal(f.store.account(alice).id, first.id);
    assert.equal(f.store.account({...alice, tenant: 'tenant-b'}), null);
    assert.equal(f.store.account({...alice, application: 'other-app'}), null);
    assert.equal(f.store.account(bob), null);
  } finally {f.cleanup();}
});

test('artist and label roles require distinct scoped one-time invitations', () => {
  const f = fixture();
  try {
    const artistToken = f.store.provisionInvitation({...alice, role: 'artist', expiresAt: Date.now() + 60_000});
    const labelToken = f.store.provisionInvitation({...alice, role: 'label', expiresAt: Date.now() + 60_000});
    assert.match(artistToken, /^[a-f0-9]{64}$/);
    assert.notEqual(artistToken, labelToken);
    assert.equal(f.store.db.prepare('SELECT digest FROM invitations WHERE role=?').get('artist').digest === artistToken, false);
    assert.throws(() => f.store.onboard(bob, 'artist'), /INVITATION_REQUIRED/);
    assert.throws(() => f.store.onboard({...alice, tenant: 'tenant-b'}, 'artist', artistToken), /INVITATION_DENIED/);
    assert.equal(f.store.account({...alice, tenant: 'tenant-b'}), null, 'failed invitation rolls back account creation');
    assert.throws(() => f.store.onboard(alice, 'label', artistToken), /INVITATION_DENIED/);
    const artist = f.store.onboard(alice, 'artist', artistToken);
    assert.deepEqual(artist.roles, ['artist']);
    assert.throws(() => f.store.onboard(bob, 'artist', artistToken), /INVITATION_DENIED/);
    assert.deepEqual(f.store.onboard(alice, 'label', labelToken).roles, ['artist', 'label']);
    assert.equal(f.store.onboard(alice, 'artist').replay, true);
  } finally {f.cleanup();}
});

test('expired invitation and malformed identity fail closed without partial records', () => {
  const f = fixture();
  try {
    const token = f.store.provisionInvitation({...alice, role: 'artist', expiresAt: Date.now() + 30_000});
    f.store.db.prepare('UPDATE invitations SET expires_at=? WHERE digest IS NOT NULL').run(Date.now() - 1);
    assert.throws(() => f.store.onboard(alice, 'artist', token), /INVITATION_DENIED/);
    assert.equal(f.store.account(alice), null);
    assert.throws(() => f.store.onboard({...alice, subject: '../other'}, 'listener'), /INVALID_SUBJECT/);
    assert.equal(f.store.account(bob), null);
  } finally {f.cleanup();}
});

test('interrupted role write rolls back the account and can be retried', () => {
  const f = fixture();
  try {
    f.store.db.exec(`CREATE TRIGGER reject_role BEFORE INSERT ON account_roles
      BEGIN SELECT RAISE(ABORT, 'injected interruption'); END`);
    assert.throws(() => f.store.onboard(alice, 'listener'), /injected interruption/);
    assert.equal(f.store.account(alice), null);
    f.store.db.exec('DROP TRIGGER reject_role');
    assert.deepEqual(f.store.onboard(alice, 'listener').roles, ['listener']);
  } finally {f.cleanup();}
});

test('HTTP boundary accepts only authenticated provider identity and same-origin writes', async () => {
  const f = fixture();
  try {
    const handle = createOnboardingHandler(f.store, async request => request.headers.get('x-fixture-auth') === 'alice' ? alice : null);
    const request = (method, path, body, headers = {}) => new Request('https://app.example.test' + path,
      {method, headers: {'origin': 'https://app.example.test', 'x-fixture-auth': 'alice', ...headers},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    assert.equal((await handle(request('POST', '/v1/onboarding', {role: 'listener'}, {'x-fixture-auth': 'none'}))).status, 401);
    assert.equal((await handle(request('POST', '/v1/onboarding', {role: 'listener'}, {origin: 'https://other.test'}))).status, 403);
    assert.equal((await handle(request('POST', '/v1/onboarding', {role: 'listener', subject: bob.subject}))).status, 403);
    assert.equal((await handle(request('POST', '/v1/onboarding', {role: 'artist'}))).status, 403);
    const created = await handle(request('POST', '/v1/onboarding', {role: 'listener'}));
    assert.equal(created.status, 201);
    assert.equal((await created.json()).subject, alice.subject);
    assert.equal((await handle(request('POST', '/v1/onboarding', {role: 'listener'}))).status, 200);
    assert.deepEqual((await (await handle(request('GET', '/v1/me'))).json()).roles, ['listener']);
    assert.equal((await handle(request('GET', '/v1/me', undefined, {'x-fixture-auth': 'none'}))).status, 401);
  } finally {f.cleanup();}
});
