import {createHash, timingSafeEqual} from 'node:crypto';
import {GrantError} from './grants.mjs';
import {OnboardingError} from '../onboarding.mjs';
import {CatalogError} from '../station-catalog.mjs';

const json = (status, body) => new Response(JSON.stringify(body), {status,
  headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
function matches(provided, expected) {
  const a = createHash('sha256').update(provided).digest(), b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Operator-only provisioning: invitations, out-of-band verified station claims,
 * role grants and station-engine credentials. Disabled unless TZ_OPERATOR_TOKEN
 * is set. Shared operations (also used by bin/operator.mjs) live in `operations`. */
export function createOperatorOperations({scope, onboarding, catalog, grants}) {
  const account = subject => {
    if (!onboarding.account({...scope, subject})) throw new GrantError('ACCOUNT_NOT_ONBOARDED', 404);
  };
  return Object.freeze({
    invitation({role, expiresInHours = 72}) {
      if (!Number.isSafeInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) throw new GrantError('INVALID_EXPIRY');
      const expiresAt = Date.now() + expiresInHours * 3600_000;
      return {role, invitation: onboarding.provisionInvitation({...scope, role, expiresAt}), expiresAt: new Date(expiresAt).toISOString()};
    },
    stationClaim({stationId, ownerSubject}) {
      account(ownerSubject);
      try { catalog.provisionStationClaim({...scope, id: stationId, ownerSubject}); }
      catch (error) {
        if (/UNIQUE constraint/.test(error?.message ?? '')) throw new GrantError('STATION_ALREADY_CLAIMED', 409);
        throw error;
      }
      return {stationId, ownerSubject, claimed: true};
    },
    grant({subject, role}) { account(subject); return grants.grant({...scope, subject, role}); },
    revokeGrant({subject, role}) { return grants.revoke({...scope, subject, role}); },
    engineCredential({engineId, stationId}) {
      if (!catalog.claimOwner({...scope, id: stationId})) throw new GrantError('STATION_CLAIM_REQUIRED', 409);
      return grants.issueEngineCredential({...scope, engineId, stationId});
    },
    revokeEngineCredential({engineId}) { return grants.revokeEngineCredential({...scope, engineId}); }
  });
}

export function createOperatorHandler({token, publicOrigin, operations}) {
  const routes = {
    '/operator/v1/invitations': body => operations.invitation(body),
    '/operator/v1/station-claims': body => operations.stationClaim(body),
    '/operator/v1/grants': body => operations.grant(body),
    '/operator/v1/grants/revoke': body => operations.revokeGrant(body),
    '/operator/v1/engine-credentials': body => operations.engineCredential(body),
    '/operator/v1/engine-credentials/revoke': body => operations.revokeEngineCredential(body)
  };
  return async request => {
    const url = new URL(request.url);
    if (!token) return json(503, {error: 'OPERATOR_API_DISABLED'});
    const header = request.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ') || !matches(header.slice(7), token)) return json(401, {error: 'OPERATOR_TOKEN_REQUIRED'});
    if (request.method !== 'POST' || !Object.hasOwn(routes, url.pathname)) return json(404, {error: 'NOT_FOUND'});
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== publicOrigin) return json(403, {error: 'ORIGIN_DENIED'});
    let body;
    try {
      const text = await request.text();
      if (text.length > 2048) return json(413, {error: 'BODY_TOO_LARGE'});
      body = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    } catch { return json(400, {error: 'INVALID_JSON'}); }
    try { return json(200, await routes[url.pathname](body)); }
    catch (error) {
      if (error instanceof GrantError || error instanceof OnboardingError || error instanceof CatalogError)
        return json(error.status, {error: error.code});
      return json(503, {error: 'OPERATOR_OPERATION_FAILED'});
    }
  };
}
