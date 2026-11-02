# TZ-08 sponsor campaign boundary

A server-verified sponsor may submit a station-scoped campaign containing an opaque encrypted audio reference, exact approved program digest, bounded time window and nonnegative minor-unit rate. A separate server-verified broadcaster must approve it through a trusted DRE-09 campaign adapter. Sponsor and broadcaster authorization, campaign approval and audit writes occur inside SQLite transactions.

Only authorized broadcasters can read active campaign projections. Revocation, expiry, later DRE-09 denial or a mismatched station/program withholds the campaign. The projection is the exact DRE-09 authorization record and contains no listener count, acoustic-output claim, delivery claim or radio points. The HTTP boundary rejects raw media, keys, client identity, cross-origin writes and bodies larger than 4,096 UTF-8 bytes.

`node --test tests/sponsor-placement.test.mjs` covers normal approval, exact DRE-09 shaping, cross-role/cross-tenant denial, unencrypted media, invalid program binding, authorization revocation, restart recovery, authenticated reads, idempotent revocation and interrupted approval. Distributed Radio Engine DRE-09 is merged through PR #11.

Production identity, actual encrypted media ingestion and scanning, sponsor contracts, program compilation/scheduling, completed-playback accounting, payout providers, deployment and field acceptance remain explicit integration gates.
