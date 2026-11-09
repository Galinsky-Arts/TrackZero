import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StationCatalog} from '../src/station-catalog.mjs';
import {createStationNodeHandler} from '../src/station-server.mjs';

test('Node station endpoint enforces claims and origin, serves inert public HTML', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tz03-http-'));
  let rightsCalls = 0, authCalls = 0;
  const catalog = new StationCatalog(join(dir, 'catalog.sqlite'), {
    artworkOrigins: ['https://assets.example.test'],
    verifyOfferRights: async () => {rightsCalls++; return true;}
  });
  const publisher = {tenant: 'tenant-a', application: 'trackzero',
    subject: 'provider:artist', roles: ['artist']};
  const handler = createStationNodeHandler({catalog, publicOrigin: 'https://app.example.test',
    authenticate: async () => {authCalls++; return publisher;}});
  const server = createServer(handler);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    const payload = {id: 'station-01', name: 'Station One', description: 'Public details',
      offers: [{id: 'album-001', title: 'Full album', type: 'complete_product', available: true}]};
    const post = (body, origin = 'https://app.example.test') => fetch(root + '/v1/stations',
      {method: 'POST', headers: {origin}, body});
    assert.equal((await post(JSON.stringify(payload))).status, 403);
    assert.equal(rightsCalls, 0);
    catalog.provisionStationClaim({...publisher, id: payload.id, ownerSubject: publisher.subject});
    assert.equal((await post(JSON.stringify(payload), 'https://evil.test')).status, 403);
    assert.equal((await post(JSON.stringify(payload))).status, 200);
    assert.equal(rightsCalls, 1);
    const page = await fetch(root + '/v1/stations/station-01?tenant=tenant-a&application=trackzero');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await page.text(), /Station One/);
    const before = authCalls;
    assert.equal((await post('x'.repeat(9000))).status, 413);
    assert.equal(authCalls, before);
  } finally {
    await new Promise(resolve => server.close(resolve));
    catalog.close(); rmSync(dir, {recursive: true, force: true});
  }
});
