# Mainnet spending: NO-GO

A separate [MAINNET claims deployment](RENDER-MAINNET.md) is prepared for signed campaigns and claims with payments disabled. It still needs the physical no-spend Nimiq Pay acceptance test before release. This document concerns enabling spending.

**Mainnet spending is explicitly blocked in `Payments.gate()` even when every configurable gate passes.** `SPENDING_ENABLED=false` remains the safe configuration. No mainnet spending, environment change, deployment or real transaction is authorized by this review.

## Current implementation

The SQLite payout path now separates the signed local organiser from the remote HTLC funding address. It validates the HTLC owner, network-specific trusted cosigner, balance and timeout independently before issuing a payment challenge and again at reservation. Reconciliation requires the exact immutable HTLC sender, recipient, reward and fee, early-resolve proof identities, canonical execution and following-macro finality. The old selected-sender dependency-injection seam no longer exists. See [PAYMENTS.md](PAYMENTS.md) for the current protocol and pinned upstream evidence; [PAYER-SELECTED-SETTLEMENT.md](PAYER-SELECTED-SETTLEMENT.md) is historical investigation.

The installed core 2.23.0 runtime returns `type: "early-resolve"` from `HashedTimeLockedContract.proofToPlain()` for early-resolve proof bytes. A direct parser regression test verifies the complete returned object and distinguishes timeout resolve. Parsing synthetic proof bytes does not establish cryptographic validity, execution or a real payment.

`senderBindingSupported` is **false**: it denotes an atomic sender guarantee through native confirmation, which SDK 0.2.5 does not provide. `htlcVerificationSupported` separately describes server HTLC verification and is true only on the SQLite payout implementation. Neither that flag nor the configuration-based `enabled` flag certifies release readiness.

## Outstanding spending blockers

- **Host account freshness:** clearing the SDK cache with documented `disconnect()` is necessary but insufficient. Current host revision `df61e2cf51ff480ab501fc4e09bba2a7241dd48b` retains a second bridge/session cache, and its replacement path can retain the previous HTLC list. No native freshness guarantee was found. A reviewed host capability/change and device validation are required.
- **No atomic sender commitment:** `sendBasicTransaction()` accepts no sender parameter. A wallet switch after the final account check can fund a different transaction. Independent reconciliation rejects a mismatch but cannot undo broadcast. Any acceptable release policy must address this limitation explicitly.
- **Physical consent and integration:** no owner-operated testnet payout, installed-binary verification, exact native amount/recipient display validation, or live RPC compatibility/finality evidence is claimed. Test rejection, replacement, background/lock, late approval, lost responses and restart while preserving permanent uncertain-attempt locks.
- **Operational review:** trusted independent full/history RPC, durable abuse protection, secure credentials/HTTPS, backup/restore and audited recovery remain release requirements. RPC execution/finality is a full-node trust boundary, not light-client cryptographic verification.

Passing automated tests does not resolve these blockers. Existing records, signatures and UNKNOWN reservations must never be reinterpreted or reset to enable another attempt. Mainnet support requires a separate reviewed code change, resolved release gates and explicit owner authorization; flags alone cannot enable it.

## Deployment paths

Only `npm start` / `server/index.ts`, using SQLite outside staging/mobile-test mode, implements the native TESTNET payout flow. It remains spending-disabled; a future authorized testnet deployment must resolve the blockers above and satisfy all server gates. This entry point refuses Render, staging and PostgreSQL environment markers.

The Render Blueprint runs `npm run start:staging`, which uses PostgreSQL + Neon. It requires `NETWORK=testnet`, `SPENDING_ENABLED=false`, zero payment limits/fees and no RPC/spending-network settings. Its gateway and backend refuse financial routes, and its restricted runtime role cannot create reservations or consume dispatch permits. Preserved payment tables/locks and stale-attempt reads do not constitute an operational payout or reconciliation API. Implementing PostgreSQL payouts is separate work, not a configuration change. See [RENDER-STAGING.md](RENDER-STAGING.md).
