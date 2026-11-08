# Mainnet readiness: NO-GO

**NO-GO for one small real mainnet transaction.** Passing tests does not remove the following unresolved blocker: official SDK 0.2.5 does not expose a verifiable pre-broadcast commitment to the account selected for `sendBasicTransaction()`. The method has no sender parameter; the wallet's signing account and payment account need not coincide. Do not enable an unsafe fallback based on `listAccounts()[0]`, list membership, a successful message signature, a configured address, or a previous payment.

The repository implements payment reservation, native-call adapter, reconciliation and receipt display, but deliberately does not install a production sender-assurance adapter. Its dependency-injection seam is exercised only with synthetic assurances in tests. There is **no environment variable or frontend switch that installs that missing capability**. `SPENDING_ENABLED=true` alone cannot authorize a request. An honest mainnet GO requires a future documented provider capability or an explicitly agreed alternative payment interface and a reviewed implementation change.

## Gates before even requesting approval to spend

- [ ] Supported pre-broadcast sender binding is documented and implemented. It must commit the exact sender to the same immutable intent and eventual native broadcast, not merely snapshot an account that could change after the check.
- [ ] Test a dedicated physical Nimiq Pay device over trusted private HTTPS. Observe account sharing, message signing, exact sender selection/commitment, payment confirmation, fee behavior, returned hash and denial cases. No current on-device result is claimed.
- [ ] Run the payout flow physically on testnet after the sender blocker is resolved. Verify independent RPC matching, inclusion, execution success and following-macro finality. Test cancellation, native timeout, browser close, lost API responses and restart without retrying uncertain attempts.
- [ ] Configure a trusted, independent mainnet full/history node implementing official RPC methods. Confirm `getNetworkId = MainAlbatross`, ID 24 in transactions, consensus, historical transaction bodies and justified following macro blocks. No third-party endpoint is silently chosen. The RPC node is the chain trust boundary; the app does not perform light-client cryptographic verification of macro proofs.
- [ ] Validate RPC response/schema compatibility against that live node using read-only probes. Current integration tests use deterministic local fixtures, not a public endpoint.
- [ ] Review allocation, hash uniqueness, immutable intent, one-time dispatch and permanent unknown-attempt locks. This version has no retry or administrative “reset” endpoint, including after finalized failure. Define audited recovery before broad use.
- [ ] Back up and restore-test the database. SQLite schema v2 must preserve organiser credentials, sessions and old campaigns. Use a separate mainnet database and credentials if the existing installation is testnet.
- [ ] Protect the organiser login, deploy behind trusted HTTPS with private operational access, secure cookies and secret handling. Replace development rate limits with durable limits and explicitly configure proxy trust. Do not use a public development tunnel.
- [ ] Set server-only spending network, a minimal per-payment Luna limit and an explicit fee. Review reward amount plus fee; campaign reward slots do not budget transaction fees. Keep other campaigns closed during the first controlled test.
- [ ] Run `npm run check`, `npm run format:check`, dependency audit and security review after the actual sender adapter changes.
- [ ] Owner separately approves the exact mainnet sender, recipient, amount, fee, campaign and one-time attempt, and personally confirms the native wallet prompt. This task provides no such authorization.

## Spending configuration

Safe defaults are `SPENDING_ENABLED=false`, no `SPENDING_NETWORK`, no positive `MAX_PAYMENT_LUNA`, `PAYMENT_FEE_LUNA=0`, and no `RPC_URL`. HTTPS, explicit network, positive safe-integer amount limit, independent RPC and a trusted selected-sender commitment are all required. RPC credentials, if needed, use server-only `RPC_AUTHORIZATION`; never put credentials in URLs, the frontend or shared logs.

Even when every other environment gate is satisfied, the current build remains blocked on selected-sender assurance. Never remove that check just to meet the deadline. Mainnet payment permission, deployment permission and GitHub push permission remain separate user decisions.
