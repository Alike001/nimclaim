# NimClaim

**Signed claims. Clear reward decisions.**

A Nimiq Pay Mini App for community organisers to invite contributors, verify wallet ownership, review reward claims and prepare approved rewards for payment. Built as an independent first vertical slice for the Nimiq Mini Apps Competition Cycle III, Pay category.

**MAINNET claims and organiser reviews are live at [nimclaim-mainnet-smv5.onrender.com](https://nimclaim-mainnet-smv5.onrender.com). Mainnet spending, escrow and automated payment verification remain blocked.** The SQLite path implements gated TESTNET HTLC payouts; spending stays disabled by default. The local organiser wallet signs authorisation; the independently checked remote HTLC funds the reward. Physical TESTNET payout validation is still pending; the active MAINNET release is claims-only. `payment-ready` means approved and unpaid; only independently verified, finalized successful execution produces a paid receipt. Campaign amounts are commitments, not escrowed funds. No chain receipts, payments, AI features or populated demo campaigns are fabricated. Nimiq native chain data is public.

## Run locally

Requires Node.js **24.14+** and npm. Uses Node's built-in SQLite API (Node currently emits an experimental-feature warning).

**Upgrading this existing installation:** preserve `.env`, the database and organiser credentials; do not copy the example over them or rerun setup. The API adds schema-v2 payment tables on next start without replacing existing records. The commands below are for a fresh installation only.

```sh
cd /path/to/nimclaim
npm ci
cp .env.example .env
npm run setup
npm run dev
```

Save the generated organiser password in a password manager; it is displayed once. Open **http://localhost:5173** and sign in. `setup` stores only a salted scrypt hash, refuses to overwrite an existing organiser, and creates no campaign or wallet data. Do not use `127.0.0.1:5173` with the default configuration: writes require the exact configured origin.

1. Create a campaign with an amount (up to five NIM decimals), number of rewards, and a future expiry within one year.
2. Create and save each invitation before leaving the screen. Each invitation consumes one fixed campaign slot. Its plaintext token cannot be retrieved from the database.
3. Send each invitation directly to its intended contributor. Invitation links use URL fragments so tokens stay out of normal HTTP URL/access logs. They are sent in JSON bodies to the API; do not enable request-body logging.
4. Recipients open their invitation in Nimiq Pay, approve account access, review a signing request, then sign and submit it.
5. Refresh the campaign to review pending claims. Approve for payment or reject. Authorize an immutable campaign signing wallet and review the native payment details. Payouts require a trusted, funded and unexpired Nimiq Pay HTLC; server spending gates remain in force. Recipients can reopen their link to see actual status and history.

Ordinary browsers can manage campaigns and view invitations but display an honest wallet-unavailable message when asked to connect. No wallet is injected by the application. The test-only wallet doubles live under `tests/`.

## Commands

```sh
npm test                 # API, crypto, native adapter and read-only RPC tests; synthetic keys/databases
npm run typecheck        # React, server, tests and configuration
npm run build            # typecheck + production client build to dist/
npm run test:runtime     # requires dist/; setup CLI + production process restart
npx playwright install chromium
npm run test:browser     # both projects run even if one fails; built client + fresh API per test
npm run test:browser:desktop # desktop only; results under test-results/desktop/
npm run test:browser:mobile  # mobile only; results under test-results/mobile/
npm run check            # API tests + build + process test + browser suite
npm run format:check     # formatting verification
npm audit --omit=dev
```

By default `test:browser` needs ports 3001 and 5173 and deliberately refuses to reuse running applications. If they are occupied, use the isolated test-port overrides below. Each test gets a fresh in-memory API, rate limiter and login; security checks remain enabled. Each device suite builds and serves the production client through a loopback Vite preview proxy, without HMR or dependency optimization. Both suites run sequentially, with separate results directories; the runner returns failure if either fails. Tests never use `data/nimclaim.sqlite`. Browser screenshots and failure traces are written to ignored `test-results/`. Synthetic test signatures exercise the real server verifier. They do not demonstrate a physical Nimiq Pay integration.

Production mode serves `dist/` and the API from one process:

```sh
npm run build
APP_ORIGIN=https://your-test-host.example NETWORK=testnet npm start
```

Place an HTTPS reverse proxy in front of `127.0.0.1:3001`. `.env` is loaded by setup, dev API and start; explicit environment variables take precedence. Production refuses an HTTP origin and sets Secure cookies, CSP, HSTS and no-store response headers. `npm start` needs the runtime `tsx` dependency (included in regular dependencies). No deployment is performed by these commands.

## Configuration and storage

| Variable        | Default                  | Purpose                                                                       |
| --------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `APP_ORIGIN`    | `http://localhost:5173`  | Exact browser origin, no trailing slash; signing domain and POST Origin check |
| `NETWORK`       | `testnet`                | `testnet` or `mainnet`; fixed in database on first API start                  |
| `DATABASE_PATH` | `./data/nimclaim.sqlite` | Durable SQLite file, relative to project working directory                    |
| `HOST`          | `127.0.0.1`              | API bind address                                                              |
| `PORT`          | `3001`                   | API port; update Vite proxy if changed                                        |

SQLite uses WAL, foreign keys, unique constraints and `BEGIN IMMEDIATE` transactions. Back up the database using SQLite's online backup tooling, or stop the process before copying the database and associated WAL files. Protect the data directory and backups: they contain recipient addresses, signatures, campaign data and authentication records. Setup creates its directory with mode 0700. Keep the app on a persistent disk; ephemeral hosting filesystems lose data.

The local SQLite and hosted TESTNET installations remain single-organiser workspaces. The separate PostgreSQL MAINNET service supports multiple wallet-authenticated organiser workspaces: the first Nimiq Pay sign-in creates a workspace, and later sign-ins return to the same wallet-owned workspace. Campaigns and review operations are scoped to that organiser. Existing MAINNET records are preserved under the original legacy workspace, which its owner can link once with the previous organiser password. Contributors still use private invitation links without registering. A lost invitation cannot be recovered; invitation possession is bearer access, so a leaked link can be claimed first by another wallet and lets its holder view the resulting claim/address. Wallet authentication proves control of a key, not contributor eligibility or one human per wallet; organiser review is necessary. Wallet loss currently has no NimClaim-side recovery path; protect the wallet's own backup.

See [payout architecture and limits](docs/PAYMENTS.md), [mainnet spending blockers](docs/MAINNET-READINESS.md), [security and API details](docs/SECURITY.md), [verification results and remaining work](docs/REPORT.md), and [HTTPS device test steps](docs/NIMIQ-PAY-TEST.md).

## PostgreSQL MAINNET deployment

Use [the separate production Blueprint](render.production.yaml) and [the MAINNET deployment and device acceptance guide](docs/RENDER-MAINNET.md). `npm run start:mainnet` requires an exact HTTPS origin, the isolated Neon PostgreSQL 17 database and restricted runtime credentials, verified before listening. MAINNET organisers create or access separate workspaces by signing a one-time Nimiq Pay message; campaigns and review operations are tenant-scoped. Existing records are migrated to the original legacy workspace and can be linked once by its owner. Contributors still claim by invitation without an account. The service has no payout or hash submission API. Approval is unpaid. Physical Nimiq Pay acceptance on two devices was completed on 11 November 2026 for the mainnet claim and approval path. Payout verification is not part of that accepted path.

### November 11, 2026 real-device acceptance

Two separate Nimiq Pay devices completed the following production workflow: organiser wallet registration, campaign creation, immutable organiser signing-wallet authorisation, private invitation, contributor wallet signature, claim submission, organiser approval and matching **Approved · unpaid** status/history on both devices. The organiser also tested copyable recipient details and downloaded the approved-rewards CSV. These are user-observed physical-device results; the automated browser suite separately uses synthetic signatures. No automatic payout was executed by NimClaim.

The organiser subsequently reported sending **10 NIM separately from Nimiq Pay** to the approved contributor. This external transfer is **user-reported, not verified by NimClaim**; a transaction hash, matching amount/addresses and finality must be checked independently before describing it as confirmed on-chain. The app intentionally retains its unverified-payment status, including after an outside transfer.

Release and submission guide: [Cycle III submission notes](docs/CYCLE3-SUBMISSION.md).

### Approved reward handoff on MAINNET

The MAINNET organiser campaign page includes an **Approved rewards** handoff for claims that have been approved and have no payment record. Organisers can copy a recipient address, copy the campaign/claim/network/amount details, or download a CSV containing the approved-unpaid reward list and approval timestamps. The export uses exact NIM decimal precision and is a coordination aid only, including when an organiser has already sent an external transfer: it is not an escrow ledger, transfer instruction, payment receipt or proof of settlement. NimClaim does not initiate, reserve, record or verify external MAINNET transfers. Contributors see an explicit explanation that approval records the organiser's decision, not a payment. Do not describe an approved reward as paid unless a separately reviewed, independently verified settlement capability is implemented.

## PostgreSQL staging path

Hosted TESTNET claims use `pg` and the async store under `server/postgres/`. `npm run start:staging` accepts only the pooled `DATABASE_URL` for the restricted `nimclaim_app` role. It verifies TLS, effective privileges, the migration ledger, reviewed schema structure, TESTNET identity and an existing organiser before listening. Direct credentials and organiser hashes are rejected at runtime. Explicit local `staging:migrate` and one-time `staging:bootstrap` commands perform administrative setup; neither runs during startup or build.

On Render, the exact origin comes from the platform-supplied `RENDER_EXTERNAL_URL` with `RENDER=true`. It must be a canonical `https://<service>.onrender.com` origin (including generated hostname suffixes), without credentials, path/trailing slash, query, fragment or explicit port. A supplied `RENDER_EXTERNAL_HOSTNAME` must match exactly; any `APP_ORIGIN` must equal that URL or startup refuses. Leave `APP_ORIGIN` unset on Render. Partial/malformed platform settings cannot fall back to a guessed origin, and incoming Host/forwarded headers never choose it. Outside Render, exact HTTPS `APP_ORIGIN` remains required for staging tooling and local acceptance tests. The single resolved origin binds gateway Host checks, POST Origin, host-only Secure cookies, public config, invitation links and signed claims. See [Render's platform variable reference](https://render.com/docs/environment-variables).

There is no SQLite fallback. The regular SQLite start command refuses Render or a Postgres URL. Local setup, SQLite data, credentials and development commands remain independent.

Versioned SQL migrations preserve campaign/invitation/claim/session and durable payment tables, safe integer Luna values, uniqueness, append-only history, immutable intents and permanent attempt locks. PostgreSQL row locks protect invitation slots and challenge consumption across processes. All staging wallet/payment/reconciliation routes are denied and spending cannot be enabled. This is a claim-only TESTNET service, not a Postgres payment execution implementation or mainnet approval.

Run `npm run test:postgres` for real disposable PostgreSQL integration tests, including concurrent API processes, migration rollback, process/database restarts and encrypted `pg_dump` restoration. It requires Docker and a local `postgres:17-alpine` image (`docker pull postgres:17-alpine` if missing). It creates only labelled loopback test containers/databases and removes their volumes; it never reads `.env` or connects to Neon. `npm run check:staging` runs the original regression/build/browser suite followed by these tests. See [the complete free Render + Neon setup, limits and readiness report](docs/RENDER-STAGING.md).

General production still needs per-client durable abuse controls, credential recovery/rotation, an operational backup/restore routine, retention/monitoring, payment-storage/API work if payments are ever separately approved, and a security review. No wallet key or RPC credential belongs in the frontend.

## Sources and independence

Wallet integration follows the official [Mini Apps overview](https://nimiq.dev/mini-apps), [provider reference](https://nimiq.dev/mini-apps/api-reference/nimiq-provider), [signed-message verification convention](https://nimiq.dev/hub/guide/transactions), and [local device testing guide](https://nimiq.dev/mini-apps/development/load-local-mini-app). Installed SDK: **@nimiq/mini-app-sdk 0.2.5**, latest npm release checked during implementation, pinned by package-lock.json. Cryptography: **@nimiq/core 2.23.0**. Current documentation was rechecked for payouts; installed SDK typings were inspected without changing dependencies. The payout adapter uses the reviewed native host’s local-wallet/remote-HTLC account roles, with explicit provider-cache clearing before critical account reads, signed ownership and independent HTLC RPC checks; the generic SDK contract does not guarantee account freshness.

Cachet is workflow inspiration only (campaign → invitation → review); its design, branding, code and Zcash privacy claims are not used. NimClaim is implemented only in this directory, without files from Nimlane or any other project.

MIT licensed. See [LICENSE](LICENSE).

## Node 24 development startup

`npm run dev:api` uses `node --watch --env-file-if-exists=.env --import tsx server/index.ts`. The previous `tsx --env-file-if-exists=.env watch ...` placement made Node resolve `watch` as an entry file and fail with `ERR_MODULE_NOT_FOUND`. The regression smoke test runs the exact npm script with copied real source, a disposable `.env` and database, verifies API/authentication, then edits only its disposable entry point to prove watch restart and record/session persistence. It never uses the existing installation's credentials.

If your dev servers already occupy ports 3001/5173, keep them running and use separate test listeners:

```sh
NIMCLAIM_TEST_API_PORT=3107 NIMCLAIM_TEST_WEB_PORT=5197 npm run check
```

These optional test overrides coordinate Playwright, its isolated API and Vite's local proxy. Default ports and backend runtime settings are unchanged. Tests still refuse to reuse existing servers.

## Native payout gate

Only the separate SQLite runtime (`npm start` → `server/index.ts`) implements the TESTNET payout flow; it remains spending-disabled and subject to host-cache/device release blockers. The Render + Neon PostgreSQL path (`npm run start:staging`) is financially disabled and cannot be enabled for payouts through flags. See [runtime paths and capability-field meanings](docs/PAYMENTS.md#runtime-and-deployment-paths) and the current [mainnet NO-GO](docs/MAINNET-READINESS.md).

The existing adapter calls `sendBasicTransaction({recipient,value,fee})`. The organiser signs a session-bound challenge covering the exact HTLC, local organiser, cosigner, contributor, amount, fee, network and claim. The backend independently checks HTLC ownership, trusted network-specific cosigner, timeout and sufficient balance at challenge and reservation. It stores the HTLC as the immutable transaction sender and retains one-time reservation/dispatch semantics. Both wallet accounts are checked again immediately before requesting the native transaction.

Nimiq Pay chooses its own validity height. The stored reservation height is a minimum inclusion block. Reconciliation requires HTLC-to-Basic early resolve, matching proof identities and exact payment fields, canonical inclusion, execution and following-macro finality. Account lists and browser hashes cannot prove a payment. See [the protocol and verification limitations](docs/PAYMENTS.md), including native account caching and the lack of an atomic sender commitment through the confirmation prompt.

Payment states are approved `payment-ready` (equivalent to PAYMENT_READY), SUBMITTING, UNKNOWN, CONFIRMED and FAILED. Only CONFIRMED with backend-verified successful execution is shown as paid. Hashes are hints, not receipts. Cancellation, timeout, lost responses and missing finality remain UNKNOWN. Each claim has at most one durable attempt in this version, including after failure; there is no reset/retry endpoint. Reconcile the existing attempt instead of sending another payment.

Safe server configuration is documented in `.env.example`: spending is off, no spending network/positive limit/RPC is configured. Optional independent `RPC_URL` must be HTTPS or loopback HTTP; `RPC_AUTHORIZATION` remains server-only. `PAYMENT_FEE_LUNA` fixes the requested fee (default zero). The server verifies exact fee as well as reward value. Per-payment amount caps and campaign allocation do not include transaction fees. None of this reserves funds on-chain.

For physical testing, use the private-LAN HTTPS procedure and Caddy example linked above. No public development tunnel is needed or permitted by that procedure. The private Caddy endpoint was started and verified locally; Android certificate trust and physical Nimiq Pay validation remain pending. Local certificates and keys are excluded from this repository. **Mainnet readiness remains NO-GO.**

The follow-up [payer-authorized settlement review](docs/PAYER-SELECTED-SETTLEMENT.md) evaluates a possible versioned alternative to strict sender equality, documents what the native confirmation actually contains in pinned host source, and identifies physical testing requirements. That document is historical context; the implemented organiser-authorised HTLC flow is now described in [PAYMENTS.md](docs/PAYMENTS.md). Mainnet remains NO-GO.

## Private Android test

The existing laptop organiser can stay open while an allowlisted phone uses a private HTTPS recipient link. See the current [running URL, CA instructions, role separation and screenshot checklist](docs/NIMIQ-PAY-TEST.md). The local launcher never runs setup or changes `.env`; it verifies the existing TESTNET database, creates an online backup, starts a separate loopback API and binds Caddy only to the selected private interface. Native dispatch remains disabled both at the proxy and in mobile server mode.

```sh
npm run mobile:status
# Start only when no private instance is already running; use your verified current hotspot IPs:
npm run mobile:start -- --bind-ip 192.168.186.152 --phone-ip 192.168.186.167
npm run mobile:stop
```

The read-only `/#diagnostics` screen checks API/host network agreement and actual provider consensus/height without requesting accounts, signatures or payments. Use the [one-page physical checklist](docs/PHYSICAL-TEST-CHECKLIST.md). Android CA trust and real-device claim signing remain owner-operated checks; a green desktop check is not physical-device evidence.

## Separate TESTNET staging blueprint (not the active MAINNET service)

Use the [Render staging readiness report and exact setup](docs/RENDER-STAGING.md) and root `render.yaml` for a fresh, isolated TESTNET claim trial. The proposed $0/month setup uses one Render Free web service and a separate Neon Free Postgres database, with durable conservative rate limits, a public route gateway and independent API payment denials. It has no disk or paid resources, and does not read local `.env` or reuse local records/credentials. Stay on the free plans without billable overages; accept sleeping and quota-related suspension. This is a separate TESTNET trial path, not the active MAINNET service linked above. Its Blueprint has not been applied; do not use it to replace or recreate the existing MAINNET service. After separate approval to push this origin change, manually replan that existing Blueprint and review the new commit and Free-only resources before any deployment approval. Do not approve the old plan or recreate the Blueprint. `DATABASE_URL` for the restricted runtime is the only manual secret; do not set `APP_ORIGIN` or override platform variables. Physical MAINNET wallet signing and claim review were accepted on two devices; MAINNET spending remains NO-GO.
