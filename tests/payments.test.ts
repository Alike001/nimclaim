import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { Payments } from "../server/payments.js";
import { digest, passwordHash } from "../server/crypto.js";
import { testSigner } from "./helpers.js";
import { paymentHarness, HASH } from "./payment-helpers.js";

test("production has no selected-sender adapter; server configuration and frontend fields cannot bypass it", async (t) => {
  const h = await paymentHarness({ verifySelectedSender: undefined });
  t.after(() => h.close());
  const c = await h.campaign(),
    proof = await h.proof(`/claims/${c.claimId}/payment/challenge`);
  assert.equal(
    (await h.call(`/claims/${c.claimId}/payment/reserve`, proof)).status,
    409,
  );
  const gate = (await h.call("/config")).body.payments;
  assert.equal(gate.enabled, false);
  assert.equal(gate.senderBindingSupported, false);
  assert.equal(
    (
      await h.call(`/claims/${c.claimId}/payment/reserve`, {
        ...proof,
        enabled: true,
        sender: h.sender.address,
      })
    ).status,
    400,
  );
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM payment_attempts").get() as any).n,
    0,
  );
});

test("organiser endpoints require auth; binding is signed, immutable, nonce- and session-bound", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const c = await h.campaign();
  for (const path of [
    `/campaigns/${c.campaignId}/wallet/challenge`,
    `/campaigns/${c.campaignId}/wallet`,
    `/claims/${c.claimId}/payment/review`,
    `/claims/${c.claimId}/payment/challenge`,
    `/claims/${c.claimId}/payment/reserve`,
    `/payments/${c.claimId}/dispatch`,
    `/payments/${c.claimId}/outcome`,
    `/payments/${c.claimId}/reconcile`,
  ])
    assert.equal((await h.call(path, {}, false)).status, 401);
  assert.equal(
    (await h.call(`/campaigns/${c.campaignId}/wallet/challenge`, {})).status,
    409,
  );
  const proof = await h.proof(`/claims/${c.claimId}/payment/challenge`);
  assert.equal(
    (
      await h.call(`/claims/${c.claimId}/payment/reserve`, {
        ...proof,
        signature: "00".repeat(64),
      })
    ).status,
    401,
  );
  await h.call("/logout", {});
  // A replacement session cannot use a challenge issued to an earlier session.
  const token = "f".repeat(64);
  h.db
    .prepare("INSERT INTO sessions VALUES (?,?)")
    .run(digest(token), Date.now() + 3600_000);
  const sessions = h.db
    .prepare("SELECT COUNT(*) AS n FROM sessions")
    .get() as any;
  assert.equal(sessions.n, 1);
  const oldProof = await fetch(
    `${h.base}/api/claims/${c.claimId}/payment/reserve`,
    {
      method: "POST",
      headers: {
        Origin: "https://payout.test",
        Cookie: `nimclaim_session=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(proof),
    },
  );
  assert.equal(oldProof.status, 409);
});

test("wrong signing wallet and independently different selected sender block before reservation", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const c = await h.campaign();
  const proof = await h.proof(
    `/claims/${c.claimId}/payment/challenge`,
    testSigner(),
  );
  assert.equal(
    (await h.call(`/claims/${c.claimId}/payment/reserve`, proof)).status,
    403,
  );
  const wrong = await paymentHarness({
    verifySelectedSender: async () => testSigner().address,
  });
  t.after(() => wrong.close());
  const d = await wrong.campaign();
  assert.equal((await wrong.reserve(d.claimId)).status, 403);
  assert.equal(
    (wrong.db.prepare("SELECT COUNT(*) AS n FROM payment_intents").get() as any)
      .n,
    0,
  );
});

test("strict API rejects changed amount or forged recipient; durable intent cannot be updated", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const c = await h.campaign(),
    p = await h.proof(`/claims/${c.claimId}/payment/challenge`);
  for (const extra of [
    { amount: 1 },
    { recipient: testSigner().address },
    { fee: 0 },
    { network: "mainnet" },
  ])
    assert.equal(
      (await h.call(`/claims/${c.claimId}/payment/reserve`, { ...p, ...extra }))
        .status,
      400,
    );
  const r = await h.call(`/claims/${c.claimId}/payment/reserve`, p);
  assert.equal(r.status, 201);
  assert.equal(r.body.intent.amount, 1234567);
  assert.equal(r.body.intent.recipient, h.recipient.address);
  assert.throws(
    () =>
      h.db
        .prepare("UPDATE payment_intents SET amount=1 WHERE id=?")
        .run(r.body.intent.id),
    /immutable/,
  );
  assert.throws(
    () =>
      h.db
        .prepare("UPDATE claims SET address=? WHERE id=?")
        .run(testSigner().address, c.claimId),
    /immutable/,
  );
  assert.throws(
    () =>
      h.db
        .prepare("UPDATE campaigns SET amount=1 WHERE id=?")
        .run(c.campaignId),
    /immutable/,
  );
  assert.throws(
    () =>
      h.db
        .prepare("UPDATE campaign_wallets SET address=?")
        .run(testSigner().address),
    /immutable/,
  );
});

test("concurrent reservations, used nonces, lost responses and dispatch permissions cannot double submit", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const c = await h.campaign(),
    p = await h.proof(`/claims/${c.claimId}/payment/challenge`);
  const responses = await Promise.all([
    h.call(`/claims/${c.claimId}/payment/reserve`, p),
    h.call(`/claims/${c.claimId}/payment/reserve`, p),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const r = responses.find((r) => r.status === 201)!.body;
  assert.equal((await h.reserve(c.claimId)).status, 409);
  assert.equal(
    (await h.call(`/payments/${r.id}/dispatch`, { permit: "0".repeat(64) }))
      .status,
    409,
  );
  const dispatches = await Promise.all([
    h.call(`/payments/${r.id}/dispatch`, { permit: r.permit }),
    h.call(`/payments/${r.id}/dispatch`, { permit: r.permit }),
  ]);
  assert.deepEqual(dispatches.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM payment_attempts").get() as any).n,
    1,
  );
});

for (const outcome of ["cancelled", "timeout", "error"] as const) {
  test(`${outcome} remains UNKNOWN and cannot release a reservation`, async (t) => {
    const h = await paymentHarness();
    t.after(() => h.close());
    const c = await h.campaign(),
      r = await h.reserve(c.claimId);
    const result = await h.call(`/payments/${r.body.id}/outcome`, { outcome });
    assert.equal(result.status, 200);
    assert.equal(result.body.state, "UNKNOWN");
    assert.equal(result.body.receipt, null);
    assert.equal((await h.reserve(c.claimId)).status, 409);
    assert.equal(
      (await h.call(`/payments/${r.body.id}/reconcile`, {})).body.state,
      "UNKNOWN",
    );
  });
}

test("hash hint cannot declare PAID; independent canonical execution and macro finality produce receipt", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const c = await h.campaign(),
    r = await h.reserve(c.claimId);
  const hint = await h.call(`/payments/${r.body.id}/outcome`, {
    outcome: "hash",
    hash: HASH,
  });
  assert.equal(hint.body.state, "UNKNOWN");
  assert.equal(hint.body.explorerUrl, null);
  assert.equal(
    (
      await h.call(`/payments/${r.body.id}/outcome`, {
        outcome: "hash",
        hash: HASH,
        state: "CONFIRMED",
      })
    ).status,
    400,
  );
  const verified = await h.call(`/payments/${r.body.id}/reconcile`, {});
  assert.equal(verified.status, 200);
  assert.equal(verified.body.state, "CONFIRMED");
  assert.equal(verified.body.receipt.sender, h.sender.address);
  assert.equal(verified.body.receipt.recipient, h.recipient.address);
  assert.equal(verified.body.receipt.amount, 1234567);
  assert.equal(verified.body.receipt.fee, 1000);
  assert.equal(verified.body.receipt.macroNumber, 128);
  assert.equal(verified.body.receipt.executionResult, true);
  assert.match(verified.body.explorerUrl, /^https:\/\/test.nimiq.watch\/#/);
  const publicView = (await h.call("/invitation", { token: c.token }, false))
    .body.claim;
  assert.equal(publicView.payment.state, "CONFIRMED");
  assert.ok(h.rpc.calls.includes("getTransactionByHash"));
  assert.ok(h.rpc.calls.includes("getMacroBlockAfter"));
  assert.equal(
    (await h.call(`/payments/${r.body.id}/reconcile`, { hash: "d".repeat(64) }))
      .status,
    409,
  );
  assert.equal(
    (
      await h.call(`/payments/${r.body.id}/outcome`, {
        outcome: "hash",
        hash: "d".repeat(64),
      })
    ).status,
    409,
  );
});

for (const altered of [
  "from",
  "to",
  "value",
  "fee",
  "networkId",
  "validityStartHeight",
  "hash",
  "flags",
] as const) {
  test(`independent RPC rejects mismatched ${altered}`, async (t) => {
    const h = await paymentHarness();
    t.after(() => h.close());
    const c = await h.campaign(),
      r = await h.reserve(c.claimId);
    h.rpc.tx[altered] = ["from", "to"].includes(altered)
      ? testSigner().address
      : altered === "hash"
        ? "d".repeat(64)
        : altered === "networkId"
          ? 24
          : 1;
    const result = await h.call(`/payments/${r.body.id}/reconcile`, {
      hash: HASH,
    });
    assert.equal(result.status, 409);
    assert.equal(
      (await h.call(`/claims/${c.claimId}/payment/review`, {})).body.payment
        .receipt,
      null,
    );
  });
}

test("unknown finality, missing execution, chain mismatch and RPC outage never confirm or fail a payment", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const c = await h.campaign(),
    r = await h.reserve(c.claimId);
  h.rpc.finality = false;
  assert.equal(
    (await h.call(`/payments/${r.body.id}/reconcile`, { hash: HASH })).body
      .state,
    "UNKNOWN",
  );
  h.rpc.finality = true;
  h.rpc.tx.executionResult = undefined;
  assert.equal(
    (await h.call(`/payments/${r.body.id}/reconcile`, { hash: HASH })).body
      .state,
    "UNKNOWN",
  );
  h.rpc.tx = {};
  h.rpc.network = "MainAlbatross";
  assert.equal(
    (await h.call(`/payments/${r.body.id}/reconcile`, { hash: HASH })).body
      .state,
    "UNKNOWN",
  );
  h.rpc.network = "TestAlbatross";
  h.rpc.offline = true;
  assert.equal(
    (await h.call(`/payments/${r.body.id}/reconcile`, { hash: HASH })).body
      .state,
    "UNKNOWN",
  );
});

test("only finalized execution failure becomes FAILED, without a paid receipt", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const c = await h.campaign(),
    r = await h.reserve(c.claimId);
  h.rpc.tx.executionResult = false;
  h.rpc.finality = false;
  assert.equal(
    (await h.call(`/payments/${r.body.id}/reconcile`, { hash: HASH })).body
      .state,
    "UNKNOWN",
  );
  h.rpc.finality = true;
  const failed = (
    await h.call(`/payments/${r.body.id}/reconcile`, { hash: HASH })
  ).body;
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.receipt.executionResult, false);
  assert.equal((await h.reserve(c.claimId)).status, 409);
});

test("one valid hash cannot satisfy multiple claims even when exact on-chain fields coincide", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const a = await h.campaign(),
    b = await h.campaign(1, h.recipient);
  const first = await h.reserve(a.claimId),
    second = await h.reserve(b.claimId);
  h.rpc.intent = first.body.intent;
  assert.equal(
    (await h.call(`/payments/${first.body.id}/reconcile`, { hash: HASH })).body
      .state,
    "CONFIRMED",
  );
  h.rpc.intent = second.body.intent;
  assert.equal(
    (await h.call(`/payments/${second.body.id}/reconcile`, { hash: HASH }))
      .status,
    409,
  );
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM payment_hashes").get() as any).n,
    1,
  );
});

test("expired campaign, bounded allocation and server spending limits prevent new attempts", async (t) => {
  const h = await paymentHarness();
  t.after(() => h.close());
  const c = await h.campaign(),
    p = await h.proof(`/claims/${c.claimId}/payment/challenge`);
  assert.equal(
    (await h.call(`/campaigns/${c.campaignId}/invitations`, {})).status,
    409,
  );
  h.advance(3600_001);
  assert.equal(
    (await h.call(`/claims/${c.claimId}/payment/reserve`, p)).status,
    410,
  );
  const limited = await paymentHarness({ maxLuna: 100 });
  t.after(() => limited.close());
  const l = await limited.campaign();
  assert.equal((await limited.reserve(l.claimId)).status, 403);
  const disabled = await paymentHarness({ enabled: false });
  t.after(() => disabled.close());
  const d = await disabled.campaign();
  assert.equal((await disabled.reserve(d.claimId)).status, 409);
  const mismatch = await paymentHarness({ spendingNetwork: "mainnet" });
  t.after(() => mismatch.close());
  const m = await mismatch.campaign();
  assert.equal((await mismatch.reserve(m.claimId)).status, 409);
});

test("additive v1 migration preserves existing credentials/data; durable reservations survive database reopen", async () => {
  const dir = mkdtempSync(resolve("data-test-")),
    path = resolve(dir, "upgrade.sqlite");
  const old = openDb(path),
    stored = passwordHash("preserved-organiser-password");
  old.prepare("INSERT INTO organiser VALUES (1,?)").run(stored);
  old
    .prepare("INSERT INTO campaigns VALUES (?,?,?,?,?,?,?)")
    .run(
      "legacy-campaign",
      "Preserved campaign",
      "Original v1 data",
      100000,
      1,
      Date.now() + 3600_000,
      Date.now(),
    );
  old
    .prepare("INSERT INTO sessions VALUES (?,?)")
    .run(digest("legacy-session"), Date.now() + 3600_000);
  old
    .prepare("INSERT INTO invitations VALUES (?,?,?,?)")
    .run(
      "legacy-invitation",
      "legacy-campaign",
      digest("legacy-token"),
      Date.now(),
    );
  old
    .prepare("INSERT INTO challenges VALUES (?,?,?,?,?)")
    .run(
      "legacy-challenge",
      "legacy-invitation",
      "legacy signed message",
      Date.now() + 60_000,
      1,
    );
  old
    .prepare("INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      "legacy-claim",
      "legacy-invitation",
      "legacy-campaign",
      testSigner().address,
      "synthetic-key",
      "synthetic-signature",
      "legacy-challenge",
      "payment-ready",
      Date.now(),
    );
  old
    .prepare("INSERT INTO events (claim_id,status,at) VALUES (?,?,?)")
    .run("legacy-claim", "payment-ready", Date.now());
  old.exec("PRAGMA user_version=1");
  old.close();
  const migrated = createApp({
    path,
    origin: "http://localhost:5173",
    network: "testnet",
  });
  assert.equal(
    (migrated.db.prepare("SELECT password_hash FROM organiser").get() as any)
      .password_hash,
    stored,
  );
  assert.equal(
    (migrated.db.prepare("PRAGMA user_version").get() as any).user_version,
    2,
  );
  assert.equal(
    (migrated.db.prepare("SELECT title FROM campaigns").get() as any).title,
    "Preserved campaign",
  );
  assert.equal(
    (migrated.db.prepare("SELECT status FROM claims").get() as any).status,
    "payment-ready",
  );
  assert.equal(
    (migrated.db.prepare("SELECT token_hash FROM invitations").get() as any)
      .token_hash,
    digest("legacy-token"),
  );
  assert.ok(
    migrated.db
      .prepare("SELECT hash FROM sessions WHERE hash=?")
      .get(digest("legacy-session")),
  );
  assert.equal(
    (migrated.db.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n,
    1,
  );
  migrated.db.close();
  // Isolated second database exercises actual payment rows; no real development database is opened.
  const h = await paymentHarness({}, resolve(dir, "attempt.sqlite"));
  try {
    const c = await h.campaign(),
      r = await h.reserve(c.claimId);
    await h.close();
    const db = openDb(resolve(dir, "attempt.sqlite"));
    const payments = new Payments(db, {
      origin: "https://payout.test",
      network: "testnet",
      now: () => Date.now() + 100_000,
      ...h.paymentOptions,
    });
    assert.equal(payments.view(c.claimId)!.state, "UNKNOWN");
    assert.throws(
      () => payments.dispatch(r.body.id, r.body.permit),
      /expired|already consumed/,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM payment_intents").get() as any).n,
      1,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent API instances racing on the same SQLite file reserve at most once", async () => {
  const dir = mkdtempSync(resolve("data-test-")),
    path = resolve(dir, "race.sqlite");
  const h = await paymentHarness({}, path);
  const second = createApp({
    path,
    origin: "https://payout.test",
    network: "testnet",
    payments: h.paymentOptions,
  });
  try {
    const c = await h.campaign(),
      proof = await h.proof(`/claims/${c.claimId}/payment/challenge`);
    second.server.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => second.server.once("listening", ok));
    const port = (second.server.address() as { port: number }).port;
    const results = await Promise.all([
      h
        .call(`/claims/${c.claimId}/payment/reserve`, proof)
        .then((r) => r.status),
      fetch(
        `http://127.0.0.1:${port}/api/claims/${c.claimId}/payment/reserve`,
        {
          method: "POST",
          headers: {
            Origin: "https://payout.test",
            Cookie: h.cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(proof),
        },
      ).then((r) => r.status),
    ]);
    assert.deepEqual(results.sort(), [201, 409]);
    assert.equal(
      (h.db.prepare("SELECT COUNT(*) AS n FROM payment_attempts").get() as any)
        .n,
      1,
    );
  } finally {
    await h.close();
    await new Promise<void>((ok) => second.server.close(() => ok()));
    second.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
