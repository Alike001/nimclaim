# Native payout implementation report

## Follow-up: Node 24 startup and settlement review

Continued from `5f4ac639` on 8 November 2026. The initial working tree already contained a proposed `dev:api` script correction; it was retained and verified. On Node **24.14.1**, the committed `tsx --env-file-if-exists=.env watch server/index.ts` command reproduced `ERR_MODULE_NOT_FOUND` resolving `watch` as a file. The corrected command is `node --watch --env-file-if-exists=.env --import tsx server/index.ts`.

The new `tests/runtime/dev-startup.test.ts` runs the exact package script against copied real server/shared source and a disposable `.env`/SQLite database. It checks API readiness, env loading, authentication and a watched restart preserving the test session and campaign. It never starts the actual installation or uses its credentials. An existing listener on port 3001 was left untouched: the initial aggregate run stopped at Playwright's port conflict, then all 26 browser tests passed with isolated ports 3107/5197. Optional `NIMCLAIM_TEST_API_PORT` and `NIMCLAIM_TEST_WEB_PORT` overrides now coordinate test API, Vite proxy and Playwright; defaults remain 3001/5173 and running services are never reused.

**Current verification:** the complete `npm run check` sequence passed with isolated test ports: 48 unit/API/native/RPC tests, 2 runtime tests, and 26 desktop/mobile browser tests (**76 total**); TypeScript and production build passed. Formatting passed and `npm audit` reported zero vulnerabilities. See the commands below. The historical 75-test report that follows predates the extra development startup regression.

The [payer-selected settlement review](PAYER-SELECTED-SETTLEMENT.md) checks current official SDK docs, installed 0.2.5 typings and official host source pinned to `dd90a9c5443be3f4e0ddeac454486c9d512fcae3` (source package version 2.23.0). It documents native confirmation fields, the local message-signing key versus HTLC funding account, host-chosen validity height, current verifier incompatibilities and the smallest versioned wallet-owner-authorized alternative. Source evidence is not physical-device evidence.

**NO-GO remains.** This task evaluates and documents the alternative; it does not implement a new settlement policy. Existing payout guards, schema, reservations, recipient/amount binding, RPC verification, hash uniqueness, permanent UNKNOWN locks and no-auto-retry behavior are unchanged. Real records, `.env` and credentials were preserved. No real wallet call/signature/payment, live-spending enablement, deployment or push occurred.

```sh
# Keep existing development servers running; these listeners are only for isolated tests.
NIMCLAIM_TEST_API_PORT=3107 NIMCLAIM_TEST_WEB_PORT=5197 npm run check
npm run format:check
npm audit
```

Changed files in this follow-up: `package.json`, `playwright.config.ts`, `vite.config.ts`, `tests/browser-server.ts`, `tests/runtime/dev-startup.test.ts`, `README.md`, `docs/MAINNET-READINESS.md`, `docs/PAYMENTS.md`, `docs/PAYER-SELECTED-SETTLEMENT.md`, and `docs/REPORT.md`.

## Previous payout milestone

The sections below record the implementation and evidence from the preceding `5f4ac639` milestone.

Date: 8 November 2026. Continued on `main` from `b762d0f6f2467f58afdd626d4afb66bc30efe6be`; the original campaign/invitation/claim/review flow is retained.

**NO-GO for one real mainnet transaction.** Safe payment infrastructure is implemented, but a usable production broadcast path cannot satisfy the required pre-broadcast sender guarantee with the installed official SDK. `sendBasicTransaction()` has no sender parameter or documented verifiable selected-sender commitment. `sign()` and `listAccounts()` cannot establish the next payment sender. Production therefore denies payment reservations and dispatches even if environment flags are enabled. No missing capability is fabricated.

## Implemented and real

- Official SDK native-call adapter uses exact recipient, integer Luna reward, explicit requested fee and validity-start height. It is invoked only after an authenticated immutable-intent reservation and one-time dispatch acknowledgement. Tests call wallet doubles; the agent made no native wallet call.
- Server-verified, session-bound campaign signing-wallet authorization is immutable. A separately signed exact payment challenge checks the authorized signer. Selected payment-sender assurance is a separate required gate; it has no production adapter today.
- Additive schema-v2 migration preserves schema-v1 credentials, sessions, campaigns, invitations, claims and history. New tables store campaign wallets, immutable intents, attempts, hashed one-time permits, unique transaction-hash consumption and payment history. Campaign and claim-identity immutability is enforced by triggers.
- Atomic reservations and one-time dispatch consumption prevent concurrent tabs, duplicate claims, used nonces, lost API responses or backend restarts from requesting a second payment. One durable attempt is allowed per claim in this version, including after failure. No retry/reset endpoint exists.
- States include existing `payment-ready` (PAYMENT_READY equivalent), SUBMITTING, UNKNOWN, CONFIRMED and FAILED. Browser cancellation/errors/timeouts do not unlock attempts or prove non-broadcast. A stale submission becomes UNKNOWN on status read without releasing its reservation.
- Independent backend official JSON-RPC checks network, consensus, head, exact sender/recipient/value/fee/network ID/validity height/basic transaction shape, canonical inclusion, explicit execution result and a justified following canonical macro block. It rereads inclusion after finality. Only finalized success produces a paid receipt; finalized execution failure remains reward-unpaid. A hash is only a lookup hint.
- Global hash uniqueness prevents reusing one valid transaction across claims. Strict POST schemas reject forged recipient/amount/state fields. Each fixed campaign reward slot can produce at most one payment intent; this does not reserve funds or cover transaction fees.
- Sender review and recipient pages show exact amounts, fee requests, network, truthful current status, history and explorer links only for independently verified finalized outcomes. Prior “no NIM transferred” and “unpaid” current badges are removed when the payment state makes them inaccurate.
- Server spending defaults off and also requires HTTPS, explicit matching spending network, a positive safe-integer per-payment limit, independent RPC and trusted sender binding. Frontend state cannot enable these gates. The RPC transport only permits read methods and never sends transactions.

The existing local `.env`, database and organiser credentials were not opened for application use, overwritten, reset or migrated during this task; they remain in place. Migration was proved against isolated v1 fixtures and will run on the next actual app start. No Nimlane or other project files were modified. Dependencies and package scripts were retained.

## Verification

| Check                                 | Result                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                            | **PASS — 48 tests**: original 13 API/crypto checks plus payout API/concurrency/migration, native-adapter and read-only RPC transport tests                                            |
| `npm run test:runtime`                | **PASS — 1 test**: actual production process stop/restart; credentials/session/claim/history plus a synthetic durable payment reservation remain preserved and dispatch stays blocked |
| `npm run test:browser`                | **PASS — 26 tests**, 13 each on desktop and mobile Chromium                                                                                                                           |
| `npm run typecheck` / `npm run build` | **PASS**; TypeScript and production Vite build                                                                                                                                        |
| Selected axe accessibility scans      | **PASS**: login, organiser detail, approved recipient and confirmed-receipt presentation fixtures; no scanned WCAG A/AA violations                                                    |
| Responsive flow                       | **PASS**: complete original flow at 320px width, mobile review and receipt views without horizontal overflow                                                                          |
| `npm run format:check`                | **PASS** after formatting the documentation edits                                                                                                                                     |
| `npm audit`                           | **PASS — zero reported vulnerabilities**, including development dependencies                                                                                                          |
| Real mainnet/testnet payout           | **NOT RUN / BLOCKED**; no real wallet or funds used                                                                                                                                   |
| Physical Nimiq Pay + private HTTPS    | **NOT RUN**; Caddy and device certificate trust remain owner-operated setup steps                                                                                                     |
| Live independent RPC compatibility    | **NOT RUN**; no public or private operational RPC endpoint was configured or probed                                                                                                   |

**75 functional tests passed.** Test fixtures are synthetic and isolated; they are not transaction evidence. There are no generated paid records in the real application database. The full check sequence passed functional tests; a formatting check initially caught a concurrent documentation edit and was corrected. The final targeted native-adapter tests/build and final formatting/audit checks also passed.

Tests cover wrong signing/selected senders, amount/recipient/fee mutation, strict authorization, session/nonce replay, immutable claims/intents, competing reservations and dispatches, independent API instances sharing SQLite, duplicate invitations/claims, hash replay, cancellation, lost reserve/dispatch/outcome responses, native/RPC timeouts, network mismatch, execution failure, missing finality/execution evidence, expiry, spending caps, migration and restart. Receipt presentation tests replace API responses with explicit synthetic fixtures; they do not assert that an actual network payment happened.

## Mobile setup and next action

Prepared URL: **`https://<your-desktop-private-LAN-IP>:8443`**, for example `https://192.168.1.50:8443` only if that is actually the desktop's private address. **No listener is currently started or claimed reachable.** Use [NIMIQ-PAY-TEST.md](NIMIQ-PAY-TEST.md) and `ops/Caddyfile.mobile.example`: private LAN binding, phone/desktop IP allowlist, Caddy admin off, trusted device certificate, backend on loopback, existing protected organiser login, spending off. Do not expose this setup through a public development tunnel.

The next permissible check is an owner-operated **no-spend** physical signing and payment-review test, with the current disabled dispatch visibly verified. The next implementation blocker is a documented, verifiable sender commitment tied to the exact native broadcast, or a separately agreed alternative signing interface. Post-broadcast sender checking cannot substitute for that requirement.

[MAINNET-READINESS.md](MAINNET-READINESS.md) contains the complete checklist. Additional blockers are physical testnet/native confirmation coverage after sender support exists, trusted live full/history RPC compatibility, operational backups/restore, durable rate limits/proxy boundaries and security review. Current SQLite remains durable development storage; the Postgres path and production constraints remain documented. No automated administrative recovery or safe retry after a locked attempt is provided.

No real NIM transfer, real wallet signing, seed phrase handling, public tunnel, deployment or GitHub push was performed. Mainnet spending requires a later separate approval after all readiness gates are closed.

## Exact changed files

- `.env.example`
- `.gitignore`
- `.prettierignore`
- `README.md`
- `docs/MAINNET-READINESS.md`
- `docs/NIMIQ-PAY-TEST.md`
- `docs/PAYMENTS.md`
- `docs/REPORT.md`
- `docs/SECURITY.md`
- `ops/Caddyfile.mobile.example`
- `server/app.ts`
- `server/db.ts`
- `server/index.ts`
- `server/payment-schema.ts`
- `server/payments.ts`
- `server/rpc.ts`
- `shared/payments.ts`
- `src/App.tsx`
- `src/Payments.tsx`
- `src/api.ts`
- `src/payout-wallet.ts`
- `src/style.css`
- `tests/browser/flow.spec.ts`
- `tests/browser/receipts.spec.ts`
- `tests/payment-helpers.ts`
- `tests/payments.test.ts`
- `tests/payout-wallet.test.ts`
- `tests/rpc.test.ts`
- `tests/runtime/process.test.ts`
