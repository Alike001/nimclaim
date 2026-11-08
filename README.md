# NimClaim

A Nimiq Pay Mini App for community organisers to invite contributors, verify wallet ownership, review reward claims and prepare approved rewards for payment. Built as an independent first vertical slice for the Nimiq Mini Apps Competition Cycle III, Pay category.

**No transfers are implemented. `payment-ready` always means approved and unpaid.** Campaign amounts are commitments, not escrowed funds. No chain receipts, payments, AI features or populated demo campaigns are fabricated. Nimiq native chain data is public.

## Run locally

Requires Node.js **24.14+** and npm. Uses Node's built-in SQLite API (Node currently emits an experimental-feature warning).

```sh
cd /home/ali/Desktop/nim/nimclaim
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
5. Refresh the campaign to review pending claims. Approve for payment or reject. Recipients can reopen their link to see status and history.

Ordinary browsers can manage campaigns and view invitations but display an honest wallet-unavailable message when asked to connect. No wallet is injected by the application. The test-only wallet doubles live under `tests/`.

## Commands

```sh
npm test                 # cryptographic and API tests; isolated synthetic keys/databases
npm run typecheck        # React, server, tests and configuration
npm run build            # typecheck + production client build to dist/
npm run test:runtime     # requires dist/; setup CLI + production process restart
npx playwright install chromium
npm run test:browser     # desktop + mobile Chromium; launches isolated API and Vite
npm run check            # API tests + build + process test + browser suite
npm run format:check     # formatting verification
npm audit --omit=dev
```

Stop any existing dev servers before `test:browser`; it needs ports 3001 and 5173 and deliberately refuses to reuse running applications. Each device suite starts a fresh isolated server so the aggregate test burst does not exhaust the development IP rate limit. Tests never use `data/nimclaim.sqlite`. Browser screenshots and failure traces are written to ignored `test-results/`. Synthetic test signatures exercise the real server verifier. They do not demonstrate a physical Nimiq Pay integration.

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

One installation supports **one organiser**, authenticated server-side. There is no open registration, multi-tenancy, password reset UI, invitation replacement or campaign editing in this slice. A rejected/expired invitation is not reissued; create another campaign if needed. Protect organiser access and save invitation links before closing the page. Lost links cannot be recovered. Invitation possession is bearer access: a leaked link can be claimed first by another wallet and lets its holder view the resulting claim/address. Signature verification proves control of a key, not contributor eligibility or one human per wallet; organiser review is necessary.

See [security and API details](docs/SECURITY.md), [verification results and remaining work](docs/REPORT.md), and [HTTPS device test steps](docs/NIMIQ-PAY-TEST.md).

## PostgreSQL path

Before public production deployment, move the repository layer in `server/app.ts` / `server/db.ts` to a Postgres driver and versioned SQL migrations. Preserve the schema's unique constraints on token hash, invitation claim, challenge consumption and `(campaign_id, address)`. Use BIGINT for Luna and timestamps and integer-safe serialization. Convert `BEGIN IMMEDIATE` into Postgres transactions with row locks (`SELECT ... FOR UPDATE`) on invitation/campaign and claim rows; keep conditional status updates and unique constraints as the final arbiter. Catch uniqueness/serialization conflicts as 409 and retry transactions only when safe. Test competing requests against separate server processes connected to Postgres before launch.

Keep sessions durable and hashed. Replace the development process-local rate limiter with durable gateway/application limits and configure trusted proxy boundaries explicitly. Add an organiser credential recovery/rotation process, migrations, automated backups/restore checks, retention policy, monitoring and a security review. Schema version 1 is recorded locally; this slice does not implement automatic upgrades of older schemas. Do not expose an unauthenticated Postgres database or put database credentials into the frontend.

## Sources and independence

Wallet integration follows the official [Mini Apps overview](https://nimiq.dev/mini-apps), [provider reference](https://nimiq.dev/mini-apps/api-reference/nimiq-provider), [signed-message verification convention](https://nimiq.dev/hub/guide/transactions), and [local device testing guide](https://nimiq.dev/mini-apps/development/load-local-mini-app). Installed SDK: **@nimiq/mini-app-sdk 0.2.5**, latest npm release checked during implementation, pinned by package-lock.json. Cryptography: **@nimiq/core 2.23.0**. No wallet sender-selection assumption is made from `listAccounts()`.

Cachet is workflow inspiration only (campaign → invitation → review); its design, branding, code and Zcash privacy claims are not used. NimClaim is implemented only in this directory, without files from Nimlane or any other project.

MIT licensed. See [LICENSE](LICENSE).
