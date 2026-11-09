# Runtime grant replacement review — 2026-11-09

Status: APPLIED after explicit user approval on 2026-11-09. The approved transaction committed on the exact target; independent verification passed. Starting commit: `29966c4` (clean tree). Initial findings and pre-approval results below are historical; see the execution results at the end.

Target: `nimclaim-staging`, project `late-dew-24158174`, branch `br-lively-rice-b9pxx7a4`, database `nimclaim`. Execute only through this explicit target as `nimclaim_owner`. SQL cannot identify the Neon project/branch; the execution connection must pin both IDs.

## Live read-only findings

- `nimclaim_app`: LOGIN, INHERIT; no superuser, CREATEDB, CREATEROLE, replication or BYPASSRLS. No memberships in any other role. The owner has administrative membership **in** the application role; this does not grant the application access to the owner.
- Owner retains database/table/function/sequence ownership. Public schema belongs to `pg_database_owner`. Runtime owns no reviewed objects.
- All 16 public tables have direct SELECT only; no column ACLs or PUBLIC table ACLs. Owner default privileges grant future public-table SELECT to runtime. This default must be removed explicitly.
- Database CONNECT exists; CREATE is denied; TEMP is inherited from PUBLIC. Public-schema USAGE exists; CREATE is denied. Two historical verification schemas deny runtime USAGE and CREATE and have no runtime table grants. They remain untouched.
- All six non-system sequences deny runtime SELECT, USAGE and UPDATE. Runtime cannot SET `session_replication_role` or `allow_system_table_mods`.
- Nine non-system functions (three public and six in inaccessible historical schemas) return `trigger`, run as invoker, and inherit PUBLIC EXECUTE. None is SECURITY DEFINER. They cannot be called as ordinary functions; no function EXECUTE grant/revoke or function-definition change is proposed. PUBLIC language/domain usage remains standard PostgreSQL behavior, without schema CREATE.
- Provider-managed `cloud_admin` defaults target `neon_superuser`, not runtime; leave them alone.
- Three migration records, one organiser, zero public campaigns. No record contents or credential material retrieved for publication.

## Exact grant-to-query mapping

Sources: `server/postgres/app.ts`, `store.ts`, `schema.ts`, `permissions.ts` and all three existing migrations. The existing `ops/nimclaim-app-grants.sql` matches the runtime's exact column-privilege verifier. Keep that canonical grant fixture unchanged; the new self-contained replacement transaction is `ops/nimclaim-app-restrict.sql`.

| Table                | SELECT                        | INSERT                              | UPDATE                 | Actual runtime requirement                                               |
| -------------------- | ----------------------------- | ----------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| schema_migrations    | version, checksum             | —                                   | —                      | Startup migration version/checksum comparison; deny applied timestamp    |
| settings             | All                           | —                                   | —                      | Startup key/value identity and TESTNET check                             |
| organiser            | All                           | —                                   | —                      | Password hash lookup WHERE id=1; startup validation                      |
| sessions             | All                           | All                                 | expires                | Authenticate by hash/expiry; login insert; logout expiry                 |
| campaigns            | All                           | All                                 | id                     | List/detail/expiry and INSERT RETURNING *; capacity SELECT FOR UPDATE    |
| invitations          | All                           | All                                 | id                     | Token lookup, campaign counts, issue insert and invitation row lock      |
| challenges           | All                           | id, invitation_id, message, expires | used                   | Verify locked proof; default unused on insert; invalidate/consume        |
| claims               | All                           | All                                 | status                 | SELECT */row lock, full signed-claim insert, expiry/decision transition  |
| events               | All                           | claim_id, status, at                | —                      | Append claim history; read history ordered by identity id                |
| campaign_wallets     | campaign_id, address, created | —                                   | —                      | Campaign wallet display/lookup; deny public_key, signature, challenge_id |
| payment_intents      | All                           | —                                   | —                      | Existing receipt lookup uses SELECT * and intent returned in view        |
| payment_attempts     | All                           | —                                   | state, reason, updated | Existing SELECT *; stale SUBMITTING to UNKNOWN with RETURNING            |
| payment_events       | All                           | attempt_id, state, reason, at       | —                      | Append stale UNKNOWN history; read ordered by identity id                |
| staging_rate         | All                           | All                                 | count, until           | Atomic UPSERT reads key/count/until; RETURNING count                     |
| organiser_challenges | —                             | —                                   | —                      | No staging route/query needs access                                      |
| payment_hashes       | —                             | —                                   | —                      | No staging route/query needs access                                      |

`campaigns.id` and `invitations.id` UPDATE are needed solely for SELECT FOR UPDATE. Campaign mutation is rejected by its immutable trigger; invitation ID mutation with dependent rows is constrained by foreign keys. They are not general UPDATE grants. PostgreSQL requires UPDATE on at least one column for these row locks ([PostgreSQL 17 privileges](https://www.postgresql.org/docs/17/ddl-priv.html)). Identity history INSERT paths need no sequence grants; explicit nextval/setval remains denied.

All table-wide reads listed above are necessary for the current SQL shape, including SELECT *. In particular, runtime retains organiser password-hash reads and all payment-attempt columns, including permit_hash. This proposal does not claim to hide those from the server role. Removing unused SELECT * fields would require a separate API/permission-contract change. Broad sensitive reads denied by this plan are organiser_challenges, payment_hashes, wallet proof columns and the migration timestamp.

ACLs do not provide row authorization. Event insertion is intentionally permitted; UPDATE/DELETE/TRUNCATE history tampering is denied, but the role can append history entries directly. Claim/challenge consumption still relies on the existing transactional SQL and constraints. This review does not claim that a compromised runtime role is unable to fabricate an append or bypass application-level rules. Existing immutable payment locks, duplicate prevention, consumption SQL and TESTNET enforcement remain unchanged.

## Transaction proposed for approval

Review the full self-contained `ops/nimclaim-app-restrict.sql` before execution. Its exact changes are:

1. BEGIN with bounded lock/statement timeouts; assert database/operator, existing non-administrative LOGIN and absence of outbound memberships.
2. ALTER the existing role to NOINHERIT (branch-wide role attribute), as required by `verifyRuntimeRole`; no password or membership change.
3. Revoke SELECT on all current public tables from runtime (16 tables); revoke the owner's future public-table default SELECT for runtime.
4. Revoke database TEMPORARY from PUBLIC (affects all non-owner/non-explicitly-granted roles in this database); repeat public-schema PUBLIC CREATE revocation, currently already absent.
5. Grant database CONNECT, public-schema USAGE and exactly the table/column rights above, without grant options.
6. COMMIT. Any failure requires rollback; no partial completion is acceptable.

No other schema, table, sequence, function, default privilege, owner, membership, credential or data change is proposed. No migration, organiser bootstrap or role creation. No DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, sequence, grant-option or DDL rights are added. PostgreSQL sums direct, inherited and PUBLIC grants; a role-only TEMP revoke cannot counter PUBLIC TEMP ([PostgreSQL 17 REVOKE](https://www.postgresql.org/docs/17/sql-revoke.html)).

## Verification and remaining gates

After approval: recheck catalog state, execute only the reviewed transaction against the exact target, inspect final effective column/object/default privileges, and exercise positive/negative SQL under `SET LOCAL ROLE nimclaim_app` in rollback-only transactions. Those probes must not print rows. Rollback does not reverse identity sequence increments, so history-insert probes need explicit accounting. Do not create privileged hosted fixture schemas or alter grants/schema to simulate negative cases.

Once the separately configured private restricted password is available, preserve the old prepared credential file until the user replaces it privately. Run `npm run staging:verify -- .local/neon-runtime.env`, then restricted hosted API acceptance (signed claim, duplicate/replay rejection, logout/refresh, decisions/history, disabled payments, restart persistence). Local Docker results do not count as hosted acceptance. The existing hosted helper is owner-only/read-only and is not restricted acceptance.

Render Free: NO-GO pending approved ACL application, fresh private runtime credentials, restricted hosted preflight/acceptance, actual HTTPS origin and Free workspace/quota/billing checks. Push, deployment, billing, payments and wallet transactions remain unauthorized.

## Pre-approval verification results

- `npm run check:staging`: PASS, all 114 regression tests (57 unit/API, 3 runtime, 17 desktop, 17 mobile, 20 PostgreSQL), including typecheck and production build.
- Additional disposable PostgreSQL 17 transition check: PASS. A local fixture reproduced LOGIN/INHERIT, broad SELECT, the owner-to-app administrative membership and future-table defaults; the exact replacement file committed successfully, `verifyRuntimeRole` passed as `nimclaim_app`, and runtime default ACL entries were absent afterward. Fixture roles/data existed only in the disposable container, which was removed. No hosted migrations or fixtures ran.
- Hosted direct/pooled verified TLS, canonical schema, migration checksums and TESTNET identity: PASS, read-only **owner-only** evidence.
- Formatting, dependency audit (zero vulnerabilities), source/history/bundle secret scan and whitespace checks: PASS.
- Hosted permission changes, restricted preflight and hosted acceptance: NOT EXECUTED, awaiting explicit approval and separately configured runtime credentials.

Reviewed transaction SHA-256: `3c0732ab68874870e221e13a1ab1fb648ff6440af8b286402fc91ef98e176420`. Recheck this digest and live state before execution; changes require a fresh review.

## Approved execution and independent verification — 2026-11-09

The user explicitly approved only the reviewed transaction and target. Its SHA-256 remained `3c0732ab68874870e221e13a1ab1fb648ff6440af8b286402fc91ef98e176420`, matching the successful PostgreSQL 17 audit. A repeat disposable PostgreSQL 17 audit passed before hosted execution. Neon endpoint metadata independently matched the exact project and branch to the pinned direct host; no connection URL or password was retrieved or printed.

Execution used the protected direct operator connection with verified TLS. The live initial privilege matrix, role flags, memberships, schemas, function types/owners, defaults and ownership matched the reviewed starting state. The approved BEGIN and COMMIT were sent separately so that read-only assertions could run before COMMIT; every approved intervening SQL statement was preserved. No additional permission mutation was introduced. Precommit checks verified the exact replacement column/object/default matrix, unchanged canonical schema and unchanged fingerprints for all 46 public/historical tables. COMMIT succeeded. A fresh connection repeated the effective ACL and fingerprint checks successfully, and canonical schema validation passed.

The committed role is LOGIN/NOINHERIT with no administrative attributes or outbound memberships. CONNECT and public USAGE remain; database CREATE/TEMP and schema CREATE are denied. The exact reviewed SELECT/INSERT/UPDATE matrix is effective. DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, grant options, sequence access, unsafe parameter access and executable SECURITY DEFINER paths are absent. Runtime future-object default ACL entries and PUBLIC future-table grants are zero. Provider defaults and historical schemas remain unchanged.

Two owner-based role-verification attempts were refused **after** the successful commit: a startup role option and explicit SET ROLE. Subsequent membership inspection explains this: owner membership in runtime has ADMIN=true, INHERIT=false and SET=false. ADMIN plus the owner's CREATEROLE permits the approved attribute alteration; it does not permit impersonation. No membership was changed. The execution helper therefore exited nonzero after recording successful precommit, commit, fresh postcommit and schema checks; this was a failed follow-up verification method, not a failed or uncertain transaction. No transaction retry occurred.

The Neon connector then authenticated directly as `nimclaim_app`, with both session_user and current_user independently confirmed. All four catalog queries from the runtime verifier passed against that authenticated role, including its exact **82-column** SELECT/INSERT/UPDATE matrix and escalation/ownership/object checks. These queries were inspected and evaluated directly; this is not a claim that the local `staging:verify` CLI ran.

A transaction through that same authenticated runtime role completed these checks:

- **15 positive SQL statements:** required SELECT, session INSERT/expiry UPDATE, campaign INSERT/row lock, invitation INSERT/row lock, challenge INSERT/consumption UPDATE, claim INSERT/decision UPDATE, zero-row event/history INSERTs, zero-row stale-attempt UPDATE and rate UPSERT.
- **24 permission denials (42501):** DELETE, TRUNCATE, CREATE table/schema/temp table, ALTER/DROP table, both unused sensitive-table reads, wallet-proof/migration-timestamp reads, event identity override, payment-history UPDATE/DELETE, permit/receipt mutation, settings mutation, explicit sequence nextval/setval/read, replication bypass, role administration, owner membership escalation and SET ROLE owner.
- **Three constraint rejections:** campaign mutation and reversal of a final claim decision (23514), plus duplicate claim insertion (23505).

Positive fixtures ran in an exception subtransaction that was deliberately rolled back; rollback and fixture absence were asserted before completion. Every prohibited statement was required to raise insufficient_privilege. No identity value was allocated, and no sequence call succeeded. Event INSERTs were deliberately zero-row to avoid irreversible sequence increments; actual hosted identity allocation and terminal payment fixture acceptance were not exercised. No privileged hosted fixture schema, migration, credential change or grant alteration was used for verification.

**Remaining gate:** the connector proves direct runtime authentication and database permission behavior, but the existing private runtime env file remains the historical prepared credential. A fresh private runtime password/pooled credential must be configured separately, without owner credentials. `npm run staging:verify -- .local/neon-runtime.env` can then proceed, followed by restricted hosted API/restart acceptance. Neither has been claimed as executed in this continuation. Render Free remains **NO-GO**; actual origin and Free workspace checks also remain pending.

Post-execution local checks: all **114 regression tests** passed again (57 unit/API, 3 runtime, 17 desktop, 17 mobile, 20 PostgreSQL), with typecheck and production build. Formatting, dependency audit (zero vulnerabilities), source/history/bundle secret scans and whitespace checks passed. All **264 protected baseline files** retained their contents and permissions, including the prepared runtime file, organiser credential, local records/certificates and Nimlane. The approved SQL file remained byte-identical. Local HEAD remains `29966c4`; only the runbook modification and new review/SQL files are uncommitted. Nothing was pushed.

## Restricted pooled runtime and hosted API acceptance — 2026-11-09

The user confirmed a replacement restricted pooled credential was privately saved. `npm run staging:verify -- .local/neon-runtime.env` **PASS, exit 0**. The runtime file is a regular, non-symlink, ignored, untracked file with mode **0600**; it contains only `DATABASE_URL`. Its contents were neither printed nor changed. Application processes received only this restricted connection and explicit production/TESTNET/disabled-spending settings; no application owner connection, hash, migration or bootstrap secret was supplied.

Fresh SQL independently confirmed both `session_user` and `current_user` are **nimclaim_app**, database **nimclaim**, at the exact pinned pooled endpoint for the approved target. Runtime effective-privilege verification passed, including the exact **82-column** contract. The TLS socket was encrypted and authorized; certificate identity matched the connection hostname and rejected a wrong hostname. A separate negative handshake using `wrong-host.invalid` failed with **ERR_TLS_CERT_ALTNAME_INVALID**. The application explicitly constructs verified TLS options from parsed fields, avoiding the [node-postgres connection-string SSL override](https://node-postgres.com/features/ssl). Stored and configured network are TESTNET; spending is false and fee/limit settings are zero.

Hosted acceptance used separate production-mode Node API child processes with the actual staging startup/configuration functions, both gateway and backend bound to OS-assigned **127.0.0.1** ports. Existing application listeners were left running. The reserved origin `https://nimclaim-hosted-acceptance.invalid` was used only as an application binding and HTTP Host/Origin in loopback requests; this does **not** establish deployed HTTPS or physical wallet-provider acceptance. Ephemeral unfunded Ed25519 test keys signed only the Nimiq claim-message envelope, with no real wallet or transaction access.

**PASS — nine hosted acceptance groups, exit 0:**

1. Restricted runtime identity and verified pooled TLS.
2. Health/config, unauthenticated campaign denial, secure organiser login cookie, authenticated session and campaign-list reads.
3. Clearly labelled synthetic campaign/detail, two private invitations, and capacity rejection.
4. TESTNET/origin-bound signed claims; invalid signature, replaced nonce, replay and duplicate wallet rejection. Actual identity-backed history INSERTs succeeded without sequence ACLs.
5. Two final **rejected** decisions, pending → rejected history, reversal rejection, and null payment views. No claim was marked paid or payment-ready.
6. Payment dispatch and wallet paths denied at both boundaries: gateway **404**, backend **403**.
7. Complete API shutdown/restart retained the authenticated session and identical campaign, invitations, claims, history and payment-gate views, with database snapshots unchanged across restart.
8. Logout, second login/logout, another shutdown/restart and old-cookie refresh confirmed durable revocation and unauthenticated organiser reads.
9. Final database comparisons confirmed unchanged organiser, settings, reviewed migration version/checksum ledger, wallet and payment tables, and all pre-existing sessions. Both new sessions have expiry zero.

A separate rollback-only runtime probe passed **nine 42501 denials**: session DELETE; organiser_challenges/payment_hashes reads; wallet public-key and migration timestamp reads; payment-intent mutation; explicit event nextval; temporary-table creation; SET ROLE owner. No explicit sequence allocation succeeded and no grant, schema or credential changed.

### Synthetic data accounting and limits

Before the run, campaigns, claims, payment intents and attempts were empty. The committed fixture is explicitly titled **SYNTHETIC ACCEPTANCE ONLY** with a unique run marker; its description disclaims real contributors, entitlement and payment, and its expiry was set 15 minutes after creation. It retains **1 campaign, 2 invitations, 4 challenges, 2 rejected claims and 4 claim-history entries**. Two added organiser sessions were revoked. Ordinary durable API/login rate counters also changed. These are isolated by campaign/run identity within the approved staging database, not a new schema or branch.

The role deliberately cannot delete these audit records; no owner cleanup or broader permission was requested or used. Four identity-backed claim-history entries were committed and their allocations are not reversible by runtime. Fixtures remain clearly synthetic and rejected; payment intents, attempts and payment-history entries remain **zero**. The retained run manifest and runner are ignored local evidence at `.local/hosted-acceptance-result.json`, `.local/hosted-acceptance.mjs`, `.local/hosted-worker.mjs` and `.local/runtime-negative.mjs`. The runner requires an empty campaign/claim/payment baseline and must not be blindly rerun against the retained fixture. Native terminal-payment fixtures, provider RPC, hosted database-engine restart and hosted restore were not exercised.

### Final local verification and readiness

`npm run check:staging` **PASS, exit 0: 114 tests** (57 unit/API, 3 runtime, 17 desktop, 17 mobile, 20 disposable PostgreSQL), with TypeScript and production build. Formatting, dependency audit (**zero vulnerabilities**), source/addition/history/bundle secret scans and whitespace checks passed. All **231 pre-existing protected local files** in the captured `.env`, `.local` and `data` baseline retained their contents and modes. No code fix was needed. The SQL remains byte-identical to the reviewed SHA-256 `3c0732ab68874870e221e13a1ab1fb648ff6440af8b286402fc91ef98e176420`; its opening proposed-only comment is retained as part of that immutable reviewed artifact, not an instruction to execute it again.

**Restricted hosted runtime acceptance: GO. Render Free deployment: NO-GO.** Remaining pre-deployment gates are the actual Render HTTPS origin, current Free workspace/quota/billing checks and platform-aware Blueprint validation (Render CLI remains unavailable), followed by separate push/deployment authorization. Physical Android/Nimiq Pay, Render sleep/wake/redeploy and encrypted hosted backup/restore remain post-deployment gates before inviting recipients. This continuation did not push, deploy, alter billing or database permissions, reset credentials, enable payments, run migrations/bootstrap, access a real wallet or modify Nimlane. All acceptance API processes were stopped.
