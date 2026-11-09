# TZ-16 complete-album checkout boundary

The draft exposes authenticated, origin-checked, idempotent complete-album checkout initiation and owner-bound receipt reads. It accepts an album ID and version, never price or card data. Verified tenant, application and buyer ID are carried through offer lookup, checkout and receipt queries; mismatched provider scope or incomplete receipt identifiers fail closed. The commerce provider remains solely responsible for pricing, charge, receipt, entitlement, refund and payout. A `PENDING` response is not a purchase grant.

`node --test tests/*.test.mjs` passes three local Node 24 tests covering the valid pending path, stale/forged/origin/role denial and owner/tenant/application receipt mismatch. The repository planning CI does not run these product tests. The original plan requires TZ-15 and DRE-24; no trusted provider-side idempotent charge, settlement account, receipt/entitlement authority or transaction sandbox is verified in this assignment. Buyer checkout UI, refunds, payment recovery and real transactions remain open. PR #21 stays draft; no charge or artist payout is claimed.

November 9 review connects the neutral actual DRE whole-work commerce adapter to
TrackZero's album DTOs. CI builds immutable audio-core source and checks out the
actual radio source, then tests checkout, durable settlement, complete-work
entitlement and private receipt handling together. No card data, price override,
point/speaker prerequisite or paid standalone song enters the request.

Private checkout/redemption controls require an approved authenticated E2EE
decoder; private success receipts require an approved encrypted response encoder.
Structural envelope checks cannot replace cryptographic verification. Raw JSON
controls and raw private receipt responses have no production fallback. Test
identity, provider and endpoint codecs are explicit fixtures. A paid order awaiting
rights-verified fulfillment is reported as pending, without another provider charge.

The actual production identity/enrollment, merchant/provider configuration,
signed provider sandbox and payout/refund workflows remain pending. This software
merge cannot establish a working merchant account or production acceptance.
