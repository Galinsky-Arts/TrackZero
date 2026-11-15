import {isAbsolute} from 'node:path';
import {loopbackOrHttps} from './accounts.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const INTERNAL_CLIENT_ID = 'trackzero-resource-server';

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required setting ${key}`);
  return value.trim();
}
function id(env, key, fallback) {
  const value = env[key]?.trim() || fallback;
  if (!ID.test(value)) throw new Error(`Invalid setting ${key}`);
  return value;
}

/** PostgreSQL over the network must verify certificates; plaintext is loopback only. */
export function databaseOptions(connectionString) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid DATABASE_URL');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const mode = url.searchParams.get('sslmode');
  if (!loopback && !['require', 'verify-ca', 'verify-full'].includes(mode ?? ''))
    throw new Error('DATABASE_URL must require TLS for a remote database');
  for (const key of ['sslmode', 'channel_binding', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  return {connectionString: url.toString(), max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
    ...(loopback && !mode ? {} : {ssl: {rejectUnauthorized: true, servername: url.hostname}})};
}

/** Reads the deployment environment. Missing security settings abort startup;
 * there is no development identity or plaintext fallback. */
export function readConfig(env = process.env) {
  const publicOrigin = loopbackOrHttps(env.TZ_PUBLIC_ORIGIN?.trim() || required(env, 'RENDER_EXTERNAL_URL'),
    'TZ_PUBLIC_ORIGIN must be an HTTPS origin (HTTP only on loopback)').origin;
  const dataDir = required(env, 'TZ_DATA_DIR');
  if (!isAbsolute(dataDir)) throw new Error('TZ_DATA_DIR must be absolute');
  const durability = required(env, 'TZ_STORAGE_DURABILITY');
  if (!['ephemeral', 'persistent'].includes(durability)) throw new Error('TZ_STORAGE_DURABILITY must be ephemeral or persistent');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Valid PORT required');
  const hops = Number(env.TZ_TRUSTED_PROXY_HOPS ?? 0);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 3) throw new Error('Invalid TZ_TRUSTED_PROXY_HOPS');
  const scope = {tenant: id(env, 'TZ_TENANT', 'trackzero'), application: id(env, 'TZ_APPLICATION', 'trackzero')};
  const audience = id(env, 'TZ_AUDIENCE', 'trackzero');
  const mode = env.TZ_IDENTITY?.trim() || 'builtin';
  let identity;
  if (mode === 'builtin') {
    const clientSecret = required(env, 'TZ_INTROSPECTION_CLIENT_SECRET');
    if (clientSecret.length < 32) throw new Error('TZ_INTROSPECTION_CLIENT_SECRET must be at least 32 characters');
    identity = {mode, database: databaseOptions(required(env, 'DATABASE_URL')), secret: required(env, 'BETTER_AUTH_SECRET'),
      issuer: publicOrigin, audience, clientId: INTERNAL_CLIENT_ID, clientSecret};
  } else if (mode === 'external') {
    identity = {mode, introspectionEndpoint: required(env, 'TZ_INTROSPECTION_ENDPOINT'), issuer: required(env, 'TZ_ISSUER'),
      audience, clientId: required(env, 'TZ_CLIENT_ID'), clientSecret: required(env, 'TZ_CLIENT_SECRET')};
  } else throw new Error('TZ_IDENTITY must be builtin or external');
  const operatorToken = env.TZ_OPERATOR_TOKEN?.trim() || null;
  if (operatorToken && operatorToken.length < 32) throw new Error('TZ_OPERATOR_TOKEN must be at least 32 characters');
  const artworkOrigins = (env.TZ_ARTWORK_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const region = env.TZ_RIGHTS_REGION?.trim() || 'US';
  if (!/^[A-Z]{2}$/.test(region)) throw new Error('TZ_RIGHTS_REGION must be an ISO 3166-1 alpha-2 code');
  const stripe = {secretKey: env.STRIPE_SECRET_KEY?.trim() || null, webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
    accountId: env.STRIPE_ACCOUNT_ID?.trim() || null};
  return Object.freeze({publicOrigin, dataDir, durability, port, trustedProxyHops: hops, ...scope, identity,
    operatorToken, artworkOrigins, region, stripe});
}
