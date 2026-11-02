# TZ-08 sponsor upload and placement boundary

The sponsor workflow stores bounded metadata for an encrypted common-program audio asset. A server-verified sponsor role and station upload authorization are required. Drafts remain quarantined and cannot contain raw audio, keys, client identity, approval claims or plaintext media URLs.

A separately verified broadcaster places the draft against an exact approved program digest. Station authorization and a trusted DRE-09 campaign adapter are rechecked inside the SQLite write transaction. Denied or interrupted authorization leaves the campaign unplaced; an accepted placement is immutable. The adapter receives the exact DRE-09 campaign shape: tenant, station, campaign, ciphertext audio reference, program digest and integer minor-unit rate.

`node --test tests/sponsor-store.test.mjs` covers restart recovery, the accepted workflow, exact campaign shaping, role and station denial, raw-media rejection, program mismatch, request limits and interrupted draft/placement writes. Distributed Radio Engine DRE-09 is merged through PR #11 and remains the authority for broadcaster-approved common-program sponsorship. It does not infer listener counts or physical outputs.

Production identity, actual upload/encryption and media scanning, moderation, program compilation, delivery accounting, invoicing, payouts, deployment and hardware/field acceptance remain explicit integration gates. No personalized audio insertion, completed delivery, payment or production-release claim is made.
