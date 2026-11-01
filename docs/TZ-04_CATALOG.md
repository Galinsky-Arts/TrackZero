# TZ-04 catalog and complete-album management

The catalog projection accepts complete-album public metadata only after an injected trusted verifier approves every album. Client-supplied rights or availability flags grant no authority. Station offer matching reuses the accepted TZ-03 storefront contract, rejects duplicate or unavailable offers, and remains an inert catalog projection without checkout or playback controls.

The DRE-04 adapter binds tenant and publisher scope server-side and verifies every declared album track through the upstream RadioCatalog.get-compatible lookup. Every item must be tenant- and publisher-matched music with an opaque ciphertext asset reference. Missing tracks, duplicate tracks, cross-tenant or cross-publisher records, non-music media, plaintext references and provider interruption fail closed. DRE-04 is merged through neophilism/Distributed-Radio-Engine PR #5.

Run `node --test tests/*.test.mjs` on Node 24. Planning CI runs the registry contract and all product tests. Coverage includes normal projection, TZ-03 offer integration, malformed and duplicate input, rights denial, cross-scope/cross-role media and interrupted DRE lookup. This is not checkout, entitlement, payment, synchronized artwork, live provider, deployed storage, hardware or production-release evidence.
