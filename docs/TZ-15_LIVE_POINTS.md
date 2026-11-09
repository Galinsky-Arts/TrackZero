# TZ-15 live artist points projection

The draft consumes trusted issuer events and displays one artist's provisional and spendable balances without issuing points. A completed outro may vest only when the terminal event carries zero provisional points. Interruption forfeits provisional points, stale sequence numbers and invalid transitions are denied, and artist wallets remain separate. Returned view snapshots are immutable so UI code cannot change the stored projection. A renderer rejects a forged nonzero unknown balance or inconsistent terminal state.

`node --test tests/*.test.mjs` passes four local Node 24 tests covering vesting, forfeiture, replay denial, artist isolation, immutable views and conservative rendering. The repository's planning CI does not run this suite. The original plan depends on TZ-14 and DRE-18; no authenticated issuer stream, verified output event, authoritative wallet reconciliation, outro marker or atomic redemption adapter has been independently verified in this assignment. PR #20 stays draft; these views do not grant or spend rewards.

November 9 review integrates actual DRE-18 atomic redemption behind a bounded,
authenticated HTTP boundary. The host must supply an approved authenticated E2EE
control decoder and a transaction authorizer; raw transaction JSON has no fallback.
Creator, offer version and user-scoped idempotency bind the request. Price and
identity cannot come from the body, and issuer receipts must match the viewer.
The source integration uses actual wallet/price/reward modules with explicit
fixture identity/control adapters. Production endpoint enrollment and encrypted
transport adapters remain required before hosting this endpoint.

Projection memory is bounded without discarding replay tombstones. Contradictory
interruption/completion states fail closed. UI amounts remain display-only;
consent, vesting and spending are separate operations. No microphone consent or
headphone listening can mint speaker points.
