import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { backup } from "node:sqlite";
import { createApp } from "../server/app.js";
import { openDb } from "../server/db.js";
import { passwordHash } from "../server/crypto.js";
import {
  stagingConfig,
  prepareStagingDatabase,
  startStaging,
  stagingDatabase,
} from "../server/staging.js";
import { testSigner } from "./helpers.js";

const origin = "https://nimclaim-testnet-staging.onrender.com";
const password = "synthetic-staging-only";
const hash = passwordHash(password);
test("staging configuration fails closed without loading local settings", () => {
  const env = {
    NIMCLAIM_STAGING: "1",
    NODE_ENV: "production",
    APP_ORIGIN: origin,
    NETWORK: "testnet",
    SPENDING_ENABLED: "false",
    DATABASE_PATH: stagingDatabase,
    STAGING_ORGANISER_PASSWORD_HASH: hash,
  };
  assert.equal(stagingConfig(env).origin, origin);
  for (const patch of [
    { NODE_ENV: "development" },
    { NETWORK: "mainnet" },
    { SPENDING_ENABLED: "true" },
    { DATABASE_PATH: "./data/nimclaim.sqlite" },
    { APP_ORIGIN: "http://localhost" },
    { APP_ORIGIN: origin + "/" },
    { APP_ORIGIN: "https://user:secret@example.com" },
    { RPC_URL: "https://rpc.example" },
    { RPC_AUTHORIZATION: "secret" },
    { SPENDING_NETWORK: "testnet" },
    { MAX_PAYMENT_LUNA: "1" },
    { STAGING_ORGANISER_PASSWORD_HASH: "" },
  ])
    assert.throws(() => stagingConfig({ ...env, ...patch }));
  assert.throws(
    () =>
      createApp({
        path: ":memory:",
        origin,
        network: "mainnet",
        staging: true,
      }),
    /TESTNET/,
  );
});
test("staging refuses unmarked databases and never replaces credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimclaim-staging-guard-"));
  const path = join(dir, "unrelated.sqlite");
  try {
    const db = openDb(path);
    db.prepare("INSERT INTO organiser VALUES (1,?)").run(hash);
    db.close();
    const before = readFileSync(path);
    assert.throws(() => prepareStagingDatabase(path, hash), /isolated staging/);
    assert.deepEqual(readFileSync(path), before);
    const fresh = join(dir, "fresh.sqlite");
    prepareStagingDatabase(fresh, hash);
    assert.throws(
      () => prepareStagingDatabase(fresh, passwordHash("other")),
      /never overwritten/,
    );
    prepareStagingDatabase(fresh, hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actual staging gateway and API preserve claims, auth, backup/restore, durable limits and two spending barriers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nimclaim-staging-flow-"));
  const config = { origin, hash, path: join(dir, "staging.sqlite") };
  let app = await startStaging(config);
  async function listen() {
    app.gateway.listen(0, "127.0.0.1");
    await once(app.gateway, "listening");
  }
  await listen();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let cookie = "";
  function call(
    path: string,
    body?: unknown,
    options: {
      direct?: boolean;
      host?: string;
      origin?: string;
      cookie?: string;
    } = {},
  ) {
    const port = (
      (options.direct ? app.server : app.gateway).address() as { port: number }
    ).port;
    return new Promise<{ status: number; body: any; cookie: string }>(
      (ok, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: body === undefined ? "GET" : "POST",
            headers: {
              Host: options.host ?? new URL(origin).host,
              Origin: options.origin ?? origin,
              "Content-Type": "application/json",
              Cookie: options.cookie ?? cookie,
              "X-Forwarded-For": "8.8.8.8",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (v) => {
              data += v;
            });
            res.on("end", () =>
              ok({
                status: res.statusCode!,
                body: data ? JSON.parse(data) : null,
                cookie: res.headers["set-cookie"]?.[0] ?? "",
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      },
    );
  }
  const publicConfig = await call("/api/config");
  assert.deepEqual(publicConfig.body, {
    network: "testnet",
    origin,
    staging: true,
    mobileTest: false,
  });
  assert.equal(app.payments.gate().enabled, false);
  assert.equal((await call("/api/campaigns")).status, 401);
  assert.equal(
    (await call("/api/config", undefined, { host: "evil.example" })).status,
    404,
  );
  for (const path of [
    "/.env",
    "/server/app.ts",
    "/api/debug",
    "/api/diagnostics",
    "/api/config?debug=1",
    "/api/../api/config",
  ])
    assert.equal((await call(path)).status, 404);
  const id = "00000000-0000-4000-8000-000000000001";
  const blocked = [
    `/api/campaigns/${id}/wallet/challenge`,
    `/api/claims/${id}/payment/review`,
    `/api/claims/${id}/payment/reserve`,
    `/api/payments/${id}/dispatch`,
    `/api/payments/${id}/reconcile`,
  ];
  for (const path of blocked) {
    assert.equal((await call(path, {})).status, 404);
    assert.equal((await call(path, {}, { direct: true })).status, 403);
  }
  assert.equal(
    (await call("/api/login", { password }, { origin: "https://evil.example" }))
      .status,
    403,
  );
  const login = await call("/api/login", { password });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly; SameSite=Strict.*Secure/);
  cookie = login.cookie.split(";")[0];
  const campaign = (
    await call("/api/campaigns", {
      title: "Staging only",
      description: "Synthetic records",
      amount: "0.12345",
      slots: 2,
      expires: Date.now() + 3600_000,
    })
  ).body.campaign;
  const invite = (await call(`/api/campaigns/${campaign.id}/invitations`, {}))
    .body;
  assert.equal(new URL(invite.url).origin, origin);
  const token = new URL(invite.url).hash.slice(7);
  const challenge = (await call("/api/challenge", { token })).body;
  const binding = JSON.parse(challenge.message);
  assert.equal(binding.origin, origin);
  assert.equal(binding.network, "testnet");
  assert.equal(binding.amountLuna, 12345);
  const signer = testSigner();
  const proof = {
    token,
    challengeId: challenge.id,
    publicKey: signer.publicKey,
    signature: signer.sign(challenge.message),
  };
  assert.equal(
    (
      await call("/api/claim", {
        ...proof,
        signature: signer.sign(
          challenge.message.replace(origin, "https://evil.example"),
        ),
      })
    ).status,
    401,
  );
  const competing = await Promise.all([
    call("/api/claim", proof),
    call("/api/claim", proof),
  ]);
  assert.deepEqual(competing.map((v) => v.status).sort(), [201, 409]);
  const claim = competing.find((v) => v.status === 201)!.body.claim;
  assert.equal(
    (
      await call(`/api/claims/${claim.id}/decision`, {
        decision: "payment-ready",
      })
    ).status,
    200,
  );
  for (const path of blocked) assert.equal((await call(path, {})).status, 404);
  // A second connection uses the same UNIQUE(campaign,address) protections.
  const other = createApp({
    path: config.path,
    origin,
    network: "testnet",
    staging: true,
  });
  assert.throws(
    () =>
      other.db
        .prepare(
          "INSERT INTO claims SELECT 'duplicate',invitation_id,campaign_id,address,public_key,signature,challenge_id,status,created FROM claims",
        )
        .run(),
    /UNIQUE/,
  );
  other.db.close();
  const copy = join(dir, "backup.sqlite");
  await backup(app.db, copy);
  const restored = openDb(copy);
  assert.equal(
    restored.prepare("PRAGMA integrity_check").get()!.integrity_check,
    "ok",
  );
  assert.equal(
    restored.prepare("SELECT status FROM claims").get()!.status,
    "payment-ready",
  );
  assert.equal(
    restored.prepare("SELECT COUNT(*) AS n FROM payment_attempts").get()!.n,
    0,
  );
  restored.close();
  await app.close();
  app = await startStaging(config);
  await listen();
  assert.equal((await call("/api/session")).body.authenticated, true);
  assert.equal(
    (await call("/api/invitation", { token })).body.claim.status,
    "payment-ready",
  );
  // Two previous login attempts counted. A peer-header change and restart cannot reset it.
  for (let i = 0; i < 8; i++) await call("/api/login", { password: "wrong" });
  assert.equal((await call("/api/login", { password })).status, 429);
  await app.close();
  app = await startStaging(config);
  await listen();
  assert.equal((await call("/api/login", { password })).status, 429);
});

test("hosted provider receives exact origin-bound challenge and rejects missing/mainnet/changed host before signing", async () => {
  const { signChallenge, connectWallet } = await import("../src/wallet.js");
  const oldWindow = globalThis.window;
  const oldLocation = globalThis.location;
  let signs = 0,
    accounts = 0,
    disconnects = 0;
  const message = JSON.stringify({
    domain: "NimClaim/claim/v1",
    purpose: "Request a contributor reward; no payment or transaction",
    origin,
    network: "testnet",
    amountLuna: 12345,
    nonce: "synthetic",
  });
  const provider = {
    disconnect() {
      disconnects++;
    },
    listAccounts: async () => {
      accounts++;
      return ["synthetic"];
    },
    isConsensusEstablished: async () => true,
    getBlockNumber: async () => 123,
    sign: async (received: string) => {
      assert.equal(received, message);
      signs++;
      return { publicKey: "synthetic", signature: "synthetic" };
    },
  };
  try {
    globalThis.location = { origin } as Location;
    globalThis.window = {
      nimiq: provider,
      nimiqPay: { network: "testnet" },
    } as unknown as Window & typeof globalThis;
    const connected = await connectWallet("testnet");
    assert.equal(connected.network, "testnet");
    await signChallenge(connected.provider, message, "testnet");
    assert.equal(signs, 1);
    for (const network of [undefined, "mainnet"] as const) {
      window.nimiqPay = { network } as typeof window.nimiqPay;
      await assert.rejects(connectWallet("testnet"));
      await assert.rejects(
        signChallenge(connected.provider, message, "testnet"),
      );
    }
    assert.equal(accounts, 1);
    assert.equal(disconnects, 1);
    assert.equal(signs, 1);
    window.nimiqPay = { network: "testnet" } as typeof window.nimiqPay;
    await assert.rejects(
      signChallenge(
        connected.provider,
        message.replace(origin, origin + ".evil.example"),
        "testnet",
      ),
    );
    assert.equal(signs, 1);
  } finally {
    globalThis.window = oldWindow;
    globalThis.location = oldLocation;
  }
});
