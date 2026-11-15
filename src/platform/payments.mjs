/** Stripe sandbox configuration state. Keys come only from the environment and
 * are never returned, logged or sent to a browser. Verification uses DRE's
 * read-only sandbox account probe; it creates no charge or Checkout session. */
export function createPaymentsStatus(stripe, {inspect} = {}) {
  const missing = ['secretKey', 'webhookSecret', 'accountId'].filter(key => !stripe?.[key]);
  let state = missing.length ? 'not_configured' : 'unverified', verification = null;
  const problems = [];
  if (!missing.length) {
    if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(stripe.secretKey)) problems.push('STRIPE_TEST_KEY_REQUIRED');
    if (!stripe.webhookSecret.startsWith('whsec_')) problems.push('STRIPE_WEBHOOK_SECRET_INVALID');
    if (!/^acct_[A-Za-z0-9]+$/.test(stripe.accountId)) problems.push('STRIPE_ACCOUNT_ID_INVALID');
    if (problems.length) state = 'misconfigured';
  }
  async function verify() {
    if (state !== 'unverified' || typeof inspect !== 'function') return;
    verification ??= (async () => {
      try {
        const account = await inspect({apiKey: stripe.secretKey});
        state = account?.accountId === stripe.accountId ? 'sandbox_verified' : 'misconfigured';
        if (state === 'misconfigured') problems.push('STRIPE_ACCOUNT_MISMATCH');
      } catch { state = 'verification_failed'; }
    })();
    await verification;
  }
  return Object.freeze({
    verify,
    snapshot: () => ({state, missing: missing.map(key => ({secretKey: 'STRIPE_SECRET_KEY',
      webhookSecret: 'STRIPE_WEBHOOK_SECRET', accountId: 'STRIPE_ACCOUNT_ID'})[key]), problems: [...problems]})
  });
}
