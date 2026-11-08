import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../server/app.js";
import { digest, passwordHash, verifyOwner } from "../server/crypto.js";
import { testSigner } from "./helpers.js";
const origin = "http://localhost:5173";
async function harness(path = ":memory:") {
  let time = Date.now();
  const app = createApp({ path, origin, network: "testnet", now: () => time });
  if (!app.db.prepare("SELECT * FROM organiser").get())
    app.db
      .prepare("INSERT INTO organiser VALUES (1,?)")
      .run(passwordHash("test-only-password"));
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address() as { port: number };
  let cookie = "";
  const call = async (
    path: string,
    body?: unknown,
    auth = true,
    requestOrigin = origin,
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: requestOrigin,
          Cookie: auth ? cookie : "",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const result = await response.json();
    return { status: response.status, body: result, response };
  };
  const login = await call("/login", { password: "test-only-password" });
  cookie = login.response.headers.get("set-cookie")!.split(";")[0];
  return {
    ...app,
    call,
    cookie,
    advance(ms: number) {
      time += ms;
    },
    async campaign(slots = 3, expires = time + 3600_000) {
      const r = await call("/campaigns", {
        title: "Test contributions",
        description: "Synthetic test campaign",
        amount: "12.34567",
        slots,
        expires,
      });
      assert.equal(r.status, 201);
      return r.body.campaign;
    },
    async invite(id: string) {
      const r = await call(`/campaigns/${id}/invitations`, {});
      assert.equal(r.status, 201);
      return r.body.url.split("#claim=")[1] as string;
    },
    async proof(token: string, signer = testSigner()) {
      const r = await call("/challenge", { token }, false);
      assert.equal(r.status, 201);
      return {
        token,
        challengeId: r.body.id,
        publicKey: signer.publicKey,
        signature: signer.sign(r.body.message),
      };
    },
    async close() {
      await new Promise<void>((ok, reject) =>
        app.server.close((e) => (e ? reject(e) : ok())),
      );
      app.db.close();
    },
  };
}

test("cryptographic ownership accepts official envelope; rejects invalid, forged and raw signatures", () => {
  const alice = testSigner(),
    bob = testSigner(),
    message = "NimClaim test";
  assert.equal(
    verifyOwner(message, alice.publicKey, alice.sign(message)),
    alice.address,
  );
  assert.equal(verifyOwner(message, bob.publicKey, alice.sign(message)), null);
  assert.equal(
    verifyOwner(message + "x", alice.publicKey, alice.sign(message)),
    null,
  );
  assert.equal(
    verifyOwner(message, alice.publicKey, alice.rawSign(message)),
    null,
  );
  assert.equal(verifyOwner(message, "invalid", "00"), null);
});

test("complete claim/review flow, exact Luna, server-derived address and immutable approval", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const c = await h.campaign(),
    token = await h.invite(c.id),
    alice = testSigner();
  assert.equal(c.amount, 1234567);
  const proof = await h.proof(token, alice);
  assert.equal(
    (await h.call("/claim", { ...proof, address: testSigner().address }, false))
      .status,
    400,
  );
  const r = await h.call("/claim", proof, false);
  assert.equal(r.status, 201);
  assert.equal(r.body.claim.address, alice.address);
  assert.equal(r.body.claim.status, "pending");
  const approved = await h.call(`/claims/${r.body.claim.id}/decision`, {
    decision: "payment-ready",
  });
  assert.equal(approved.status, 200);
  assert.deepEqual(
    approved.body.claim.history.map((e: any) => e.status),
    ["pending", "payment-ready"],
  );
  assert.equal(
    (
      await h.call(`/claims/${r.body.claim.id}/decision`, {
        decision: "rejected",
      })
    ).status,
    409,
  );
  const view = await h.call("/invitation", { token }, false);
  assert.equal(view.body.claim.status, "payment-ready");
  h.advance(7200_000);
  assert.equal(
    (await h.call("/invitation", { token }, false)).body.claim.status,
    "payment-ready",
  );
});

test("authorization, CSRF origin, validation, session invalidation and expiry", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const c = await h.campaign();
  for (const [path, body] of [
    ["/campaigns", undefined],
    ["/campaigns", {}],
    [`/campaigns/${c.id}`, undefined],
    [`/campaigns/${c.id}/invitations`, {}],
    [`/claims/${c.id}/decision`, { decision: "payment-ready" }],
  ] as const)
    assert.equal((await h.call(path, body, false)).status, 401);
  assert.equal(
    (await h.call("/login", { password: "wrong" }, false)).status,
    401,
  );
  assert.equal(
    (await h.call("/campaigns", {}, true, "https://evil.example")).status,
    403,
  );
  assert.equal(
    (
      await h.call("/campaigns", {
        title: "x",
        description: "x",
        amount: "1e5",
        slots: 1,
        expires: Date.now() + 5000,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.call("/campaigns", {
        title: "x",
        description: "x",
        amount: "1.000001",
        slots: 1,
        expires: Date.now() + 5000,
      })
    ).status,
    400,
  );
  assert.equal(
    (await h.call("/invitation", { token: "bad" }, false)).status,
    400,
  );
  assert.equal(
    (await h.call("/invitation", { token: "f".repeat(64) }, false)).status,
    404,
  );
  assert.equal((await h.call("/logout", {})).status, 200);
  assert.equal((await h.call("/campaigns")).status, 401);
});

test("one-time nonces, already-used invitations, duplicate wallet across links and invalid proofs", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const c = await h.campaign(),
    a = await h.invite(c.id),
    b = await h.invite(c.id),
    alice = testSigner();
  const old = await h.proof(a, alice),
    proof = await h.proof(a, alice);
  assert.equal((await h.call("/claim", old, false)).status, 409);
  assert.equal(
    (await h.call("/claim", { ...proof, signature: "00".repeat(64) }, false))
      .status,
    401,
  );
  assert.equal(
    (
      await h.call(
        "/claim",
        { ...proof, publicKey: testSigner().publicKey },
        false,
      )
    ).status,
    401,
  );
  assert.equal((await h.call("/claim", proof, false)).status, 201);
  assert.equal((await h.call("/claim", proof, false)).status, 409);
  assert.equal((await h.call("/challenge", { token: a }, false)).status, 409);
  assert.equal(
    (await h.call("/claim", await h.proof(b, alice), false)).status,
    409,
  );
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as any).n,
    1,
  );
});

test("challenge binds invitation, origin, network, amount and expiration", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const c = await h.campaign(),
    a = await h.invite(c.id),
    b = await h.invite(c.id),
    signer = testSigner();
  const challenge = await h.call("/challenge", { token: a }, false),
    parsed = JSON.parse(challenge.body.message);
  assert.equal(parsed.origin, origin);
  assert.equal(parsed.network, "testnet");
  assert.equal(parsed.amountLuna, c.amount);
  assert.equal(parsed.campaign, c.id);
  assert.equal(parsed.tokenHash, digest(a));
  assert.equal(parsed.domain, "NimClaim/claim/v1");
  assert.match(parsed.nonce, /^[a-f0-9]{64}$/);
  const proof = {
    token: a,
    challengeId: challenge.body.id,
    publicKey: signer.publicKey,
    signature: signer.sign(challenge.body.message),
  };
  assert.equal(
    (await h.call("/claim", { ...proof, token: b }, false)).status,
    409,
  );
  for (const altered of [
    { ...parsed, origin: "https://evil.example" },
    { ...parsed, network: "mainnet" },
    { ...parsed, amountLuna: 1 },
  ])
    assert.equal(
      (
        await h.call(
          "/claim",
          { ...proof, signature: signer.sign(JSON.stringify(altered)) },
          false,
        )
      ).status,
      401,
    );
  h.advance(300_001);
  assert.equal((await h.call("/claim", proof, false)).status, 409);
});

test("expired links and pending claims cannot be claimed or approved; rejection final", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const c = await h.campaign(),
    a = await h.invite(c.id),
    b = await h.invite(c.id),
    d = await h.invite(c.id);
  const claim = (await h.call("/claim", await h.proof(a), false)).body.claim;
  const rejected = (await h.call("/claim", await h.proof(b), false)).body.claim;
  assert.equal(
    (await h.call(`/claims/${rejected.id}/decision`, { decision: "rejected" }))
      .status,
    200,
  );
  assert.equal(
    (
      await h.call(`/claims/${rejected.id}/decision`, {
        decision: "payment-ready",
      })
    ).status,
    409,
  );
  const proof = await h.proof(d);
  h.advance(3600_001);
  assert.equal((await h.call("/claim", proof, false)).status, 410);
  assert.equal((await h.call("/challenge", { token: d }, false)).status, 410);
  assert.equal(
    (await h.call(`/campaigns/${c.id}/invitations`, {})).status,
    410,
  );
  assert.equal(
    (
      await h.call(`/claims/${claim.id}/decision`, {
        decision: "payment-ready",
      })
    ).status,
    409,
  );
  const view = (await h.call("/invitation", { token: a }, false)).body;
  assert.equal(view.expired, true);
  assert.equal(view.claim.status, "expired");
  assert.equal(view.claim.history.length, 2);
});

test("concurrent claims, slot issuance and competing approvals commit exactly once", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const c = await h.campaign(1);
  const invites = await Promise.all([
    h.call(`/campaigns/${c.id}/invitations`, {}),
    h.call(`/campaigns/${c.id}/invitations`, {}),
  ]);
  assert.deepEqual(invites.map((r) => r.status).sort(), [201, 409]);
  const token = invites
      .find((r) => r.status === 201)!
      .body.url.split("#claim=")[1],
    proof = await h.proof(token);
  const claims = await Promise.all([
    h.call("/claim", proof, false),
    h.call("/claim", proof, false),
  ]);
  assert.deepEqual(claims.map((r) => r.status).sort(), [201, 409]);
  const id = claims.find((r) => r.status === 201)!.body.claim.id;
  const decisions = await Promise.all([
    h.call(`/claims/${id}/decision`, { decision: "payment-ready" }),
    h.call(`/claims/${id}/decision`, { decision: "rejected" }),
  ]);
  assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      h.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE claim_id=?")
        .get(id) as any
    ).n,
    2,
  );
});

test("concurrent claims from same wallet on separate links create a single campaign claim", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const c = await h.campaign(),
    alice = testSigner();
  const a = await h.proof(await h.invite(c.id), alice),
    b = await h.proof(await h.invite(c.id), alice);
  const responses = await Promise.all([
    h.call("/claim", a, false),
    h.call("/claim", b, false),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
});

test("durable restart preserves credentials, sessions, token hashes, claims, used nonce and history", async () => {
  const dir = mkdtempSync(resolve("data-test-"));
  const path = resolve(dir, "test.sqlite");
  let h = await harness(path);
  try {
    const c = await h.campaign(),
      token = await h.invite(c.id),
      proof = await h.proof(token);
    const claim = (await h.call("/claim", proof, false)).body.claim;
    await h.call(`/claims/${claim.id}/decision`, { decision: "payment-ready" });
    assert.equal(
      (h.db.prepare("SELECT token_hash FROM invitations").get() as any)
        .token_hash,
      digest(token),
    );
    const cookie = h.cookie;
    await h.close();
    h = await harness(path);
    const row = h.db
      .prepare("SELECT hash FROM sessions WHERE hash=?")
      .get(digest(cookie.split("=")[1]));
    assert.ok(row);
    assert.equal((await h.call("/campaigns")).body.campaigns.length, 1);
    const view = (await h.call("/invitation", { token }, false)).body;
    assert.equal(view.claim.status, "payment-ready");
    assert.equal(view.claim.history.length, 2);
    assert.equal((await h.call("/claim", proof, false)).status, 409);
    assert.equal(
      (
        h.db
          .prepare("SELECT used FROM challenges WHERE id=?")
          .get(proof.challengeId) as any
      ).used,
      1,
    );
    assert.equal(readFileSync(path).includes(Buffer.from(token)), false);
    h.advance(9 * 3600_000);
    assert.equal((await h.call("/campaigns")).status, 401);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent API instances share atomic claim and decision constraints", async () => {
  const dir = mkdtempSync(resolve("data-test-")),
    path = resolve(dir, "concurrent.sqlite");
  const a = await harness(path),
    b = await harness(path);
  try {
    const c = await a.campaign(1),
      token = await a.invite(c.id),
      proof = await a.proof(token);
    const responses = await Promise.all([
      a.call("/claim", proof, false),
      b.call("/claim", proof, false),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    const id = responses.find((r) => r.status === 201)!.body.claim.id;
    const decisions = await Promise.all([
      a.call(`/claims/${id}/decision`, { decision: "payment-ready" }),
      b.call(`/claims/${id}/decision`, { decision: "payment-ready" }),
    ]);
    assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("network is fixed per database and stale origin challenges fail after restart", async () => {
  const dir = mkdtempSync(resolve("data-test-")),
    path = resolve(dir, "binding.sqlite");
  let h = await harness(path);
  let other: ReturnType<typeof createApp> | undefined;
  try {
    const c = await h.campaign(),
      token = await h.invite(c.id),
      proof = await h.proof(token);
    await h.close();
    assert.throws(
      () => createApp({ path, origin, network: "mainnet" }),
      /Database network mismatch/,
    );
    other = createApp({
      path,
      origin: "https://new.example",
      network: "testnet",
    });
    other.server.listen(0, "127.0.0.1");
    await once(other.server, "listening");
    const address = other.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/claim`, {
      method: "POST",
      headers: {
        Origin: "https://new.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(proof),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /different origin or network/);
  } finally {
    if (other) {
      await new Promise<void>((ok) => other!.server.close(() => ok()));
      other.db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login throttling rejects bursts and resets after its bounded window", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  for (let n = 0; n < 9; n++)
    assert.equal(
      (await h.call("/login", { password: "wrong" }, false)).status,
      401,
    );
  assert.equal(
    (await h.call("/login", { password: "test-only-password" }, false)).status,
    429,
  );
  h.advance(60_001);
  assert.equal(
    (await h.call("/login", { password: "test-only-password" }, false)).status,
    200,
  );
});

test("body limits reject oversized requests and preserve Unicode input", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  assert.equal(
    (await h.call("/campaigns", { description: "x".repeat(20_000) })).status,
    413,
  );
  const r = await h.call("/campaigns", {
    title: "Ẹ ṣé · Danke",
    description: "Community contributions 🌍",
    amount: "1",
    slots: 1,
    expires: Date.now() + 60_000,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.campaign.title, "Ẹ ṣé · Danke");
});
