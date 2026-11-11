# NimClaim — Cycle III submission

**Submission date:** 11 November 2026  
**Category:** Pay  
**Pricing:** Free  
**Public Mini App:** https://nimclaim-mainnet-smv5.onrender.com  
**Open-source repository:** https://github.com/Alike001/nimclaim  
**Submission form:** https://miniappscompetition.com/submit

## Form details

- **App name:** NimClaim
- **Tagline:** Signed claims. Clear reward decisions.
- **Category:** Pay
- **Pricing:** Free
- **Repository:** https://github.com/Alike001/nimclaim
- **Demo URL:** https://nimclaim-mainnet-smv5.onrender.com
- **Video:** Optional; add a link only if a final demo video is ready.
- **Builder story:** Optional in the portal, but recommended to explain the real-device test and the product's deliberate settlement boundary.
- **Social / Skool links:** Add only genuine posts; do not invent links.

## Required written description (max 250 words)

NimClaim is a Nimiq Pay Mini App for open-source communities, hackathon organisers and small project teams that need a clear way to manage contributor rewards. Organisers sign in with their Nimiq Pay wallet, create a campaign with a declared NIM reward and deadline, and issue private, single-use invitation links. A contributor opens an invitation in Nimiq Pay and signs a one-time request to prove control of the receiving wallet—without creating an account or sharing a private key. Organisers review each claim, approve or reject it, and retain a persistent decision history. For approved claims, NimClaim shows the recipient address and exact NIM amount, provides copyable settlement details, and exports the approved-rewards list as CSV so an organiser can arrange a separate payment in Nimiq Pay. The workflow has been exercised on two real Nimiq Pay devices with an organiser and contributor. NimClaim does not hold funds, escrow rewards, initiate transfers, or verify external payments; an approval remains unpaid/unverified in the app until a separately verified settlement capability exists. Nimiq Pay wallet signatures and NIM are central to the experience, not just an added logo or payment button.

## Optional builder story

I built NimClaim around a simple distinction: a reward promise is not a verified claim, and an approval is not a payment. Organisers of open-source projects, hackathons and community initiatives need to know which wallet is requesting a reward; contributors need a straightforward way to prove wallet ownership without creating another account or sharing sensitive information. I wanted to make that handoff clear and traceable without pretending to solve settlement before the wallet host provides the guarantees needed for safe payment verification.

I tested the workflow on two separate Nimiq Pay devices: organiser wallet registration, campaign creation, private invitation, contributor signature, claim submission and organiser approval. After the real claim was approved, I separately sent the 10 NIM reward through Nimiq Pay. That transfer happened outside NimClaim, so the app does not record it as paid or claim to verify it. This release focuses on reliable claims, clear decisions and a safe reward handoff; automated settlement remains a separate capability that requires further technical validation.

## Release evidence

- [x] Real Nimiq Pay organiser wallet access
- [x] Real campaign created and organiser signing wallet authorised
- [x] Contributor opened a private invitation and signed
- [x] Organiser received and approved the real claim
- [x] Matching status and history on both devices
- [x] Approved Rewards address copy and CSV download
- [x] Mainnet spending disabled by server configuration
- [x] Organiser reported sending 10 NIM separately from Nimiq Pay after approval
- [ ] Independent confirmation of the separate 10 NIM transfer (transaction hash not supplied)
- [ ] Automated payout/escrow and independent settlement verifier (out of scope for this release)
- [ ] Final Cycle III submission PR accepted/merged (not yet established)

## Suggested 3-minute demo outline

0:00–0:20 — Explain the coordination problem: a reward request, wallet ownership and organiser approval should be visible and distinct. Show the landing page and MAINNET status.

0:20–0:50 — Open the organiser workspace and an existing real campaign, showing the declared per-contributor NIM amount and authorised signing wallet.

0:50–1:25 — On the contributor phone, open a private invitation **with its secret token hidden in the video**. Show wallet signing and the resulting claim, not the private request itself.

1:25–1:55 — In the organiser workspace, show the claim history and approval decision. On the contributor phone, refresh and show the same status.

1:55–2:25 — Show Approved Rewards, recipient address, copy details and CSV export. Explain that this is a handoff, not an in-app payment receipt.

2:25–3:00 — Explain that the organiser sent the 10 NIM separately through Nimiq Pay, outside NimClaim. Show the public GitHub repository and live app. Do not describe the external transfer as NimClaim-verified.

## Manual payment evidence

For the organiser-reported 10 NIM transfer, retrieve the transaction hash from Nimiq Pay if available. Use a mainnet explorer such as https://nimiq.watch/ to compare the actual sender and recipient, the 10 NIM amount (1,000,000 Luna), execution success and finality. Save a redacted screenshot or explorer link for the demo. No wallet seed, recovery phrase, invitation token or organiser authentication token should be published.

Do **not** edit the database, set a paid flag, or display an in-app paid receipt from a hash alone. NimClaim does not independently verify external MAINNET transfers.

## Last release checks

1. Reopen the public app in Nimiq Pay, confirm MAINNET, and sign into the existing workspace.
2. Reopen the existing approved campaign; check that the recipient, amount and event history survive refresh.
3. Copy the recipient details, download CSV and inspect the external-payment-unverified field.
4. Reopen the contributor invitation and confirm approval remains visible, with an explicit note that external payments are not tracked.
5. Verify that no NimClaim button initiates a wallet payment prompt and no new spending endpoint is exposed.
6. Check the README, public repository and app URL.
7. Submit through the portal before **23:59 UTC on 11 November 2026**, the published Cycle III deadline.

## Official judging rubric: evidence and remaining gaps

The official scoring guide weights functionality, reliability and usefulness at 45 points; Nimiq Pay and Nimiq integration at 25; real usage at 15; design and UX at 10; and builder promotion at 5. The Community Council also looks for a clear target audience, a real need, stability, completeness and repeat value.

- **Functionality, reliability and usefulness (45):** the demonstrated workflow is organiser wallet sign-in, campaign creation, private invitation, contributor signature, claim submission, organiser approval and persistent history. The API tests cover one-time invitations, duplicate-wallet prevention, expiry, immutable decisions and concurrent claims. The MAINNET app does not execute or verify a payout; do not present that missing capability as complete.
- **Nimiq Pay and Nimiq integration (25):** real Nimiq Pay wallet authentication and claim signatures are core to the organiser and contributor flows; rewards are denominated in NIM. The release does not broadcast a NIM transfer. Be explicit about this distinction.
- **Real usage (15):** evidence currently documents one organiser and one contributor using two separate Nimiq Pay devices. The organiser reported a separate 10 NIM transfer, but NimClaim did not make or verify it. This evidence does not establish 25+ unique users; do not claim a larger user count without records.
- **Design and UX (10):** the responsive desktop and mobile browser suites each passed 20 tests in the latest application run. These browser fixtures use synthetic signatures; the two-device acceptance is separate physical evidence. Show the mobile recipient flow and clear Approved · unpaid status.
- **Builder promotion (5):** the public MIT repository and live app are available. The demo walkthrough is encouraged but optional. Add genuine X/Skool/community posts and feedback links only if they exist; no promotional post or user count should be invented.

### Honest scope of unimplemented payment cases

Duplicate claims, used invitations, competing decisions and expired invitations are covered by application tests. Unknown payment outcomes, refunds and fulfilment are not active MAINNET workflows because NimClaim does not initiate or escrow payments. There is no refund path for funds the app never holds. Any external transfer must be checked independently; no hash or screenshot alone should change an in-app claim to paid.

### Promotion and final evidence checklist

- [ ] Record a short walkthrough using the live app and real Nimiq Pay screens; hide invitation tokens and private account material.
- [ ] Share a genuine progress/demo post with the live URL and public repository.
- [ ] Invite real community members to test the claim flow and record unique, consented usage accurately.
- [ ] Capture feedback and any fixes made in response.
- [ ] Add the actual video, X and Skool links to the portal if available.

## Facts to avoid overstating

- A wallet ownership signature proves control of a key; it does not prove contribution quality or one human per wallet.
- **Approved · unpaid** means NimClaim has no verified payment record; it does not prove that no external transfer occurred.
- The 10 NIM transfer was reported by the organiser as a separate Nimiq Pay transfer. It is not verified by NimClaim or represented by an in-app paid receipt.
- No funded contract escrow or automated MAINNET NIM payout is deployed.
- Automated browser fixtures are not the same as physical-device tests.
- Mainnet spending remains disabled.

**Judging continuity:** keep the Render service, existing PostgreSQL database, organiser workspaces, claim history and spending gate unchanged during submission.
