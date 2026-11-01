import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StationCatalog, createStationCatalogHandler} from '../src/station-catalog.mjs';

const artist = {tenant: 'tenant-a', application: 'trackzero', subject: 'provider:artist', roles: ['artist']};
const other = {...artist, subject: 'provider:other'};
const listener = {...artist, subject: 'provider:listener', roles: ['listener']};
const station = {id: 'station-01', name: 'Station One', description: 'Public station description',
  offers: [{id: 'album-001', title: 'Full album', type: 'complete_product', available: true}]};
function fixture(rights = async () => true) {
  const dir = mkdtempSync(join(tmpdir(), 'tz03-')), file = join(dir, 'catalog.sqlite');
  const options = {verifyOfferRights: rights, artworkOrigins: ['https://assets.example.test']};
  const catalog = new StationCatalog(file, options);
  catalog.provisionStationClaim({...artist, id: station.id, ownerSubject: artist.subject});
  return {catalog, file, options, cleanup() {this.catalog.close(); rmSync(dir, {recursive: true, force: true});}};
}

test('publisher stores public metadata atomically and it survives restart', async () => {
  const f = fixture();
  try {
    const created = await f.catalog.publish(artist, station);
    assert.equal(created.name, station.name);
    assert.equal(created.offers[0].type, 'complete_product');
    f.catalog.close(); f.catalog = new StationCatalog(f.file, f.options);
    assert.equal(f.catalog.get({...artist, id: station.id}).offers[0].title, 'Full album');
    assert.equal(f.catalog.get({...artist, tenant: 'tenant-b', id: station.id}), null);
    assert.equal(f.catalog.get({...artist, application: 'other', id: station.id}), null);
  } finally {f.cleanup();}
});

test('catalog setup refuses an untrusted artwork policy or absent rights verifier', () => {
  for (const artworkOrigins of [['http://assets.example.test'], ['https://assets.example.test/extra'],
    ["https://assets.example.test' evil"]]) {
    assert.throws(() => new StationCatalog(':memory:', {verifyOfferRights: async () => true, artworkOrigins}));
  }
  assert.throws(() => new StationCatalog(':memory:', {artworkOrigins: []}));
});

test('listener, other owner, missing rights and hostile offers cannot publish', async () => {
  const f = fixture(async (_actor, record) => !record.offers.some(offer => offer.id === 'album-denied'));
  try {
    await assert.rejects(f.catalog.publish(listener, station), /PUBLISHER_ROLE_REQUIRED/);
    await assert.rejects(f.catalog.publish(artist, {...station, offers:[{...station.offers[0],id:'album-denied'}]}), /RIGHTS_NOT_VERIFIED/);
    assert.equal(f.catalog.get({...artist, id:station.id}), null);
    await f.catalog.publish(artist, station);
    await assert.rejects(f.catalog.publish(other, {...station,name:'Takeover'}), /STATION_CLAIM_REQUIRED/);
    assert.equal(f.catalog.get({...artist,id:station.id}).name, station.name);
    await assert.rejects(f.catalog.publish(artist, {...station, offers:[{...station.offers[0],type:'track'}]}), /INVALID_PUBLIC_METADATA/);
  } finally {f.cleanup();}
});

test('first publication needs an operator claim and claim cannot be transferred', async () => {
  let rightsCalls = 0;
  const f = fixture(async () => {rightsCalls++; return true;});
  try {
    const unclaimed = {...station, id: 'unclaimed-station'};
    await assert.rejects(f.catalog.publish(artist, unclaimed), /STATION_CLAIM_REQUIRED/);
    assert.equal(rightsCalls, 0, 'unclaimed station cannot invoke the rights verifier');
    assert.equal(f.catalog.get({...artist, id: unclaimed.id}), null);
    assert.throws(() => f.catalog.provisionStationClaim({...artist,
      id: station.id, ownerSubject: other.subject}));
    assert.throws(() => f.catalog.provisionStationClaim({...artist,
      id: '../invalid', ownerSubject: artist.subject}), /INVALID_STATION_CLAIM/);
    assert.equal((await f.catalog.publish(artist, station)).id, station.id);
  } finally {f.cleanup();}
});

test('an interrupted offer write rolls back the old published catalog', async () => {
  const f = fixture();
  try {
    await f.catalog.publish(artist, station);
    f.catalog.db.exec(`CREATE TRIGGER reject_offer BEFORE INSERT ON station_offers
      BEGIN SELECT RAISE(ABORT, 'injected interruption'); END`);
    await assert.rejects(f.catalog.publish(artist, {...station,name:'Changed'}), /injected interruption/);
    assert.equal(f.catalog.get({...artist,id:station.id}).name, 'Station One');
    assert.equal(f.catalog.get({...artist,id:station.id}).offers.length, 1);
    f.catalog.db.exec('DROP TRIGGER reject_offer');
    assert.equal((await f.catalog.publish(artist, {...station,name:'Changed'})).name, 'Changed');
  } finally {f.cleanup();}
});

test('HTTP publishing rejects client identity claims, cross-origin requests and unauthenticated roles', async () => {
  const f = fixture();
  try {
    const handle = createStationCatalogHandler(f.catalog, async request =>
      request.headers.get('x-fixture-auth') === 'artist' ? artist : listener);
    const request = (body, headers = {}) => new Request('https://app.example.test/v1/stations',
      {method:'POST', headers:{origin:'https://app.example.test','x-fixture-auth':'artist',...headers},body:JSON.stringify(body)});
    assert.equal((await handle(request(station,{origin:'https://other.test'}))).status,403);
    assert.equal((await handle(request({...station, owner:other.subject}))).status,403);
    assert.equal((await handle(request(station,{'x-fixture-auth':'listener'}))).status,403);
    assert.equal((await handle(request(station))).status,200);
    const publicRead = await handle(new Request('https://app.example.test/v1/stations/station-01?tenant=tenant-a&application=trackzero'));
    assert.equal(publicRead.status,200);
    assert.match(publicRead.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await publicRead.text(), /Station One/);
  } finally {f.cleanup();}
});
