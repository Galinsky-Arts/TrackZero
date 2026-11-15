# TZ-23 integrated pilot — software dry run (NOT field evidence)

`node scripts/pilot-dry-run.mjs` composes the real TrackZero application in-process
(real SQLite stores, real HTTP handlers, real pinned DRE reward ladder) in a
temporary data directory and walks the pilot workflow. It prints a JSON report
and exits non-zero if any software stage fails. `tests/pilot-dry-run.test.mjs`
runs it in `npm test`.

Every report carries, unconditionally:

```json
{"evidenceKind": "software-dry-run-with-fixture-verifiers", "fieldEvidence": false, "pilotComplete": false}
```

## Stages

1. Identity required; forged bearer tokens rejected by introspection.
2. Creator/reviewer/listener onboarding; operator invitation; invitation reuse denied.
3. Operator-verified station claim; owner-only publication; cross-origin write denied.
4. Independent rights review: offer refused before review, ungranted reviewer and self-review denied, approved offer published.
5. Owner-only, rights-gated program sequencing; unlicensed item and stale version denied.
6. Station engine credential: PRIMARY -> FALLBACK -> RECOVERING -> PRIMARY, replay rejected, listener cannot read status, revoked credential denied.
7. Public guest, album, discovery and station-list pages expose public metadata only.
8. Commerce, redemption and privacy stay fail-closed (`ENDPOINT_ENROLLMENT_REQUIRED`, payments `not_configured`); listeners cannot preview creator reward prices.
9. Restart over the same data directory preserves stations, rights and programs.

## Fixture verifiers (stated in the report)

- Identity: an in-process RFC 7662 introspection stub (token `t-<subject>`), not a real IdP or real accounts.
- Station engine: events driven by the script with an operator-issued credential, not a deployed DRE engine.
- Clock: host wall clock; no trusted time source.

## Not exercised — the TZ-23 field pilot remains open

Enrolled DAE endpoints and key/codec provisioning, encrypted media intake, any
actual playback, phones, speakers or loudspeaker contribution evidence, Stripe
sandbox checkout and webhooks, real pilot artists/listeners, consent and field
measurements. TZ-23's external prerequisites in `registry/prs.json` are unchanged;
this harness cannot mark the unit complete. Use it as a regression gate and as the
software rehearsal before a real pilot.
