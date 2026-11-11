# Render MAINNET claims deployment

## Read-only MAINNET RPC configuration

Set `NIMIQ_READONLY_RPC_URLS` in the existing Render service environment to
a comma-separated list of HTTPS RPC origins. For example, the public Nimiq
Watch endpoint is `https://rpc.nimiqwatch.com`; it is rate-limited and has no
uptime guarantee, so configure a healthy backup or a dedicated node for
production. The runtime uses only read methods and still rejects `RPC_URL`,
`RPC_AUTHORIZATION`, spending network settings and all broadcast paths.


The active public MAINNET service is [nimclaim-mainnet-smv5.onrender.com](https://nimclaim-mainnet-smv5.onrender.com), deployed on Render from `main` in Frankfurt on the Free plan, with automatic deploys disabled. It supports private campaigns, organiser wallet binding, signed recipient claims and review using Neon PostgreSQL 17. **NimClaim never initiates or escrows NIM transfers.** Organisers pay through Nimiq Pay and can submit a transaction hash for read-only MAINNET verification. The runtime records an immutable receipt only after exact sender, recipient, amount, canonical execution and macro finality checks. The separate TESTNET staging blueprint uses `render.yaml` and `start:staging`; it is not the active MAINNET service.

## Production environment

[`render.production.yaml`](../render.production.yaml) defines `nimclaim-mainnet`, a separate Render web service. It uses `npm ci --include=dev && npm run build`, starts with `npm run start:mainnet`, and exposes `/healthz` after startup checks succeed. The production application does not load `.env`, create an organiser at startup, migrate on boot, import data or fall back to SQLite. Organiser workspaces are created only after a wallet signs a one-time authentication challenge.

| Variable                   | Required value                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_VERSION`             | `24.14.1` (Render build/runtime)                                                                                                                                      |
| `NODE_ENV`                 | `production`                                                                                                                                                          |
| `NIMCLAIM_PRODUCTION`      | `1`                                                                                                                                                                   |
| `NETWORK`                  | `mainnet`                                                                                                                                                             |
| `SPENDING_ENABLED`         | `false`                                                                                                                                                               |
| `MAX_PAYMENT_LUNA`         | `0`                                                                                                                                                                   |
| `PAYMENT_FEE_LUNA`         | `0`                                                                                                                                                                   |
| `APP_ORIGIN`               | Exact assigned HTTPS URL, e.g. `https://nimclaim-mainnet.onrender.com`. Include any Render hostname suffix; omit paths, trailing slash and ports.                     |
| `PRODUCTION_DATABASE_HOST` | Direct endpoint hostname of the new Neon project, e.g. `ep-<production-id>.<region>.aws.neon.tech`, without `-pooler`, scheme or port.                                |
| `DATABASE_URL`             | Pooled URI for `nimclaim_app` and database `nimclaim_mainnet` at the corresponding `-pooler` hostname. TLS and hostname verification are enforced by the application. |
| `PORT`                     | Provided by Render; the start script defaults to `10000` outside Render.                                                                                              |

`APP_ORIGIN` is the sole browser/signing origin and gateway Host. Start with the assigned Render subdomain and no custom domains; Render uses its subdomain for health checks when there is no verified custom domain. Use one origin for links, sessions, signatures and health checks. [Render health check Host rules](https://render.com/docs/health-checks#http-health-checks-web-services-only)

Leave `NIMCLAIM_STAGING`, `NIMCLAIM_MOBILE_TEST`, `DATABASE_PATH`, `DIRECT_DATABASE_URL`, `SPENDING_NETWORK`, `RPC_URL`, `RPC_AUTHORIZATION`, test settings and organiser passwords/hashes out of the Render service. The service needs no signing key, seed, funded wallet, RPC credential or shared session secret. New organisers authenticate with their own Nimiq Pay wallet; no wallet PIN, seed phrase or private key is sent to NimClaim. It issues its own host-only Secure session cookie (`nimclaim_mainnet_session`) and stores token hashes only in its production database.

## Historical provisioning and upgrade runbook

The current MAINNET service described above is already provisioned and deployed. The following steps are retained for audit, recovery planning or a separately approved replacement environment. **Do not repeat the initial Neon project creation, bootstrap or Blueprint setup for the current service.** Preserve its existing database, organiser workspaces and credentials.

1. In Neon, create a **new project**, PostgreSQL **17**, in a region near the Render service (Frankfurt for this Blueprint). Create a fresh database named `nimclaim_mainnet`. Keep its direct owner URI and endpoint separate from TESTNET. Enable a history window appropriate to the campaign and plan a restore exercise on an isolated branch. Do not clone staging, import SQLite, or seed acceptance campaigns. [Neon database access](https://neon.com/docs/manage/database-access) · [Neon history window](https://neon.com/docs/postgres/backup-restore/history-window)
2. Using the new database's owner connection, create the dedicated runtime role **through SQL**. Console-created roles may have `neon_superuser`, which runtime startup rejects. Set a fresh, high-entropy password via an interactive `psql` `\password nimclaim_app` prompt over verified TLS; store it securely. Do not embed a password in SQL history or command-line arguments.

   ```sql
   CREATE ROLE nimclaim_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
     NOINHERIT NOREPLICATION NOBYPASSRLS;
   ```

3. From the repository root, install dependencies and prepare `.local/mainnet/admin.env` and `.local/mainnet/runtime.env` as ignored regular files, mode `0600`, under a private `.local/mainnet` directory. Do not use symlinks. Both files use the production settings above (`NODE_VERSION` and `PORT` are optional locally). The admin file uses **`DIRECT_DATABASE_URL`** with the new database owner and the direct hostname **in place of** `DATABASE_URL`. The runtime file has only the pooled `DATABASE_URL` with the restricted role and no owner secrets. If the role is not listed in the Neon Connect dialog, use the same endpoint/DB from the owner URI, substitute the URL-encoded runtime credentials, and add `-pooler` to the endpoint ID. [Neon pooled connection strings](https://neon.com/docs/connect/connection-pooling)

   ```sh
   npm ci --include=dev
   umask 077
   mkdir -p .local/mainnet
   # Create the two protected .env files described above with an editor.
   npm run mainnet:credentials
   npm run mainnet:migrate -- .local/mainnet/admin.env
   npm run mainnet:bootstrap -- .local/mainnet/admin.env .local/mainnet/credentials.json
   npm run mainnet:grants -- .local/mainnet/admin.env
   npm run mainnet:verify -- .local/mainnet/runtime.env
   ```

   `mainnet:credentials` saves the legacy workspace-link password and its salted hash in a protected file without printing them. Put the password in a password manager. `bootstrap` creates the one-time legacy-link credential once and refuses overwrite. Keep direct credentials and the organiser file off Render. New organisers do not need this password: they explicitly choose **Create a new workspace** and sign with Nimiq Pay; returning organisers choose **Sign in with Nimiq Pay**. `mainnet:verify` checks the **pooled** runtime identity, TLS, migration checksums, schema, legacy organiser and exact privileges without writing. Runtime can create organiser identities, sessions, campaigns and claims. It can select and insert rows in the immutable `manual_payment_receipts` table only; native payment intents, attempts, hashes and dispatch data remain inaccessible.

### Upgrade the already-deployed single-organiser MAINNET database

The multi-organiser release adds migration `004_multi_organiser.sql`. It does not create a replacement database and must not be applied to TESTNET.

1. Take a fresh encrypted backup of the **MAINNET** database. Install PostgreSQL 17 client tools (`pg_dump --version` must report 17.x), then create a separate 32-byte backup key and store it outside the repository:
   ```sh
   umask 077
   mkdir -p /secure/backups
   node --input-type=module -e 'import{randomBytes}from"node:crypto";import{writeFileSync}from"node:fs";writeFileSync("/secure/nimclaim-mainnet-backup.key",randomBytes(32),{flag:"wx",mode:0o600})'
   npm run mainnet:backup -- .local/mainnet/admin.env /secure/nimclaim-mainnet-backup.key "/secure/backups/nimclaim-mainnet-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"
   ```
   The command verifies the pinned MAINNET database marker and PostgreSQL major version, prints only campaign/invitation/claim/history counts, and writes an AES-256-GCM encrypted archive without a plaintext dump. Keep the key separately from the archive. Never upload either file or paste the key into chat. Confirm the archive exists before continuing.
   Schedule a short maintenance window: the currently deployed single-organiser build is not compatible with the tenant columns added by migration 004. Do not accept organiser or contributor traffic between the migration and the new application deployment; complete the migration, grant verification and manual Render deploy back-to-back. If the upgrade is interrupted, keep the service unavailable until the reviewed multi-organiser build is deployed.
2. From the repository version containing migration 004, run:
   ```sh
   npm run mainnet:migrate -- .local/mainnet/admin.env
   ```
   The migration creates a legacy tenant, assigns every existing campaign and session to it, preserves invitations, claims and history, and expires all old sessions so password-only cookies cannot remain valid.
3. Apply the updated restricted grants and verify them:
   ```sh
   npm run mainnet:grants -- .local/mainnet/admin.env
   npm run mainnet:verify -- .local/mainnet/runtime.env
   ```
   Do **not** run `mainnet:bootstrap` again on the existing database; it refuses to overwrite the original legacy credential.
4. Only after the migration and grant checks pass, deploy the reviewed application commit to the existing MAINNET Render service. Keep automatic deploys off until the manual deploy is intentionally started. Existing users must sign in again. The legacy owner uses the old password once under **Link your previous workspace**, then signs the wallet challenge. New organisers simply sign in with Nimiq Pay.

Do not run these upgrade steps against production until the PR has passed CI and a backup has been verified. The external-receipt migration adds one immutable receipt table and narrowly grants SELECT/INSERT; it does not enable broadcasting, escrow or spending.

4. After PR review and merge to `main`, and only after release authorisation, in Render choose **New → Blueprint**, connect the repository and select `main`. Set **Blueprint Path** to `render.production.yaml`. The service in this Blueprint also deploys from `main`; keep `autoDeployTrigger` off. The plan must contain only the new `nimclaim-mainnet` web service; use a separate Blueprint and leave the staging Blueprint alone. Enter `APP_ORIGIN`, `PRODUCTION_DATABASE_HOST` and the pooled `DATABASE_URL` when prompted. Check the actual assigned hostname; if Render adds a suffix, set the exact origin for this new service before completing release checks. Applying a Blueprint starts deployment even with automatic service deploys off. [Render Blueprint setup](https://render.com/docs/infrastructure-as-code#setup)
5. Verify `GET /healthz` returns `{"ready":true}` and `GET /api/config` reports `network: "mainnet"`, the exact origin, `staging: false` and `claimsOnly: true`. Confirm TESTNET `/api/config` still reports `testnet`, and a newly registered wallet sees only its own empty workspace, while the previous organiser can link the legacy workspace to recover its existing records. `/healthz` reports process liveness after database startup validation; use `/api/config` or a private signed-in read to check ongoing database availability. Verify the backup history and restore a copy before accepting claims. Keep deployment/recovery scoped to this service and project.
6. Complete the physical test below **before sharing or submitting the production URL**. For a device trial use a private, production-shaped MAINNET deployment with a separate Neon project, or the newly deployed service with a real campaign and consenting organiser/recipient. Never insert synthetic records into the production database.

MAINNET supports multiple independent organiser workspaces. Each campaign is assigned to its creator, and all organiser reads, invitation issuance, wallet binding and claim decisions are scoped to that owner. The original campaigns and claims are backfilled to a single legacy workspace; its owner links that workspace once by signing with a wallet and supplying the old organiser password. All existing sessions are expired during the migration. New wallet sign-ins create new workspaces without a password. The shared PostgreSQL minute buckets allow 180 other API requests per minute across all clients, including wallet authentication; an abusive client can consume the shared bucket. Monitor `429`/`503` rates and database capacity during the competition. Expand access only after load testing and adding suitable edge abuse controls. Wallet loss currently has no NimClaim-side recovery path, so users must protect their Nimiq wallet backup. Plan retention and credential rotation outside the HTTP API. Protect data and backups: they contain wallet addresses, signatures and private campaign records.

## Physical Nimiq Pay acceptance — completed for the claims-only release

On 11 November 2026, the organiser and contributor completed the MAINNET claim-and-review flow on two separate Nimiq Pay devices, including wallet authentication, campaign creation, invitation, contributor signature, organiser approval, matching claim status, recipient details and CSV export. A separate 10 NIM transfer was reported by the organiser; its hash still needs to be submitted to the verifier before the app can record it as paid. Browser tests use synthetic signatures and RPC fixtures; they do not replace installed-wallet or real-chain acceptance. [Nimiq Pay Custom URL and network switch](https://nimiq.dev/mini-apps/development/load-local-mini-app)

1. In Nimiq Pay on each supported mobile platform, select Mainnet, then open the exact production HTTPS URL via **Mini Apps → Custom URL**. A normal browser should show wallet unavailable when asked to connect. Verify the MAINNET label and unpaid notice.
2. Choose **Sign in with Nimiq Pay** for an existing account or **Create a new workspace** for a new organiser. Review the one-time `NimClaim/organiser/auth/v1` authentication message; it must identify the exact origin and MAINNET and explicitly state that it is not a transaction. Sign and confirm the wallet address is shown in the workspace. If migrating the original workspace, expand **Link your previous workspace**, enter the old organiser password once, then sign; verify existing campaigns remain visible. A new wallet must see only its own empty workspace. Create a real campaign, then tap **Authorize campaign wallet**. Review the separate `NimClaim/organiser/bind/v1` message, exact origin, network, campaign and Luna amount. Cancel once, then sign. Verify the displayed address matches the signing wallet and persists on reload.
3. Save a private invitation and open the complete link in Nimiq Pay as the recipient. Verify the campaign amount and expiry. Test account-sharing cancellation and message-signing cancellation; neither should create a claim. Connect and approve a `NimClaim/claim/v1` message. Compare the saved server-derived address to the actual signer. Reopen the link and verify no second claim can be made.
4. With a fresh invitation, verify the wrong network and account changes cannot silently submit a stale signing request. Switch to Testnet and reload; the MAINNET connection must fail closed. Verify a wallet change before or during signing is handled or causes the host to reload; reconnect before signing again. Record the OS and Nimiq Pay version and keep private identifiers out of screenshots.
5. Approve the real pending claim. Confirm both sides show the approval. In Approved rewards, check the recipient and exact amount. Send the reward separately through Nimiq Pay, then submit its transaction hash. Confirm the verifier checks the authorised sender, recipient, amount and finality before showing Paid · verified on-chain. A hash alone must never create a receipt.

## Why payment is blocked

The [Nimiq provider API](https://nimiq.dev/mini-apps/api-reference/nimiq-provider#sendbasictransaction) can ask its native host to send NIM with user confirmation. It returns a hash and accepts no sender parameter. Clearing the SDK account cache does not establish that the host returned fresh accounts; the reviewed host can retain old account/HTLC context. A later read-only RPC check could reject a mismatched sender, but cannot undo the transfer. `Payments.gate()` still rejects mainnet on the SQLite payout path. The PostgreSQL production runtime has neither a payout execution route nor payment table privileges.

The MAINNET external-payment verifier is implemented as a separate read-only path. It binds an immutable approved claim to the campaign-authorised sender, recipient, exact Luna value and a unique transaction hash; it verifies successful canonical inclusion and macro-block finality before storing immutable evidence. It does not broadcast or custody the transfer. The SQLite TESTNET HTLC verifier remains a separate protocol. See [mainnet spending blockers](MAINNET-READINESS.md).
