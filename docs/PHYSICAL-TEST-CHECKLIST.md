# Physical Nimiq Pay test — TESTNET only

Owner-operated checks; no agent wallet access. **No payments. Mainnet NO-GO.** Use a dedicated TESTNET wallet. Never enter or share recovery material, credentials, addresses or private invitation links in screenshots.

**Phone URL:** https://192.168.186.152:8443/#diagnostics (current hotspot only). Laptop organiser: http://localhost:5173. Keep its existing login; do not run setup or replace `.env`. The phone is allowlisted for recipient routes only; organiser and payment endpoints are blocked.

1. **Trusted HTTPS.** Run `npm run mobile:status` on the laptop. Follow [CA instructions and fingerprint](NIMIQ-PAY-TEST.md). Import only `.local/mobile/nimclaim-test-ca.crt`, never a key or directory. Open the URL in Nimiq Pay → Mini Apps → Custom URL. Stop on a TLS error. Android/Nimiq Pay may not trust user CAs; browser trust alone is insufficient. Use an owner-controlled domain with a publicly trusted certificate (optionally resolving privately, with DNS certificate validation) if blocked. Do not bypass validation, modify Android/app TLS settings, use a public development tunnel or deploy without separate authorization.
2. **Wallet network.** Personally confirm Nimiq Pay is set to TESTNET, then reload the Mini App. Screenshot: network-selection screen, masking wallet details.
3. **Read-only diagnostics.** Press **Refresh wallet diagnostics**. Require SDK loaded, injected provider detected, HTTPS, API TESTNET, host TESTNET, network agreement **MATCH**, consensus established and a real block height. No account/signature/payment prompt should appear. Screenshot: the diagnostics panel. Message signing alone does not prove host chain identity.
4. **Private invitation.** On the laptop, create a test campaign/invitation through the existing organiser login. Replace only the invitation origin with `https://192.168.186.152:8443`, preserving the entire `/#claim=...` fragment, and send it privately to the phone. Check title, exact NIM amount, expiry and TESTNET. Screenshot: campaign view with URL/fragment hidden. This is a commitment, not escrow.
5. **Account consent.** Tap **Connect Nimiq Pay**. Reject once and check usable cancellation/no saved claim. Retry only by your own action. Screenshot: native account-sharing prompt, masking addresses. Shared accounts and message signers do not select a payment sender.
6. **Claim signature.** Review the native **Sign Message** prompt for `NimClaim/claim/v1`, TESTNET, exact HTTPS origin, campaign/reward and expiry. Reject once and verify no pending claim. If correct, personally approve the TESTNET claim when ready. Screenshot: prompt with nonce, hashes, IDs and addresses hidden. No transfer or payment confirmation is expected; reject and stop if one appears.
7. **Review and unpaid status.** Phone must show **Your request is with the organiser** after server verification. Laptop: refresh, review and approve/reject. Phone: refresh/reopen the same link and verify matching status/history. Approval must show **Approved. Awaiting payment.** and no NIM transferred. Screenshot: laptop review and recipient status, masking addresses/invitations. Confirm a used link cannot create a second claim. Preserve UNKNOWN reservations; never reset or retry payments.

If blocked, record only OS/app version, screen name and sanitized error; never share private links or wallet data. Actual provider injection, native consent/signature behavior and TLS trust remain unverified until these owner checks are completed.

From the project directory, `npm run mobile:status` verifies existing services. Restart only if needed:

```sh
npm run mobile:stop
npm run build
npm run mobile:start -- --bind-ip 192.168.186.152 --phone-ip 192.168.186.167
```

Recheck actual hotspot IPs before restart. No firewall widening, TLS bypass, database reset or live-spending enablement is part of this procedure. See [mainnet blockers](MAINNET-READINESS.md).
