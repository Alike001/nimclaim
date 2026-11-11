# Mainnet spending: NO-GO

## Read-only external payment verification

The MAINNET PostgreSQL runtime accepts an organiser-submitted transaction hash
for an already completed Nimiq Pay transfer. The server derives the expected
sender from the campaign wallet, recipient from the claim and amount from the
campaign. It verifies the MAINNET network, Basic account types, exact amount,
successful canonical block inclusion and following macro-block finality.
Verified receipts are immutable and transaction hashes are unique across
claims. A successful check changes the displayed settlement status to
**Paid · verified on-chain** without changing the immutable approval decision.

This does not enable native wallet broadcasting, escrow, automatic payouts or
refunds. A transfer made from a different sender wallet will not match the
campaign's authorised wallet. The public RPC used for the demo is rate-limited
and has no uptime guarantee; production needs a dedicated trusted node.


The [MAINNET claims deployment](RENDER-MAINNET.md) is live at https://nimclaim-mainnet-smv5.onrender.com. Physical no-spend Nimiq Pay acceptance for organiser access, contributor claims and review was completed on two devices on 11 November 2026. This document concerns enabling spending only.

**MAINNET spending is explicitly blocked.** `SPENDING_ENABLED=false` remains the safe configuration. A separate read-only verifier now checks transfers already sent in Nimiq Pay; it does not sign, broadcast, reserve or custody funds. The verifier cannot turn an unconfirmed or mismatched transaction into a paid receipt.

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

The active MAINNET Render service runs `npm run start:mainnet` with PostgreSQL + Neon and `NETWORK=mainnet`. It has no payout execution or escrow, but it supports read-only verification of an external NIM transfer by transaction hash. The runtime can select and insert immutable manual receipts; it cannot update or delete them. The separate TESTNET Render Blueprint runs `npm run start:staging`, requires `NETWORK=testnet` and `SPENDING_ENABLED=false`, and refuses financial routes. Automated MAINNET spending remains NO-GO. See [RENDER-STAGING.md](RENDER-STAGING.md).
