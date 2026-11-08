# Private Android test: running, phone validation pending

For the short owner-operated sequence, use the [one-page physical test checklist](PHYSICAL-TEST-CHECKLIST.md). This guide retains the detailed certificate, access-control and startup instructions.

The private endpoint was started and verified locally on 8 November 2026. The laptop is connected to the intended Android phone's hotspot. No public tunnel, port forwarding, deployment, real wallet signing or payment was performed. The owner will perform the phone steps after this task.

**Enter this exact URL in Nimiq Pay → Mini Apps → Custom URL:**

**https://192.168.186.152:8443/#diagnostics**

This is the current hotspot session's URL, not a permanent hostname. Laptop interface: `wlp2s0`, private address `192.168.186.152`; phone/hotspot gateway: `192.168.186.167`. Only those two source addresses are permitted. If the hotspot addresses change, stop and restart with the new verified addresses.

## What is running and verified

- Existing web/Vite on `127.0.0.1:5173` and API on `127.0.0.1:3001` are healthy; the proxy/API network readbacks both report TESTNET and spending disabled.
- A separate production-mode API runs on **loopback `127.0.0.1:3002`**, serves the built frontend and uses the **same existing database and credentials**. The launcher verifies the existing API has that database open, takes a consistent protected SQLite online backup, checks that credential/payment-attempt rows are unchanged, and never runs setup or writes `.env`.
- Checksum-verified official **Caddy 2.11.9** runs only on **`192.168.186.152:8443`**, not `0.0.0.0`, Docker, or a public interface. Its admin API and HTTP redirects are off. It does not install a system CA or enable access logging.
- The laptop can reach organiser endpoints, still protected by the existing password/session and Origin checks. The phone can fetch the built app/config and POST only invitation lookup, claim challenge and claim submission. Phone cookies are stripped before proxying. Login, sessions, campaign administration and payment APIs are denied to the phone. Other peers are denied entirely; forwarded IP headers do not confer access.
- Native reservation/dispatch routes are denied at the proxy. The mobile API also forces spending disabled, even if other server payment options are enabled. Strict payout protections, durable reservations and existing UNKNOWN outcomes were retained.
- Built HTML, JS, CSS and `/api/config` were fetched using the private CA with certificate/hostname verification enabled. An unauthenticated laptop organiser request returns 401. Tests exercise real Caddy TLS and phone/laptop ACL separation on isolated loopback peers.

**Not verified:** the phone reaching the endpoint, Android/Nimiq Pay trusting the CA, the actual injected provider/network/consensus, native consent/signature prompts, or a real-device claim/review. Browser wallet doubles are not physical evidence. No live claim was submitted by the agent.

## Certificate: transfer only the public CA

The public certificate is:

`/home/ali/Desktop/nim/nimclaim/.local/mobile/nimclaim-test-ca.crt`

Current SHA-256 certificate fingerprint:

```text
08:50:D8:73:A2:D6:2A:3B:20:FB:F7:AD:23:DE:08:79:54:AC:7D:0A:88:0A:B7:83:AD:F7:B4:67:3E:3C:3E:67
```

Copy **only that `.crt` file** to the phone using USB file transfer, Bluetooth or another private file-sharing method. Do not copy the `.local/caddy` directory, any `.key` file, database/backup, `.env`, local logs or state files. In Android Settings, search for **Install certificate** and choose **CA certificate** (often under Security → Encryption & credentials). Import the public `.crt`, verify its fingerprint against the laptop, and confirm the OS warning only if it is the intended test CA. Remove the test CA when finished.

Installing this CA on the phone is a user action. Do not use “continue anyway,” disable certificate checks or ignore SSL errors. The laptop verification used an explicit CA file and did not modify the laptop's system/browser trust store.

### Important Android trust blocker

Android apps targeting modern SDKs do not normally trust user-added CAs unless their app configuration opts in. The inspected Nimiq Pay source targets SDK 36 and its manifest does not declare a user-CA network security configuration. The installed app/merged manifest has **not** been inspected on the phone. A Chrome browser success therefore does not establish Nimiq Pay WebView trust.

If Nimiq Pay rejects the certificate after import, **stop**. The actionable alternatives are an owner-controlled domain resolving to the private laptop address with a publicly trusted certificate obtained without a public web tunnel (for example DNS validation), or an approved Nimiq Pay test build explicitly trusting this test CA. Neither alternative has been configured or authorized here. Do not modify a release APK or bypass TLS validation.

If the phone cannot connect at all (before a certificate screen), first confirm hotspot addresses and run `npm run mobile:status` on the laptop. Host ingress/firewall and Android hotspot reachability have not been tested from the phone. If an active UFW firewall blocks it, an administrator can permit only this peer/interface/port:

```sh
sudo ufw allow in on wlp2s0 from 192.168.186.167 to 192.168.186.152 port 8443 proto tcp
```

This firewall command was not run by the agent; do not add broad LAN/public rules. The proxy's phone/laptop route restrictions still apply.

Sources: [Android CA trust defaults](https://developer.android.com/privacy-and-security/security-config#CustomTrust), [inspected host manifest](https://github.com/nimiq/nimiq-pay-app/blob/dd90a9c5443be3f4e0ddeac454486c9d512fcae3/android/app/src/main/AndroidManifest.xml), [host SDK target](https://github.com/nimiq/nimiq-pay-app/blob/dd90a9c5443be3f4e0ddeac454486c9d512fcae3/android/variables.gradle).

## Keep the organiser on the laptop

Your existing desktop services and organiser session were not replaced or cleared. Use **http://localhost:5173** for organiser writes and keep that tab open. The `127.0.0.1` page renders, but it is a different browser origin and its writes are rejected by the current exact-origin API policy. If needed, sign in at the localhost URL using the existing password; do not reset credentials. Generate a fresh invitation there, then **replace only its scheme/host/port with `https://192.168.186.152:8443`** when sharing it privately to the phone. Preserve the entire `/#claim=...` fragment. Do not paste invitation links into diagnostics, Git, screenshots or this conversation.

Invitation tokens are stored as hashes and are not originally bound to a URL origin. The phone's _new signing challenge_ is bound to the actual HTTPS origin and TESTNET. An isolated integration test proves the two-origin flow: laptop session → private phone claim without an organiser cookie → laptop approval → recipient status update, using shared records and real synthetic signature verification.

Alternatively, if you explicitly trust the CA in your laptop browser, open the HTTPS base URL there and sign in using the **existing** organiser password to generate HTTPS invitations directly. A new origin may require a new browser login; no password/database reset is needed. The phone is intentionally prevented from using organiser login regardless of its UI.

## Human checklist and exact screenshots

Use a dedicated TESTNET wallet chosen by its owner. Never send funds or enter recovery material. Switch Nimiq Pay to Testnet first, then reload the Mini App. The official guide describes long-pressing Settings for 10 seconds to reach network selection. The coding agent must not operate your wallet.

| Step                    | What to check                                                                                                                                                                                                                                                                                                                  | Screenshot needed                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Trust/reachability   | Import the public CA, then open the exact diagnostics URL in Nimiq Pay. Stop at any TLS error.                                                                                                                                                                                                                                 | If blocked: the certificate/network error screen only, with no private link in the address bar.                                                                       |
| 2. Testnet setting      | Confirm Nimiq Pay itself is set to Testnet, then reload the Mini App.                                                                                                                                                                                                                                                          | Nimiq Pay's network-selection screen showing Testnet; mask any wallet information.                                                                                    |
| 3. Provider diagnostics | Tap **Refresh wallet diagnostics**. Require injected provider detected, API TESTNET, host TESTNET, agreement MATCH, consensus established and a real nonnegative height. This action must show no account, signature or payment prompt.                                                                                        | The **Wallet diagnostics** panel after refresh. It contains no account addresses or tokens.                                                                           |
| 4. Private invitation   | Open the complete HTTPS `/#claim=...` invitation. Confirm campaign title, exact reward and expiry. Expand diagnostics if needed.                                                                                                                                                                                               | Campaign/claim screen with the address bar and invitation fragment cropped out.                                                                                       |
| 5. Account consent      | Tap **Connect Nimiq Pay**. Reject once; confirm usable cancellation UX and no saved claim. Retry when ready.                                                                                                                                                                                                                   | Native **account-sharing/connect** prompt. Crop/mask all address text; retain app name and permission/buttons.                                                        |
| 6. Claim signature      | Review the native **Sign Message** prompt: `NimClaim/claim/v1`, TESTNET, the HTTPS origin, correct campaign/amount and expiry. Reject once and verify no pending claim. Approve a test claim only by your explicit action.                                                                                                     | Native **Sign Message** prompt showing domain/network/origin/amount. Crop/mask nonce, token hash, IDs and other private identifiers; never share a full private link. |
| 7. Server verification  | After approval, phone shows **Your request is with the organiser** and the backend-derived recipient address. Refresh the laptop; approve/reject through the original organiser session. Refresh the phone; verify matching status/history and **unpaid**. Reopening a used invitation must not expose another signing action. | Recipient pending/status screen and laptop claim review/status screen. Hide addresses, invitation textarea and URL fragments.                                         |
| 8. Failures             | Check ordinary-browser provider absence, network mismatch and an expired invitation. Do not change or forge real wallet data.                                                                                                                                                                                                  | Only the readable error state, with private values hidden.                                                                                                            |

The badge alone is not proof: diagnostics independently fetches API configuration, reads injected host metadata, and invokes provider consensus/height methods. Claim signing rechecks host network and validates the server message's origin/network before calling the wallet. Mobile mode is TESTNET-only server-side. Message signing proves ownership and attests the server's network-bound request; it does **not** cryptographically prove the chain the phone is connected to. Physical host-setting/provider observations remain necessary.

**No native payment confirmation should appear in this test.** If one appears, reject it and stop. An approved reward remains payment-ready and unpaid. Preserve all UNKNOWN outcomes; do not attempt retries or resets. Mainnet remains NO-GO per [MAINNET-READINESS.md](MAINNET-READINESS.md).

## Launch/status/stop commands

Already installed locally; no need to copy `.env` or run setup:

```sh
cd /home/ali/Desktop/nim/nimclaim
npm run mobile:status
```

To deliberately restart only the private test services after a hotspot change:

```sh
npm run mobile:stop
npm run build
npm run mobile:start -- --bind-ip 192.168.186.152 --phone-ip 192.168.186.167
```

The launcher checks both addresses, active LAN interface, existing TESTNET database/API, free ports and native-spending safety. It creates a protected online backup and validates Caddy before starting. `mobile:stop` targets only recorded private test processes whose command/marker matches; it does not stop the normal desktop API/Vite or reset data. `.local` contains all CA keys, private logs, backups and runtime state and is ignored by Git. Do not serve this directory over HTTP.

For a fresh checkout without the local Caddy binary, obtain the official Linux-amd64 release and verify its checksum before executing it. The installed release here was checked against the vendor's **SHA-512** manifest, not SHA-256. Do not replace the known executable with an unverified download.

```sh
mkdir -p .local/bin .local/caddy
chmod 700 .local .local/bin .local/caddy
curl -fSL https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_amd64.tar.gz -o .local/caddy/caddy_2.11.9_linux_amd64.tar.gz
curl -fSL https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_checksums.txt -o .local/caddy/caddy_2.11.9_checksums.txt
(cd .local/caddy && sha512sum --check --ignore-missing caddy_2.11.9_checksums.txt)
# Only after successful verification:
tar -xzf .local/caddy/caddy_2.11.9_linux_amd64.tar.gz -C .local/bin caddy
chmod 700 .local/bin/caddy
```

[Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https), [Nimiq local device testing](https://nimiq.dev/mini-apps/development/load-local-mini-app), [provider reference](https://nimiq.dev/mini-apps/api-reference/nimiq-provider).
