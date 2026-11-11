# NimClaim — Cycle III submission

**Submission date:** 11 November 2026  
**Category:** Pay  
**Public Mini App:** https://nimclaim-mainnet-smv5.onrender.com  
**Open-source repository:** https://github.com/Alike001/nimclaim  
**Submission form:** https://miniappscompetition.com/submit

## Copy-ready description (under 250 words)

NimClaim helps Nimiq communities recognise and organise contributor rewards. Organisers connect their Nimiq Pay wallet, create a campaign with a declared NIM reward and deadline, and issue private invitation links. Each contributor opens their link inside Nimiq Pay, signs a one-time wallet ownership request, and submits a claim without registering or sharing a private key. Organisers review verified claims, approve or reject them, and maintain a visible decision history.

On MAINNET, NimClaim supports separate wallet-owned organiser workspaces, private invitations, real wallet signatures, persistent claims and approval statuses. An Approved Rewards view provides the recipient NIM address, exact amount, copyable settlement details and a CSV handoff for organisers.

**Important limit:** the declared reward is not escrowed. An approved claim is not proof of payment. Organisers may send NIM separately with Nimiq Pay, but NimClaim does not initiate, track or independently verify those transfers. The interface labels approvals as unverified/unpaid in-app, even if an external payment has occurred. Automated settlement, escrow and paid receipts are not part of this release.

The public version uses Nimiq Pay for wallet verification and was exercised on real mainnet devices with an organiser and contributor.

## Release evidence

- [x] Real Nimiq Pay organiser wallet access
- [x] Real campaign created and organiser signing wallet authorised
- [x] Contributor opened a private invitation and signed
- [x] Organiser received and approved the real claim
- [x] Matching status and history on both devices
- [x] Approved Rewards address copy and CSV download
- [x] Mainnet spending disabled by server configuration
- [ ] Independent confirmation of the organiser-reported separate 10 NIM transfer (transaction hash not supplied)
- [ ] Automated payout/escrow and independent settlement verifier (out of scope)
- [ ] Final submission form accepted and merged (not yet established)

## Suggested 3-minute demo outline

0:00–0:20 — Explain why contributors need a clear signed claim and organiser decision. Show the landing page and MAINNET status.

0:20–0:50 — Open the organiser workspace and an existing real campaign, showing the per-contributor NIM commitment and authorised signing wallet.

0:50–1:25 — On the contributor phone, open a private invitation **with its secret token hidden in the video**. Show wallet signing and the resulting claim, not the private request itself.

1:25–1:55 — In the organiser workspace, show the claim history and approval decision. On the contributor phone, refresh and show the same status.

1:55–2:25 — Show Approved Rewards, verified recipient address, copy details, and CSV export. Explain it is a payout handoff, **not an actual payment receipt**.

2:25–3:00 — Explain that any NIM transfer must be signed separately in Nimiq Pay and independently verified on-chain. Show public GitHub README and end with the public app link.

## Manual payment evidence (before claiming it is confirmed)

For the organiser-reported 10 NIM transfer, retrieve the transaction hash from Nimiq Pay. Use a mainnet explorer such as https://nimiq.watch/ to compare the actual sender and recipient, the 10 NIM amount (1,000,000 Luna), execution success and finality. Save a redacted screenshot or explorer link for the demo. No wallet seed, recovery phrase, invitation token or organiser authentication token should be published. Do **not** edit the database, set a paid flag, or display an in-app paid receipt from a hash alone.

## Last release checks

1. Reopen the public app in Nimiq Pay, confirm MAINNET, and sign into the existing workspace.
2. Reopen an existing approved campaign; check that the recipient, amount and event history survive refresh.
3. Copy the recipient details, download CSV and inspect its external-payment-unverified column.
4. Reopen the contributor invitation and confirm approval remains visible, with an explicit note that external payments are not tracked.
5. Verify that no wallet payment prompt is initiated by any NimClaim button and no new spending endpoint is exposed.
6. Check the README, demo link, GitHub repository and app URL; submit the form **before 23:59 UTC on 11 November 2026**.

## Facts to avoid overstating

- Wallet ownership signature is real; it does not prove contribution quality or one human per wallet.
- Approved · unpaid means the application has no verified payment record; it does not prove money was never sent externally.
- The user reported one 10 NIM payment made outside NimClaim; no independently verified on-chain receipt was available when this document was written.
- No funded contract escrow or automated MAINNET NIM payout is deployed.
- Automated browser fixtures are not the same as physical-device tests.

**Judging continuity:** keep the Render service, existing PostgreSQL database, workspace accounts, claim history and spending gate unchanged during submission.
