# NimClaim

**Signed claims. Clear reward decisions.**

NimClaim is a Nimiq Pay Mini App for open-source communities, hackathon
organisers and small project teams. It helps organisers create NIM reward
campaigns, invite contributors privately, verify receiving-wallet ownership,
review claims and prepare a clear settlement handoff.

- **Live Mini App:** https://nimclaim-mainnet-smv5.onrender.com
- **Source:** https://github.com/Alike001/nimclaim
- **Competition:** Nimiq Mini Apps Competition — Cycle III, Pay category
- **License:** MIT

## Current release

The public Render deployment runs the MAINNET, PostgreSQL-backed,
wallet-authenticated claims workflow. It supports separate organiser
workspaces, signed organiser access, private invitations, contributor wallet
signatures, claim review, persistent decision history and an Approved Rewards
handoff with copyable recipient details and CSV export.

**Important payment boundary:** MAINNET spending is disabled. NimClaim does
not hold or escrow reward funds, initiate NIM transfers, or independently
verify transfers made outside the app. A campaign amount is a declared reward
commitment, not reserved money. An approved claim means the organiser approved
the claim; it does not mean the reward has been paid. The app deliberately
does not mark external transfers as paid.

The organiser and contributor workflow was exercised on two separate real
Nimiq Pay devices on 11 November 2026. Automated browser tests use synthetic
test signatures and are reported separately from that physical-device
acceptance. No populated demo campaigns or payment receipts are fabricated.

## How it works

1. **Organiser signs in.** The organiser opens NimClaim inside Nimiq Pay and
   signs a one-time wallet-authentication message.
2. **Campaign is created.** The organiser sets a title, description, NIM reward
   amount, available claim slots and expiry, then authorises the campaign's
   signing wallet.
3. **Contributor claims.** The organiser shares a private invitation. The
   contributor opens it inside Nimiq Pay, reviews and signs a one-time
   wallet-ownership request, and submits a claim without creating an account.
4. **Organiser reviews.** The organiser approves or rejects the claim. Both
   sides can see the resulting decision and history.
5. **Reward handoff.** Approved Rewards shows the recipient address and exact
   NIM amount, supports copying settlement details and exports a CSV for
   separately arranged payment.

## Nimiq Pay integration

Nimiq Pay is part of the core workflow, not just a logo or payment link:

- Organisers authenticate by signing with their Nimiq Pay wallet.
- Contributors prove control of the receiving wallet by signing a
  claim-specific message.
- Campaigns declare rewards in NIM and display the receiving NIM address.
- The app uses the Nimiq Mini App provider and SDK; it never asks for a wallet
  PIN, recovery phrase or private key.

This release is a claims and review workflow with a settlement handoff. It is
not an automated payment processor. Do not describe a claim approval, copied
address, CSV export or external transaction hash as a verified payment.

## Try the Mini App

For the wallet-signing flow, open the public HTTPS URL from inside Nimiq Pay:

1. Open **Nimiq Pay → Mini Apps → Custom URL**.
2. Paste the public URL shown above.
3. Choose **Sign in with Nimiq Pay** to access an existing organiser
   workspace, or **Create a new workspace** for a new organiser.
4. Create a campaign, authorise its signing wallet and generate an invitation.
5. Open the complete invitation URL in Nimiq Pay on a contributor device.
6. Sign and submit the claim; return to the organiser workspace to review it.

Contributors do not need an organiser account. Treat invitation links as
private bearer credentials: share them only with the intended recipient and
never publish their secret token in screenshots, videos or public posts.

## Known limitations

- MAINNET NIM spending is disabled by server configuration.
- There is no escrow, on-chain reward reservation or automatic payout.
- NimClaim does not record or verify transfers made separately in Nimiq Pay.
- Approved claims remain unverified in the app even if an organiser later
  sends a separate transfer.
- Wallet signatures prove control of a key, not contribution quality or one
  human per wallet.
- Wallet recovery is controlled by the user's Nimiq wallet; NimClaim cannot
  recover a lost wallet or invitation.

These are intentional release boundaries, not hidden or simulated features.
See [MAINNET readiness](docs/MAINNET-READINESS.md) and
[security notes](docs/SECURITY.md).

## Technology

- React, TypeScript and Vite
- Node.js API and PostgreSQL 17
- Render web service and Neon PostgreSQL
- Nimiq Mini App SDK and Nimiq wallet signatures
- MIT-licensed open-source code

The hosted MAINNET service uses the PostgreSQL runtime. The separate SQLite
runtime and gated TESTNET payout research are development/technical paths;
they are not enabled as MAINNET spending capabilities.

## Development

Requires Node.js **24.14+** and npm.

    npm ci
    cp .env.example .env
    npm run setup
    npm run dev

The setup command creates a local organiser credential once. Keep the
generated password in a password manager. Do not overwrite an existing
environment file, database or organiser credential when upgrading an
installation. The default local configuration is for TESTNET development; the
hosted MAINNET service has separate credentials and storage.

Useful commands:

    npm run typecheck       # TypeScript checks
    npm run build           # Typecheck and production client build
    npm test                # Unit, API and cryptographic tests
    npm run test:runtime    # Runtime and restart-persistence tests
    npm run test:browser    # Desktop and mobile browser suites
    npm run check           # Unit tests, build, runtime and browser suites
    npm run test:postgres   # PostgreSQL 17 integration tests (Docker required)
    npm run format:check    # Prettier verification

The automated browser suite uses synthetic fixtures. It does not replace
physical Nimiq Pay device testing. PostgreSQL integration tests create
disposable, labelled local test databases; they do not connect to the hosted
Neon database.

## Deployment and operations

The live service is configured on Render with auto-deploy disabled and uses
the main branch. Deployments are intentionally reviewed and triggered
manually. The production service uses an isolated Neon PostgreSQL 17 database
and the production MAINNET runtime.

Do not run local setup or staging bootstrap against production. Do not reset
the hosted database, replace its credentials, enable spending, or change the
financial gate as part of a documentation or demo update.

Deployment and acceptance instructions:
- [MAINNET Render deployment](docs/RENDER-MAINNET.md)
- [Physical device test checklist](docs/PHYSICAL-TEST-CHECKLIST.md)
- [Nimiq Pay device notes](docs/NIMIQ-PAY-TEST.md)
- [Release and submission checklist](docs/CYCLE3-SUBMISSION.md)

## Project documentation

- [Architecture and test report](docs/REPORT.md)
- [Security model](docs/SECURITY.md)
- [Payment architecture and limitations](docs/PAYMENTS.md)
- [MAINNET readiness and disabled capabilities](docs/MAINNET-READINESS.md)
- [Cycle III submission description and demo outline](docs/CYCLE3-SUBMISSION.md)

## Competition submission

NimClaim is submitted in the **Pay** category. Its Nimiq integration is the
wallet-authenticated organiser and contributor claim flow, with NIM-denominated
reward commitments and a separate settlement handoff. The current release
does not execute or verify the NIM transfer itself; this boundary is disclosed
in the app and submission materials.

The official competition requires a working Mini App, a public MIT repository,
a written description of no more than 250 words, and meaningful Nimiq Pay
integration. A demo walkthrough is encouraged. The current submission copy and
demo plan are in [docs/CYCLE3-SUBMISSION.md](docs/CYCLE3-SUBMISSION.md).

## License

NimClaim is released under the [MIT License](LICENSE).
