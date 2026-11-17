// PostgreSQL-backed durability for TrackZero's application stores.
//
// The stores (stations, rights, programs, grants, onboarding, ...) keep their
// synchronous SQLite query engine and their transactional checks unchanged.
// In TZ_STORAGE_DURABILITY=postgres mode the SQLite files under TZ_DATA_DIR are
// only a working copy:
//
//  * boot: the instance takes a new ownership epoch for this deployment and, in
//    the same PostgreSQL transaction, reads the latest committed snapshot of
//    every store, then rebuilds the working files from them (SHA-256 checked);
//  * every request: committed SQLite changes are detected per store (PRAGMA
//    data_version on a separate observer connection), captured as a consistent
//    copy (VACUUM INTO) and written to PostgreSQL in one transaction BEFORE the
//    response leaves the server. A failed write answers 503, never a silent
//    acknowledgement;
//  * an instance whose epoch was superseded (for example the old instance
//    during a zero-downtime deploy) can no longer write: its flush is refused
//    and it reports not ready, so two instances never overwrite each other.
//
// Stored bytes are exactly the private business storage the SQLite files hold:
// endpoint-sealed privacy records stay ciphertext, and no endpoint keys or
// protected media exist in these stores. Nothing here logs row values.
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes} from 'node:crypto';
import {chmodSync, existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export const STORE_NAMES = Object.freeze(['catalog.sqlite', 'grants.sqlite', 'interstitials.sqlite', 'onboarding.sqlite',
  'operations.sqlite', 'privacy.sqlite', 'programs.sqlite', 'rights.sqlite', 'sponsors.sqlite']);
const SIDE_FILES = ['', '-wal', '-shm', '-journal'];
const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_STORE_BYTES = 64 * 1024 * 1024;

export class StoreDurabilityError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function migrateStoreTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS trackzero_store_epoch(
      deployment TEXT PRIMARY KEY,
      epoch BIGINT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS trackzero_store_snapshot(
      deployment TEXT NOT NULL,
      name TEXT NOT NULL,
      generation BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      written_epoch BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (deployment, name));`);
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  finally { client.release(); }
}

/**
 * Create the durability layer for one deployment (tenant/application scope).
 * Call restore() before opening stores, attach() after, and flush() after each
 * request (the composed app does both).
 */
export function createPostgresStoreDurability({pool, dataDir, deployment, now = () => Date.now()}) {
  if (!pool || typeof pool.connect !== 'function') throw new StoreDurabilityError('STORE_POOL_REQUIRED');
  if (!DEPLOYMENT.test(deployment ?? '')) throw new StoreDurabilityError('INVALID_DEPLOYMENT');
  let epoch = null, superseded = false, lastError = null, lastFlushAt = null, restored = 0;
  const observers = new Map(); // name -> {db, version, sha}
  const remote = new Map();    // name -> sha256 last known in PostgreSQL
  let queue = Promise.resolve();

  async function restore() {
    await migrateStoreTables(pool);
    let claimedEpoch = null;
    const rows = await transaction(pool, async client => {
      const claimed = await client.query(`INSERT INTO trackzero_store_epoch(deployment, epoch) VALUES ($1, 1)
        ON CONFLICT (deployment) DO UPDATE SET epoch = trackzero_store_epoch.epoch + 1, claimed_at = now()
        RETURNING epoch`, [deployment]);
      claimedEpoch = String(claimed.rows[0].epoch);
      return (await client.query(`SELECT name, sha256, bytes FROM trackzero_store_snapshot WHERE deployment=$1`,
        [deployment])).rows;
    });
    const known = rows.filter(row => STORE_NAMES.includes(row.name));
    for (const row of known) if (sha256(row.bytes) !== row.sha256) throw new StoreDurabilityError('STORE_SNAPSHOT_DIGEST_MISMATCH');
    // PostgreSQL is authoritative once it holds any snapshot for this deployment.
    // On the very first boot, existing local files (for example from a former
    // persistent disk) are kept and become the first snapshots.
    if (known.length) {
      for (const name of STORE_NAMES) for (const suffix of SIDE_FILES) rmSync(join(dataDir, name + suffix), {force: true});
      for (const row of known) {
        const path = join(dataDir, row.name);
        writeFileSync(path, row.bytes, {mode: 0o600});
        chmodSync(path, 0o600);
        remote.set(row.name, row.sha256);
      }
    }
    // Only a fully verified and rebuilt restore makes this instance writable.
    restored = known.length;
    epoch = claimedEpoch;
    return {epoch, restored};
  }

  function attach() {
    for (const name of STORE_NAMES) {
      const path = join(dataDir, name);
      if (observers.has(name) || !existsSync(path)) continue;
      const db = new DatabaseSync(path);
      db.exec('PRAGMA busy_timeout=5000');
      observers.set(name, {db, version: null, sha: remote.get(name) ?? null});
    }
  }

  function capture(name, observer) {
    const version = observer.db.prepare('PRAGMA data_version').get().data_version;
    if (observer.version === version) return null;
    const temp = join(dataDir, `.snapshot-${randomBytes(8).toString('hex')}.sqlite`);
    try {
      observer.db.prepare('VACUUM INTO ?').run(temp);
      const bytes = readFileSync(temp);
      if (bytes.length > MAX_STORE_BYTES) throw new StoreDurabilityError('STORE_TOO_LARGE');
      return {name, version, bytes, sha: sha256(bytes)};
    } finally { rmSync(temp, {force: true}); }
  }

  async function flushNow() {
    if (epoch === null) throw new StoreDurabilityError('STORE_NOT_RESTORED');
    attach();
    const changed = [];
    for (const [name, observer] of observers) {
      const snapshot = capture(name, observer);
      if (!snapshot) continue;
      if (snapshot.sha === observer.sha) { observer.version = snapshot.version; continue; }
      changed.push(snapshot);
    }
    if (!changed.length) return 0;
    // A superseded instance may still answer reads but can never write.
    if (superseded) throw new StoreDurabilityError('STORE_SUPERSEDED');
    await transaction(pool, async client => {
      const owner = await client.query('SELECT epoch FROM trackzero_store_epoch WHERE deployment=$1 FOR UPDATE', [deployment]);
      if (String(owner.rows[0]?.epoch) !== epoch) { superseded = true; throw new StoreDurabilityError('STORE_SUPERSEDED'); }
      for (const snapshot of changed)
        await client.query(`INSERT INTO trackzero_store_snapshot(deployment, name, generation, sha256, bytes, written_epoch)
          VALUES ($1, $2, 1, $3, $4, $5)
          ON CONFLICT (deployment, name) DO UPDATE SET generation = trackzero_store_snapshot.generation + 1,
            sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, written_epoch = EXCLUDED.written_epoch, updated_at = now()`,
          [deployment, snapshot.name, snapshot.sha, snapshot.bytes, epoch]);
    });
    for (const snapshot of changed) {
      const observer = observers.get(snapshot.name);
      observer.version = snapshot.version; observer.sha = snapshot.sha;
      remote.set(snapshot.name, snapshot.sha);
    }
    return changed.length;
  }

  /** Persist every committed local change; serialized so snapshots never race. */
  function flush() {
    const run = queue.then(flushNow);
    queue = run.then(() => { lastError = null; lastFlushAt = now(); }, error => { lastError = error?.code ?? 'STORE_WRITE_FAILED'; });
    return run;
  }

  return {
    backend: 'postgres', restore, attach, flush,
    status() {
      return {backend: 'postgres', epoch, superseded, restoredStores: restored, trackedStores: observers.size,
        lastError, lastFlushAt: lastFlushAt === null ? null : new Date(lastFlushAt).toISOString()};
    },
    healthy() { return epoch !== null && !superseded && lastError === null; },
    async close() {
      try { await flush(); } catch {}
      for (const {db} of observers.values()) { try { db.close(); } catch {} }
      observers.clear();
    }
  };
}
