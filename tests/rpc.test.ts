import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { HttpRpc } from "../server/rpc.js";

test("RPC adapter only permits read methods and parses official result.data envelopes", async (t) => {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    methods.push(input.method);
    assert.deepEqual(input.params, []);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: input.id,
        result: { data: "TestAlbatross", metadata: null },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  const rpc = new HttpRpc(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  assert.equal(await rpc.call("getNetworkId", []), "TestAlbatross");
  for (const method of [
    "sendBasicTransaction",
    "sendRawTransaction",
    "pushTransaction",
    "listAccounts",
    "createAccount",
  ])
    await assert.rejects(rpc.call(method, []), /read-only/);
  assert.equal(await rpc.call("getAccountByAddress", []), "TestAlbatross");
  assert.deepEqual(methods, ["getNetworkId", "getAccountByAddress"]);
  assert.throws(() => new HttpRpc("http://public.example"), /HTTPS/);
  assert.throws(
    () => new HttpRpc("https://user:secret@rpc.example"),
    /credentials/,
  );
});

test("RPC timeout and missing/error envelopes fail closed", async (t) => {
  let mode: "timeout" | "error" | "bad" = "timeout";
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    if (mode === "timeout") return;
    res.end(
      JSON.stringify(
        mode === "error"
          ? { jsonrpc: "2.0", id: input.id, error: { code: -1 } }
          : { jsonrpc: "2.0", id: input.id, result: { value: true } },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((ok) => server.close(() => ok()));
  });
  const rpc = new HttpRpc(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    undefined,
    50,
  );
  await assert.rejects(rpc.call("getNetworkId", []));
  mode = "error";
  await assert.rejects(rpc.call("getNetworkId", []));
  mode = "bad";
  await assert.rejects(rpc.call("getNetworkId", []));
});

test("official cosigner trust lists are derived and isolated by network", async () => {
  const { trustedCosigners, cosignerPublicKeys, publicKeyAddress, verifyHtlc } =
    await import("../server/rpc.js");
  const { FixtureRpc } = await import("./payment-helpers.js");
  const rpc = new FixtureRpc();
  assert.equal(trustedCosigners("testnet").length, 2);
  assert.equal(trustedCosigners("mainnet").length, 1);
  for (const key of cosignerPublicKeys.testnet) {
    rpc.account.recipient = publicKeyAddress(key);
    assert.equal(
      (
        await verifyHtlc(
          rpc,
          "testnet",
          rpc.htlc,
          rpc.owner.address,
          1234567,
          1000,
          Date.now(),
        )
      ).sender,
      rpc.htlc,
    );
    assert.ok(!trustedCosigners("mainnet").includes(publicKeyAddress(key)));
  }
  rpc.account.recipient = trustedCosigners("mainnet")[0];
  await assert.rejects(
    verifyHtlc(
      rpc,
      "testnet",
      rpc.htlc,
      rpc.owner.address,
      1234567,
      1000,
      Date.now(),
    ),
    /trusted/,
  );
  rpc.account = { balance: 1235567 };
  await verifyHtlc(
    rpc,
    "testnet",
    rpc.htlc,
    rpc.owner.address,
    1234567,
    1000,
    Date.now(),
  );
  rpc.account.balance = 1235566;
  await assert.rejects(
    verifyHtlc(
      rpc,
      "testnet",
      rpc.htlc,
      rpc.owner.address,
      1234567,
      1000,
      Date.now(),
    ),
    /insufficient/,
  );
});

test("installed core decodes early and timeout resolve proofs with their actual runtime discriminators", async () => {
  const { HashedTimeLockedContract } = await import("@nimiq/core");
  const { testSigner } = await import("./helpers.js");
  const { cosignerPublicKeys, publicKeyAddress } =
    await import("../server/rpc.js");
  const creator = testSigner();
  const publicKey = cosignerPublicKeys.testnet[0];
  // Structurally serialized proofs with synthetic signatures: parsing is not
  // evidence of cryptographic validity, chain execution, or a real payment.
  const signerSignature = "11".repeat(64);
  const creatorSignature = "22".repeat(64);
  const signerProof = "00" + publicKey + "00" + signerSignature;
  const creatorProof = "00" + creator.publicKey + "00" + creatorSignature;
  const raw = "01" + signerProof + creatorProof;
  const early = HashedTimeLockedContract.proofToPlain(Buffer.from(raw, "hex"));
  assert.deepEqual(early, {
    type: "early-resolve",
    raw,
    signer: publicKeyAddress(publicKey),
    signature: signerSignature,
    publicKey,
    pathLength: 0,
    creator: creator.address,
    creatorSignature,
    creatorPublicKey: creator.publicKey,
    creatorPathLength: 0,
  });
  const timeoutRaw = "02" + creatorProof;
  const timeout = HashedTimeLockedContract.proofToPlain(
    Buffer.from(timeoutRaw, "hex"),
  );
  assert.deepEqual(timeout, {
    type: "timeout-resolve",
    raw: timeoutRaw,
    creator: creator.address,
    creatorSignature,
    creatorPublicKey: creator.publicKey,
    creatorPathLength: 0,
  });
  assert.throws(() =>
    HashedTimeLockedContract.proofToPlain(Buffer.from("0100", "hex")),
  );
});
