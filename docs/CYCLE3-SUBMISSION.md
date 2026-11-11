# NimClaim — Cycle III submission

**Submission date:** 11 November 2026  
**Category:** Pay  
**Pricing:** Free  
**Public Mini App:** https://nimclaim-mainnet-smv5.onrender.com  
**Open-source repository:** https://github.com/Alike001/nimclaim  
**Submission form:** https://miniappscompetition.com/submit

## Form details

- **App name:** NimClaim
- **Tagline:** Signed claims. Verified NIM rewards.
- **Category:** Pay
- **Pricing:** Free
- **Repository:** https://github.com/Alike001/nimclaim
- **Demo URL:** https://nimclaim-mainnet-smv5.onrender.com
- **Video:** Optional; add a link only if a final demo video is ready.
- **Builder story:** Optional in the portal, but recommended to explain the real-device test and the product's deliberate settlement boundary.
- **Social / Skool links:** Add only genuine posts; do not invent links.

## Required written description (max 250 words)

NimClaim is a Nimiq Pay Mini App for open-source communities, hackathon organisers and small teams that need a traceable way to manage contributor rewards. Organisers sign in with their Nimiq Pay wallet, create a campaign with a NIM reward and deadline, and issue private, single-use invitations. Contributors open an invitation in Nimiq Pay and sign a one-time request proving control of the receiving wallet without creating an account or sharing a private key. Organisers review and approve claims. For each approved claim, NimClaim shows the exact recipient and reward amount. The organiser sends NIM separately through Nimiq Pay, then submits the transaction hash. The server independently verifies the authorised campaign-wallet sender, recipient, exact Luna value, successful canonical inclusion and macro-block finality before recording an immutable receipt. Reused hashes are rejected. NimClaim does not broadcast or custody funds. The workflow has been exercised on two real Nimiq Pay devices; automated tests use synthetic fixtures. Nimiq Pay wallet signatures and verified NIM transfers are central to the product, not an added logo or payment button.

## Optional builder story

I built NimClaim because a reward promise, an approval and a payment are three different events. Organisers need a reliable way to track who claims, while contributors need to prove wallet ownership without sharing sensitive information. I tested the claim flow on two Nimiq Pay devices. After approval, I sent a 10 NIM reward separately through Nimiq Pay. NimClaim now supports server-side verification of a transaction hash against the approved campaign's authorised sender, recipient, exact amount and finality. The 10 NIM transaction remains unverified in the app until its hash is supplied and passes those checks. The product deliberately never sends or holds funds.

## Release evidence

- [x] Real Nimiq Pay organiser wallet access
- [x] Real campaign created and organiser signing wallet authorised
- [x] Contributor opened a private invitation and signed
- [x] Organiser received and approved the real claim
- [x] Matching status and history on both devices
- [x] Approved Rewards address copy and CSV download
- [x] Mainnet spending disabled by server configuration
- [x] Organiser reported sending 10 NIM separately from Nimiq Pay after approval
- [x] MAINNET read-only verifier checks exact sender, recipient, amount and macro finality
- [ ] Supply and verify the separate 10 NIM transaction hash before claiming that transfer is confirmed
- [ ] Automated payout/escrow and independent settlement verifier (out of scope for this release)
- [ ] Final Cycle III submission PR accepted/merged (not yet established)

## Suggested 3-minute demo outline

0:00–0:20 — Explain the coordination problem: a reward request, wallet ownership and organiser approval should be visible and distinct. Show the landing page and MAINNET status.

0:20–0:50 — Open the organiser workspace and an existing real campaign, showing the declared per-contributor NIM amount and authorised signing wallet.

0:50–1:25 — On the contributor phone, open a private invitation **with its secret token hidden in the video**. Show wallet signing and the resulting claim, not the private request itself.

1:25–1:55 — In the organiser workspace, show the claim history and approval decision. On the contributor phone, refresh and show the same status.

1:55–2:25 — Show Approved Rewards, the approved/paid/unpaid counts, recipient, exact amount and transaction-hash verification. Submit the 10 NIM hash only after checking it is the correct transfer.

2:25–3:00 — Show Paid · verified on-chain only if the independent checks succeed. Explain that the organiser sent the transfer through Nimiq Pay; NimClaim did not broadcast or custody it. Show the public GitHub repository and live app.

## Manual payment evidence

For the organiser-reported 10 NIM transfer, retrieve the transaction hash from Nimiq Pay and submit it in Approved Rewards. NimClaim checks the campaign-authorised sender, approved recipient, 1,000,000 Luna amount, successful execution, canonical block and macro-block finality. If any check fails or the RPC is unavailable, the claim remains unpaid. Save the resulting explorer link for the demo only after verification succeeds. Never publish a wallet seed, recovery phrase, invitation token or organiser authentication token.

Do **not** edit the database or set a paid flag manually. A hash alone is not proof; only the server-side verifier may create an immutable paid receipt after every chain check succeeds.

## Last release checks

1. Reopen the public app in Nimiq Pay, confirm MAINNET, and sign into the existing workspace.
2. Reopen the existing approved campaign; check that the recipient, amount and event history survive refresh.
3. Copy the recipient details, download CSV and inspect the external-payment-unverified field.
4. Reopen the contributor invitation and confirm the verified payment receipt appears after successful verification.
5. Verify that no NimClaim button initiates a wallet payment prompt; only the read-only hash-verification endpoint is exposed.
6. Check the README, public repository and app URL.
7. Submit through the portal before **23:59 UTC on 11 November 2026**, the published Cycle III deadline.

## Official judging rubric: evidence and remaining gaps

The official scoring guide weights functionality, reliability and usefulness at 45 points; Nimiq Pay and Nimiq integration at 25; real usage at 15; design and UX at 10; and builder promotion at 5. The Community Council also looks for a clear target audience, a real need, stability, completeness and repeat value.

- **Functionality, reliability and usefulness (45):** the demonstrated workflow is organiser wallet sign-in, campaign creation, private invitation, contributor signature, claim submission, organiser approval and persistent history. The API tests cover one-time invitations, duplicate-wallet prevention, expiry, immutable decisions and concurrent claims. The MAINNET app does not execute or verify a payout; do not present that missing capability as complete.
- **Nimiq Pay and Nimiq integration (25):** real Nimiq Pay wallet authentication and claim signatures are core to the workflow. Organisers send NIM through Nimiq Pay, and NimClaim independently verifies the exact MAINNET transfer by hash and finality. NimClaim does not broadcast or custody funds.
- **Real usage (15):** evidence currently documents one organiser and one contributor using two separate Nimiq Pay devices. The organiser reported a separate 10 NIM transfer; its transaction hash still needs to be submitted and verified before claiming an on-chain paid result. This does not establish 25+ unique users.
- **Design and UX (10):** the responsive desktop and mobile browser suites each passed 20 tests in the latest application run. These browser fixtures use synthetic signatures; the two-device acceptance is separate physical evidence. Show the mobile recipient flow and the correct settlement state: Paid · verified on-chain after a successful hash check, otherwise Approved · unpaid.
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
- The 10 NIM transfer was reported by the organiser as a separate Nimiq Pay transfer. It must pass the new hash verifier before NimClaim represents it with an in-app paid receipt.
- No funded contract escrow or automated MAINNET NIM payout is deployed.
- Automated browser fixtures are not the same as physical-device tests.
- Mainnet spending remains disabled.

**Judging continuity:** keep the Render service, existing PostgreSQL database, organiser workspaces, claim history and spending gate unchanged during submission.
