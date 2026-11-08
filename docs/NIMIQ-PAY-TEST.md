# Next check: physical Nimiq Pay over HTTPS

Status: **not performed**. Automated wallet doubles are not physical wallet evidence. Do this with a dedicated test wallet and testnet; no funds or seed phrases are needed for signing.

1. Install dependencies, run `npm run setup` and save the generated password. Select a dedicated SQLite path if separating this test from local work. Build with `npm run build`.
2. Arrange a trusted HTTPS reverse proxy or HTTPS tunnel to local port 3001. Do not publish or deploy until authorised. Use a stable origin for this test; unstable tunnel URLs invalidate old signing requests and invitation URLs.
3. Set `.env` to `APP_ORIGIN=https://<your-test-host>` (no trailing slash), `NETWORK=testnet`, the chosen `DATABASE_PATH`, `HOST=127.0.0.1`, `PORT=3001`. Run `npm start`. Production mode serves the built app and API together. Verify HTTPS on the phone without ignoring certificate errors. Do not expose Vite's development server for a public test.
4. Open the HTTPS origin in an ordinary browser, sign in and create a small explicitly labelled test campaign. Generate an invitation and save it. Confirm the link contains the HTTPS origin.
5. In Nimiq Pay, open Mini Apps and enter the full HTTPS invitation URL including `/#claim=...` in Custom URL. Use a current host exposing `nimiqPay.network`. The official local testing guide describes the testnet selector: long-press Settings for 10 seconds and select Testnet. Do not change any real wallet settings or use a real wallet for this check without the owner's explicit choice.
6. On the invitation screen, tap Connect Nimiq Pay. Cancel account consent first and verify a usable cancellation message. Retry and grant consent. Check reported network/consensus/block information. Consensus does not gate off-chain ownership signing.
7. Review the exact message. Verify origin, testnet, campaign, amount and expiry. Tap Sign & submit claim; cancel once and confirm no pending claim appears. Refresh the signing request and approve the signature. Confirm the server records the address derived from the signing public key, even if it differs from the addresses initially shared.
8. Refresh the organiser campaign, approve the claim and reopen the recipient link. Both must show payment-ready and unpaid, with pending/approval history. Try another decision, a second claim using the same invitation and the same wallet on another campaign invitation; conflicts must not create extra claims or events.
9. Test an expiry, wallet network mismatch, missing provider and offline status query. Restart the backend with the same database/config and confirm campaigns, sessions and claim history persist. Record device OS, Nimiq Pay version, SDK lockfile version, exact test steps and observed outcomes without publishing tokens/credentials/addresses.

Success here closes the physical signing integration check only. It does not authorise transfers. A later separately approved payment milestone must define native transfer intent, idempotency, reconciliation after ambiguous wallet outcomes, independent on-chain success/finality verification and accurate sender/recipient/payment history before adding a paid state.

References: [Nimiq provider API](https://nimiq.dev/mini-apps/api-reference/nimiq-provider), [official local mini app testing guide](https://nimiq.dev/mini-apps/development/load-local-mini-app).
