# $0/month Render + Neon TESTNET staging

Prepared from local commit `207bcd2` without starting over. This replaces that commit's **paid disk proposal** with one Render Free Node web service and a separate Neon Free Postgres database. No cloud resource was created, commit pushed, site deployed, real wallet accessed, signature requested or NIM sent. The existing local SQLite database, `.env`, organiser credentials, private CA/runtime data and Nimlane are not migration inputs and were not changed.

## Verdict and next human action

**Neon infrastructure and public schema are initialized; Render deployment remains NO-GO.** The approved project is `nimclaim-staging` (`late-dew-24158174`), branch `main` (`br-lively-rice-b9pxx7a4`), database `nimclaim`, PostgreSQL 17 in AWS Frankfurt. Connection secrets are held only in the ignored, untracked, mode-0600 `.local/neon-staging.env`. The owning organisation is Free. This continuation does not authorize pushing, deploying, billing changes or wallet operations. See the dated evidence below for hosted verification results and remaining gates.

**Next human actions:** retain the private migration credentials locally; prepare a fresh staging organiser credential, the actual Render HTTPS origin, least-privilege runtime access and free-only workspace/quota checks. Do not create another Neon project. Pushing reviewed commits and creating the **Free** Render service require separate authorization. Do not click Create/Apply to obtain a preview: those actions start a deploy even with automatic deployments off.

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

1. **Already completed:** use only `nimclaim-staging` / `late-dew-24158174`, branch `main` / `br-lively-rice-b9pxx7a4`, database `nimclaim`, PostgreSQL **17**, AWS Frankfurt. Do not create another project, select Nimlane, import local records, or enable Auth/Data API. The three reviewed public migrations have been applied. Keep the existing Free plan, smallest compute and ordinary scale-to-zero behavior; monitor the quota. [Project guidance](https://neon.com/docs/manage/projects).
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

The driver is `pg` 8.23.1 locked by `package-lock.json`. Versioned schema/bootstrap run during startup, not build: no DB write occurs during `npm run build`. Startup direct privileges must allow the migrations (tables, domain, functions/triggers and sequences); runtime needs access to the same schema. The supplied URLs currently authenticate as the database owner; they are operator migration credentials, not approved permanent application credentials. **Least-privilege separation is a pre-deployment gate.** Do not upload this owner credential file or place its contents in Render while this gate is open. See the explicit access plan below. The current Blueprint/startup still requires a direct migration credential, so it is not ready to apply unchanged.

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

Typecheck, production build, formatting, dependency audit (zero reported vulnerabilities), whitespace checks and current Render JSON Schema validation passed. No DB URL/hash secret names or connection strings are present in the generated client bundle. Redacted Git-history and tracked-source secret scans passed with no leaks found. The original commit did not test Neon. The dated continuation evidence below supersedes that limitation for direct/pooled TLS and the hosted checks actually listed; platform-aware Render validation, cloud sleep/redeploy/restore and physical Nimiq Pay remain unverified.

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

## Hosted Neon verification — 2026-11-09 continuation from 08b65e4

This section records actual hosted results, distinct from the original disposable PostgreSQL tests above. No Render service, deploy, push, billing change, wallet connection, RPC call or payment was performed. Existing `.env`, SQLite records, organiser credentials and certificates were not migration inputs or edited. No production startup, migration SQL, sender restriction or HTLC rule was changed.

### Identity, private configuration and migration evidence

- Neon metadata tied the approved project ID to `main` / `br-lively-rice-b9pxx7a4` and endpoint `ep-royal-sunset-b9d4cl7u`. Database name was checked independently through Neon MCP and each supplied connection. PostgreSQL reported `17.11`.
- The credential file is a regular file with mode `0600`, ignored by Git and absent from the index. Tools parse it internally; they never source the existing `.env`, print driver errors, echo URLs or pass secrets in command arguments. The verification helper pins both exact approved hosts and the database name and refuses a mismatch before connecting.
- Both direct and pooled application-facing sockets were encrypted and authorized by Node's trusted certificate store. Explicit `checkServerIdentity` accepted the correct host and rejected `wrong-host.invalid` against each peer certificate. No CA override or verification bypass was introduced. Neon's internal `pg_stat_ssl.ssl=false` is not the client-facing TLS status; checking it initially produced a false diagnostic failure. The verified socket is the relevant evidence. See the [driver's TLS implementation](https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/connection.js).
- Immediately before DDL, the initialization transaction acquired the same advisory lock as the reviewed migrator and verified zero user relations, non-extension functions/types and additional user namespaces. No unexpected objects existed. The initial zero-table state was also independently checked through MCP.
- Every SQL file was compared byte-for-byte with `08b65e4` before execution. Only the existing migration ledger and these three reviewed migrations were applied; the only initial application rows are the two immutable TESTNET/deployment settings.

| Version | File               | SHA-256                                                            |
| ------- | ------------------ | ------------------------------------------------------------------ |
| 1       | `001_claims.sql`   | `29437cd523985e89b3e2a752d653dc4559d3d94916129a4df896ad7b0d8f3eb7` |
| 2       | `002_payments.sql` | `6eb2f9baeae027ed6f605988b9cd90fa55d6e9d1d3b775d8d657aa00eaa33a5d` |
| 3       | `003_limits.sql`   | `336af74ab07bfce58224e0142001a675b2f5294ccc0e5bafd1fc299fef77ff4b` |

The existing `migrate()` was rerun twice after commit. All ledger versions, checksums and application timestamps remained identical. Independent read-only catalog inspection found **16 public tables, three application functions, 21 application triggers and zero unvalidated constraints**. Public campaigns, claims, sessions, organisers and payment attempts remain empty. The real staging organiser is deliberately not bootstrapped with a synthetic password.

### Hosted synthetic checks and persistence

The explicit operator command `node --import tsx tests/postgres/neon.ts test` creates a fresh schema with no `public` search-path fallback, copies only the reviewed application DDL there and starts two loopback-only API child processes against verified direct Neon connections. It uses ephemeral generated signing keys and a synthetic organiser password; no wallet or funded identity is used. The production entry point never imports this harness. The supplied pooled connection independently reads committed test data inside a transaction with `SET LOCAL search_path`, without assuming PgBouncer preserves session state.

**PASS — final hosted run**, schema `nimclaim_verify_56263f5c6baeb2d1`:

- Two separate API processes serialized campaign capacity; duplicate token hashes were rejected.
- Concurrent signed claims consumed a challenge once; competing invitations for one campaign/address produced one winner and rolled back the losing challenge's consumption.
- UNKNOWN attempts could not reset to SUBMITTING or be deleted. Intent amounts and claim identity remained immutable; events and hashes rejected update/delete, and payment-history TRUNCATE was rejected.
- After SIGKILL of one process, graceful shutdown of the other and a fresh replacement, the hashed session remained authenticated, the exact Luna amount and decision/history survived, expired claims retained their expiry history, and both shared rate buckets still rejected requests. Explicitly expiring the synthetic session then made it unauthenticated.
- The pooled connection independently read the committed session, claim status, expiry/history and UNKNOWN lock from that isolated schema. Payment mutation routes remained unavailable.
- All public application activity tables remained empty and the public migration ledger was unchanged.

Each run retains its clearly named schema for review; it does not drop any schema/table, truncate real data or remove public records or retained test fixtures. The first run's schema, `nimclaim_verify_e6609655330487d1`, remains isolated and contains partial fixtures. It stopped on a timing assumption: the earlier login bucket had legitimately expired while remote checks ran, so the test observed 10 successes instead of its expected 9. The corrected test establishes its own synthetic rate window and asserts 10 successes plus two HTTP-429 domain errors, then tests persistence through replacement. This changes only the test fixture, not the application's rate-limit logic.

The verification distinguishes process restart from a database-engine restart. Only the disposable local PostgreSQL engine was restarted; the hosted Neon compute was not restarted or deliberately kept awake. Render sleep/redeploy and physical Nimiq Pay acceptance remain untested.

### Commands, access plan and remaining Render Free gates

Executed commands (no command contains a connection secret):

```sh
npm run check:staging
npm run typecheck
npm run build
npm run format:check
npm audit --json
node --import tsx tests/postgres/neon.ts initialize
node --import tsx tests/postgres/neon.ts test
node --import tsx ops/neon-secret-scan.ts
git diff --check
```

`initialize` is a one-time operation that refuses an already populated database; it is not the rerun command. It performed the preflight and additive application initialization in one transaction, then invoked the reviewed migrator twice for idempotency. Future application migration execution uses `migrate()` after an independently reviewed plan; do not bypass the empty-database refusal or edit applied files.

The full existing suite is **107 passing tests**: 57 unit/domain/API tests, three runtime tests, 17 desktop browser tests, 17 mobile browser tests and 13 disposable PostgreSQL integration tests. Deliberate connection-loss tests emit generic `Database connection unavailable` lines; their assertions pass. Initial new-harness typecheck errors involved circular type inference and an untyped proof array; both were corrected before initialization. The final build includes typecheck. Dependency audit reports **zero vulnerabilities**. The secret scanner checks tracked files, pending source additions, all reachable Git history blobs and the generated client bundle against the private URLs/passwords and high-confidence credential/key patterns; it prints counts only. It is a targeted scan, not a guarantee against every possible secret format. Credentials and runtime logs remain ignored.

Before deployment, implement and verify this least-privilege access split:

| Identity                 | Required access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Prohibited access                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local migration operator | Existing owner/direct connection for reviewed migrations and one-time fresh organiser bootstrap                                                                                                                                                                                                                                                                                                                                                                                                     | Permanent Render environment or frontend exposure                                                                                                                  |
| Dedicated runtime login  | CONNECT to `nimclaim`, USAGE on `public`; SELECT on required application tables; INSERT/DELETE sessions; INSERT campaigns/invitations plus minimal column UPDATE privileges needed for their SELECT FOR UPDATE locks (campaign mutation still fails its trigger); INSERT/UPDATE/DELETE challenges; INSERT/UPDATE claims; INSERT events; INSERT/UPDATE staging_rate; UPDATE only payment-attempt state/reason/updated for stale-to-UNKNOWN; INSERT payment_events; USAGE on required event sequences | Owner membership, superuser, role/database creation, schema CREATE, DDL, TRUNCATE, trigger disablement, intent/attempt/hash insertion or grants to other databases |

Create a fresh runtime role with no administrative memberships and a new privately saved password; do not rotate or reuse the existing owner/local passwords. Verify the role's effective permissions and positive/negative API cases on Neon. Keep the approved migration operator secret off Render. The current `startFromEnvironment()` always performs migrations/bootstrap and the current Blueprint prompts for `DIRECT_DATABASE_URL`; separating those operator tasks from read-only runtime schema/organiser validation is **still required before deployment**. A restricted runtime login alone does not solve that startup dependency. No owner credential has been published or placed on Render during this task.

Remaining human inputs and deployment sequence:

1. Retain the private connection file locally. Keep this Neon project/branch/database and Free billing unchanged; do not create another project or import personal records.
2. Prepare a fresh staging organiser password/hash with `node --import tsx ops/staging-credentials.ts` only if its new output path does not already exist. The tool refuses overwrite. Preserve existing credentials and store the new password privately. Bootstrap that hash using the local migration operator after the access split is implemented; public organiser is currently empty.
3. Complete the least-privilege startup/access gate above. Enter only the dedicated pooled runtime credential into Render after it passes verification. Do not upload `.local/`, the private env file, credentials JSON, certificates, SQLite data, logs or backups.
4. Confirm the actual Render workspace is free-only and check quota/billing behavior without changing another project's billing. Validate `render.yaml` using Render's platform-aware validator when available. This continuation did not recheck pricing or platform quotas.
5. Obtain separate authorization to push and create one Frankfurt **Free** Node web service. Creating/applying deploys. Use `npm ci --include=dev && npm run build`, then the reviewed staging start command, `/healthz`, auto-deploy off, the actual assigned HTTPS origin, TESTNET and all zero/false spending settings shown above. The Blueprint must first reflect the credential separation; do not apply it unchanged.
6. After separately authorized hosting, verify Android/Nimiq Pay signing, Render restart/sleep/redeploy and encrypted backup/restore into a separately approved empty destination before inviting recipients. Mainnet, payments, native sender bypasses and HTLC relaxation remain NO-GO.
