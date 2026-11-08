# First vertical slice verification

Implementation date: 8 November 2026. Scope: campaign creation through approval for payment. Repository branch: `main`. This report describes local implementation and testing, not a deployment or physical-wallet acceptance result.

## Working behavior

- React/TypeScript/Vite opens directly into the organiser workspace or the recipient invitation. Mobile layouts, labelled inputs, visible focus styles, accessible status/error messages and full claim history are implemented. There are no seeded campaigns or contributors in the application.
- A setup command creates one organiser with a generated password. Server-side password verification and durable hashed cookie sessions protect campaign creation, invitation issuance and claim decisions.
- Campaigns persist with title, description, exact integer Luna reward, fixed reward slots and expiry. Each high-entropy invitation reserves a slot and is returned once. Only its hash is stored. An invitation is a bearer secret, not an identity check.
- The official `@nimiq/mini-app-sdk` 0.2.5 integration uses `init()`, `listAccounts()`, `sign()`, `isConsensusEstablished()` and `getBlockNumber()`. It checks host network, handles normalized wallet errors, distinguishes status RPC failures and displays unavailable-provider states in ordinary browsers.
- The API verifies Ed25519 signatures over the official Nimiq framed SHA-256 message digest. The challenge binds origin, network, campaign, invitation, token hash, amount, one-time random nonce and deadline. The recipient address is derived from the verified public key. Shared accounts and frontend addresses are not trusted as identity evidence.
- Claim insertion, nonce consumption, wallet/campaign uniqueness and initial history are atomic. Organiser approval/rejection is a separate authenticated atomic transition. Replays and competing decisions cannot create duplicate claims or approvals.
- Pending claims expire with the campaign; expiration history records the campaign deadline when next evaluated by the server. Approved commitments remain payment-ready and unpaid. Both organiser and recipient can refresh actual server state and history.
- Durable local storage is `./data/nimclaim.sqlite`, configurable through `DATABASE_PATH`. PostgreSQL migration requirements are documented in the README.

## Verification results

| Check                               | Result                                                                                 | Evidence                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cryptography and API                | 13 tests passed                                                                        | `npm test`; `tests/api.test.ts`                                                                                                                    |
| Actual production-process lifecycle | 1 test passed                                                                          | `npm run test:runtime`; real setup CLI, built HTML, secure cookie headers, process stop/restart, persisted session/campaign/verified claim/history |
| Desktop Chromium                    | 9 tests passed                                                                         | `npm run test:browser`; synthetic signed claim → organiser approval → recipient reload                                                             |
| Mobile Chromium                     | 9 tests passed                                                                         | Same suite using Pixel device emulation; complete flow additionally exercised at 320px width without horizontal overflow                           |
| Automated accessibility             | Passed on login, campaign detail and approved recipient views on both browser projects | axe WCAG 2 A/AA and 2.1 AA checks embedded in browser flow; no violations on these scanned views                                                   |
| TypeScript and production build     | Passed                                                                                 | `npm run build`                                                                                                                                    |
| Runtime dependency audit            | Zero reported vulnerabilities                                                          | `npm audit --omit=dev`                                                                                                                             |
| Formatting                          | Passed                                                                                 | `npm run format:check`                                                                                                                             |

API coverage includes valid/invalid signatures, forged public keys and address fields, raw-message rejection, message tampering, stale/used nonces, cross-invitation proofs, expired and already-used links, per-wallet uniqueness, simultaneous claims, slot issuance, competing approvals/rejections, independent API instances sharing one SQLite database, authorization, origin checks, exact Luna parsing, input/body limits, Unicode input, session expiration/logout, rate limiting, origin changes, network immutability and restart persistence. Browser coverage includes numeric/legacy/unknown SDK errors, account/signing cancellation, network mismatch, provider absence and unavailable consensus/block RPC results.

Tests use ephemeral synthetic Ed25519 keys and isolated databases. Node's crypto module generates the test signatures independently of the server's Nimiq-core verifier. Browser wallet doubles exist only in test files; they are not shipped in the client bundle. Screenshots under ignored `test-results/recipient-*.png` show synthetic test data, not real rewards. Test-only startup does not populate the actual local development database.

## Remaining gates and limits

Physical Nimiq Pay signing has **not** been tested. The real host's permission prompts, injected network context, signature framing and account choice still need on-device HTTPS verification. SDK and cryptographic integration are implemented and locally exercised; automated wallet doubles cannot certify the native host. See the [exact HTTPS device-test procedure](NIMIQ-PAY-TEST.md).

Native payments are **not implemented** and have no API or UI action. There is no paid status, fake transaction hash, simulated receipt, on-chain write or balance assertion. No financial transaction, real wallet access, seed phrase access, deployment or GitHub push was performed. Payment-ready records represent organiser approval only. A later separately authorised milestone must add native wallet transfers and independently verified payment outcomes.

The first slice intentionally uses a single organiser and fixed campaigns/invitations. It has no password recovery UI, multi-tenancy, invitation replacement or Postgres implementation. The local rate limiter is process-local and shared behind reverse proxies; production needs durable rate limits, explicit proxy trust, migrations, backups, credential operations and a security review as documented. Automated accessibility scans cover selected screens; physical screen-reader testing and iOS/WebKit coverage remain open.

## Reproduce

```sh
cd /home/ali/Desktop/nim/nimclaim
npm ci
cp .env.example .env
npm run setup
npm run dev
```

Open `http://localhost:5173` and use the organiser password printed once by setup. To reproduce verification, stop the dev servers, install Chromium with `npx playwright install chromium`, then run `npm run check` and `npm run format:check`. No wallet is necessary for automated tests. Preserve any existing `.env`; copying the example is for a fresh installation.
