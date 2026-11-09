import {CatalogError} from './station-catalog.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Bind a provider-verified principal to locally granted account roles.
 * authenticateIdentity must verify a real session; lookupAccount must read the
 * durable TZ-02 account store. Provider-supplied role claims are ignored.
 */
export function createCatalogPublisherAuthenticator(authenticateIdentity, lookupAccount) {
  if (typeof authenticateIdentity !== 'function' || typeof lookupAccount !== 'function') {
    throw new Error('Verified identity and account lookup required');
  }
  return async request => {
    const identity = await authenticateIdentity(request);
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
        !['tenant', 'application', 'subject'].every(key =>
          typeof identity[key] === 'string' && ID.test(identity[key]))) {
      throw new CatalogError('UNAUTHENTICATED', 401);
    }
    const principal = {tenant: identity.tenant, application: identity.application,
      subject: identity.subject};
    const account = await lookupAccount(principal);
    if (!account || account.tenant !== principal.tenant ||
        account.application !== principal.application || account.subject !== principal.subject ||
        !Array.isArray(account.roles)) throw new CatalogError('ACCOUNT_REQUIRED', 403);
    return {...principal, roles: account.roles.filter(role => role === 'artist' || role === 'label')};
  };
}
