import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseUrl, startApp, client, operator} from './helpers/app-fixture.mjs';

const skip = !databaseUrl && 'Set TZ_TEST_DATABASE_URL to a disposable PostgreSQL database';

test('Better Auth accounts issue opaque tokens verified by RFC 7662 introspection', {skip}, async t => {
  const {origin, stop} = await startApp();
  t.after(stop);
  const health = await fetch(origin + '/readyz');
  assert.equal((await health.json()).checks.accounts, 'ok');

  const ann = client(origin);
  assert.equal((await ann.call('/api/account/session')).data.signedIn, false);
  assert.equal((await ann.call('/api/account/token', {method: 'POST', auth: false})).status, 401);
  await ann.signUp('ann@example.com', 'Ann');
  assert.match(ann.bearer, /^[A-Za-z0-9_-]{43}$/);
  const session = await ann.call('/api/account/session');
  assert.equal(session.data.email, 'ann@example.com');
  // Session cookie is HttpOnly and token minting requires the exact origin.
  assert.ok([...ann.jar.keys()].some(name => name.startsWith('trackzero')));
  assert.equal((await ann.call('/api/account/token', {method: 'POST', auth: false, headers: {origin: 'https://evil.test'}, sameOrigin: false})).status, 403);

  assert.equal((await ann.call('/v1/onboarding', {method: 'POST', body: {role: 'listener'}})).status, 201);
  const context = await ann.call('/api/context');
  assert.equal(context.data.subject, session.data.userId);
  assert.deepEqual(context.data.roles, ['listener']);

  // Introspection: confidential client required; unknown tokens inactive.
  const form = token => new URLSearchParams({token}).toString();
  const noClient = await fetch(origin + '/oauth2/introspect', {method: 'POST', body: form(ann.bearer), headers: {'content-type': 'application/x-www-form-urlencoded'}});
  assert.equal(noClient.status, 401);
  const wrong = await fetch(origin + '/oauth2/introspect', {method: 'POST', body: form(ann.bearer), headers: {'content-type': 'application/x-www-form-urlencoded',
    authorization: 'Basic ' + Buffer.from('trackzero-resource-server:wrong').toString('base64')}});
  assert.equal(wrong.status, 401);
  const basic = 'Basic ' + Buffer.from('trackzero-resource-server:' + 'introspection-secret-'.padEnd(48, 'y')).toString('base64');
  const active = await (await fetch(origin + '/oauth2/introspect', {method: 'POST', body: form(ann.bearer),
    headers: {'content-type': 'application/x-www-form-urlencoded', authorization: basic}})).json();
  assert.equal(active.active, true);
  assert.equal(active.sub, session.data.userId);
  assert.equal(active.tenant, 'trackzero');
  assert.equal(active.iss, origin);
  assert.ok(active.exp - Math.floor(Date.now() / 1000) <= 600);
  const unknown = await (await fetch(origin + '/oauth2/introspect', {method: 'POST', body: form('x'.repeat(43)),
    headers: {'content-type': 'application/x-www-form-urlencoded', authorization: basic}})).json();
  assert.deepEqual(unknown, {active: false});

  // Provider data never grants roles; invitations and operator grants do.
  const bob = client(origin);
  await bob.signUp('bob@example.com', 'Bob');
  assert.equal((await bob.call('/v1/onboarding', {method: 'POST', body: {role: 'artist', invitation: 'f'.repeat(64)}})).data.error, 'INVITATION_DENIED');
  const invite = await operator(origin, '/operator/v1/invitations', {role: 'label'});
  assert.deepEqual((await bob.call('/v1/onboarding', {method: 'POST', body: {role: 'label', invitation: invite.data.invitation}})).data.roles, ['label']);
  // Ann's token cannot act as Bob.
  assert.equal((await ann.call('/v1/me')).data.subject, session.data.userId);

  // Sign-out revokes the session and every token minted from it.
  const before = ann.bearer;
  assert.equal((await ann.call('/api/auth/sign-out', {method: 'POST', body: {}, auth: false})).status, 200);
  ann.bearer = before;
  assert.equal((await ann.call('/v1/me')).status, 401);
  const after = await (await fetch(origin + '/oauth2/introspect', {method: 'POST', body: form(before),
    headers: {'content-type': 'application/x-www-form-urlencoded', authorization: basic}})).json();
  assert.equal(after.active, false);
});

test('composed server ignores Host and client IP headers and bounds bodies', {skip}, async t => {
  const {origin, stop} = await startApp();
  t.after(stop);
  const forged = await fetch(origin + '/healthz', {headers: {host: 'evil.test', 'x-trackzero-client-ip': '1.2.3.4'}});
  assert.equal(forged.status, 200);
  const big = await fetch(origin + '/v1/onboarding', {method: 'POST', body: 'x'.repeat(200_000), headers: {origin}});
  assert.equal(big.status, 413);
  const absolute = await fetch(origin + '/readyz', {method: 'GET'});
  assert.equal(absolute.status, 200);
});

test('password recovery stays off without mail settings and says what to set', {skip}, async t => {
  const {origin, stop} = await startApp();
  t.after(stop);
  const ready = await (await fetch(origin + '/readyz')).json();
  assert.equal(ready.features.passwordRecovery.state, 'not_configured');
  assert.match(ready.features.passwordRecovery.needs, /RESEND_API_KEY and TZ_MAIL_FROM/);
  const ann = client(origin);
  const response = await ann.call('/api/auth/request-password-reset', {method: 'POST', auth: false, body: {email: 'ann@example.com'}});
  assert.equal(response.status, 503);
  assert.equal(response.data.error, 'password_recovery_not_configured');
});

test('emailed password recovery resets the password and revokes every session', {skip}, async t => {
  const sent = [];
  const mailFetch = async (url, init) => {
    sent.push({url, headers: new Headers(init.headers), body: JSON.parse(init.body)});
    return Response.json({id: 'email-test'});
  };
  const {origin, stop} = await startApp({env: {RESEND_API_KEY: 're_test_placeholder', TZ_MAIL_FROM: 'TrackZero <accounts@example.com>'},
    options: {mailFetch}});
  t.after(stop);
  assert.equal((await (await fetch(origin + '/readyz')).json()).features.passwordRecovery.state, 'configured');
  const ann = client(origin);
  await ann.signUp('ann@example.com', 'Ann');
  const oldBearer = ann.bearer;
  // Unknown and known addresses get the same answer; only the known one is mailed.
  const unknown = await client(origin).call('/api/auth/request-password-reset', {method: 'POST', auth: false, body: {email: 'nobody@example.com'}});
  const known = await client(origin).call('/api/auth/request-password-reset', {method: 'POST', auth: false, body: {email: 'ann@example.com'}});
  assert.equal(unknown.status, 200); assert.equal(known.status, 200);
  assert.equal(unknown.data.message, known.data.message);
  for (let i = 0; i < 20 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.resend.com/emails');
  assert.equal(sent[0].headers.get('authorization'), 'Bearer re_test_placeholder');
  assert.deepEqual(sent[0].body.to, ['ann@example.com']);
  const link = /(https?:\/\/\S+#\/reset\/(\S+))/.exec(sent[0].body.text);
  assert.ok(link && link[1].startsWith(origin + '/#/reset/'));
  const token = decodeURIComponent(link[2]);
  // The server-side redirect endpoint (token in a query string) is closed.
  assert.equal((await fetch(`${origin}/api/auth/reset-password/${token}?callbackURL=/`, {redirect: 'manual'})).status, 404);
  const anon = client(origin);
  assert.equal((await anon.call('/api/auth/reset-password', {method: 'POST', auth: false, body: {token, newPassword: 'short'}})).status, 400);
  assert.equal((await anon.call('/api/auth/reset-password', {method: 'POST', auth: false, body: {token, newPassword: 'a-new-strong-password-2'}})).status, 200);
  // Single use, old sessions and access tokens revoked, new password works, old fails.
  assert.equal((await anon.call('/api/auth/reset-password', {method: 'POST', auth: false, body: {token, newPassword: 'another-password-3'}})).status, 400);
  ann.bearer = oldBearer;
  assert.equal((await ann.call('/v1/me')).status, 401);
  assert.equal((await client(origin).call('/api/auth/sign-in/email', {method: 'POST', auth: false, body: {email: 'ann@example.com', password: 'a-strong-password-1'}})).status, 401);
  assert.equal((await client(origin).call('/api/auth/sign-in/email', {method: 'POST', auth: false, body: {email: 'ann@example.com', password: 'a-new-strong-password-2'}})).status, 200);
});
