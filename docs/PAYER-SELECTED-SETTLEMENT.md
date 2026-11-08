# Sender selection and payer-authorized settlement review

Reviewed 8 November 2026 on Node 24.14.1, starting from NimClaim `5f4ac639`. This is an investigation and a proposed design, **not an implemented policy change or spending authorization**. No native wallet request, real signature, payment, spending enablement, deployment or push was performed.

## Decision

A wallet-owner-authorized settlement model is viable in principle: an authenticated organiser approves a reward, and the person controlling the active Nimiq Pay wallet explicitly elects to fund it. The campaign approval key and the on-chain spending account need not be the same. Backend receipt verification can establish which account actually paid without asserting that it belongs to the approval signer.

That model does **not** make the SDK select a sender or expose an address selector. In the inspected host, the ordinary NIM confirmation has neither a sender row nor an account picker. It is therefore only defensible as explicit authorization to spend the active wallet's NIM funds, with clear wallet context and separately accepted product semantics. It cannot promise pre-broadcast approval of a particular on-chain source address. If that promise is required, retain strict sender binding and wait for a supported host capability or choose a separately reviewed interface.

**Current mainnet result: NO-GO.** Physical informed-consent evidence, a versioned policy implementation and real-host/RPC compatibility tests are missing. Merely deleting the sender check would be unsafe. The current sender guard, spending defaults, schema, immutable records and payment implementation remain unchanged by this review.

## Evidence and confidence

Official Mini App docs require native confirmation and specify `sendBasicTransaction({recipient,value,fee?,validityStartHeight?})` returning a hash. Neither it nor the installed SDK **0.2.5** exposes a sender parameter or pre-broadcast transaction inspection. `sign()` returns a public key/signature; `listAccounts()` shares addresses. Neither selects the next payment sender. These are API-contract facts. [Provider reference](https://nimiq.dev/mini-apps/api-reference/nimiq-provider), [FAQ](https://nimiq.dev/mini-apps/faq#can-i-choose-which-nimiq-address-signs-or-pays)

Nimiq's [official open-source announcement](https://www.nimiq.com/blog/nimiq-pay-is-now-open-source/) identifies its host repository. The source inspection below is pinned to **`dd90a9c5443be3f4e0ddeac454486c9d512fcae3`**, whose package version is **2.23.0**. It is evidence about that source revision, **not proof of the binary installed on a phone**. Host GPL code was read for facts; no host implementation was copied into NimClaim's MIT code.

| Question                              | Evidence from the inspected native NIM path                                                                                                           | What it does not establish                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| What signs messages?                  | The host uses its local wallet key after message confirmation.                                                                                        | That key's derived address is not the transaction funding address.                             |
| What funds an ordinary payment?       | The host requires its remote account; transaction construction uses that account as an HTLC sender and a basic recipient.                             | No caller-selected sender or stable mapping to a human identity is exposed to the Mini App.    |
| Is requested validity height honored? | The basic handler parses recipient/value/fee and does not forward the supplied validity height. Transaction construction obtains a height internally. | The SDK typing alone does not guarantee the requested height is the one used by this revision. |

Sources: [host signing/payment handlers](https://github.com/nimiq/nimiq-pay-app/blob/dd90a9c5443be3f4e0ddeac454486c9d512fcae3/src/composables/useMiniAppHost.ts#L1560-L1699), [confirmation-to-send path](https://github.com/nimiq/nimiq-pay-app/blob/dd90a9c5443be3f4e0ddeac454486c9d512fcae3/src/composables/useMiniAppHost.ts#L2151-L2251), [ordinary transaction construction](https://github.com/nimiq/nimiq-pay-app/blob/dd90a9c5443be3f4e0ddeac454486c9d512fcae3/src/lib/tx.ts#L48-L67). Installed Nimiq core typings define Basic as 0 and HTLC as 2.

## What native confirmation shows

For an ordinary native NIM payment in that revision:

| Element                    | Source-derived behavior                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Identity/context           | App name/hostname and logo; a transaction confirmation title.                                                                  |
| Recipient                  | Generally first four and last four characters, not the full address; special labels for the local account or staking contract. |
| Amount                     | NIM formatting defaults to at most two decimal places. Do not call this an exact five-decimal display.                         |
| Fee                        | A row appears only for a nonzero fee; formatting permits all five NIM decimals.                                                |
| Reference                  | A message row is included when data/message is supplied.                                                                       |
| Controls                   | Confirm and Reject buttons.                                                                                                    |
| Absent from these NIM rows | Sender address, account selector, explicit mainnet/testnet field, validity height and a computed total.                        |

This is an inspection of the NIM branch, not the separate EVM or Lightning dialogs. [NIM sheet construction](https://github.com/nimiq/nimiq-pay-app/blob/dd90a9c5443be3f4e0ddeac454486c9d512fcae3/src/lib/mini-app-confirmation.ts#L78-L150), [amount/fee formatter](https://github.com/nimiq/nimiq-pay-app/blob/dd90a9c5443be3f4e0ddeac454486c9d512fcae3/src/composables/useCurrencyFormatter.ts#L60-L65)

The native sheet does not prove the whole recipient address to the user. NimClaim must retain a trusted HTTPS review with full recipient, exact NIM/Luna, requested fee, total and network. Native truncation and amount formatting are residual consent risks; a synthetic browser dialog is not evidence that the phone makes these sufficiently clear.

## Consequences for the actual current code

- `Payments.details()` currently treats the campaign signing wallet as the expected chain sender. `reserve()` independently requires `verifySelectedSender`, which production intentionally lacks. This protects the current promise; account-list ordering or another message signature cannot fulfill it.
- Schema-v2 `payment_intents.sender` is non-null and immutable. It cannot honestly represent an unknown future payer source by storing the approval key and later rewriting it.
- `server/rpc.ts` additionally requires `fromType === 0`, empty recipient data and the exact reserved validity height. The inspected host constructs an HTLC sender (type 2) and chooses its own height. Even removing the sender-address comparison would leave incompatible assumptions and could result in real funds moving while the app rejects the receipt. The existing tests use deliberate basic-account fixtures, not demonstrated native-host compatibility.
- `submitNativePayment()` already reserves before its native request, consumes a one-time dispatch acknowledgement, binds immutable recipient/amount/fee, records ambiguity and never auto-retries. Preserve these properties in either future model.

No reconciliation criterion was relaxed and no existing UNKNOWN attempt was reclassified as paid in this task.

## Smallest safe prospective design

This is the narrow design to implement and test if wallet-level payer consent is explicitly accepted. It is not available through configuration in the current build.

1. **Version and opt in.** Use a new explicit settlement policy for newly opted-in campaigns/attempts, such as `wallet-owner-authorized-v1`. Retain the authenticated organiser and campaign approval key as authorization actors. Do not reinterpret old strict-sender campaigns, signed challenges, immutable intents, pending attempts or receipts. Version any schema/API migration and restore-test it with existing data.
2. **Separate authorization from funding.** The organiser's one-time, session/origin/network/claim-bound authorization must cover recipient, exact integer Luna amount, exact requested fee, expiry, settlement policy and unique reference. It authorizes settlement without naming a guaranteed source account. The human payer must separately and explicitly choose to use the active Nimiq Pay wallet's funds and confirm the native request. In the smallest scope this is the signed-in organiser using their own wallet; adding public sponsors or recipient-initiated payments is out of scope.
3. **Do not invent an expected sender.** Freeze the source policy before broadcast, with an explicit unknown expected source. Store the canonical, observed chain sender/type in the verified receipt. Never describe the observed sender as cryptographically owned by the campaign approver merely because the reward settled. If product requirements demand a specific funding address, this model is ineligible.
4. **Bind this payment to this intent.** Since sender is not prebound and supplied validity height is not honored by the inspected host, plain `sendBasicTransaction()` fields are insufficient correlation for repeated identical rewards. The smallest supported native extension is `sendBasicTransactionWithData()`, using a fresh opaque per-attempt reference, e.g. `NC-PAY-1:<UUID>` (45 ASCII bytes, below the 64-byte limit). Freeze the exact reference before dispatch, pass it as data and verify exact on-chain `recipientData`. It is public: never include invitation tokens, names or credentials. It must survive the actual native signing path; test this rather than assuming it.
5. **Preserve all reservation protections.** Atomically enforce approved/unexpired claim, fixed campaign allocation and per-payment cap; create immutable intent/attempt and consume the nonce before requesting the wallet. Consume dispatch exactly once. Lost API/native responses, cancelled callbacks, backgrounding, process restart and late wallet results retain the same permanent lock. No auto-retry and no lock release on a time lease or “not found” response.
6. **Verify independently.** Pin RPC network/ID, consensus and canonical chain; match exact recipient, value, requested fee, unique reference and permitted transaction structure. Support only separately tested native funding account kinds (the inspected path is HTLC-to-basic), not all contract transactions. Treat host-chosen validity height as observed evidence under a reviewed reservation/inclusion window and policy, not as an echoed frontend field. Preserve explicit execution success, canonical inclusion and following-macro finality checks, a final inclusion reread and globally unique hash consumption. Missing or contradictory evidence stays UNKNOWN. The hash remains only a lookup hint.
7. **Keep receipts truthful.** Report campaign approval actor, settlement policy, observed sender/type, recipient, exact reward/fee, network, reference, transaction hash, inclusion and finality. Describe it as a reward settled from the observed source, not proof that a particular person or campaign treasury paid. Failed execution never becomes paid. Display verified chain data only; do not overwrite the original intent with client-reported “actual” values.
8. **Make informed consent a release gate.** Keep full in-app review and require explicit owner action followed by native confirmation. Native source has no address selector: the claim is authorization to use the chosen wallet context, not an exact selected address. Until device testing resolves exact amount presentation, constrain new-policy rewards to amounts exactly representable in the observed native amount display; never round a frozen reward to make it fit. If the payer cannot recognize the funding wallet/context or adequately verify the destination/amount/network, retain NO-GO and require host UI/capability changes.

The additional public reference and HTLC support require reviewed code changes; this task intentionally does not switch payment methods or weaken the existing verifier. There is no on-chain escrow, reservation of wallet funds or custody in this proposal.

## Physical device evidence still required

Only the wallet owner may perform these checks in a separately authorized session; no agent wallet interaction is authorized here. Start with private HTTPS and a dedicated testnet wallet. Record OS, Nimiq Pay build and network; do not publish secrets or invitation links.

- Observe native sheets on supported iOS/Android builds: full app identity, recipient truncation/expansion options, amount precision, fee/total, message/reference, network indication and presence/absence of payer/account controls. Source inspection cannot certify installed-build rendering, native-plugin behavior or accessibility.
- Establish whether wallet-level consent is informed in that actual build: which funds/account context the person believes will be spent, whether they can choose/change it, how the local signing account differs from the funding HTLC and what happens after contract rotation. A testnet success does not confer an address-binding guarantee absent from the API.
- In a separately approved testnet transfer test, compare all requested fields and the exact reference against independent RPC, including sender type, actual validity height, fee, success and finalized receipt. Do not infer any of these from returned accounts or a hash. A mainnet test requires later explicit approval.
- Test rejection, native timeout, closing/reopening, lock/background, wallet or network changes during the prompt, late approval and lost API responses. A native rejection callback or absent hash does not release the attempt. Inspect ambiguous transactions independently before any further action.

**Decision rule:** if explicit wallet-owner funding consent is verified and accepted, a new versioned model can remove the need for organiser-address sender equality while preserving payment correctness. If exact address selection is required or funding/network context remains misleading, sender uncertainty is unacceptable and NO-GO remains. Neither policy is enabled by this document.
