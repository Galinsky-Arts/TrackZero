import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {exportStores, importStores, verifyExport} from '../src/platform/data-transfer.mjs';
import {GrantStore} from '../src/platform/grants.mjs';
import {OnboardingStore} from '../src/onboarding.mjs';

const scope = {tenant: 'trackzero', application: 'trackzero'};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tz-transfer-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const dataDir = join(root, 'data'), outDir = join(root, 'export'), restoreDir = join(root, 'restore');
  return {root, dataDir, outDir, restoreDir};
}
async function seed(dataDir) {
  mkdirSync(dataDir, {recursive: true});
  {
    const grants = new GrantStore(join(dataDir, 'grants.sqlite'));
    grants.grant({...scope, subject: 'user-1', role: 'moderator'});
    grants.grant({...scope, subject: 'user-2', role: 'sponsor'});
    grants.close();
    const onboarding = new OnboardingStore(join(dataDir, 'onboarding.sqlite'));
    onboarding.close?.();
  }
}

test('export -> verify -> import restores identical store bytes and row counts, owner-only', async t => {
  const f = fixture(t); await seed(f.dataDir);
  const manifest = await exportStores({dataDir: f.dataDir, outDir: f.outDir, now: () => new Date('2026-11-15T00:00:00Z')});
  assert.deepEqual(manifest.files.map(file => file.name), ['grants.sqlite', 'onboarding.sqlite']);
  assert.equal(manifest.files[0].tables.role_grants, 2);
  assert.equal(statSync(f.outDir).mode & 0o777, 0o700);
  for (const name of readdirSync(f.outDir)) assert.equal(statSync(join(f.outDir, name)).mode & 0o777, 0o600, name);
  assert.doesNotMatch(readFileSync(join(f.outDir, 'manifest.json'), 'utf8'), /user-1|moderator/, 'manifest has counts, not values');
  verifyExport(f.outDir);
  const result = importStores({exportDir: f.outDir, dataDir: f.restoreDir});
  assert.deepEqual(result, {restored: ['grants.sqlite', 'onboarding.sqlite'], preserved: null});
  const grants = new GrantStore(join(f.restoreDir, 'grants.sqlite'));
  try { assert.equal(grants.db.prepare('SELECT count(*) AS n FROM role_grants').get().n, 2); } finally { grants.close(); }
  assert.equal(statSync(join(f.restoreDir, 'grants.sqlite')).mode & 0o777, 0o600);
});

test('tampered, extra or mismatched exports are rejected before any write', async t => {
  const f = fixture(t); await seed(f.dataDir);
  await exportStores({dataDir: f.dataDir, outDir: f.outDir});
  await assert.rejects(exportStores({dataDir: f.dataDir, outDir: f.outDir}), /EXPORT_DIR_NOT_EMPTY/);
  writeFileSync(join(f.outDir, 'notes.txt'), 'x');
  assert.throws(() => verifyExport(f.outDir), /EXPORT_UNEXPECTED_FILES/);
  rmSync(join(f.outDir, 'notes.txt'));
  const db = new DatabaseSync(join(f.outDir, 'grants.sqlite'));
  db.exec(`DELETE FROM role_grants WHERE subject='user-2'`); db.close();
  assert.throws(() => importStores({exportDir: f.outDir, dataDir: f.restoreDir}), /EXPORT_DIGEST_MISMATCH/);
  assert.equal(existsSync(join(f.restoreDir, 'grants.sqlite')), false);
  assert.throws(() => verifyExport('relative/path'), /EXPORT_DIR_MUST_BE_ABSOLUTE/);
});

test('import never overwrites silently; --replace preserves previous stores', async t => {
  const f = fixture(t); await seed(f.dataDir);
  await exportStores({dataDir: f.dataDir, outDir: f.outDir});
  assert.throws(() => importStores({exportDir: f.outDir, dataDir: f.dataDir}), /DATA_DIR_HAS_STORES/);
  const before = readFileSync(join(f.dataDir, 'grants.sqlite'));
  const result = importStores({exportDir: f.outDir, dataDir: f.dataDir, replace: true, now: () => new Date('2026-11-15T01:02:03Z')});
  assert.match(result.preserved, /pre-import-2026-11-15T01-02-03-000Z$/);
  assert.deepEqual(readFileSync(join(result.preserved, 'grants.sqlite')), before);
  assert.equal(statSync(result.preserved).mode & 0o777, 0o700);
});

test('CLI prints counts and digests only and fails closed with a code', async t => {
  const f = fixture(t); await seed(f.dataDir);
  const env = {...process.env, TZ_DATA_DIR: f.dataDir};
  const out = spawnSync(process.execPath, ['bin/data-transfer.mjs', 'export', f.outDir], {env, encoding: 'utf8'});
  assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /grants\.sqlite sha256=[0-9a-f]{16}… rows=\{"engine_credentials":0,"role_grants":2\}/);
  assert.doesNotMatch(out.stdout, /user-1/);
  const bad = spawnSync(process.execPath, ['bin/data-transfer.mjs', 'import', f.outDir], {env, encoding: 'utf8'});
  assert.equal(bad.status, 1); assert.match(bad.stderr, /DATA_DIR_HAS_STORES/);
});
