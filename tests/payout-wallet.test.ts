import { test } from "node:test";
import assert from "node:assert/strict";
import { NimiqProviderError, type NimiqProvider } from "@nimiq/mini-app-sdk";
import { submitNativePayment } from "../src/payout-wallet.js";
import type { api } from "../src/api.js";
import type { Intent } from "../shared/payments.js";
const intent: Intent = {
  id: "synthetic-intent",
  claim_id: "synthetic-claim",
  campaign_id: "synthetic-campaign",
  sender: "synthetic-sender",
  recipient: "synthetic-recipient",
  amount: 1234567,
  fee: 1000,
  network: "testnet",
  validity_start_height: 100,
  created: 1,
  expires: 2,
};
const proof = {
  challengeId: "synthetic",
  publicKey: "synthetic",
  signature: "synthetic",
};
function fixture(
  mode:
    | "hash"
    | "cancel"
    | "timeout"
    | "error"
    | "reserve-lost"
    | "dispatch-lost"
    | "outcome-lost"
    | "blocked" = "hash",
) {
  globalThis.window = { nimiqPay: { network: "testnet" } } as typeof window;
  const calls: string[] = [];
  let sends = 0,
    result: any;
  const request = (async (path: string, body: any) => {
    calls.push(path);
    if (path.endsWith("/reserve")) {
      if (mode === "blocked" || mode === "reserve-lost")
        throw new Error("Reservation blocked or response lost");
      return { id: "synthetic-attempt", permit: "synthetic-permit", intent };
    }
    if (path.endsWith("/dispatch")) {
      if (mode === "dispatch-lost") throw new Error("Dispatch response lost");
      return { attemptId: "synthetic-attempt", broadcastAllowed: true, intent };
    }
    result = body;
    if (mode === "outcome-lost") throw new Error("Outcome response lost");
    return {};
  }) as typeof api;
  const provider = {
    async sendBasicTransaction(parameters: unknown) {
      sends++;
      calls.push("wallet.sendBasicTransaction");
      assert.deepEqual(parameters, {
        recipient: intent.recipient,
        value: 1234567,
        fee: 1000,
        validityStartHeight: 100,
      });
      if (mode === "cancel")
        throw new NimiqProviderError(
          "PERMISSION_DENIED",
          "Test cancellation",
          4001,
        );
      if (mode === "timeout") return new Promise<string>(() => {});
      if (mode === "error")
        throw new Error("Synthetic native transport failure");
      return "a".repeat(64);
    },
  } as unknown as NimiqProvider;
  return {
    request,
    provider,
    calls,
    get sends() {
      return sends;
    },
    get result() {
      return result;
    },
  };
}

test("native adapter calls official method with immutable Luna parameters only after durable reserve/dispatch acknowledgements", async () => {
  const f = fixture();
  await submitNativePayment(
    f.provider,
    intent.claim_id,
    "testnet",
    proof,
    f.request,
    50,
  );
  assert.equal(f.sends, 1);
  assert.deepEqual(f.calls, [
    `/claims/${intent.claim_id}/payment/reserve`,
    "/payments/synthetic-attempt/dispatch",
    "wallet.sendBasicTransaction",
    "/payments/synthetic-attempt/outcome",
  ]);
  assert.equal(f.result.outcome, "hash");
});
for (const mode of ["cancel", "timeout", "error"] as const)
  test(`native ${mode} records uncertain outcome without retrying the wallet`, async () => {
    const f = fixture(mode);
    await submitNativePayment(
      f.provider,
      intent.claim_id,
      "testnet",
      proof,
      f.request,
      5,
    );
    assert.equal(f.sends, 1);
    assert.equal(f.result.outcome, mode === "cancel" ? "cancelled" : mode);
  });
for (const mode of ["reserve-lost", "dispatch-lost", "blocked"] as const)
  test(`${mode} prevents any SDK broadcast call`, async () => {
    const f = fixture(mode);
    await assert.rejects(
      submitNativePayment(
        f.provider,
        intent.claim_id,
        "testnet",
        proof,
        f.request,
        5,
      ),
    );
    assert.equal(f.sends, 0);
  });
test("lost outcome response is explicitly uncertain and never triggers another native call", async () => {
  const f = fixture("outcome-lost");
  await assert.rejects(
    submitNativePayment(
      f.provider,
      intent.claim_id,
      "testnet",
      proof,
      f.request,
    ),
    /Do not retry/,
  );
  assert.equal(f.sends, 1);
});
test("wallet chain mismatch prevents reservation and native invocation", async () => {
  const f = fixture();
  window.nimiqPay = { network: "mainnet" } as typeof window.nimiqPay;
  await assert.rejects(
    submitNativePayment(
      f.provider,
      intent.claim_id,
      "testnet",
      proof,
      f.request,
    ),
    /network changed/,
  );
  assert.equal(f.sends, 0);
  assert.equal(f.calls.length, 0);
});

test("NIM formatting retains the exact smallest unit at the maximum safe Luna integer", async () => {
  const { nim } = await import("../src/api.js");
  assert.match(nim(1), /0[.,]00001$/);
  assert.match(nim(1234567), /12[.,]34567$/);
  assert.match(nim(Number.MAX_SAFE_INTEGER), /40991$/);
});
