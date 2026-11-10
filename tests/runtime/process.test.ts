import { openDb } from "../../server/db.js";
import { Payments } from "../../server/payments.js";
import { digest } from "../../server/crypto.js";
import { FixtureRpc } from "../payment-helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import { testSigner } from "../helpers.js";

test("setup CLI and production process: Secure authentication, static build and full backend restart persistence", async () => {
  const dir = mkdtempSync(resolve("data-test-"));
  const env = {
    ...process.env,
    DATABASE_PATH: resolve(dir, "runtime.sqlite"),
    APP_ORIGIN: "https://smoke.example",
    NETWORK: "testnet",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "0",
  };
  let child: ChildProcess | undefined;
  const cli = resolve("node_modules/tsx/dist/cli.mjs");
  async function start() {
    child = spawn(process.execPath, [cli, "server/index.ts"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise<number>((ok, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Production server startup timed out")),
        10_000,
      );
      child!.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        const match = /NimClaim API port (\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          ok(Number(match[1]));
        }
      });
      child!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Production server exited during startup: ${code}`));
      });
    });
    return `http://127.0.0.1:${port}`;
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
    child = undefined;
  }
  try {
    const output = execFileSync(process.execPath, [cli, "server/setup.ts"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const password = /\n([a-f0-9]{64})\s*$/.exec(output)?.[1];
    assert.ok(password, "setup must generate one high-entropy credential");
    let base = await start(),
      cookie = "";
    const call = async (path: string, body?: unknown) =>
      fetch(`${base}/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: env.APP_ORIGIN,
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const html = await fetch(base);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /NimClaim/);
    assert.match(
      html.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.equal(html.headers.get("referrer-policy"), "no-referrer");
    const login = await call("/login", { password });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(";")[0];
    const campaignResponse = await call("/campaigns", {
      title: "Process restart test",
      description: "Synthetic runtime verification only",
      amount: "1",
      slots: 1,
      expires: Date.now() + 3600_000,
    });
    assert.equal(campaignResponse.status, 201);
    const { campaign } = await campaignResponse.json();
    const { url } = await (
      await call(`/campaigns/${campaign.id}/invitations`, {})
    ).json();
    const token = url.split("#claim=")[1],
      signer = testSigner();
    const challenge = await (await call("/challenge", { token })).json();
    const proof = {
      token,
      challengeId: challenge.id,
      publicKey: signer.publicKey,
      signature: signer.sign(challenge.message),
    };
    const claimResponse = await call("/claim", proof);
    assert.equal(claimResponse.status, 201);
    const { claim } = await claimResponse.json();
    assert.equal(
      (
        await call(`/claims/${claim.id}/decision`, {
          decision: "payment-ready",
        })
      ).status,
      200,
    );
    const organiserSigner = testSigner();
    const walletChallenge = await (
      await call(`/campaigns/${campaign.id}/wallet/challenge`, {})
    ).json();
    assert.equal(
      (
        await call(`/campaigns/${campaign.id}/wallet`, {
          challengeId: walletChallenge.id,
          publicKey: organiserSigner.publicKey,
          signature: organiserSigner.sign(walletChallenge.message),
        })
      ).status,
      200,
    );
    // Test-only service uses synthetic read-only RPC; the runtime remains disabled.
    const testDb = openDb(env.DATABASE_PATH);
    const rpc = new FixtureRpc();
    rpc.owner = organiserSigner;
    const service = new Payments(testDb, {
      origin: env.APP_ORIGIN,
      network: "testnet",
      now: () => Date.now() - 100_000,
      enabled: true,
      spendingNetwork: "testnet",
      maxLuna: 1_000_000,
      rpc,
    });
    const payChallenge = await service.paymentChallenge(
      claim.id,
      digest(cookie.split("=")[1]),
      rpc.htlc,
    );
    const reservation = await service.reserve(
      claim.id,
      digest(cookie.split("=")[1]),
      {
        challengeId: payChallenge.id,
        publicKey: organiserSigner.publicKey,
        signature: organiserSigner.sign(payChallenge.message),
      },
    );
    testDb.close();
    await stop();
    base = await start();
    assert.equal((await call("/session")).status, 200);
    assert.equal((await (await call("/session")).json()).authenticated, true);
    const restored = await (await call(`/campaigns/${campaign.id}`)).json();
    assert.equal(restored.claims[0].address, signer.address);
    assert.equal(restored.claims[0].status, "payment-ready");
    assert.equal(restored.claims[0].history.length, 2);
    assert.equal(restored.claims[0].payment.state, "UNKNOWN");
    assert.equal(restored.claims[0].payment.id, reservation.id);
    assert.equal(restored.claims[0].payment.receipt, null);
    assert.equal(
      (
        await call(`/payments/${reservation.id}/dispatch`, {
          permit: reservation.permit,
        })
      ).status,
      409,
    );
    const gate = (await (await call("/config")).json()).payments;
    assert.equal(gate.senderBindingSupported, false);
    assert.equal(gate.htlcVerificationSupported, true);
    assert.equal(gate.enabled, false);
    assert.ok(
      gate.reasons.includes("Spending is disabled by server configuration."),
    );
    assert.equal((await call("/claim", proof)).status, 409);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
