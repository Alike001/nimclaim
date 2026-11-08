# Native payout implementation report

## Browser verification repair after public commit d003911

8 November 2026. Started on clean `main` at `d003911db9f2e65ad27cb99d9dd9e705f2e23ac3`. Existing desktop/private HTTPS listeners, `.env`, organiser credentials, database and payment reservations were preserved. Changes are confined to the test harness and documentation; application, schema, SDK adapter, sender/HTLC restrictions and payout policy are unchanged.

### What the five saved failures actually show

The original logs and traces were preserved privately under `.local/browser-fix/publication-results/` before new runs. These were failures before the intended wallet/status assertions, not failed cryptographic or payment assertions:

| Original desktop test             | Exact failure location                                                                                     | Evidence and classification                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organiser → signed claim → review | 30-second test budget expired at `page.exposeFunction()` for the recipient's synthetic signer              | UI setup and two axe scans had already consumed the budget. Trace includes slow browser operations, including a 3.7-second new page. Recorded API responses were 200/201. The signer/claim assertion was not reached.                                                      |
| Ordinary browser unavailable      | Budget expired during axe `finishRun()` on the login page                                                  | Axe's extra blank-page creation took about 6.9 seconds, with individual JS injection/evaluation calls taking several seconds. The unavailable-wallet expectation was not reached.                                                                                          |
| SDK rejected                      | Budget expired at the initial `page.goto('/')`                                                             | Creating the browser page already took about 10 seconds. There were no API responses in this trace; the SDK rejection assertion was not reached.                                                                                                                           |
| SDK legacy rejection              | `page.evaluate: Execution context was destroyed, most likely because of a navigation` during axe injection | Network trace records a second document GET for the same root page about 0.8 seconds after the first. The scan raced an unexpected document navigation. The trace does not record the reload initiator, so attributing it to a particular Vite event would be speculation. |
| SDK unknown error                 | Budget expired filling the campaign Title field                                                            | Campaign setup was still running; the trace records a roughly 41-second create-form click spanning cancellation. API responses shown were 200. The future-host-error assertion was not reached.                                                                            |

The first unchanged isolated rerun of these five passed 5/5. A second unchanged run with two repetitions passed 9/10 and exposed a different, reproducible problem: the last test's campaign/claim/config calls returned **429**, and the page displayed **Too many requests**. The API's shared per-IP limiter survived between tests/repetitions. No original saved failure had a recorded 429, so this is not falsely presented as the cause of all five original failures.

During diagnosis, Linux memory-pressure sampling showed `full avg10=52.68` and swap usage around 3.3 GiB. This establishes severe resource stalls during this task, consistent with the multi-second browser commands; it does not retrospectively prove the exact OS cause of every historical timeout. There is no evidence here of an application claim bug, occupied test ports, or expired authentication causing the original five. The precise historical reload trigger and source of all browser stalls remain unproven.

### Harness fixes and checks

- Every test now owns a fresh in-memory API/database, sessions and rate limiter. The loopback port is acquired explicitly; occupied listeners are never reused. No limiter, authentication, Origin or payment check is disabled. All specs use the fixture. Module-level cross-context organiser-cookie caching was removed; UI login remains exercised.
- Browser tests build and serve the actual production client with a loopback Vite preview proxy, removing HMR navigation/dependency-optimizer activity from the test environment. Development startup is still checked by its separate Node 24 regression.
- Login accessibility gets its own test after the login form is visible. The same WCAG tags and zero-violation assertion remain; campaign and approved-recipient accessibility assertions are retained. No tests are skipped, assertion relaxed or timeout enlarged. The default browser test budget stays 30 seconds.
- Desktop and mobile have separate scripts and output directories. The combined runner always executes both sequentially and exits nonzero if either fails. A process-level regression uses a failing desktop stub and successful mobile stub to prove both execution and failure propagation.

**Final full verification:** `NIMCLAIM_TEST_API_PORT=3107 NIMCLAIM_TEST_WEB_PORT=5197 npm run check` passed: **53 unit/API/native/RPC checks, 3 runtime checks, 16 desktop Chromium tests and 16 mobile Chromium tests (88 total)**. TypeScript, production build and formatting passed; dependency audit returned zero vulnerabilities. The same five selected desktop cases then passed both repetitions (**10/10**) with the fixed fixture, including the workload that had previously exhausted the shared limiter. Browser emulation and synthetic signatures are not physical Nimiq Pay evidence. Detailed traces/logs stay ignored locally, not in the public repo.

### Physical testing handoff

`npm run mobile:status` verifies the existing endpoint **https://192.168.186.152:8443/#diagnostics**. CA/hostname-verified requests returned HTML/config 200 and unauthenticated organiser API 401; API readback is TESTNET, mobile profile true, native spending false. The unit suite exercised actual Caddy TLS role restrictions with separate synthetic peers, including phone admin denial, cookie stripping and dispatch denial. No phone ingress or provider operation is claimed. The phone remains restricted to recipient routes; laptop organiser login is **http://localhost:5173**.

The [one-page physical checklist](PHYSICAL-TEST-CHECKLIST.md) covers network setting, consensus, native account consent, claim-message review, organiser approval and unpaid status, with exact sanitized screenshots. Existing [certificate/startup instructions](NIMIQ-PAY-TEST.md) remain valid. Android/Nimiq Pay user-CA trust is an unresolved physical check. If rejected, use a publicly trusted HTTPS certificate on an owner-controlled endpoint/domain (private DNS resolution is possible), separately authorized; never bypass TLS or expose development admin services through a tunnel.

**Mainnet NO-GO remains.** No real signing, transfer, deployment, credential reset, database migration, payment reservation reset or Nimlane modification was performed.

## Current milestone: private Android test endpoint started

Continued from `c3f99998` on 8 November 2026. The actual API and Vite proxy were checked independently and are healthy on TESTNET with spending disabled. The owner confirmed that the laptop uses the Android phone's hotspot and deferred all phone interactions until after this task.

**Running URL:** `https://192.168.186.152:8443/#diagnostics`. It is bound only to the active Wi-Fi interface address; the intended phone/hotspot gateway is `192.168.186.167`. An official Caddy 2.11.9 binary was verified against its SHA-512 release manifest and installed only inside ignored `.local/bin`. Caddy's admin API is off; there is no public tunnel or global CA installation. HTTPS HTML, JS, CSS and the private TESTNET API were fetched with full certificate/hostname verification using the local CA.

The private API is a separate loopback listener on 3002 and uses the already-opened existing SQLite database, verified through the original API process's open-file metadata. A protected online backup was taken. Existing organiser credential and payment-attempt rows were compared before/after startup and were unchanged. The original API/Vite stayed running; private-only stop/restart commands were also exercised. The existing local origin policy accepts organiser writes at the localhost URL, not the separately rendering 127.0.0.1 URL; the guide calls this out without changing `.env` or weakening Origin checks. No `.env` reset, organiser reset, schema change, fake campaign or real claim was performed on the actual installation.

Phone access is restricted to built assets, public configuration and the three recipient claim endpoints; its cookies are removed. Organiser/admin/session/payment endpoints are denied to the phone. Laptop administration retains server authentication. Reserve/dispatch are blocked at the proxy for all peers and spending is additionally forced off in TESTNET-only mobile API mode. Existing strict sender protections, durable reservations and UNKNOWN outcomes remain intact.

A safe read-only diagnostics page/recipient panel reports SDK/provider detection, API and host network readbacks, agreement, consensus, block height and sanitized error categories. It never requests accounts, signatures or transfers and never displays account addresses, invitation links or raw host errors. Before signing, the client rechecks host network and exact server challenge network/origin. Backend challenges and verification remain TESTNET/domain-bound; message signatures do not independently attest the phone's blockchain network.

**Verification:** 53 unit/API/native/RPC checks (including five new mobile tests), 2 runtime checks and 30 browser checks passed (**85 total**); TypeScript and production build passed. New coverage exercises the actual Caddy TLS proxy with separate loopback laptop/phone peers, denied admin access, cookie stripping, spoofed headers, forced-off spending, sanitized diagnostics, network/origin rejection before signing, and separate laptop/phone origins sharing claims and organiser review. The Caddy integration ran with no skip on this machine. Formatting passed and dependency audit reported zero vulnerabilities.

**Still not done:** Android certificate trust, phone reachability, actual SDK injection, native account consent, native claim signature and physical organiser/recipient status confirmation. The owner explicitly plans these after the task. In the inspected target-SDK-36 host source there is no user-CA trust declaration; installed-binary/WebView behavior must be tested. If Nimiq Pay rejects the local CA, the actionable alternatives are an owner-controlled private-resolving domain with a publicly trusted certificate or an approved test build with explicit CA trust. TLS bypass is not acceptable. This endpoint is locally verified, not certified physical-device readiness.

The [updated device guide](NIMIQ-PAY-TEST.md) contains the public CA file/fingerprint, exact URL, launch/status/stop commands, laptop-session workflow, screenshots to capture and the next safe read-only phone action. All CA private keys, backups, logs and runtime state remain ignored and protected under `.local`; no secrets were printed or committed. Mainnet remains NO-GO. No real wallet interaction, real payment, deployment or push was performed.

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
