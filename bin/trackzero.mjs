import {readConfig} from '../src/platform/config.mjs';
import {createTrackZeroApp} from '../src/platform/app.mjs';

let config;
try { config = readConfig(); }
catch (error) {
  // Configuration messages name settings, never their values.
  console.error(`TrackZero configuration error: ${error.message}`);
  process.exit(1);
}
const app = await createTrackZeroApp(config);
if (process.argv.includes('--migrate')) {
  if (!app.accounts) { console.error('Account migrations apply only to TZ_IDENTITY=builtin'); await app.close(); process.exit(1); }
  await app.accounts.migrate();
  console.log('Account schema migrated');
  await app.close();
} else {
  if (app.accounts && process.env.TZ_MIGRATE_ON_START === 'true') await app.accounts.migrate();
  app.server.listen(config.port, '0.0.0.0', () => console.log(`TrackZero listening on port ${config.port} (${config.publicOrigin})`));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => { app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); });
}
