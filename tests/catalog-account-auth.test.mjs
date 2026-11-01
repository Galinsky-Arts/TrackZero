import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StationCatalog, createStationCatalogHandler} from '../src/station-catalog.mjs';
import {createCatalogPublisherAuthenticator} from '../src/catalog-account-auth.mjs';

const principal = {tenant: 'tenant-a', application: 'trackzero', subject: 'provider:alice'};
const station = {id: 'station-01', name: 'Station One', description: 'Public station', offers: []};
const post = body => new Request('https://app.example.test/v1/stations',
  {method: 'POST', headers: {origin: 'https://app.example.test'}, body: JSON.stringify(body)});

test('provider role claims cannot publish without a matching local artist grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tz03-role-'));
  const catalog = new StationCatalog(join(dir, 'catalog.sqlite'), {verifyOfferRights: async () => true});
  try {
    let account = null;
    const authenticate = createCatalogPublisherAuthenticator(
      async () => ({...principal, roles: ['artist', 'admin']}), async () => account);
    const handle = createStationCatalogHandler(catalog, authenticate);
    assert.equal((await handle(post(station))).status, 403);
    account = {...principal, roles: ['listener']};
    assert.equal((await handle(post(station))).status, 403);
    account = {...principal, tenant: 'tenant-b', roles: ['artist']};
    assert.equal((await handle(post(station))).status, 403);
    account = {...principal, roles: ['artist']};
    assert.equal((await handle(post(station))).status, 200);
    assert.equal(catalog.get({...principal, id: station.id}).name, station.name);
  } finally {catalog.close(); rmSync(dir, {recursive: true, force: true});}
});

test('malformed provider identity is denied before account lookup', async () => {
  let lookups = 0;
  const authenticate = createCatalogPublisherAuthenticator(
    async () => ({...principal, tenant: '../other', roles: ['artist']}),
    async () => {lookups++; return {...principal, roles: ['artist']};});
  await assert.rejects(authenticate(post(station)), {code: 'UNAUTHENTICATED', status: 401});
  assert.equal(lookups, 0);
});
