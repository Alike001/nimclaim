import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { HttpRpc, verifyBasicTransfer } from "../server/rpc.js";
import { testSigner } from "./helpers.js";

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

test("MAINNET verifies an exact external Basic-to-Basic NIM transfer through canonical inclusion and macro finality", async () => {
  const sender = testSigner();
  const recipient = testSigner();
  const hash = "f".repeat(64);
  const tx = {
    hash,
    from: sender.address,
    to: recipient.address,
    fromType: 0,
    toType: 0,
    value: 1_000_000,
    fee: 1000,
    networkId: 24,
    validityStartHeight: 100,
    flags: 0,
    senderData: "",
    recipientData: "",
    blockNumber: 101,
    executionResult: true,
    proof: "00",
  };
  const calls: string[] = [];
  const rpc = {
    async call(method: string, params: unknown[]) {
      calls.push(method);
      if (method === "isConsensusEstablished") return true;
      if (method === "getBlockNumber") return 200;
      if (method === "getTransactionByHash") return tx;
      if (method === "getMacroBlockAfter") return 128;
      if (method === "getBlockByNumber" && params[0] === 200)
        return {
          number: 200,
          hash: "d".repeat(64),
          network: "MainAlbatross",
        };
      if (method === "getBlockByNumber" && params[0] === 128)
        return {
          number: 128,
          hash: "b".repeat(64),
          network: "MainAlbatross",
          type: "macro",
          justification: { sig: "SYNTHETIC_TEST_ONLY" },
        };
      if (method === "getBlockByNumber" && params[0] === 101)
        return {
          number: 101,
          hash: "c".repeat(64),
          network: "MainAlbatross",
          type: "micro",
          transactions: [tx],
        };
      throw new Error("Unexpected synthetic RPC method");
    },
  };
  const result = await verifyBasicTransfer(
    rpc,
    {
      sender: sender.address,
      recipient: recipient.address,
      amount: 1_000_000,
      network: "mainnet",
    },
    hash,
    1_800_000_000_000,
  );
  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.receipt?.source, "external");
  assert.equal(result.receipt?.sender, sender.address);
  assert.equal(result.receipt?.recipient, recipient.address);
  assert.equal(result.receipt?.amount, 1_000_000);
  assert.equal(result.receipt?.fee, 1000);
  assert.equal(result.receipt?.validityStartHeight, 100);
  assert.equal(result.receipt?.blockNumber, 101);
  assert.equal(result.receipt?.macroNumber, 128);
  assert.equal(result.receipt?.executionResult, true);
  assert.ok(calls.includes("getTransactionByHash"));
  assert.ok(calls.includes("getMacroBlockAfter"));
  assert.ok(!calls.some((method) => /send|broadcast|push/i.test(method)));
});

test("MAINNET external payment verification rejects mismatched payer, recipient, amount and chain", async () => {
  const sender = testSigner();
  const recipient = testSigner();
  const hash = "e".repeat(64);
  const tx = {
    hash,
    from: sender.address,
    to: recipient.address,
    fromType: 0,
    toType: 0,
    value: 1_000_000,
    fee: 1000,
    networkId: 24,
    validityStartHeight: 100,
    flags: 0,
    senderData: "",
    recipientData: "",
    blockNumber: 101,
    executionResult: true,
    proof: "00",
  };
  const rpc = {
    async call(method: string, params: unknown[]) {
      if (method === "isConsensusEstablished") return true;
      if (method === "getBlockNumber") return 200;
      if (method === "getTransactionByHash") return tx;
      if (method === "getMacroBlockAfter") return 128;
      if (method === "getBlockByNumber" && params[0] === 200)
        return { number: 200, hash: "d".repeat(64), network: "MainAlbatross" };
      if (method === "getBlockByNumber" && params[0] === 128)
        return {
          number: 128,
          hash: "b".repeat(64),
          network: "MainAlbatross",
          type: "macro",
          justification: { sig: "SYNTHETIC_TEST_ONLY" },
        };
      if (method === "getBlockByNumber" && params[0] === 101)
        return {
          number: 101,
          hash: "c".repeat(64),
          network: "MainAlbatross",
          type: "micro",
          transactions: [tx],
        };
      throw new Error("Unexpected synthetic RPC method");
    },
  };
  await assert.rejects(
    verifyBasicTransfer(
      rpc,
      {
        sender: testSigner().address,
        recipient: recipient.address,
        amount: 1_000_000,
        network: "mainnet",
      },
      hash,
      Date.now(),
    ),
    /does not match/,
  );
  await assert.rejects(
    verifyBasicTransfer(
      rpc,
      {
        sender: sender.address,
        recipient: recipient.address,
        amount: 10_000_000,
        network: "mainnet",
      },
      hash,
      Date.now(),
    ),
    /does not match/,
  );
});

test("MAINNET failed execution or missing finality never becomes a paid receipt", async () => {
  const sender = testSigner();
  const recipient = testSigner();
  const hash = "c".repeat(64);
  const tx = {
    hash,
    from: sender.address,
    to: recipient.address,
    fromType: 0,
    toType: 0,
    value: 1_000_000,
    fee: 1000,
    networkId: 24,
    validityStartHeight: 100,
    flags: 0,
    senderData: "",
    recipientData: "",
    blockNumber: 101,
    executionResult: false,
    proof: "00",
  };
  let finality = true;
  const rpc = {
    async call(method: string, params: unknown[]) {
      if (method === "isConsensusEstablished") return true;
      if (method === "getBlockNumber") return 200;
      if (method === "getTransactionByHash") return tx;
      if (method === "getMacroBlockAfter") return 128;
      if (method === "getBlockByNumber" && params[0] === 200)
        return { number: 200, hash: "d".repeat(64), network: "MainAlbatross" };
      if (method === "getBlockByNumber" && params[0] === 128)
        return {
          number: 128,
          hash: "b".repeat(64),
          network: "MainAlbatross",
          type: "macro",
          justification: finality ? { sig: "SYNTHETIC_TEST_ONLY" } : {},
        };
      if (method === "getBlockByNumber" && params[0] === 101)
        return {
          number: 101,
          hash: "c".repeat(64),
          network: "MainAlbatross",
          type: "micro",
          transactions: [tx],
        };
      throw new Error("Unexpected synthetic RPC method");
    },
  };
  const expected = {
    sender: sender.address,
    recipient: recipient.address,
    amount: 1_000_000,
    network: "mainnet" as const,
  };
  const failed = await verifyBasicTransfer(rpc, expected, hash, Date.now());
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.receipt, undefined);
  finality = false;
  const unknown = await verifyBasicTransfer(rpc, expected, hash, Date.now());
  assert.equal(unknown.state, "UNKNOWN");
  assert.equal(unknown.receipt, undefined);
});
