# TZ-19 voluntary revenue boundary

The draft accepts explicit user-initiated tip, complete-album gift and sponsor-support intent requests. It requires a verified scoped buyer, same-origin POST, idempotency key, bounded amount and currency, and a trusted target check. Gifts additionally require recipient authorization. The trusted target adapter must verify album offer price and rights for a gift, or the permitted voluntary amount for tips and sponsor support. The commerce provider owns payment consent, charge, receipt, entitlement, refunds and settlement; the endpoint returns only `PENDING`, never a purchase or payout claim.

`node --test tests/voluntary-support.test.mjs` passes three local Node 24 tests for accepted pending intents, separate non-gift flows and denial of missing recipient approval, target, identity, origin or forged fields. No payment provider or recipient consent service is configured, and no real transaction was attempted. Product CI and provider sandbox integration remain open. The original plan depends on TZ-18, whose reporting PR is draft. This is not a released payment flow.

November 9 review requires approved E2EE request/response endpoint codecs and
explicit transaction approval bound to amount, currency, target, recipient and
idempotency key. Target and recipient consent remain separate checks. Private
support receipts cannot fall back to plaintext. Provider-backed intents, signed
webhooks, actual gifts/fulfillment and settlement await the configured merchant
provider; software fixtures create no real payment or entitlement.
