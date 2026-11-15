import {ENGINE_TOKEN_PREFIX} from './grants.mjs';
import {OnboardingError} from '../onboarding.mjs';

/** Builds every handler-specific identity shape from one verified principal.
 * The principal comes only from the configured introspection authenticator.
 * Roles come only from local durable stores: onboarding roles (invitations),
 * operator role grants, and station-claim ownership (broadcaster).
 * Results are memoized per Request so one request costs one introspection. */
export function createIdentity({authenticate, onboarding, catalog, grants}) {
  if (typeof authenticate !== 'function' || !onboarding || !catalog || !grants) throw new Error('Identity sources required');
  const principals = new WeakMap();
  const principal = request => {
    if (!principals.has(request)) principals.set(request, authenticate(request));
    return principals.get(request);
  };
  async function strictActor(request) {
    const p = await principal(request);
    const account = onboarding.account(p);
    const roles = new Set(account?.roles ?? []);
    for (const role of grants.roles(p)) roles.add(role);
    if ((roles.has('artist') || roles.has('label')) && catalog.claimsFor(p).length) roles.add('broadcaster');
    return Object.freeze({tenant: p.tenant, application: p.application, subject: p.subject,
      roles: Object.freeze([...roles].sort()), account: account ? account.id : null});
  }
  // Unauthenticated callers become null so each handler emits its own 401/403;
  // provider outages still propagate and surface as 503.
  const nullable = fn => async request => {
    try { return await fn(request); } catch (error) {
      if (error instanceof OnboardingError && error.status === 401) return null;
      throw error;
    }
  };
  const actor = nullable(strictActor);
  return Object.freeze({
    principal: nullable(principal),
    actor,
    /** Station ownership is the operator-verified claim, never a body field. */
    ownsStation(scope, stationId) {
      return typeof stationId === 'string' && catalog.claimOwner({...scope, id: stationId}) === scope.subject;
    },
    /** Station engine reports authenticate with an operator-issued engine credential. */
    async operations(request) {
      const header = request.headers.get('authorization') ?? '';
      if (header.startsWith(`Bearer ${ENGINE_TOKEN_PREFIX}`)) {
        const engine = grants.engineForToken(header.slice('Bearer '.length));
        return engine ? {tenant: engine.tenant, application: engine.application, engineId: engine.engineId,
          role: 'station_engine'} : null;
      }
      return actor(request);
    },
    async listener(request) {
      const value = await actor(request);
      return value && {...value, userId: value.subject, role: value.roles.includes('listener') ? 'listener' : null};
    },
    async creator(request) {
      const value = await actor(request);
      return value && {tenantId: value.tenant, applicationId: value.application, principalId: value.subject,
        role: value.roles.includes('artist') || value.roles.includes('label') ? 'creator' : null};
    }
  });
}
