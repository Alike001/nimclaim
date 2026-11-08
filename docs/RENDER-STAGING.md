# $0/month Render + Neon TESTNET staging

Prepared from local commit `207bcd2` without starting over. This replaces that commit's **paid disk proposal** with one Render Free Node web service and a separate Neon Free Postgres database. No cloud resource was created, commit pushed, site deployed, real wallet accessed, signature requested or NIM sent. The existing local SQLite database, `.env`, organiser credentials, private CA/runtime data and Nimlane are not migration inputs and were not changed.

## Verdict and next human action

**GO for local implementation review. NO-GO for creating the staging service now.** Real local Postgres validation is available; missing operational inputs are the separately approved Neon project/database, its pooled/direct connection secrets, the actual Render HTTPS origin, a fresh staging organiser hash and confirmation of free-only billing/quota settings. Creation itself deploys and needs separate approval. Render CLI/platform-aware validation and live Neon/Render compatibility are also unverified.

**Next human action:** review this report and approve creating only an isolated **Neon Free** project/database first. Do not send connection strings in chat. After approved setup, enter secrets directly in Render's creation form/environment fields; approve pushing the reviewed commits and creating the **Free** Render service separately. Do not click Create/Apply to obtain a preview: those actions start a deploy even with automatic deployments off.

Physical Android/Nimiq Pay acceptance is a post-deploy gate before inviting recipients. **Mainnet and all payment dispatch remain NO-GO.** The November 11, 2026 competition deadline does not relax these gates. This narrow implementation supports campaigns → private invitations → cryptographically verified claims → organiser decisions/status. It does not add payout execution, import personal local records, or implement a new sender/HTLC policy.

## What makes the proposal $0/month

The only proposed resources are **Render Free Web Service + Neon Free Postgres**. No paid database, disk, worker, cron job, keep-alive service, paid add-on or custom domain is required. Stay on the actual Free plans, without a Render payment method that permits supplementary charges; use a separate free workspace if necessary instead of changing billing for other projects. If account verification requires billing that could permit charges, or quotas cannot be kept free-only, stop and reassess. Exhaustion/suspension is accepted; automatic paid upgrades are not.

Current [Render Free documentation](https://render.com/docs/free) says the service sleeps after 15 idle minutes, can take about a minute to resume, loses local files, and shares 750 running hours/workspace/month. Bandwidth/build usage has included allowances: overage can be billed when a payment method exists; without one, service/build access can be suspended. High outbound traffic, including database traffic, can also trigger suspension. Free has no persistent disk, SSH/dashboard shell, one-off jobs or multi-instance scaling. Verify the workspace's actual included usage before creation.

Current [Neon plan documentation](https://neon.com/docs/introduction/plans) lists Free at $0/month, 100 CU-hours/project/month, 1 GB Postgres storage/project (20 GB account total), 5 GB public transfer/project, five-minute idle suspension and up to six hours of restore history. These current figures supersede older cached 0.5 GB references. No uptime SLA is promised. At 0.25 CU, 100 CU-hours is 400 active hours; continuous queries can exhaust it. Monitor quotas rather than upgrading. Render sleeping does not delete Neon data. `/healthz` makes no DB query, avoiding a health-check keep-alive loop.

[Neon pooling](https://neon.com/docs/connect/connection-pooling) accepts up to 10,000 pooled client connections, but actual backend concurrency depends on compute `max_connections`, not that headline limit. This app uses **three pooled connections/process**, no minimum warm pool, ten-second idle eviction and a single direct migration connection. Overlapping replacements may briefly double these small pools. No session-level locks, named prepared statements or session `SET` assumptions are used through PgBouncer. Timeout settings use `SET LOCAL` in transactions because [unsupported startup parameters](https://neon.com/docs/connect/connection-errors) can otherwise break pooled connections.

Sleep/cold starts and quota exhaustion can delay a recipient or invalidate a five-minute challenge. After the app wakes, refresh status and explicitly obtain a fresh challenge if expired. Never automatically retry a signature, claim submission or payment after an ambiguous response; refresh the invitation status first. Do not use a monitoring ping to prevent sleep. Free-tier persistence is not a production availability or disaster-recovery guarantee.

## Architecture and storage safety

```text
Chrome / Nimiq Pay -> Render trusted HTTPS edge
  -> public gateway 0.0.0.0:$PORT (exact Host/path/method allowlist)
  -> loopback-only async Postgres API
  -> Neon pooled runtime connections, verified TLS
Startup -> matching direct Neon connection -> transactional migrations/bootstrap
```

`npm run start:staging` loads no `.env` and has no SQLite fallback or import. It refuses non-production/non-TESTNET settings, spending flags, a spending network, positive fee/limit, RPC settings or any `DATABASE_PATH`. Pooled/direct URLs must target the same Neon endpoint/database. They are parsed into explicit driver fields; URL options cannot replace `rejectUnauthorized: true` or hostname validation. The normal SQLite start command also refuses Render/Postgres settings. A failed migration, unavailable database or missing organiser stops startup before the gateway opens. There is no writable ephemeral staging mode.

SQLite remains available for existing local development and the original tests. Its data/credentials/schema are not exported, migrated or used to seed Postgres. Legacy SQLite staging helper tests remain regression coverage only; the Render start command uses the new Postgres path exclusively.

Migrations under `server/postgres/migrations/` are versioned and checksummed. One direct-connection transaction and a transaction-scoped advisory lock serialize migration runners. Failed DDL/version writes roll back together; applied files may not be edited and newer unsupported versions abort. A nonempty unrelated database is rejected before schema changes. Startup inserts a new organiser hash once; a conflicting hash aborts rather than replacing it. `network=testnet` and a staging deployment marker are stored and immutable. There are no seeded campaigns or paid receipts.

| Boundary                        | PostgreSQL enforcement                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact Luna/timestamp values     | `bigint` safe-integer domain; driver rejects unsafe values instead of rounding                                                                   |
| Campaign invitation capacity    | Campaign row `FOR UPDATE`, count and insertion in one transaction                                                                                |
| Token secrecy/uniqueness        | Only SHA-256 token hash stored; UNIQUE token hash; fragment invitation URL returned once                                                         |
| Challenge refresh/claim         | Invitation row lock, then challenge row lock; prior unused challenge replaced under same invitation lock                                         |
| Claim proof                     | Original message, expiry and origin/network checked; original Nimiq envelope verifier derives signer address                                     |
| Replay/concurrent wallet claims | UNIQUE invitation, challenge and `(campaign_id,address)`; conditional challenge consumption in the claim transaction                             |
| Decisions/expiry                | Claim lock or conditional update; status change and history insert commit atomically; decisions are final                                        |
| Sessions/security limits        | Hashed durable sessions; atomic shared Postgres rate counters, using DB time                                                                     |
| Payment storage                 | Preserved intents/attempts/wallet authorizations/hashes/events; unique claim/intent/hash reservations                                            |
| Permanent locks/history         | Immutable intents/claim identity/campaigns/wallets; append-only events/hashes; attempts cannot be deleted, swapped or reset UNKNOWN → SUBMITTING |

Every transaction uses one checked-out `pg` client. Deadlock/serialization/uniqueness/lock conflicts return conflict responses; no automatic retry is performed after uncertain COMMIT outcomes. Pending attempts cannot be unlocked by browser state or a process restart. A stale SUBMITTING record can only become UNKNOWN with an appended event. The Postgres service deliberately implements **no** wallet binding, payment authorization/reservation/dispatch/outcome/reconciliation mutation endpoints. Those records' constraints are preserved and tested, while native execution remains disabled. Existing SQLite native payment/RPC regressions still run.

## Public and organiser boundaries

The gateway allows GET `/`, generated `/assets/*`, `/healthz`, `/api/config`, `/api/session`, authenticated campaign list/detail; POST login/logout, invitation/challenge/claim and authenticated campaign/invitation/decision operations. A permitted organiser path still requires the existing server-side authentication protocol. Login requires the fresh password and is rate-limited; there is no public setup, registration or credential retrieval. Recipient APIs strip cookies and require private invitation proofs. Other methods, hosts, query variants, source files, diagnostics/debugging and all wallet/payment/reconciliation routes are denied. The API independently rejects payment routes even on a valid organiser session. There is no sender-assurance bypass flag.

Exact HTTPS POST Origin checks, JSON/16 KiB body validation, HttpOnly/Secure/SameSite=Strict cookies, CSP/HSTS/no-referrer/no-store, scrypt organiser authentication and server signature verification remain. Shared HTTP validators/headers and the original crypto verifier serve both backends. No browser database connection exists. Public config reveals network/origin/staging flags, not gate internals. `/#diagnostics` and native payment controls remain unavailable. `/healthz` is minimal process liveness after successful database startup, not continuous DB readiness; database outages return generic 503 responses on operations.

Global shared rate buckets remain **10 login attempts/minute and 180 other API requests/minute**. They survive all API process replacements; spoofed forwarded IPs cannot evade them. Health checks bypass them and do not touch Postgres. These conservative global buckets can cause shared availability loss under abuse; this small supervised trial is not a general public production service. Driver/migration/API/backup errors log no URL, SQL value, token, signature or password. Do not enable body/cookie/query logging in platform tooling.

## Exact manual configuration — after separate approval

1. In an explicitly Free Neon organization/project, create a **fresh project**, e.g. `nimclaim-testnet-staging`, with Postgres **17** and an empty staging database. Prefer AWS Frankfurt near Render Frankfurt. Do not select Nimlane, an existing personal database, a data-bearing branch, Auth, a Data API or other paid capability. No local import is needed. Use the smallest available compute/normal scale-to-zero behavior and monitor the Free quota. Retain only necessary branches. [Project guidance](https://neon.com/docs/manage/projects).
2. In Neon's Connect dialog, select that same database/role and copy the **pooled** URL (hostname contains `-pooler`) and the **direct** URL (without it) privately. Retain TLS options; `sslmode=require`/`verify-full` and `channel_binding=require` are accepted, but the application always verifies the certificate/hostname. Do not paste either URL in chat, a command argument/history, Git, frontend variables or the existing local `.env`.
3. Generate a fresh organiser credential using the existing reviewed `node --import tsx ops/staging-credentials.ts` tool only when authorized to write new local staging credentials. It writes a protected ignored file and refuses overwrite; it never reads the real organiser password. Store the new password in a password manager. Only its scrypt hash belongs in Render; do not upload the credentials file.
4. After approval to push and deploy, review root `render.yaml` and create one **Free** Node service from this repository/main. No existing environment groups, secret files or databases should be linked. Verify the actual assigned `onrender.com` hostname; the name requested in YAML is not a hostname guarantee. Use exactly that HTTPS origin, without path/trailing slash or an alternate custom domain. Host mismatch intentionally fails closed; health checks must use the same hostname. If correcting a setting, use Save only until a deploy is separately authorized.
5. Enter all four prompted values privately. Initial creation starts a deploy; auto-deploy off only stops later automatic deployments. Do not Apply before the values/plan are reviewed.

| Render setting                    | Value                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Resource/runtime/plan             | One `web` / `node` / `free`, Frankfurt, one instance                                                                                 |
| Node                              | `24.14.1`                                                                                                                            |
| Build                             | `npm ci --include=dev && npm run build`                                                                                              |
| Start                             | `npm run start:staging`                                                                                                              |
| Health                            | `/healthz`, canonical Host                                                                                                           |
| Deploy policy                     | `autoDeployTrigger: "off"`; no pre-deploy command                                                                                    |
| Binding                           | Gateway `0.0.0.0`, Render's `PORT`; API loopback only                                                                                |
| Fixed env                         | `NODE_ENV=production`, `NIMCLAIM_STAGING=1`, `NETWORK=testnet`, `SPENDING_ENABLED=false`, `MAX_PAYMENT_LUNA=0`, `PAYMENT_FEE_LUNA=0` |
| `APP_ORIGIN`                      | Exact actual `https://<assigned-host>.onrender.com`                                                                                  |
| `DATABASE_URL`                    | Secret pooled URL for the **new** Neon staging database                                                                              |
| `DIRECT_DATABASE_URL`             | Secret direct URL to that same database, for startup migrations                                                                      |
| `STAGING_ORGANISER_PASSWORD_HASH` | Secret fresh scrypt hash; never the existing local hash                                                                              |
| Absent                            | Disk, Render database, workers/cron, `DATABASE_PATH`, `SPENDING_NETWORK`, `RPC_URL`, `RPC_AUTHORIZATION`, `VITE_*` secrets           |

The driver is `pg` 8.23.1 locked by `package-lock.json`. Versioned schema/bootstrap run during startup, not build: no DB write occurs during `npm run build`. Startup direct privileges must allow the migrations (tables, domain, functions/triggers and sequences); runtime needs access to the same schema. The default fresh Neon database owner works for this narrow deployment; its two URLs remain sensitive administrative secrets. A dedicated least-privilege runtime role is a future hardening step, not a reason to reuse an unrelated database.

The current public [Render JSON Schema](https://render.com/schema/render.yaml.json) validates this Blueprint. Render CLI is unavailable locally, so `render blueprints validate render.yaml` still needs an authenticated, approved workspace. It validates only and must not be replaced with Apply. [Blueprint reference](https://render.com/docs/blueprint-spec) and [secret handling](https://render.com/docs/configure-environment-variables) were retrieved and read. Never upload the workspace, local SQLite/WAL, logs, private CA, backup/key files or test screenshots. Render gets reviewed tracked source from Git only.

## Encrypted backups and restoration

Render Free has no shell/one-off jobs. Run backups from the owner machine with Node 24.14+, this reviewed source and PostgreSQL 17 `pg_dump`/`pg_restore` tools (use matching server major version, or review newer-version compatibility). Use a **direct** TLS URL. Keep an encrypted copy off the database host after each testing session and before changes; loss since the last backup remains possible. Neon short restore history does not replace this backup. No paid cron/storage service is required; use existing owner-controlled protected storage.

`ops/postgres-backup.ts` streams a custom-format [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) into AES-256-GCM encryption. It writes no plaintext archive, uses a fresh nonce, creates output exclusively with mode 0600, deletes incomplete output and never overwrites an existing backup. A separate 32-byte random key is required. The restore authenticates the entire ciphertext **before** invoking [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html), then restores with `--single-transaction --exit-on-error --no-owner --no-acl`. It refuses a nonempty destination in the CLI preflight. Archive decryption is bounded to 128 MiB of encrypted archive on the operator machine; larger archives require a reviewed alternative. Credentials go to libpq environment fields, never process arguments or output. Only trusted owner-created archives are eligible to restore.

Owner-operated examples, **after approval**, with paths outside this repository:

```sh
# Create this protected directory first. Never reuse existing local application keys.
node --input-type=module -e 'import{randomBytes}from"node:crypto";import{writeFileSync}from"node:fs";writeFileSync("/secure/nimclaim-backup.key",randomBytes(32),{flag:"wx",mode:0o600})'

# /secure/nimclaim-neon.env is a NEW owner-controlled 0600 file with DIRECT_DATABASE_URL.
# It is not the application's local .env. The filename, never its contents, appears in history.
node --env-file=/secure/nimclaim-neon.env --import tsx ops/postgres-backup.ts backup /secure/nimclaim-backup.key /secure/backups/nimclaim-2026-11-09.dump.enc

# Obtain separate approval for an EMPTY restore-test database. Never restore into the live stage.
# /secure/nimclaim-restore.env contains RESTORE_DATABASE_URL for that empty target only.
node --env-file=/secure/nimclaim-restore.env --import tsx ops/postgres-backup.ts restore /secure/nimclaim-backup.key /secure/backups/nimclaim-2026-11-09.dump.enc
```

Store the encryption key separately from encrypted archives, with a tested recovery path. Losing it makes the archive unusable. The owner should verify restored migration checksums, all constraints validated, matching campaign/claim/session/history counts, exact Luna values, organiser login and unchanged UNKNOWN locks. Test the restored application in isolation with its own canonical origin before any cutover. Shut off writes and take a final backup before a separately approved cutover; never delete/recreate an attempt to recover a payment. No cloud restore or real-record backup has been run in this task.

## Automated evidence and remaining acceptance

The original **94 tests passed**: 57 API/crypto/RPC/provider/SQLite-staging tests, three runtime tests, 17 desktop Chromium and 17 mobile Chromium tests. Typecheck and production build passed as part of that run. These remain real regressions for the local development path; they do not pretend to be hosted Android proof.

The added Postgres suite uses a real disposable Docker **PostgreSQL 17.11** engine, real SQL, real HTTP requests and separate Node API child processes, with synthetic records/keys only. It tests migrations twice/concurrently; initial and incremental migration failures/rollback/recovery/checksum mismatch; refusal of unrelated databases; slot/challenge/claim/decision races; unique wallet claims; exact integer parsing; signature/origin/replay/expiry protections; secure cookies/authentication; restored sessions and decisions after killed process replacement; durable limits across processes; payment route denial at both layers; immutable/append-only/hash/UNKNOWN constraints; database engine restart; encrypted real `pg_dump` and real `pg_restore`; wrong-key/tampered-archive refusal; and backup failure cleanup. The test runner waits for TCP-ready Postgres (not its initialization-only Unix socket), binds a stable loopback port for restart tests, and removes only its labelled disposable containers/volumes.

```sh
# Original suite, leaving the existing local services alone:
NIMCLAIM_TEST_API_PORT=3107 NIMCLAIM_TEST_WEB_PORT=5197 npm run check
# Requires Docker and a locally available postgres:17-alpine image; never reads .env:
npm run test:postgres
npm run typecheck
npm run build
npm run format:check
npm audit
# Or combine original checks plus actual Postgres integration:
NIMCLAIM_TEST_API_PORT=3107 NIMCLAIM_TEST_WEB_PORT=5197 npm run check:staging
```

Real local Postgres persistence/restore is evidence for the implementation, **not** a claim that Neon infrastructure, its TLS endpoint/PgBouncer, Render sleep/redeploy, Android trust or Nimiq Pay provider injection have been exercised. Those remain live acceptance work after separate approval. The Postgres test container uses synthetic loopback-only transport; production has no switch to disable verified Neon TLS. No system certificate is installed or TLS check bypassed.

After approved creation/deployment, before inviting recipients:

1. Confirm trusted HTTPS loads in Chrome and Nimiq Pay without installing a CA or bypassing TLS. Warm once manually if cold, then reopen the exact invitation in Nimiq Pay. A prior blank page is not yet independently diagnosed.
2. Confirm `/api/config` shows TESTNET and the exact hosted origin, unauthenticated campaign reads return 401, private/debug/payment paths are denied, and a fresh organiser sees no imported campaigns. Personally confirm host TESTNET; unknown or mainnet host metadata must fail closed before signing.
3. Create only new staging records. With **separate wallet-signing approval**, inspect the exact native `NimClaim/claim/v1` JSON: no-payment purpose, actual HTTPS origin, `testnet`, invitation/campaign/token hash, integer Luna, nonce and expiry. Rejection should leave no claim. A transfer/payment prompt is a stop condition. This task has not signed anything.
4. Verify one accepted claim and organiser decision, then a Render restart, sleep/wake and redeploy preserving the same sessions, invitations, claims and append-only history. An ambiguous response requires status refresh, not automatic resubmission. Approval remains unpaid.
5. Run an encrypted staging backup and restore into a separately approved empty target. Verify the restored application and data before relying on recovery. Record sanitized versions/status evidence only; hide credentials, tokens, signatures and wallet identifiers.

Actual provider/network/origin checks remain implemented and regression-tested; physical hosted Nimiq Pay compatibility stays **UNVERIFIED** until those owner checks pass. Payments, live RPC writes and mainnet are still prohibited.

## Final local verification and exact files

**PASS — 107 tests:** the complete original 94 plus **13 real PostgreSQL integration tests**. The final Postgres rerun also verifies explicit TRUNCATE guards, because row-level delete triggers alone cannot protect append-only history from PostgreSQL bulk truncation. The engine-restart test reconnects explicitly after invalidating old sockets; production does not automatically retry ambiguous business operations. Generic connection-unavailable messages during that deliberate engine restart are expected.

Typecheck, production build, formatting, dependency audit (zero reported vulnerabilities), whitespace checks and current Render JSON Schema validation passed. No DB URL/hash secret names or connection strings are present in the generated client bundle. Redacted Git-history and tracked-source secret scans passed with no leaks found. Platform-aware Render validation, real Neon TLS/PgBouncer, cloud sleep/redeploy/restore and physical Nimiq Pay remain untested until separately approved setup.

The exact changed files are:

| Purpose                                       | Files                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Free deployment/commands/driver               | `render.yaml`, `package.json`, `package-lock.json`, `ops/staging-start.ts`                                                              |
| Async Postgres API/storage/startup            | `server/postgres/app.ts`, `server/postgres/db.ts`, `server/postgres/store.ts`, `server/postgres/staging.ts`                             |
| Versioned SQL                                 | `server/postgres/migrations/001_claims.sql`, `server/postgres/migrations/002_payments.sql`, `server/postgres/migrations/003_limits.sql` |
| Shared HTTP/gateway and preserved SQLite path | `server/http-contract.ts`, `server/staging-gateway.ts`, `server/app.ts`, `server/index.ts`, `server/staging.ts`                         |
| Encrypted backup and publication exclusions   | `ops/postgres-backup.ts`, `.gitignore`                                                                                                  |
| Real integration/process/restore tests        | `tests/postgres/integration.test.ts`, `tests/postgres/run.ts`, `tests/postgres/worker.ts`                                               |
| Instructions/readiness/security               | `README.md`, `docs/RENDER-STAGING.md`, `docs/SECURITY.md`, `docs/MAINNET-READINESS.md`                                                  |
