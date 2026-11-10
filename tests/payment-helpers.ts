import { once } from "node:events";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
import { passwordHash } from "../server/crypto.js";
import type { PaymentOptions } from "../server/payments.js";
import {
  cosignerPublicKeys,
  trustedCosigners,
  type Intent,
  type Rpc,
} from "../server/rpc.js";
import { testSigner } from "./helpers.js";
export const HASH = "a".repeat(64);
export class FixtureRpc implements Rpc {
  intent?: Intent;
  owner = testSigner();
  htlc = testSigner().address;
  timeout = Date.now() + 86400_000;
  account: Record<string, unknown> = {};
  accountData() {
    return {
      address: this.htlc,
      type: "htlc",
      balance: 100_000_000,
      sender: this.owner.address,
      recipient: trustedCosigners("testnet")[0],
      timeout: this.timeout,
      ...this.account,
    };
  }
  tx: Record<string, unknown> = {};
  head = 100;
  finality = true;
  consensus = true;
  network = "TestAlbatross";
  offline = false;
  calls: string[] = [];
  transaction() {
    const i = this.intent!;
    return {
      hash: HASH,
      from: i.sender,
      to: i.recipient,
      fromType: 2,
      toType: 0,
      value: i.amount,
      fee: i.fee,
      networkId: 5,
      validityStartHeight: i.validity_start_height + 1,
      flags: 0,
      senderData: "",
      recipientData: "",
      blockNumber: 101,
      executionResult: true,
      // Synthetic node evidence: no real cosigner signature or transaction broadcast.
      // Signature validity is asserted by the independent full node's execution/finality.
      proof:
        "0100" +
        cosignerPublicKeys.testnet[0] +
        "00" +
        "11".repeat(64) +
        "00" +
        this.owner.publicKey +
        "00" +
        "22".repeat(64),
      ...this.tx,
    };
  }
  async call(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push(method);
    if (this.offline) throw new Error("Synthetic RPC outage");
    switch (method) {
      case "getAccountByAddress":
        return this.accountData();
      case "getNetworkId":
        return this.network;
      case "isConsensusEstablished":
        return this.consensus;
      case "getBlockNumber":
        return this.head;
      case "getTransactionByHash":
        return this.transaction();
      case "getMacroBlockAfter":
        return 128;
      case "getBlockByNumber":
        if (params[0] === 128)
          return {
            number: 128,
            hash: "b".repeat(64),
            network: "TestAlbatross",
            type: this.finality ? "macro" : "micro",
            ...(this.finality
              ? { justification: { sig: "SYNTHETIC_TEST_ONLY" } }
              : {}),
          };
        return {
          number: 101,
          hash: "c".repeat(64),
          network: "TestAlbatross",
          type: "micro",
          transactions: [this.transaction()],
        };
      default:
        throw new Error("Unexpected read method");
    }
  }
}
export async function paymentHarness(
  options: Partial<PaymentOptions> = {},
  path = ":memory:",
) {
  let time = Date.now();
  const sender = testSigner(),
    recipient = testSigner(),
    rpc = new FixtureRpc();
  rpc.owner = sender;
  const paymentOptions = {
    enabled: true,
    spendingNetwork: "testnet" as const,
    maxLuna: 10_000_000,
    feeLuna: 1000,
    rpc,
    ...options,
  };
  const origin = "https://payout.test";
  const app = createApp({
    path,
    origin,
    network: "testnet",
    now: () => time,
    payments: paymentOptions,
  });
  if (!app.db.prepare("SELECT id FROM organiser").get())
    app.db
      .prepare("INSERT INTO organiser VALUES (1,?)")
      .run(passwordHash("payment-test-password"));
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let cookie = "";
  const call = async (path: string, body?: unknown, authenticated = true) => {
    if (path.endsWith("/reconcile")) rpc.head = 128; // Deterministically advance the synthetic chain after reservation.
    const res = await fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: authenticated ? cookie : "",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), response: res };
  };
  cookie = (
    await call("/login", { password: "payment-test-password" })
  ).response.headers
    .get("set-cookie")!
    .split(";")[0];
  async function proof(path: string, signer = sender) {
    const challenge = await call(
      path,
      path.endsWith("/payment/challenge") ? { sender: rpc.htlc } : {},
    );
    assert.equal(challenge.status, 201);
    return {
      challengeId: challenge.body.id,
      publicKey: signer.publicKey,
      signature: signer.sign(challenge.body.message),
    };
  }
  async function campaign(slots = 1, signer = recipient) {
    const c = await call("/campaigns", {
      title: "Synthetic payout test",
      description: "No actual wallet or real funds",
      amount: "12.34567",
      slots,
      expires: time + 3600_000,
    });
    assert.equal(c.status, 201);
    const id = c.body.campaign.id;
    const url = (await call(`/campaigns/${id}/invitations`, {})).body.url,
      token = url.split("#claim=")[1];
    const ch = (await call("/challenge", { token }, false)).body;
    const claim = await call(
      "/claim",
      {
        token,
        challengeId: ch.id,
        publicKey: signer.publicKey,
        signature: signer.sign(ch.message),
      },
      false,
    );
    assert.equal(claim.status, 201);
    const claimId = claim.body.claim.id;
    assert.equal(
      (await call(`/claims/${claimId}/decision`, { decision: "payment-ready" }))
        .status,
      200,
    );
    const bind = await proof(`/campaigns/${id}/wallet/challenge`);
    assert.equal((await call(`/campaigns/${id}/wallet`, bind)).status, 200);
    return { campaignId: id, claimId, token };
  }
  async function reserve(claimId: string) {
    const p = await proof(`/claims/${claimId}/payment/challenge`);
    const r = await call(`/claims/${claimId}/payment/reserve`, p);
    if (r.status === 201) rpc.intent = r.body.intent;
    return r;
  }
  return {
    ...app,
    base,
    cookie,
    call,
    sender,
    recipient,
    rpc,
    proof,
    campaign,
    reserve,
    paymentOptions,
    advance(ms: number) {
      time += ms;
    },
    async close() {
      await new Promise<void>((ok, reject) =>
        app.server.close((e) => (e ? reject(e) : ok())),
      );
      app.db.close();
    },
  };
}
