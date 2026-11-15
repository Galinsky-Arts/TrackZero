// Real-browser test of the composed app: account sign-up, invitation, operator
// station claim, station publication, program sequencing (keyboard and drag),
// guest page, discovery and endpoint-gated listener features, with axe checks
// at phone width. Needs PostgreSQL (TZ_TEST_DATABASE_URL) and Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseUrl, startApp, operator} from './helpers/app-fixture.mjs';

let chromium = null, AxeBuilder = null;
try {
  ({chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core'));
  ({default: AxeBuilder} = await import('@axe-core/playwright'));
} catch {}
const skip = (!databaseUrl && 'Set TZ_TEST_DATABASE_URL') || (!chromium && 'playwright-core not installed');

export async function creatorJourney(page, origin, {operatorCall, email = `artist-${Date.now()}@example.com`, stationId = `station-${Date.now().toString(36)}`, axe} = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`); });
  await page.goto(origin + '/#/account');
  await page.getByRole('button', {name: 'Create a new account'}).click();
  await page.getByLabel('Display name').fill('Test Artist');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-strong-password-1');
  await page.getByRole('button', {name: 'Create account'}).click();
  const reference = (await page.locator('#account-reference').textContent()).trim();
  assert.match(reference, /^[A-Za-z0-9]{8,}$/);
  await axe?.('account');
  await page.getByRole('button', {name: 'Join as listener'}).click();
  await page.getByRole('button', {name: 'Listener role active'}).waitFor();

  const invitation = await operatorCall('/operator/v1/invitations', {role: 'artist'});
  await page.getByLabel('Invitation code').fill(invitation.invitation);
  await page.getByRole('button', {name: 'Redeem invitation'}).click();
  await page.locator('#account-roles', {hasText: 'artist'}).waitFor();
  await operatorCall('/operator/v1/station-claims', {stationId, ownerSubject: reference});

  await page.goto(origin + '/#/studio');
  await page.reload();
  await page.getByRole('heading', {name: 'Creator studio'}).waitFor();
  await page.getByLabel('Station name').fill('Browser Test Radio');
  await page.getByLabel('Description').fill('Published from a real browser.');
  await page.getByRole('button', {name: 'Publish station'}).click();
  await page.getByText('Published Browser Test Radio').waitFor();

  for (const id of ['top-of-hour', 'news-break', 'night-block']) {
    await page.getByLabel('Item ID', {exact: true}).fill(id);
    await page.getByLabel('Item kind').selectOption('block');
    await page.getByRole('button', {name: 'Add item'}).click();
    await page.locator('.program li', {hasText: id}).waitFor();
  }
  await page.getByRole('button', {name: 'Move block news-break up'}).click();
  await page.getByText('Moved block news-break to position 1 of 3.').waitFor();
  await page.locator('.program li', {hasText: 'night-block'}).dragTo(page.locator('.program li', {hasText: 'news-break'}));
  await page.getByRole('button', {name: 'Save sequence'}).click();
  await page.getByText('Sequence saved.').waitFor();
  const order = await page.locator('.program li span').allTextContents();
  assert.deepEqual(order, ['block night-block', 'block news-break', 'block top-of-hour']);
  await axe?.('studio');

  await page.goto(`${origin}/stations/${stationId}`);
  await page.getByRole('heading', {name: 'Browser Test Radio'}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Play live station'}).isDisabled(), true);
  await page.getByText(/Live playback unavailable/).waitFor();
  await axe?.('guest station');

  await page.goto(origin + '/#/discover');
  await page.getByRole('link', {name: 'Open Browser Test Radio'}).waitFor();

  await page.goto(origin + '/#/listen');
  await page.getByRole('heading', {name: 'Listener features'}).waitFor();
  await page.getByRole('button', {name: 'Try album checkout'}).click();
  await page.getByText(/Requires an enrolled endpoint\. This operation exchanges endpoint-encrypted payloads/).first().waitFor();
  const payments = await page.locator('#payments-state').textContent();
  await axe?.('listen');

  await page.goto(origin + '/#/account');
  await page.getByRole('button', {name: 'Sign out'}).click();
  await page.getByRole('heading', {name: 'Sign in'}).waitFor();
  return {reference, stationId, payments, errors};
}

test('creator and listener journeys work in Chromium at phone width with no axe violations', {skip}, async t => {
  const {origin, stop} = await startApp();
  t.after(stop);
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {});
  t.after(() => browser.close());
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url()).origin));
  const axe = async label => {
    const result = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(result.violations.map(v => `${label}: ${v.id} ${v.nodes.map(n => n.target).join(' ')}`), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label} overflows`);
  };
  const result = await creatorJourney(page, origin, {axe,
    operatorCall: async (path, body) => { const response = await operator(origin, path, body); assert.equal(response.status, 200); return response.data; }});
  assert.match(result.payments, /Payments not configured/);
  assert.deepEqual(result.errors.filter(message => !/status of 503/.test(message)), []);
  assert.deepEqual([...new Set(requests)], [origin], 'no third-party requests');
});
