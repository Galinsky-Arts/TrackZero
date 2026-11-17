# TZ-24 production rollout and creator/support runbook — DRAFT

Status: **draft**. Written from the development deployment and automated tests.
It has not been exercised in a real rollout, restore drill or pilot. Steps that
need owner decisions, credentials or field evidence are marked **Owner** or
**Blocked**. External review is deferred by owner policy and is not a gate here.

## 1. Environments

| Item | Galinsky Arts development deployment |
|---|---|
| Render service | `trackzero-galinsky-arts` (`srv-dbsvq9l6e07s73b1lgjg`), free plan, virginia, auto-deploy after checks pass |
| URL | https://trackzero-galinsky-arts.onrender.com |
| Accounts | Neon project `trackzero` (`wandering-union-47737865`), aws-us-east-1, PG 17, free |
| Application stores | SQLite working copy under `TZ_DATA_DIR`, persisted to the same Neon database before every response (`TZ_STORAGE_DURABILITY=postgres`, tables `trackzero_store_snapshot`/`trackzero_store_epoch`) and restored on start |

The Galinsky Labs preview (`trackzero.onrender.com`) is a separate account set and
is not operated by this runbook.

## 2. Configuration inventory

Generated at deploy time and stored only in Render: `BETTER_AUTH_SECRET`,
`TZ_INTROSPECTION_CLIENT_SECRET`, `TZ_OPERATOR_TOKEN` (each >= 32 characters).
Set from Neon: `DATABASE_URL` (`sslmode=require`; the app enforces certificate
verification). Fixed: `NODE_VERSION`, `NODE_ENV`, `TZ_DATA_DIR`,
`TZ_STORAGE_DURABILITY=postgres`, `TZ_TRUSTED_PROXY_HOPS=1`, `TZ_IDENTITY=builtin`.
Optional: `TZ_ARTWORK_ORIGINS`, `TZ_RIGHTS_REGION` (default `US`).

**Owner-supplied (unset today):** `RESEND_API_KEY` and `TZ_MAIL_FROM` (password
recovery email; off and labelled "not configured" until both are set),
`STRIPE_SECRET_KEY` (sk_test_ only),
`STRIPE_WEBHOOK_SECRET`, `STRIPE_ACCOUNT_ID`. While unset the app reports
"Payments not configured" and checkout stays unavailable. Rotate a generated
secret by replacing it in Render and redeploying; rotating `BETTER_AUTH_SECRET`
signs everyone out.

## 3. Pre-flight for every release

1. `npm run deps:prepare && npm ci --ignore-scripts && npm run check` on Node 24.
2. Full suite with `TZ_REQUIRE_FULL_SUITE=1`, a disposable PostgreSQL and Chromium.
3. `node scripts/pilot-dry-run.mjs` — every stage must pass. It is labelled
   non-field evidence ([TZ-23-DRY-RUN.md](TZ-23-DRY-RUN.md)).
4. Confirm hosted CI is green at the exact merge commit; Render deploys it only after checks pass.

## 4. Deploy and verify

1. Merge to `main`; watch the Render deploy reach `live`.
2. `/healthz` must return `{"status":"ok"}`; `/readyz` must show storage and
   account checks ok, the declared durability, payments state and
   `requires_enrolled_endpoint` for endpoint-encrypted features. Never edit
   readiness to turn green.
3. Browser smoke at phone width: sign-up, listener join, operator invitation,
   station claim/publication, program save, public station page, checkout shows
   the honest unavailable state, sign-out.

## 5. Creator onboarding (operator)

Use the operator console or the token-guarded `/operator/v1/*` API with `TZ_OPERATOR_TOKEN`
(`npm run operator -- ...` works only for local SQLite modes; it refuses in postgres mode):

- `invitation artist` -> give the one-time invitation to the artist out of band.
- `station-claim <station-id> <owner-subject>` after verifying the artist's identity.
- `grant <subject> rights_reviewer|sponsor|moderator`; reviewers must not review their own claims (enforced).
- `engine-credential <engine-id> <station-id>` (shown once; stored as a digest); `revoke-engine` on loss.

## 6. Backup and restore of application stores

**Postgres mode (the Galinsky Arts deployment).** Accounts and application store
snapshots are in one Neon database, so one Neon restore covers both consistently:

1. Suspend the Render service (no writers).
2. Before risky changes, create a named Neon branch (`backup-<reason>-<date>`).
   To restore, restore the production branch to a timestamp inside Neon's history
   window (free plan: 6 hours) or from the named branch, keeping a pre-restore backup branch.
3. Resume/deploy. On start the service claims a new epoch and rebuilds every store
   from `trackzero_store_snapshot` (SHA-256 checked); the log line
   `TrackZero application stores: postgres durability, epoch N, M restored` confirms it.
4. Repeat section 4 checks.

Every Render deploy or free-plan restart is itself a restore from PostgreSQL.

**Local SQLite modes** (`persistent` volume):

1. Stop the service (no writers).
2. `TZ_DATA_DIR=... node bin/data-transfer.mjs export /abs/backup-YYYYMMDD` — owner-only
   directory with `manifest.json` (SHA-256 and row counts only).
3. `node bin/data-transfer.mjs verify /abs/backup-YYYYMMDD` before relying on it.
4. Restore: `node bin/data-transfer.mjs import /abs/backup-YYYYMMDD` into an empty
   data directory, or add `--replace` to move current stores to `pre-import-<time>/` first.
   A failed import rolls back to the previous files.
5. Restart and repeat section 4 checks. Accounts are restored separately with
   Neon branching/point-in-time restore.

Never roll back by deleting durable receipts, replay tombstones or grants.
Backups contain private business data (endpoint-sealed privacy records stay sealed);
keep them owner-only and never in the repository.

## 7. Incidents

- Readiness, identity or provider verification failing: stop issuing purchases
  and rewards, keep private endpoints unavailable, leave public discovery up,
  and preserve evidence.
- Compromised operator token or engine credential: replace `TZ_OPERATOR_TOKEN`
  and redeploy; `revoke-engine` the credential and issue a new one.
- Bad release: redeploy the previous successful commit from Render's deploy
  history; application stores are not rolled back.

## 8. Still blocked before a production rollout

- **Owner:** Neon backup/retention policy beyond the free history window (application data is durable in Neon).
- **Owner:** Stripe sandbox keys, webhook registration, later live-transaction approval.
- **Blocked:** approved DAE endpoint enrollment, key/codec provisioning and encrypted media intake.
- **Blocked:** TZ-23 real pilot (artists, listeners, phones, speakers) and TZ-22 device evidence.
- **Owner:** operational ownership, alerting and a recorded point-in-time restore drill.
