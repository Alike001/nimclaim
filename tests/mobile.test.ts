import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import https from "node:https";
import { createApp } from "../server/app.js";
import { mobileCaddyfile, privateIpv4 } from "../ops/mobile-config.js";
import { diagnosticError } from "../src/WalletDiagnostics.js";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";

test("mobile mode requires TESTNET before opening a database and forces native spending disabled", () => {
  assert.throws(
    () =>
      createApp({
        path: ":memory:",
        origin: "https://private.example",
        network: "mainnet",
        mobileTest: true,
      }),
    /TESTNET/,
  );
  const app = createApp({
    path: ":memory:",
    origin: "https://private.example",
    network: "testnet",
    mobileTest: true,
    payments: {
      enabled: true,
      spendingNetwork: "testnet",
      maxLuna: 100000,
      rpc: { call: async () => 100 },
      verifySelectedSender: async () => "synthetic",
    },
  });
  assert.equal(app.payments.gate().enabled, false);
  assert.ok(
    app.payments
      .gate()
      .reasons.includes("Spending is disabled by server configuration."),
  );
  app.db.close();
});
test("private proxy rejects unsafe addresses and diagnostics never echoes private error data", () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.1",
    "8.8.8.8",
    "192.168.1.2\nadmin :2019",
  ])
    assert.equal(privateIpv4(ip), false);
  assert.throws(() => mobileCaddyfile("0.0.0.0", "192.168.1.2"), /private/);
  assert.throws(
    () => mobileCaddyfile("192.168.1.2", "192.168.1.2"),
    /Distinct/,
  );
  for (const error of [
    new Error("private invitation token and wallet address"),
    new NimiqProviderError(
      "INTERNAL_ERROR",
      "private invitation token and wallet address",
    ),
  ])
    assert.doesNotMatch(diagnosticError(error), /invitation|address|token/);
});
test(
  "actual Caddy TLS proxy isolates phone routes, strips cookies and rejects spoofed peer headers",
  { skip: !existsSync(resolve(".local/bin/caddy")), timeout: 20000 },
  async (t) => {
    const directory = mkdtempSync(resolve("data-test-mobile-proxy-"));
    const backend = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          network: "testnet",
          mobileTest: true,
          payments: { enabled: false },
          cookieReceived: !!req.headers.cookie,
        }),
      );
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const apiPort = (backend.address() as { port: number }).port;
    const temporary = tcpServer();
    temporary.listen(0, "127.0.0.1");
    await once(temporary, "listening");
    const port = (temporary.address() as { port: number }).port;
    await new Promise<void>((ok) => temporary.close(() => ok()));
    // Simulate separate laptop/phone peers on loopback, never bind a test to the real LAN.
    const config = mobileCaddyfile("192.168.1.2", "192.168.1.3", port, apiPort)
      .replaceAll("https://192.168.1.2:", "https://127.0.0.1:")
      .replace("bind 192.168.1.2", "bind 127.0.0.1")
      .replace("@laptop remote_ip 192.168.1.2", "@laptop remote_ip 127.0.0.2")
      .replaceAll("remote_ip 192.168.1.3", "remote_ip 127.0.0.3");
    const file = resolve(directory, "Caddyfile");
    writeFileSync(file, config);
    const child = spawn(
      resolve(".local/bin/caddy"),
      ["run", "--config", file, "--adapter", "caddyfile"],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: resolve(directory, "data"),
          XDG_CONFIG_HOME: resolve(directory, "config"),
        },
        stdio: "ignore",
      },
    );
    const ended = once(child, "exit");
    t.after(async () => {
      child.kill("SIGTERM");
      await ended;
      await new Promise<void>((ok) => backend.close(() => ok()));
      rmSync(directory, { recursive: true, force: true });
    });
    const cert = resolve(
      directory,
      "data/caddy/pki/authorities/local/root.crt",
    );
    async function request(
      peer: string,
      path: string,
      method = "GET",
      headers: Record<string, string> = {},
    ) {
      return new Promise<{ status: number; body: string }>((ok, reject) => {
        const r = https.request(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method,
            localAddress: peer,
            ca: readFileSync(cert),
            headers,
            timeout: 1000,
          },
          (res) => {
            let body = "";
            res.on("data", (v) => {
              body += v;
            });
            res.on("end", () => ok({ status: res.statusCode!, body }));
          },
        );
        r.on("error", reject);
        r.on("timeout", () => r.destroy(new Error("timeout")));
        r.end();
      });
    }
    for (let i = 0; ; i++) {
      try {
        await request("127.0.0.3", "/api/config");
        break;
      } catch {}
      if (i > 60) throw new Error("Isolated Caddy TLS setup failed");
      await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.equal((await request("127.0.0.3", "/api/config")).status, 200);
    assert.equal(
      (
        await request("127.0.0.3", "/api/invitation", "POST", {
          Cookie: "synthetic-session",
        })
      ).body.includes('"cookieReceived":false'),
      true,
    );
    assert.equal(
      (
        await request("127.0.0.2", "/api/campaigns", "GET", {
          Cookie: "synthetic-session",
        })
      ).body.includes('"cookieReceived":true'),
      true,
    );
    for (const path of [
      "/api/campaigns",
      "/api/session",
      "/.env",
      "/api/login",
      "/api/payments/id/reconcile",
    ])
      assert.equal(
        (
          await request("127.0.0.3", path, "POST", {
            "X-Forwarded-For": "127.0.0.2",
          })
        ).status,
        403,
      );
    for (const path of [
      "/api/claims/id/payment/reserve",
      "/api/payments/id/dispatch",
    ])
      assert.equal((await request("127.0.0.2", path, "POST")).status, 403);
    assert.equal((await request("127.0.0.4", "/")).status, 403);
  },
);

test("claim signing verifies host network and server challenge network/origin before asking the wallet", async () => {
  const { signChallenge } = await import("../src/wallet.js");
  globalThis.window = { nimiqPay: { network: "testnet" } } as typeof window;
  globalThis.location = { origin: "https://private.example" } as Location;
  let calls = 0;
  const provider = {
    sign: async () => {
      calls++;
      return { publicKey: "synthetic", signature: "synthetic" };
    },
  } as unknown as import("@nimiq/mini-app-sdk").NimiqProvider;
  for (const message of [
    JSON.stringify({ network: "mainnet", origin: location.origin }),
    JSON.stringify({ network: "testnet", origin: "https://other.example" }),
    "invalid",
  ])
    await assert.rejects(signChallenge(provider, message, "testnet"));
  assert.equal(calls, 0);
  await signChallenge(
    provider,
    JSON.stringify({ network: "testnet", origin: location.origin }),
    "testnet",
  );
  assert.equal(calls, 1);
  window.nimiqPay = { network: "mainnet" } as typeof window.nimiqPay;
  await assert.rejects(
    signChallenge(
      provider,
      JSON.stringify({ network: "testnet", origin: location.origin }),
      "testnet",
    ),
  );
  assert.equal(calls, 1);
});

test("laptop session and private phone invitation use the same records across distinct origins", async (t) => {
  const { paymentHarness } = await import("./payment-helpers.js");
  const { testSigner } = await import("./helpers.js");
  const directory = mkdtempSync(resolve("data-test-mobile-sessions-"));
  const laptop = await paymentHarness({}, resolve(directory, "shared.sqlite"));
  const origin = "https://private-phone.example";
  const phone = createApp({
    path: resolve(directory, "shared.sqlite"),
    origin,
    network: "testnet",
    mobileTest: true,
  });
  phone.server.listen(0, "127.0.0.1");
  await once(phone.server, "listening");
  t.after(async () => {
    await laptop.close();
    await new Promise<void>((ok) => phone.server.close(() => ok()));
    phone.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(phone.server.address() as { port: number }).port}`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(base + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const c = await laptop.call("/campaigns", {
    title: "Separate device test",
    description: "Synthetic shared records",
    amount: "1",
    slots: 1,
    expires: Date.now() + 3600_000,
  });
  const invite = await laptop.call(
    `/campaigns/${c.body.campaign.id}/invitations`,
    {},
  );
  // Replacing only the origin preserves the invitation secret; no organiser cookie travels to the phone.
  const token = new URL(invite.body.url).hash.slice("#claim=".length);
  assert.equal((await call("/session")).body.authenticated, false);
  assert.equal((await call("/invitation", { token })).status, 200);
  const challenge = (await call("/challenge", { token })).body;
  assert.equal(JSON.parse(challenge.message).origin, origin);
  assert.equal(JSON.parse(challenge.message).network, "testnet");
  const signer = testSigner();
  const claim = await call("/claim", {
    token,
    challengeId: challenge.id,
    publicKey: signer.publicKey,
    signature: signer.sign(challenge.message),
  });
  assert.equal(claim.status, 201);
  assert.equal((await laptop.call("/session")).body.authenticated, true);
  assert.equal(
    (
      await laptop.call(`/claims/${claim.body.claim.id}/decision`, {
        decision: "payment-ready",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("/invitation", { token })).body.claim.status,
    "payment-ready",
  );
});
