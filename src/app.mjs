import {createServer} from 'node:http';
import {isAbsolute} from 'node:path';
import {OnboardingStore} from './onboarding.mjs';
import {createIntrospectionAuthenticator} from './authentication.mjs';
import {createOnboardingNodeHandler} from './server.mjs';

/** Construct the deployable HTTP application. The process or hosting platform
 * owns TLS, the persistent volume, secret injection and server.listen().
 * A missing setting aborts startup; no development identity fallback exists.
 */
export function createOnboardingApp(config, {fetchImpl = fetch} = {}) {
  const required = ['databasePath', 'publicOrigin', 'introspectionEndpoint', 'issuer',
    'audience', 'application', 'clientId', 'clientSecret'];
  if (!config || required.some(key => typeof config[key] !== 'string' || !config[key])) {
    throw new Error('Onboarding configuration required');
  }
  if (!isAbsolute(config.databasePath) || config.databasePath === ':memory:') {
    throw new Error('Absolute durable database path required');
  }
  const authorize = () => ({authorization:
    `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`});
  const authenticate = createIntrospectionAuthenticator({endpoint: config.introspectionEndpoint,
    issuer: config.issuer, audience: config.audience, application: config.application,
    authorize, fetchImpl});
  // Validate public origin before opening the database file.
  const validatedOrigin = new URL(config.publicOrigin);
  if (validatedOrigin.protocol !== 'https:' || validatedOrigin.username ||
      validatedOrigin.password || validatedOrigin.pathname !== '/' ||
      validatedOrigin.search || validatedOrigin.hash) throw new Error('HTTPS public origin required');
  const store = new OnboardingStore(config.databasePath);
  try {
    const server = createServer(createOnboardingNodeHandler({store, authenticate,
      publicOrigin: config.publicOrigin}));
    return {server, store, close: async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    }};
  } catch (error) {
    store.close();
    throw error;
  }
}
