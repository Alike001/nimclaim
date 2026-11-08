# Render TESTNET staging readiness

Prepared 8 November 2026 from clean committed `main` at `7b02957`. Preparation only: no Render resource was created, no code pushed, no external site published, no real wallet called and no funds sent. The existing `.env`, organiser credentials, local database, private TLS setup and Nimlane project are not inputs to staging and were not changed.

## Decision and scope

**NO-GO for deployment now.** The final hosted origin and fresh staging credential hash have not been supplied, Render account/region/cost approval and platform-aware validation remain pending, and deployment itself requires separate approval. **GO for local preparation/review.** After those setup gates and explicit approval, this design is suitable for a small owner-operated, invitation-only TESTNET claim trial. Physical Nimiq Pay acceptance is a post-deploy gate before inviting testers. **NO-GO for payments, mainnet or general production.**

Android's private-certificate warning is a TLS trust failure. The Nimiq Pay blank page has not been independently diagnosed; fixing certificate trust is necessary but does not prove that its WebView/provider works. Use Render's publicly trusted HTTPS endpoint; do not install a private CA, bypass TLS, expose Vite or use a development tunnel. See [Render TLS](https://render.com/docs/tls) and [web services](https://render.com/docs/web-services).

## Minimum durable architecture

One paid Node web service, one process, one attached **1 GB persistent disk at `/var/data`**, fresh SQLite `/var/data/nimclaim-staging.sqlite`. The Blueprint requests `0.5c-512mb` compute in Frankfurt, one instance, automatic deployment off. Confirm availability and cost in the intended Render workspace before approval. The current public schema accepts this configuration.

SQLite is a deliberate bounded staging choice, not an assertion of public production safety. Existing WAL, foreign keys, `busy_timeout`, `BEGIN IMMEDIATE`, one-time challenge consumption and all uniqueness/immutability protections remain. Staging adds FULL synchronous writes and durable global rate-limit counters. No Postgres migration is required for this single-instance trial; none was attempted. Postgres with tested row locking, durable per-client limiting and operational recovery remains the recommended production/scaling path described in the README. Never scale or run another service against this disk.

Render's ordinary filesystem is ephemeral. The service refuses another database path; copying the database into source, using free ephemeral hosting or placing it in `dist` is unacceptable. A disk attaches only at runtime, so bootstrap runs in the start command, never a build/pre-deploy hook. An existing database must bear the staging marker or startup refuses it before schema writes. The organiser hash is inserted once and never overwritten; a conflicting hash aborts startup. The deployment is network-locked to TESTNET. There are no seeded campaigns, invitations or paid records.

[Render persistent disk documentation](https://render.com/docs/disks) confirms single-instance access, runtime-only mounts and interrupted deployments. Expect brief downtime on redeploy; this is accepted for this trial. Disk persistence is not a backup, high availability or disaster recovery guarantee.

## Request and spending boundaries

```text
Android Chrome / Nimiq Pay
  -> Render public HTTPS edge (publicly trusted certificate)
  -> Node gateway on 0.0.0.0:$PORT
  -> Node API on an ephemeral loopback-only port
  -> isolated persistent SQLite
```

`npm run start:staging` runs `ops/staging-start.ts` without reading `.env`. It requires production mode, `NIMCLAIM_STAGING=1`, exact HTTPS origin, TESTNET, the fixed disk path, disabled spending and a fresh scrypt hash. It rejects a spending network, positive spending limit/fee, RPC URL or RPC authorization. The regular start command refuses staging mode, preventing accidental loss of its gateway.

Three independent controls prevent a native payment: the gateway has no wallet/payment route, the API rejects every wallet/payment route in staging even with a valid organiser session, and the payment engine is explicitly disabled regardless of adapter options. No native payment controls render in staging. Existing native SDK sender-assurance restrictions and RPC/signature validation are retained. There is no payment-review exception or live request to an RPC endpoint.

The gateway accepts only the canonical Host, exact paths and methods. It ignores/removes forwarded client headers rather than trusting a spoofable IP. It permits GET `/`, generated `/assets/*`, `/api/config`, `/api/session`, and organiser campaign reads; POST login/logout, token-protected invitation/challenge/claim, and authenticated campaign/invitation/decision operations. Organiser data still requires a valid hashed, durable session. Login is the sole credential-authenticated entry point; no credential retrieval/setup API exists. Recipient API requests have cookies stripped and still require private invitation proofs. All other paths, query variants, diagnostics, source, logs and payment/debug APIs are denied.

Public `/api/config` returns network, exact origin and staging/mobile flags only, without internal payment gate reasons. `/#diagnostics` displays an unavailable page. Diagnostic/native controls are not an access-control mechanism: server and gateway restrictions enforce the boundary. Static client code is public and contains no secrets.

Exact HTTPS POST Origin checks, JSON/body-size validation, CSP/HSTS/no-referrer/no-store, HttpOnly/Secure/SameSite=Strict cookies, organiser scrypt authentication and invitation fragment tokens remain. The API uses its stored exact claim message and the standard Nimiq signed-message envelope, deriving the address from the verified key. Challenges from another origin/network cannot be submitted after a configuration change.

Rate limits are deliberately shared across staging: **10 logins/minute and 180 other API calls/minute**, including health checks. SQLite counters survive restarts and cannot be evaded with forwarded IP headers. This conservative boundary can cause shared throttling/availability loss under abuse; it is acceptable only for a small supervised trial. Do not loosen it or add unverified proxy trust to support public traffic. Production needs durable per-client gateway limits, monitoring and a separate health-check policy.

## Exact proposed Render configuration

Use the root [Blueprint](../render.yaml). Current documentation was retrieved directly and read for [Blueprints](https://render.com/docs/blueprint-spec), [disk constraints](https://render.com/docs/disks) and [environment/secrets](https://render.com/docs/configure-environment-variables); Context7 was also consulted. The current public [JSON Schema](https://render.com/schema/render.yaml.json) validates the file. Render CLI is not installed locally; platform-aware CLI validation has **not** run. Later, with the correct Render workspace/authentication, run `render blueprints validate render.yaml` without applying it.

| Setting           | Exact value                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source            | Existing NimClaim repository, reviewed commit on `main`; no other project                                                            |
| Runtime           | Node 24.14.1 (pinned; matches local verification)                                                                                    |
| Compute / region  | `0.5c-512mb` / `frankfurt`, one instance                                                                                             |
| Build             | `npm ci --include=dev && npm run build`                                                                                              |
| Start             | `npm run start:staging`                                                                                                              |
| Health check      | `/api/config`; exact configured Host must be used                                                                                    |
| Deploy policy     | `autoDeployTrigger: "off"`; initial Blueprint creation still deploys                                                                 |
| Disk              | 1 GB, `/var/data`                                                                                                                    |
| Database          | `DATABASE_PATH=/var/data/nimclaim-staging.sqlite`                                                                                    |
| Fixed environment | `NODE_ENV=production`, `NIMCLAIM_STAGING=1`, `NETWORK=testnet`, `SPENDING_ENABLED=false`, `MAX_PAYMENT_LUNA=0`, `PAYMENT_FEE_LUNA=0` |
| Runtime port      | Render-supplied `PORT`, bound by gateway to `0.0.0.0`; API stays loopback                                                            |

Two values remain to be entered manually (Blueprint `sync: false`):

1. **`APP_ORIGIN`**: the exact assigned `https://<actual-service-host>.onrender.com`, without path or trailing slash. The example host in tests is synthetic. Do not assume the requested service name guarantees that hostname. Confirm the assigned hostname during the separately approved setup; correct this setting before accepting health checks or invitations. An incorrect Host intentionally fails closed. Do not attach custom domains during this trial: [Render health checks](https://render.com/docs/health-checks) use a verified custom domain as Host when present, otherwise the assigned onrender.com hostname. Use one canonical origin throughout, without cross-origin API/proxy redirects. A later custom domain is a new signing origin and requires fresh challenges and device acceptance.
2. **`STAGING_ORGANISER_PASSWORD_HASH`**: a newly generated salted scrypt hash, never the existing local password/hash. The owner may run `node --import tsx ops/staging-credentials.ts` once after review. It writes a protected, ignored `.local/staging/credentials.json`, refuses to overwrite it and prints no password/hash. Store the new password in a password manager, enter only the hash into Render's secret environment field, and use the password only for staging login. Never upload this file. The hash is sensitive even though it is not plaintext. Changing this environment value does not rotate the database credential; mismatches abort startup. Credential recovery/rotation needs a separate reviewed procedure.

No wallet key, mnemonic, local `.env`, RPC credential, certificate or Nimlane setting is needed. Do not link existing environment groups, secret files, databases or services. Do not bulk-import `.env`. Render's Git checkout/build must contain tracked source only; do not upload the workspace, `.local`, SQLite/WAL files, logs, test results or certificates. `.gitignore` excludes these, and a tracked-source secret scan is part of verification.

After separate approval only: push the reviewed commit, validate in the intended Render workspace, review the paid service/disk and the exact hostname, then create/apply the Blueprint and configure the two required values. Creating a service/Blueprint itself starts an initial deploy even with automatic deploys off. Do not click Create/Apply merely to preview configuration. Verify the live certificate chain from Android without exceptions. Verify the served Host/origin, TESTNET configuration, unauthenticated 401 on campaign data, 404 on gateway payment/debug paths, and a fresh empty staging campaign list. Create only new synthetic campaigns/invitations through the staging organiser account.

## Backups and restart acceptance

Before testers, establish an owner-operated backup and off-service retention process. Do not restore Render disk snapshots as database backups: Render warns filesystem snapshots can be inconsistent for a custom database. Use SQLite's online backup API; keep the resulting staging backup protected and transfer it through authenticated SSH/SFTP to an owner-controlled encrypted store. No local real database is involved.

Example for the **approved deployed service's runtime shell only**, before a redeploy and at least daily during testing:

```sh
# Choose a fresh path each time. This command must never target the local installation.
node --input-type=module -e 'import {DatabaseSync,backup} from "node:sqlite"; import {existsSync,chmodSync} from "node:fs"; const out="/var/data/staging-backup.sqlite"; if(existsSync(out)) throw Error("Choose a fresh backup filename"); const db=new DatabaseSync("/var/data/nimclaim-staging.sqlite",{readOnly:true}); if(db.prepare("SELECT value FROM settings WHERE key=?").get("deployment")?.value!=="isolated-testnet-staging-v1") throw Error("Wrong database"); await backup(db,out); chmodSync(out,0o600); db.close();'
```

Download the resulting backup securely before reusing/deleting that filename. A backup left only on the same disk does not protect against disk/service loss. Test a downloaded copy in an isolated environment with `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, campaign/claim/history counts and a staging-only login. Never restore over a running database; stop the service, preserve the current staging file/WAL for recovery, and restore only the staging store through a separately reviewed operation. Local automated tests prove a native online backup contains the approved unpaid claim and passes integrity checks; actual Render backup scheduling, transfer and disaster recovery have not been exercised.

Before inviting testers, restart/redeploy the approved stage and confirm the organiser/session, campaign/invitation, signed claim and decision survive. Lost responses/repeated requests must not create another claim. Native payment attempts must remain absent. Keep all staged data synthetic and minimal; delete it under an agreed retention procedure when the trial ends.

## Native Nimiq Pay acceptance

The installed SDK 0.2.5 and [current provider reference](https://nimiq.dev/mini-apps/api-reference/nimiq-provider) support injected-provider initialization and exact message signing. [Network context](https://nimiq.dev/mini-apps) is available through `getHostNetwork`; unknown or mainnet hosts are rejected, including if the network changes before signing. The normal browser remains wallet-unavailable. No wallet is injected by the application. The SDK/host check is compatibility evidence, not independent blockchain network proof.

Automated hosted-origin tests use `https://nimclaim-testnet-staging.onrender.com` as a synthetic intended-origin fixture: the actual assigned origin remains a required setting. They verify exact message forwarding, origin mutation rejection, missing/mainnet/changed-host rejection before signatures, real server signature verification, replay/conflict protection, secure cookies and restored status. Tests use generated keys and provider doubles, not physical wallet signing.

After approved deployment, the owner must open the actual HTTPS private invitation inside Nimiq Pay's Custom URL flow and follow these acceptance steps without a public diagnostics screen:

1. Android Chrome and Nimiq Pay load the actual HTTPS URL without certificate warnings or exceptions. Record sanitized OS/app versions and errors if either fails. Public trust does not by itself prove native-provider compatibility.
2. Personally select TESTNET in the host, then reload. The recipient flow must display TESTNET and real consensus/height after explicit account consent. Unknown host metadata or a mainnet host must stop before consent/signing; verify the mismatch and return to TESTNET yourself. See [official device/network guide](https://nimiq.dev/mini-apps/development/load-local-mini-app).
3. Using only a new synthetic staging invitation, reject account access once, retry by your own action, then reject a signing request once. No pending claim should appear from rejection.
4. Only with separate owner authorization for wallet signing, inspect the exact native message: `NimClaim/claim/v1`, no-payment purpose, **exact actual hosted HTTPS origin**, `testnet`, campaign/invitation/token hash, exact Luna amount, random nonce and expiry. The application forwards that stored string unchanged. A transfer/payment prompt is a stop condition. This preparation does not authorize or perform the signature.
5. After an owner-approved claim signature, confirm one verified pending claim; review it through the separate staging organiser login. Approval remains **Approved. Awaiting payment.** Reopening/replaying cannot produce another claim. Do not bind a payout wallet, request a payment, dispatch or send funds.

Until these checks are recorded, physical Nimiq Pay/provider compatibility is **UNVERIFIED**, not a claimed success. Never publish invitation fragments, passwords, signatures or wallet identifiers in screenshots/logs.

## Local implementation verification

All checks below passed on Node 24.14.1, using synthetic isolated databases/keys and separate browser ports. **94 automated tests passed: 57 API/crypto/RPC/provider/staging tests, 3 runtime regressions, 17 desktop and 17 mobile Chromium tests.** Physical Android/Nimiq Pay evidence is separate and remains pending.

```sh
NIMCLAIM_TEST_API_PORT=3107 NIMCLAIM_TEST_WEB_PORT=5197 npm run check
npm run format:check
npm audit
```

The full check includes TypeScript, the production build, process persistence/watch-restart tests, native payment/RPC regression tests, browser accessibility/recipient/review/receipt flows and both device projects. New staging tests cover unsafe configuration rejection, preservation of an unrelated database, immutable credentials, gateway Host/path allowlists, unauthenticated organiser rejection, secure cookies/exact Origin, origin-bound cryptographic signatures, competing claims/replay, native online backup integrity, restart/session/decision persistence, durable login limits and payment denials on both gateway and direct API paths. A hosted-origin provider double verifies the exact message string and rejects unknown/mainnet/changed hosts without requesting signatures. Browser regression tests confirm public staging diagnostics/setup instructions are unavailable.

Dependency audit reports **zero vulnerabilities**, including development dependencies. Formatting and `git diff --check` pass. The current Render JSON Schema validates the Blueprint. Gitleaks checks the complete reachable Git history and a staged-source export with redacted reporting: **no leaks found** in either scan; no local private files are included. This does not establish live Render behavior, a certificate-chain check, real provider injection or native wallet signing success.
