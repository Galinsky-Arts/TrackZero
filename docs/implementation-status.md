# TrackZero implementation and evidence

## November 17, 2026 — endpoint enrollment: why the browser cannot be enrolled

The endpoint-encrypted features (album checkout, voluntary support, Groove settings, reports,
point redemption, fan library, privacy/complaints, live playback, speaker contribution) stay gated
with `ENDPOINT_ENROLLMENT_REQUIRED`. This was re-examined against the pinned engines:

- **What "enrollment" and "approved codecs" mean in code.** Each gated handler requires injected
  `decodeControl`/`encodeResponse` (and `seal`/`open` for privacy) that authenticate *and decrypt*
  the `DAE-CONTROL-v1` envelope (`src/http-boundary.mjs`). In the Audio Engine the envelope's
  Ed25519 signature is integrity only; its `payloadCiphertextBase64` must come from "an authenticated
  E2EE control channel" (`src/controls.ts`, `docs/security.md`), and attachment keys/manifests must
  arrive over "an authenticated E2EESA pairwise/group channel" the object codec does not implement.
- **The only approved channel** is the Signal protocol through `@signalapp/libsignal-client` 0.105.0
  (`integrations/signal-parent`), which provides prekey establishment, ratcheting and device
  membership. It is a Node native library ("not an Android or iOS executable"); there is no
  supported browser build, and no other key-establishment library is approved in any repository.
- **DAE-08's WebCrypto primitives are not enough on their own.** They give Ed25519 control signatures
  and AES-256-GCM attachment decryption, i.e. what happens *after* keys are delivered. Enrolling a
  browser would require composing a key exchange from WebCrypto (X25519/ECDH + HKDF) or adopting an
  unreviewed JavaScript Signal port; both are a home-grown or unapproved key-establishment protocol,
  which AGENTS.md forbids. The pinned `client-web-hardened` profile additionally needs release
  closure, SRI and update transparency, none of which exist yet.
- **Result.** No browser enrollment was built and nothing was switched on. `/readyz` now reports
  `endpointEnrollment` (browser `not_supported`, native `pending`, with the reason) and each gated
  answer carries `enrollment: {browser: 'not_supported', native: 'pending'}`; the UI says browsers
  cannot be enrolled yet. New adversarial tests confirm structurally valid self-signed envelopes,
  their replays and expired copies are refused on every gated route (no decoding path exists).
- **What would unblock it.** An approved browser-capable implementation of the pinned Signal
  protocol (or another standard protocol the E2EESA profile and owner approve, from an audited
  library), or a native endpoint: the Audio Engine now has Android (WebView) and iOS
  (JavaScriptCore) audio hosts, but a mobile Signal binding, root-pinned device enrollment and
  protected state are still missing. Payments additionally need `STRIPE_*`.

Also in this change: a failed store restore no longer adopts its ownership epoch (it stays
unwritable), engine pins moved to DAE `292b564` and DRE `392b3d3`, and the suite has 164 passing
cases locally with PostgreSQL and Chromium.

## November 17, 2026 — durable application stores and password recovery

- **Durable stores in Neon.** `TZ_STORAGE_DURABILITY=postgres` (`src/platform/store-durability.mjs`)
  keeps SQLite as the in-process query engine and writes every committed store change to PostgreSQL
  before the response is sent; on start the stores are rebuilt from PostgreSQL (SHA-256 checked) under a
  new ownership epoch that fences any older instance. Failed persistence answers 503, never a silent
  acknowledgement. The Galinsky Arts service now runs in this mode, so stations, rights, programs,
  grants, engine credentials and the other application stores survive restarts and deploys. SQLite
  (`ephemeral`/`persistent`) remains the local/dev default. A Neon backup branch
  `backup-pre-durable-stores-20261117` was taken before the switch.
- **Live verification.** Deploy `dep-dbtrlqmk1f9s739ia68g` (commit `a6f033a`) first ran postgres mode and
  uploaded the stores; the next deploy `dep-dbtrn33rjlhs73b13kl0` (commit `935091a`) booted on a fresh
  instance and logged `postgres durability, epoch 4, 8 restored from PostgreSQL, 8 tracked` before
  serving — the restart-restore path works on Render. (Stores from the earlier ephemeral preview were
  already lost by then.) HTTP checks of the live URL are not possible from this environment.
- **Password recovery.** Emailed reset through Resend (`RESEND_API_KEY` + `TZ_MAIL_FROM`), off and
  labelled "not configured" in the UI and `/readyz` until both are set. Fragment-only reset link,
  30-minute single-use token, all sessions and access tokens revoked, same answer for unknown addresses.
- **Tests.** 164 cases pass locally with PostgreSQL and Chromium (four new durability cases: restart
  with an empty data directory, superseded-instance fencing, failed-write 503, tampered snapshot; two
  recovery cases).
- **Still not built (by design or blocked):** endpoint-encrypted features (checkout, support, Groove
  settings, reports, redemption, fan library, privacy, interstitial/sponsor publication, live playback,
  speaker contribution) need approved enrolled-endpoint codecs; payments need `STRIPE_*`; email
  verification at sign-up is not implemented; device/pilot evidence (TZ-22/23) is pending.

## November 15, 2026 — data transfer, pilot dry run and runbook draft

- `bin/data-transfer.mjs` exports, verifies and imports the application SQLite stores
  (SQLite backup API, SHA-256 + row-count manifest, owner-only files, no silent
  overwrite, rollback on failed import). Server must be stopped.
- `scripts/pilot-dry-run.mjs` runs a nine-stage TZ-23 software dry run against the
  real composed app with fixture identity; reports are labelled
  `software-dry-run-with-fixture-verifiers`, `fieldEvidence: false` ([details](TZ-23-DRY-RUN.md)).
- [TZ-24-RUNBOOK.md](TZ-24-RUNBOOK.md) is a draft rollout/creator/support runbook.
- Galinsky Arts development deployment: Render `trackzero-galinsky-arts`
  (`srv-dbsvq9l6e07s73b1lgjg`) with accounts in Neon project `trackzero`
  (`wandering-union-47737865`). Stripe remains unset (payments not configured).

The repository now contains scoped onboarding, creator catalog/rights/program controls, station operations, guest playback adapters, tested Android/Swift listener shells, opt-in contribution UI, actual DRE reward pricing/redemption, complete-album commerce, a private fan library/reporting/support boundary, endpoint-sealed complaints and moderated discovery. TZ-25 adds actual DRE-backed atomic Groove settings; TZ-26 adds an accessible shared-transition reveal with durable once-per-opportunity checkpoints.

The current full development suite has 153 passing tests against the actual pinned DAE/DRE modules (DAE 6c5b21d6, DRE f7b8456f, pinned in dependency-pins.json), including the composed server, the Better Auth/PostgreSQL account service with RFC 7662 introspection, and a Chromium creator/listener journey with automated WCAG checks at phone width. Native hosted CI compiles/tests its implemented shells; browser qualification exercises the reveal in Chromium with reduced motion, focus, mobile overflow, forced colors and automated WCAG checks. Current PR snapshots and dependency links are in registry/prs.json. Individual docs describe the supported slices and unresolved host integrations.

## Composed application (November 15, 2026)

The components now run as one application: `bin/trackzero.mjs` composes every handler on one origin with shared durable stores, `/healthz` and an honest `/readyz`, a first-party Better Auth account service issuing opaque tokens verified by RFC 7662 introspection (external IdP still configurable), operator provisioning, and an accessible web UI (creator studio, rights review, listener features, discovery, operator console). See [APPLICATION.md](APPLICATION.md).

Working end to end in the composed app: sign-up/sign-in, listener and invitation-based artist/label onboarding, operator-verified station claims, station and complete-album catalog publication gated by approved sale rights, rights claims/independent review/withdrawal, rights-gated drag-and-drop and keyboard program sequencing, interstitial drafts, sponsor campaign submission/revocation, station-engine reports with operator-issued credentials, reward price preview from the DRE ladder, guest station/album pages and discovery.

Present but unavailable by design until approved endpoints are enrolled (the server answers `ENDPOINT_ENROLLMENT_REQUIRED`, never a plaintext fallback): album checkout, voluntary support, Groove settings, reports, point redemption, fan library, privacy/complaints, interstitial publication, sponsor approval, live playback and speaker contribution. Stripe keys are wired through environment variables and verified read-only; with no keys the UI says payments are not configured.

The application is not a qualified production deployment. Remaining: approved identity/key/codec provisioning and composition, native encrypted endpoint bootstrap, encrypted recording upload, Stripe sandbox delivery (keys not yet supplied), live multi-merchant payout/refund/support flows, persistent hosting/restore and real phone/acoustic/pilot evidence remain incomplete. TZ-22 through TZ-24 and DRE-27/DRE-28 cannot honestly be closed as real qualification/rollout without those results. See RELEASE_READINESS.md for concrete steps and evidence. No certification or independent human review is claimed; external review is deferred by owner policy.
