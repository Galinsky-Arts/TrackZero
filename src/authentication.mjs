import {OnboardingError} from './onboarding.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function configuredUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('HTTPS introspection endpoint required');
  }
  return url.toString();
}

/** RFC 7662-style opaque access token introspection. The caller supplies
 * confidential-client authentication from a secure runtime, never a browser.
 * Provider roles are ignored: local grants remain the authorization source.
 */
export function createIntrospectionAuthenticator({endpoint, issuer, audience, application,
  authorize, fetchImpl = fetch}) {
  const target = configuredUrl(endpoint);
  if (typeof issuer !== 'string' || !issuer || typeof audience !== 'string' || !audience ||
      typeof application !== 'string' || !ID.test(application) ||
      typeof authorize !== 'function' || typeof fetchImpl !== 'function') {
    throw new Error('Introspection configuration required');
  }

  return async function authenticate(request) {
    const header = request.headers.get('authorization');
    const match = /^Bearer ([A-Za-z0-9._~+\/-]{1,8192})$/.exec(header || '');
    if (!match) throw new OnboardingError('UNAUTHENTICATED', 401);

    let response;
    try {
      const clientHeaders = await authorize();
      if (!clientHeaders || typeof clientHeaders !== 'object') throw new Error('Missing client authorization');
      const headers = new Headers(clientHeaders);
      headers.set('content-type', 'application/x-www-form-urlencoded');
      headers.set('accept', 'application/json');
      const body = new URLSearchParams({token: match[1], token_type_hint: 'access_token'});
      response = await fetchImpl(target, {method: 'POST', headers, body,
        redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000)});
    } catch {
      throw new OnboardingError('AUTH_PROVIDER_UNAVAILABLE', 503);
    }
    if (!response?.ok) throw new OnboardingError('AUTH_PROVIDER_UNAVAILABLE', 503);
    let result;
    try { result = await response.json(); }
    catch { throw new OnboardingError('AUTH_PROVIDER_UNAVAILABLE', 503); }
    if (!result || result.active !== true || result.iss !== issuer ||
        !(result.aud === audience || (Array.isArray(result.aud) && result.aud.includes(audience))) ||
        !Number.isSafeInteger(result.exp) || result.exp <= Math.floor(Date.now() / 1000) ||
        typeof result.sub !== 'string' || !ID.test(result.sub) ||
        typeof result.tenant !== 'string' || !ID.test(result.tenant)) {
      throw new OnboardingError('UNAUTHENTICATED', 401);
    }
    return {tenant: result.tenant, application, subject: result.sub};
  };
}
