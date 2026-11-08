# Public source audit

Date: 8 November 2026. Scope: this independent NimClaim repository only.

Before publication, all four existing reachable commits were enumerated, including 84 unique historical file blobs (602,632 bytes), not just the working tree. Git object integrity passed. No additional branches, tags, remotes or submodules were present. Existing commits were retained; normal Git author metadata remains public.

## Secret and record checks

- Gitleaks v8.24.3, built from its versioned Go module, scanned the full reachable Git history with redacted reporting and no exclusions. A separate tracked-file export was scanned. Both reported no leaks.
- Supplemental checks inspected every reachable blob for database/binary contents, sensitive filenames, private-key headers, provider tokens, embedded URL credentials, stored password hashes, literal wallet addresses, invitation values and recovery phrases. Existing installation credential/environment records were compared in memory without printing their values. No matching private record was found.
- A URL credential rejection fixture in `tests/rpc.test.ts` uses a reserved `.example` host; it is deliberately synthetic, not an exposed credential. Test passwords belong only to disposable synthetic installations. Signing keys are generated ephemerally during tests, not committed or connected to funded wallets.
- No real personal/customer records, screenshots, database files, private invitation links, wallet secrets, TLS certificates or private CA keys were present in tracked files or reachable historical blobs. Generated browser screenshots/traces remain ignored. Physical-device screenshots have not been supplied or verified.
- `.env` and its variants (except the safe `.env.example`), databases, `.local/`, mobile runtime state, certificate/key formats and key stores are ignored. Checks covered actual local environment/database/CA paths and representative files outside `.local/`. Local data, credentials, services and payment reservations were preserved.

Detailed scanner output and temporary audit tools remain under ignored `.local/audit/`; no local certificates, keys or private reports are publication assets. Automated scans supplement manual inspection and are not a guarantee against every possible secret format. Any future detected credential requires stopping publication, rotating it and reviewing history before resuming.

## Implementation represented publicly

Campaigns, private invitations, cryptographically verified wallet-signed claims, authenticated organiser review, persisted statuses and history are implemented. Browser tests use synthetic accounts and signatures, not physical Nimiq Pay evidence. Private HTTPS is locally verified; Android trust, actual provider injection and native claim prompts remain pending owner-operated testing.

Native payment intent/reservation, adapter and independent RPC reconciliation code exist, but live spending remains blocked. The official SDK supplies no supported pre-broadcast selected-sender assurance for the current strict policy. No production sender adapter is installed. UNKNOWN attempts retain durable reservations and are never automatically retried. Approved rewards are unpaid commitments, not escrow. Mainnet is **NO-GO**; publication grants no deployment or spending authorization.

The README states these limits and links the readiness/device guides. `LICENSE` contains the MIT license. Publication preparation changes only documentation and ignore rules; it does not alter runtime payment protections or existing Git history.
