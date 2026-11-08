# Payout protocol and trust boundaries

## Selected sender: unresolved in SDK 0.2.5

The [official provider reference](https://nimiq.dev/mini-apps/api-reference/nimiq-provider#accounts-and-signing) and installed typings agree: `sign()` has no signer parameter and `sendBasicTransaction()` has no sender parameter. A shared address, signature, configured address or previous transfer cannot bind the next selected payment sender. NimClaim therefore does **not** claim to have completed a usable production broadcast path under the required pre-broadcast sender guarantee.

The production server never provides `verifySelectedSender`. Payment services receive that dependency only in isolated deterministic tests, where it represents a synthetic trusted commitment. It must not be replaced in production with an address-list or signing-key comparison. A future adapter must verify a commitment that remains bound to the exact intent through actual native dispatch. Installing such an adapter is an implementation/security-review milestone, not an environment change.

## Current host compatibility findings

The [payer-authorized settlement review](PAYER-SELECTED-SETTLEMENT.md) now includes pinned official host-source evidence. Ordinary native payments there use an HTLC source, and the basic handler does not forward the caller's validity-start height. The existing verifier deliberately requires a basic sender and exact requested height. Its basic-account fixtures therefore do not prove live native compatibility, even if address binding were relaxed. The production spending gate remains closed; no payout rule was changed by this investigation.

A wallet-owner-authorized alternative is conditionally viable with explicit consent and a new immutable policy/reference model. It is not the same as the SDK choosing an address and is not implemented in this build. Existing strict intents and UNKNOWN attempts must retain their original semantics.

## Protocol

1. The authenticated installation organiser can request a campaign-specific wallet-binding challenge. Its domain, purpose, origin, network, allocation, nonce, session hash and expiry are server-bound. Server verification derives the signing address and freezes a campaign-wallet record. This is an authorization role, **not sending-account evidence**. Existing campaigns can bind their wallet without losing their prior invitations or claims.
2. Payment review reads the approved claim, campaign amount, verified recipient and immutable campaign wallet. It displays exact integer Luna and NIM, network, explicit requested fee and total. No client-provided sender, recipient, amount or fee is accepted. Expired campaigns cannot start payments. Review shows gate reasons even while spending is blocked.
3. A fresh session-bound payment challenge covers those exact details. The organiser explicitly signs it. Server requires the cryptographically derived signer to equal the authorized campaign wallet, then requires an independent selected-sender commitment. The current production path stops here, before any reservation or native request.
4. With a future supported commitment, the server would independently check RPC network/consensus/head, then atomically freeze the intent, reserve one attempt, consume the nonce and return a random one-time permit. All checks are repeated inside the SQLite write transaction after asynchronous work. Unique constraints limit one intent/attempt per claim. Intent count cannot exceed campaign reward slots; all intents use the fixed per-slot amount. No fund balance or escrow is implied.
5. The browser sends the permit to an authenticated dispatch endpoint and waits for its successful acknowledgement. The server consumes it exactly once before authorizing any native call. Lost reserve or dispatch responses block progress; the browser does not repeat them or call the wallet. Permissions expire after at most 90 seconds or campaign expiry. The reservation is never released by a lease or restart.
6. Only an explicit organiser action invokes the official SDK native method with the returned immutable recipient, value, explicit fee and validity-start height. There is no sender parameter. Native confirmation remains mandatory. All calls in automated testing use wallet doubles; no real SDK wallet has been invoked.
7. The browser reports a hash, cancellation, error or timeout. These reports never establish execution or failure. They put the attempt into UNKNOWN. A cancelled browser callback cannot safely release the lock because the server cannot independently prove non-broadcast. Native timeouts do not dismiss the wallet prompt: a late approval can still submit. A missing outcome report becomes UNKNOWN on the next status read after the dispatch window. Reopening the app never repeats a native call.
8. An authenticated organiser requests read-only reconciliation with a candidate hash from the wallet's history, or the saved hint. A missing hash remains unknown; there is no automatic address scan or inference from “not found.” A corrected hash can be supplied for independent verification. This version provides no payment-reset or retry API, even after finalized failure.

## Independent chain verification

`server/rpc.ts` implements a small allowlisted client for **official Nimiq JSON-RPC**, not the wallet's RPC. Only `getNetworkId`, `isConsensusEstablished`, `getBlockNumber`, `getTransactionByHash`, `getBlockByNumber` and `getMacroBlockAfter` are permitted. Write methods are rejected before transport. It requires official `result.data` envelopes, matching request IDs, a time limit, response-size limit and no redirects. The endpoint and any Authorization header are server configuration; browser input cannot choose them.

Network is pinned to `TestAlbatross` / transaction ID 5 or `MainAlbatross` / ID 24. Reconciliation requires:

- Network match, consensus and a verified head at or beyond both inclusion and finality heights.
- A full historical transaction returned by the independent node, with exact hash, normalized sender/recipient, reward value and fee as safe integers in Luna, network ID and validity-start height.
- Basic-account sender/recipient, zero flags and no sender/recipient data, matching the SDK basic-transaction request. Prior transactions cannot match a newly frozen validity height.
- Inclusion in the canonical micro block retrieved by number, with an explicit boolean execution result matching the transaction lookup.
- A following canonical macro block at the RPC policy-reported height, on the same network and with a nonempty justification. Numerical confirmations alone are insufficient.
- A second canonical inclusion-block read after finality, with unchanged hash, transaction fields and execution outcome.
- Atomic, global transaction-hash uniqueness across payment attempts/claims before recording the receipt. Candidate hashes also have unique assignment constraints.

Successful finalized execution becomes CONFIRMED and is the only paid state. Explicit finalized execution failure becomes FAILED and shows the failed transaction receipt with **reward unpaid**. Missing/malformed evidence, pre-macro inclusion, RPC timeouts, not-found responses, consensus failure or chain mismatch stay UNKNOWN. Known mismatches in immutable transaction fields are rejected with 409 and do not create a paid receipt. Reconciliation is allowed after campaign expiry for previously reserved attempts.

The configured full/history node is the trust boundary. This is independent of frontend/wallet assertions, but is **not** local light-client verification of validator signatures. No live RPC endpoint has been selected or probed in this task. All chain fixtures are explicitly synthetic and exist only in tests. Compatibility and trust must be checked against the intended operational node before mainnet readiness.

Sources checked: [RPC migration/envelopes and transaction fields](https://nimiq.dev/migration/migration-json-rpc), [official RPC interface](https://github.com/nimiq/core-rs-albatross/blob/albatross/rpc-interface/src/blockchain.rs), [executed transaction and block types](https://github.com/nimiq/core-rs-albatross/blob/albatross/rpc-interface/src/types.rs), [macro-block policy methods](https://github.com/nimiq/core-rs-albatross/blob/albatross/rpc-interface/src/policy.rs), [network IDs](https://github.com/nimiq/core-rs-albatross/blob/albatross/primitives/src/networks.rs).

## Data and operational limits

Schema v2 adds organiser challenges, immutable campaign wallets, immutable payment intents, one-per-intent attempts, hash consumption and payment history. The old claim status remains its approval status; its `payment` object is the authoritative payout state. Screens derive the current display status from that object, so a confirmed receipt is never shown with a current “unpaid” badge. Prior approval history remains visible.

No payment retry, password recovery, multi-tenant ownership, automatic background reconciler or audited administrative repair tool is provided. A read-time transition makes stale SUBMITTING attempts UNKNOWN without releasing them. Single-organiser server authentication is retained. The default rate limiter remains process-local. SQLite is durable development storage; the README describes the Postgres path. A production migration must also preserve payment immutability, unique attempt/hash constraints and atomic dispatch/state transitions.
