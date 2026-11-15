// Runs every node:test suite against the pinned engine packages installed from
// dependency-pins.json, unless explicit module paths are supplied.
import {spawnSync} from 'node:child_process';
import {readdirSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..');
const env = {...process.env};
env.AUDIO_ENGINE_MODULE ??= resolve(root, 'node_modules/@neophilism/distributed-audio-engine/dist/src/index.js');
env.DRE_PLAYBACK_MODULE ??= resolve(root, 'node_modules/@neophilism/distributed-radio-engine/src/radio-playback.mjs');
for (const key of ['AUDIO_ENGINE_MODULE', 'DRE_PLAYBACK_MODULE'])
  if (!existsSync(env[key])) throw new Error(`${key} not found; run npm run deps:prepare && npm ci`);
// CI sets TZ_REQUIRE_FULL_SUITE so PostgreSQL/Chromium suites cannot silently skip.
if (process.env.TZ_REQUIRE_FULL_SUITE === '1' && !env.TZ_TEST_DATABASE_URL)
  throw new Error('TZ_TEST_DATABASE_URL required for the full suite');
const files = ['registry/pr-contract.test.mjs', ...readdirSync(resolve(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`)];
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files],
  {cwd: root, env, stdio: 'inherit'});
process.exit(result.status ?? 1);
