import {createOnboardingApp} from '../src/app.mjs';

const config = {
  databasePath: process.env.TZ_DATABASE_PATH,
  publicOrigin: process.env.TZ_PUBLIC_ORIGIN,
  introspectionEndpoint: process.env.TZ_INTROSPECTION_ENDPOINT,
  issuer: process.env.TZ_ISSUER,
  audience: process.env.TZ_AUDIENCE,
  application: process.env.TZ_APPLICATION,
  clientId: process.env.TZ_CLIENT_ID,
  clientSecret: process.env.TZ_CLIENT_SECRET
};
const port = Number(process.env.PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('Valid PORT required');
}
const app = createOnboardingApp(config);
app.server.listen(port, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {app.close().then(() => {process.exitCode = 0;}, () => {process.exitCode = 1;});});
}
