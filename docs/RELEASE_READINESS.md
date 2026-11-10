# TrackZero release readiness — November 10, 2026

Development merges are authorized. Production rollout is not yet qualified. This record replaces the earlier copied audio-engine status: automated fixtures, native host tests and browser checks are development evidence, not real customers, provider transactions, measured speaker output or phone battery results.

## Repeatable software validation

Use Node 24.19+ (24.x). Build the pinned Distributed Audio Engine (`npm ci --ignore-scripts && npm run build`), and check out the DRE revision in `.github/workflows/planning.yml`. Set AUDIO_ENGINE_MODULE to the absolute DAE dist/src/index.js and DRE_PLAYBACK_MODULE to the absolute DRE src/radio-playback.mjs. Run `node --test registry/pr-contract.test.mjs tests/*.test.mjs`, the registry/roadmap validators and `python3 scripts/validate_e2eesa_status.py`.

Run `npm ci --ignore-scripts --prefix tools/browser-qualification`, then `node tools/browser-qualification/node_modules/playwright-core/cli.js install --with-deps chromium` and `node scripts/browser-qualification.mjs`. Alternatively set CHROMIUM_PATH to an installed Chrome/Chromium executable. The browser fixture uses no media, credentials or provider. Source-hashed local results are in qualification/browser-dom.json; CI repeats the checks. Android compile/lint/JUnit and macOS Swift XCTest run in native-listener.yml.

## TZ-22: accessibility, battery and recovery

DOM automation covers the Groove live-region semantics, retained keyboard focus, reduced motion, forced colors and mobile overflow. Existing playback/native tests cover software interruption, stale starts and cleanup. Pending real-device evidence must include device/OS/app revision, actual screen-reader output, wired/Bluetooth/speaker route, lock/background/call/network-loss/rejoin cases, elapsed playback and battery change/thermal state. Record failures and stop conditions. Do not substitute synthetic capture or a desktop browser for these measurements.

## TZ-23 / DRE-27: integrated pilot

A real pilot needs a deployed authenticated artist/listener endpoint and approved key enrollment, authorized encrypted complete albums/interstitials, actual current station clock, persistent endpoint stores and a configured Stripe sandbox webhook. Exercise creator publication, guest current-position listening, headphone completion, speaker contribution only with authenticated physical evidence, points/outro vesting/redemption, shared Groove grant/reconnect, complete-album Checkout, signed webhook replay and private receipt/library recovery. No on-demand radio insertion is permitted. The automated suites compose these APIs with explicit verifiers/fixtures; they do not establish that the deployed flow works.

## TZ-24 / DRE-28: rollout and creator/support procedure

1. Provision identity introspection settings from TZ-02-RUNBOOK.md and an owner-private persistent endpoint volume. Accounts alone do not grant decrypting/device authority.
2. Bind actual approved DAE enrollment/key storage, private-control and response codecs, current recording rights, publication/moderation and transaction authorizers. Never enable a plaintext/dev fallback.
3. Provision sandbox STRIPE_SECRET_KEY through secret settings (sk_test_…; never in chat/source). Obtain the account ID with the read-only DRE inspect-stripe-sandbox script. Register a deployed raw webhook for checkout.session.completed at the pinned Stripe API version and provision STRIPE_WEBHOOK_SECRET (whsec_…). Use explicit account/work ownership approval. Connect artist payouts, refunds/disputes and paid gifting/tips are not implemented by the sandbox album adapter.
4. Deploy the exact tested revisions into Phillip's selected Render workspace, then verify live readiness, authenticated encrypted flow, signed webhook retry and a real restore/restart drill. The inspected workspace had no TrackZero service. Persistent SQLite services cannot be scaled as independent unsynchronized writers.
5. Complete actual phone/acoustic/pilot evidence above, record operational ownership, retention/export/deletion and backup restore procedures, alerting and rollback revision. Never roll a database back by deleting durable receipts or replay tombstones.
6. Before live money, configure the actual merchant/artist payout and support/refund operations and obtain the user's live-transaction approval. Do not enable live keys through the current sandbox adapter.

If readiness or identity/key/provider verification fails, stop issuing new purchases/rewards and leave private endpoints unavailable. Preserve durable evidence and entitlements, continue only authorized public discovery, and surface an unavailable/retry state. Do not turn a payment redirect into settlement or a fixture into field evidence. External human review is deferred under AGENTS.md and is not the blocker; missing operational integrations, credentials and actual qualification are.

Current locked npm graphs report zero known vulnerabilities on November 10; docs/dependency-audit.json binds that result to the lockfile hash. CI repeats npm audit at high/critical failure threshold. scripts/check-current-secrets.py scans tracked current source for embedded Stripe keys/private PEM blocks without printing values; history and other secret formats remain outside that narrow check.
