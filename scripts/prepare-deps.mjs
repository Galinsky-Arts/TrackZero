// Fetch the exact pinned engine commits, build them and pack reproducible
// archives that package.json consumes as file: dependencies. Run before npm ci.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, mkdir, rename, rm, chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const pins = JSON.parse(await readFile(resolve(root, 'dependency-pins.json'), 'utf8'));
const repositories = {audio: 'Galinsky-Arts/Distributed-Audio-Engine', radio: 'Galinsky-Arts/Distributed-Radio-Engine'};
await mkdir(resolve(root, '.deps'), {recursive: true});
for (const [name, pin] of Object.entries(pins)) {
  if (pin.repository !== repositories[name] || !/^[0-9a-f]{40}$/.test(pin.commit) ||
      !/^\.deps\/[a-z-]+\.tgz$/.test(pin.archive)) throw new Error('INVALID_DEPENDENCY_PIN');
  // Optional local mirror (an existing clone) for offline development. The
  // fetched commit is still verified against the pin below.
  const mirror = process.env[`TZ_${name.toUpperCase()}_SOURCE`];
  const remote = mirror ? resolve(mirror) : `https://github.com/${pin.repository}.git`;
  const source = resolve(root, '.build', name);
  await rm(source, {recursive: true, force: true});
  await mkdir(source, {recursive: true});
  await run('git', ['init', '-q', source]);
  await run('git', ['-C', source, 'fetch', '-q', '--depth=1', remote, pin.commit]);
  await run('git', ['-C', source, 'checkout', '-q', '--detach', 'FETCH_HEAD']);
  const {stdout: revision} = await run('git', ['-C', source, 'rev-parse', 'HEAD']);
  if (revision.trim() !== pin.commit) throw new Error('DEPENDENCY_PIN_MISMATCH');
  if (pin.build) {
    // Engine builds need their devDependencies (tsc, @types) even when NODE_ENV=production.
    await run('npm', ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'], {cwd: source});
    await run('npm', ['run', 'build'], {cwd: source});
  }
  // Normalize file modes so a restrictive umask and a hosted runner pack identical bytes.
  const {stdout: listing} = await run('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], {cwd: source});
  for (const file of JSON.parse(listing)[0].files)
    await chmod(resolve(source, file.path), file.mode & 0o111 ? 0o755 : 0o644);
  const {stdout} = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', resolve(root, '.deps')], {cwd: source});
  const [packed] = JSON.parse(stdout);
  await rename(resolve(root, '.deps', packed.filename), resolve(root, pin.archive));
  console.log(`Prepared ${pin.package} ${pin.commit}`);
}
