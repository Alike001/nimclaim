# Private HTTPS mobile test

Physical Nimiq Pay testing has **not** been performed. No HTTPS listener, tunnel, deployment, real signing request or payment was started during implementation. The prepared URL is **`https://<your-desktop-private-LAN-IP>:8443`**. Its actual address depends on your LAN; no reachable mobile URL is claimed yet.

**GO for a separately user-operated, no-spend physical signing/review test. NO-GO for any real mainnet transaction.** The current official provider has no sender argument or verifiable pre-broadcast sending-account commitment. All production reservations/dispatches remain blocked even if the spending environment flags are changed. Signing and sharing an account cannot prove which account will send a transaction.

## Preserve the current installation

Do not rerun setup, overwrite `.env`, delete the database or change its network. Existing organiser credentials and data are retained. The API automatically applies an additive schema-v2 migration on next start. Stop all NimClaim processes and make a protected backup of the database and any WAL files before upgrading. Tests use separate temporary databases, never the existing development database.

If using a separate test database, explicitly choose a new `DATABASE_PATH` and run setup only for that new installation. Do not switch a populated testnet database to mainnet: network binding is immutable.

## Local HTTPS, no public tunnel

Use a private Wi-Fi/LAN you control and a current Caddy binary. Do not expose the API, Vite, organiser login, Caddy admin API or local secrets through a public development tunnel. Do not open router ports or change the API's loopback binding. Use DHCP reservations or otherwise keep the phone and desktop IP addresses stable.

Example addresses below are placeholders; substitute your actual private IPv4 addresses. In a terminal:

```sh
cd /home/ali/Desktop/nim/nimclaim
npm ci
npm run build
mkdir -p .local
cp ops/Caddyfile.mobile.example .local/Caddyfile.mobile
export MOBILE_BIND_IP=192.168.1.50
export MOBILE_DESKTOP_IP=192.168.1.50
export MOBILE_PHONE_IP=192.168.1.60
caddy validate --config .local/Caddyfile.mobile --adapter caddyfile
caddy run --config .local/Caddyfile.mobile --adapter caddyfile
```

The example binds HTTPS only on the chosen private address/8443, allows only the desktop and phone source IPs, disables the Caddy admin API and HTTP redirects, and proxies to `127.0.0.1:3001`. Caddy access logging is not enabled. Keep the host firewall limited to those two source addresses. The Caddyfile does not contain credentials. Caddy is not installed or running as part of this task, so its validation and device certificate compatibility remain manual checks.

In another terminal, keep `.env` and its `DATABASE_PATH` intact and override only the app origin and safe spending settings for this run:

```sh
cd /home/ali/Desktop/nim/nimclaim
APP_ORIGIN=https://192.168.1.50:8443 HOST=127.0.0.1 PORT=3001 SPENDING_ENABLED=false npm start
```

Use the network already recorded in this database. Copy **only Caddy's public `root.crt`** from its `pki/authorities/local` data directory to the phone via a private channel and install/trust it for HTTPS, following the OS trust settings. Never share the CA private key, server private keys, database, `.env`, session cookies or organiser password. Some Android WebViews do not trust user-installed CAs; if Nimiq Pay rejects the certificate, stop and resolve trust with a supported device/private-network certificate setup. Do not bypass certificate errors or disable TLS verification. Remove the test CA from the phone when testing ends.

Open `https://192.168.1.50:8443` on the desktop and phone. Verify a trusted certificate and a successful `/api/config` response; it must show the expected network and payment gate reasons. The example's organiser login is reachable only from allowlisted private devices and still requires the existing password with Secure, HttpOnly, SameSite=Strict cookies. Rate limits remain active. Changing origin invalidates old signing challenges; generate new invitations using the HTTPS origin.

## Physical no-spend test

1. In an ordinary browser on an allowlisted device, sign in with existing organiser credentials. Create an explicitly labelled test campaign and invitation. Confirm the URL starts with the chosen private HTTPS origin.
2. Open the **full invitation including `/#claim=...`** through Nimiq Pay → Mini Apps → Custom URL. Use a dedicated test wallet selected by its owner, not a funded wallet. Do not let the coding agent interact with your wallet. For testnet, the official guide describes long-pressing Settings for 10 seconds and selecting Testnet; confirm the injected network matches the database.
3. Tap Connect Nimiq Pay. Cancel consent once, retry, then inspect network/consensus/block states. Cancel claim signing once and verify that no pending claim appears. Review the exact message and, only by explicit owner action, approve a test signature. Verify the address derived by the backend, not an assumed first shared account.
4. Approve the claim in the organiser workspace. Recipient must show payment-ready and unpaid.
5. On the organiser's phone inside Nimiq Pay, explicitly authorize the campaign signing wallet if desired. This permanently binds that signing address to the campaign but does not attest the sending address. Review the exact domain-separated message before approving.
6. Open **Review native NIM payment**. Verify sender commitment limitation, recipient, exact NIM/Luna amount, network, requested fee and total. Connect-for-payment must remain disabled with the sender-assurance blocker. There must be **no native payment prompt and no broadcast**. Stop if one appears.
7. Test ordinary-browser provider absence, network mismatch, expired invitation and duplicate claims. Restart the backend with the same database and confirm history and session persistence. Do not record or publish raw invitation URLs, passwords, session cookies or wallet identifiers in Git.

Record device/OS, Nimiq Pay version, SDK lockfile version, certificate setup and observed outcomes. This checks physical signing and fail-closed review only; it cannot certify the blocked payment path.

A future supported sender commitment or separately agreed transaction-signing interface is required before any physical payout test. See [mainnet readiness](MAINNET-READINESS.md). Automated native method calls use isolated wallet doubles and synthetic chain fixtures; they are not evidence of a real transfer.

Sources: [provider reference](https://nimiq.dev/mini-apps/api-reference/nimiq-provider), [official local mini app testing guide](https://nimiq.dev/mini-apps/development/load-local-mini-app), [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https), [Caddy bind](https://caddyserver.com/docs/caddyfile/directives/bind).
