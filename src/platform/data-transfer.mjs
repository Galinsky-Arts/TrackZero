// Export and import TrackZero's application SQLite stores (stations, rights,
// programs, grants, ...). Accounts live in PostgreSQL and are not part of this.
//
// Run only while the server is stopped: each file is copied with SQLite's
// online backup API (consistent per file), but the set of files is not one
// atomic snapshot while writers are active.
//
// The export directory holds the same private business storage as the data
// directory (privacy.sqlite keeps its endpoint-sealed ciphertext as-is). It is
// created owner-only (0700/0600); never publish it. Manifests carry file names,
// SHA-256 digests and table row counts only, never row values.
import {DatabaseSync, backup} from 'node:sqlite';
import {createHash, randomBytes} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

export const STORE_FILES = Object.freeze(['catalog.sqlite', 'grants.sqlite', 'interstitials.sqlite', 'onboarding.sqlite',
  'operations.sqlite', 'privacy.sqlite', 'programs.sqlite', 'rights.sqlite', 'sponsors.sqlite']);
export const FORMAT = 'trackzero-sqlite-export';
const MANIFEST = 'manifest.json';

export class DataTransferError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new DataTransferError(code); };
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const identifier = name => '"' + name.replaceAll('"', '""') + '"';

function absoluteDirectory(path, code) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(code);
  return path;
}

/** Integrity check plus per-table row counts of a closed SQLite file (read-only). */
export function inspectStore(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const check = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]);
    if (check.length !== 1 || check[0] !== 'ok') fail('STORE_INTEGRITY_FAILED');
    const tables = {};
    for (const {name} of db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all())
      tables[name] = Number(db.prepare(`SELECT count(*) AS n FROM ${identifier(name)}`).get().n);
    return tables;
  } finally { db.close(); }
}

/** Copy every present store into a new owner-only directory with a manifest. */
export async function exportStores({dataDir, outDir, now = () => new Date(), source = {}}) {
  absoluteDirectory(dataDir, 'DATA_DIR_MUST_BE_ABSOLUTE'); absoluteDirectory(outDir, 'EXPORT_DIR_MUST_BE_ABSOLUTE');
  if (existsSync(outDir) && readdirSync(outDir).length) fail('EXPORT_DIR_NOT_EMPTY');
  mkdirSync(outDir, {recursive: true, mode: 0o700}); chmodSync(outDir, 0o700);
  const files = [];
  for (const name of STORE_FILES) {
    const from = join(dataDir, name);
    if (!existsSync(from)) continue;
    const to = join(outDir, name);
    const db = new DatabaseSync(from, {readOnly: true});
    try { await backup(db, to); } finally { db.close(); }
    chmodSync(to, 0o600);
    files.push({name, bytes: statSync(to).size, sha256: sha256(to), tables: inspectStore(to)});
  }
  if (!files.length) fail('NO_STORES_FOUND');
  const manifest = {format: FORMAT, version: 1, createdAt: now().toISOString(), source, files};
  writeFileSync(join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
  return manifest;
}

/** Verify an export without touching any data directory. */
export function verifyExport(exportDir) {
  absoluteDirectory(exportDir, 'EXPORT_DIR_MUST_BE_ABSOLUTE');
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(exportDir, MANIFEST), 'utf8')); } catch { fail('MANIFEST_UNREADABLE'); }
  if (manifest?.format !== FORMAT || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) fail('MANIFEST_INVALID');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!STORE_FILES.includes(file?.name) || seen.has(file.name) || !/^[0-9a-f]{64}$/.test(file.sha256 ?? '')) fail('MANIFEST_INVALID');
    seen.add(file.name);
    const path = join(exportDir, file.name);
    if (!existsSync(path) || sha256(path) !== file.sha256) fail('EXPORT_DIGEST_MISMATCH');
    const tables = inspectStore(path);
    if (JSON.stringify(tables) !== JSON.stringify(file.tables)) fail('EXPORT_ROW_COUNT_MISMATCH');
  }
  const extra = readdirSync(exportDir).filter(name => name !== MANIFEST && !seen.has(name));
  if (extra.length) fail('EXPORT_UNEXPECTED_FILES');
  return manifest;
}

/** Restore a verified export. Refuses to overwrite existing stores unless
 * `replace` is set; replaced files (with -wal/-shm) move to a timestamped
 * owner-only directory first, never deleted. Each file is written to a
 * temporary name and renamed into place. */
export function importStores({exportDir, dataDir, replace = false, now = () => new Date()}) {
  const manifest = verifyExport(exportDir);
  absoluteDirectory(dataDir, 'DATA_DIR_MUST_BE_ABSOLUTE');
  mkdirSync(dataDir, {recursive: true, mode: 0o700}); chmodSync(dataDir, 0o700);
  const present = manifest.files.flatMap(({name}) => [name, name + '-wal', name + '-shm']).filter(name => existsSync(join(dataDir, name)));
  if (present.length && !replace) fail('DATA_DIR_HAS_STORES');
  let preserved = null;
  if (present.length) {
    preserved = join(dataDir, 'pre-import-' + now().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(preserved, {mode: 0o700});
    for (const name of present) renameSync(join(dataDir, name), join(preserved, name));
  }
  const restored = [];
  try {
    for (const file of manifest.files) {
      const target = join(dataDir, file.name), temporary = target + '.import-' + randomBytes(6).toString('hex');
      try {
        copyFileSync(join(exportDir, file.name), temporary); chmodSync(temporary, 0o600);
        if (sha256(temporary) !== file.sha256) fail('IMPORT_COPY_MISMATCH');
        renameSync(temporary, target);
      } finally { rmSync(temporary, {force: true}); }
      restored.push(file.name);
    }
  } catch (error) {
    // Roll back to the exact pre-import file set.
    for (const name of restored) rmSync(join(dataDir, name), {force: true});
    if (preserved) for (const name of present) renameSync(join(preserved, name), join(dataDir, name));
    if (preserved) rmSync(preserved, {recursive: true, force: true});
    throw error;
  }
  return {restored, preserved};
}
