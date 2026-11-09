# TZ-07 artist interstitial boundary

The artist interstitial studio accepts bounded metadata for recorded or uploaded opening, closing and station identifications. A server-verified broadcaster and station authorization callback are required. Drafts contain a digest and capture provenance, remain quarantined, and never accept raw audio bytes, keys, client identity or self-asserted publication state.

Publication accepts only an opaque `ciphertext:` audio reference. A trusted adapter must recheck the broadcaster and station and authorize the exact DRE-08 record inside the SQLite write transaction. Denied or interrupted authorization leaves the draft unpublished; an accepted record is immutable and cannot be replaced through this boundary. This repository does not treat the ciphertext reference, claimed MIME type or digest as proof on its own.

`node --test tests/interstitial.test.mjs tests/interstitial-store.test.mjs` covers normal record/upload metadata, DRE-08 record shaping, role and station denial, raw-media rejection, restart persistence, duplicate publication, UTF-8 request limits, and interrupted draft/publication writes. Distributed Radio Engine DRE-08 is merged through PR #9 and remains the authority for endpoint-attested nonempty encrypted audio.

Production identity, an actual recording/upload endpoint, media scanning and encryption, preview playback, moderation, real browser accessibility, deployment and hardware/field acceptance remain explicit integration gates.
