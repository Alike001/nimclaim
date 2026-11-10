import { test } from "node:test";
import assert from "node:assert/strict";
import { NimiqProviderError, type NimiqProvider } from "@nimiq/mini-app-sdk";
import { payoutAccounts } from "../src/wallet.js";
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
const expectedAccounts = {
  organiser: "synthetic-organiser",
  htlc: intent.sender,
};
const proof = {
  challengeId: "synthetic",
  publicKey: "synthetic",
  signature: "synthetic",
};
function fixture(
  mode:
    | "wallet-changed"
    | "owner-changed"
    | "htlc-missing"
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
  let hostAccounts = [expectedAccounts.organiser, expectedAccounts.htlc];
  let cachedAccounts: string[] | undefined;
  let accessError: Error | undefined;
  let disconnectError: Error | undefined;
  let approvals = 0;
  const accountCalls: string[] = [];
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
      if (mode === "wallet-changed") hostAccounts[1] = "different-htlc";
      if (mode === "owner-changed") hostAccounts[0] = "different-owner";
      return { attemptId: "synthetic-attempt", broadcastAllowed: true, intent };
    }
    result = body;
    if (mode === "outcome-lost") throw new Error("Outcome response lost");
    return {};
  }) as typeof api;
  const provider = {
    disconnect() {
      accountCalls.push("disconnect");
      if (disconnectError) throw disconnectError;
      cachedAccounts = undefined;
    },
    async listAccounts() {
      accountCalls.push("listAccounts");
      if (cachedAccounts) return cachedAccounts;
      approvals++;
      if (accessError) throw accessError;
      cachedAccounts =
        mode === "htlc-missing"
          ? [expectedAccounts.organiser]
          : [...hostAccounts];
      return cachedAccounts;
    },
    async sendBasicTransaction(parameters: unknown) {
      sends++;
      calls.push("wallet.sendBasicTransaction");
      assert.deepEqual(parameters, {
        recipient: intent.recipient,
        value: 1234567,
        fee: 1000,
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
    accountCalls,
    changeAccounts(accounts: string[]) {
      hostAccounts = [...accounts];
    },
    rejectAccess(
      error: Error = new NimiqProviderError(
        "PERMISSION_DENIED",
        "Renewed access rejected",
        4001,
      ),
    ) {
      accessError = error;
    },
    failDisconnect() {
      disconnectError = new Error("Disconnect failed");
    },
    get approvals() {
      return approvals;
    },
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
    expectedAccounts,
    proof,
    f.request,
    50,
  );
  assert.equal(f.sends, 1);
  assert.deepEqual(f.accountCalls, [
    "disconnect",
    "listAccounts",
    "disconnect",
    "listAccounts",
  ]);
  assert.equal(f.approvals, 2);
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
      expectedAccounts,
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
        expectedAccounts,
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
      expectedAccounts,
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
      expectedAccounts,
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

for (const mode of ["wallet-changed", "owner-changed"] as const) {
  test(`${mode} after dispatch prevents native request and retains uncertain reservation`, async () => {
    const f = fixture(mode);
    const result = await submitNativePayment(
      f.provider,
      intent.claim_id,
      "testnet",
      expectedAccounts,
      proof,
      f.request,
      5,
    );
    assert.equal(f.sends, 0);
    assert.equal(result.outcome, "error");
    assert.equal(f.result.outcome, "error");
    assert.equal(f.calls.filter((p) => p.endsWith("/reserve")).length, 1);
    assert.equal(f.calls.filter((p) => p.endsWith("/dispatch")).length, 1);
  });
}
test("missing active HTLC blocks before reserving", async () => {
  const f = fixture("htlc-missing");
  await assert.rejects(
    submitNativePayment(
      f.provider,
      intent.claim_id,
      "testnet",
      expectedAccounts,
      proof,
      f.request,
    ),
    /active remote HTLC/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.sends, 0);
});

// The fake must expose the original bug: changing the host does not invalidate
// an approved SDK list. Only disconnect() makes the next read request access.
test("provider fake caches approved accounts until disconnect", async () => {
  const f = fixture();
  const first = await f.provider.listAccounts();
  f.changeAccounts([expectedAccounts.organiser, "rotated-htlc"]);
  assert.deepEqual(await f.provider.listAccounts(), first);
  assert.equal(f.approvals, 1);
  f.provider.disconnect();
  assert.deepEqual(await f.provider.listAccounts(), [
    expectedAccounts.organiser,
    "rotated-htlc",
  ]);
  assert.equal(f.approvals, 2);
});

const invoke = (f: ReturnType<typeof fixture>) =>
  submitNativePayment(
    f.provider,
    intent.claim_id,
    "testnet",
    expectedAccounts,
    proof,
    f.request,
    5,
  );

for (const [name, accounts] of [
  ["HTLC rotation", [expectedAccounts.organiser, "rotated-htlc"]],
  ["organiser change", ["different-organiser", expectedAccounts.htlc]],
  ["missing HTLC", [expectedAccounts.organiser]],
  ["reversed host roles", [expectedAccounts.htlc, expectedAccounts.organiser]],
  [
    "duplicate addresses",
    [expectedAccounts.organiser, expectedAccounts.organiser],
  ],
] as const) {
  test(`${name} invalidates cached approval before reservation`, async () => {
    const f = fixture();
    await f.provider.listAccounts();
    f.changeAccounts([...accounts]);
    await assert.rejects(invoke(f));
    assert.equal(f.approvals, 2);
    assert.equal(f.calls.length, 0);
    assert.equal(f.sends, 0);
  });
}

for (const kind of ["reject", "error", "disconnect-error"] as const) {
  test(`renewed access ${kind} before reservation never falls back to cached accounts`, async () => {
    const f = fixture();
    await f.provider.listAccounts();
    if (kind === "disconnect-error") f.failDisconnect();
    else
      f.rejectAccess(
        kind === "error" ? new Error("Account transport failed") : undefined,
      );
    await assert.rejects(invoke(f));
    assert.equal(f.calls.length, 0);
    assert.equal(f.sends, 0);
  });

  test(`renewed access ${kind} after dispatch records uncertainty and blocks resubmission`, async () => {
    const f = fixture();
    const request = (async (path, body) => {
      const reply = await f.request(path, body);
      if (path.endsWith("/dispatch")) {
        if (kind === "disconnect-error") f.failDisconnect();
        else
          f.rejectAccess(
            kind === "error"
              ? new Error("Account transport failed")
              : undefined,
          );
      }
      return reply;
    }) as typeof api;
    const result = await submitNativePayment(
      f.provider,
      intent.claim_id,
      "testnet",
      expectedAccounts,
      proof,
      request,
      5,
    );
    assert.equal(result.outcome, kind === "reject" ? "cancelled" : "error");
    assert.equal(f.result.outcome, result.outcome);
    assert.equal(f.sends, 0);
    await assert.rejects(invoke(f), /Do not retry/);
    assert.equal(f.calls.filter((p) => p.endsWith("/reserve")).length, 1);
    assert.equal(f.calls.filter((p) => p.endsWith("/dispatch")).length, 1);
  });
}

test("missing HTLC immediately before native payment retains the reservation", async () => {
  const f = fixture();
  const request = (async (path, body) => {
    const reply = await f.request(path, body);
    if (path.endsWith("/dispatch"))
      f.changeAccounts([expectedAccounts.organiser]);
    return reply;
  }) as typeof api;
  const result = await submitNativePayment(
    f.provider,
    intent.claim_id,
    "testnet",
    expectedAccounts,
    proof,
    request,
    5,
  );
  assert.equal(result.outcome, "error");
  assert.equal(f.sends, 0);
  await assert.rejects(invoke(f), /Do not retry/);
  assert.equal(f.calls.filter((p) => p.endsWith("/reserve")).length, 1);
});

for (const mode of [
  "hash",
  "cancel",
  "timeout",
  "error",
  "reserve-lost",
  "dispatch-lost",
  "outcome-lost",
] as const) {
  test(`${mode}: concurrent and repeated submissions cannot duplicate reservation or native request`, async () => {
    const f = fixture(mode);
    const results = await Promise.allSettled([invoke(f), invoke(f)]);
    assert.equal(results[1].status, "rejected");
    await assert.rejects(invoke(f), /Do not retry/);
    assert.equal(f.calls.filter((p) => p.endsWith("/reserve")).length, 1);
    assert.ok(f.calls.filter((p) => p.endsWith("/dispatch")).length <= 1);
    assert.equal(
      f.sends,
      ["reserve-lost", "dispatch-lost"].includes(mode) ? 0 : 1,
    );
  });
}

test("fresh payout preparation uses the reviewed host roles after clearing an old approval", async () => {
  const f = fixture();
  await f.provider.listAccounts();
  f.changeAccounts([expectedAccounts.organiser, "rotated-htlc"]);
  assert.deepEqual(await payoutAccounts(f.provider), {
    organiser: expectedAccounts.organiser,
    htlc: "rotated-htlc",
  });
});

test("network change during renewed approval blocks reservation", async () => {
  const f = fixture();
  const read = f.provider.listAccounts.bind(f.provider);
  f.provider.listAccounts = async () => {
    const accounts = await read();
    window.nimiqPay = { network: "mainnet" } as typeof window.nimiqPay;
    return accounts;
  };
  await assert.rejects(invoke(f), /network changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sends, 0);
});

// Characterization of the reviewed host's second cache, not a freshness promise.
// A future host fix must be validated against its own source and actual devices.
test("SDK disconnect cannot invalidate a separate host bridge account cache", async () => {
  let nativeAccounts = [expectedAccounts.organiser, expectedAccounts.htlc];
  let bridgeAccounts: string[] | undefined;
  let sdkAccounts: string[] | undefined;
  let nativeReads = 0;
  let disconnects = 0;
  const provider = {
    disconnect() {
      disconnects++;
      sdkAccounts = undefined;
    },
    async listAccounts() {
      if (sdkAccounts) return sdkAccounts;
      if (!bridgeAccounts) {
        nativeReads++;
        bridgeAccounts = [...nativeAccounts];
      }
      sdkAccounts = bridgeAccounts;
      return sdkAccounts;
    },
  } as unknown as NimiqProvider;
  assert.deepEqual(await payoutAccounts(provider), expectedAccounts);
  nativeAccounts = [expectedAccounts.organiser, "rotated-native-htlc"];
  // The previous pair still passes: no fresh native read occurred despite
  // disconnect. Independent RPC can validate the old HTLC, but cannot prove it
  // is the host's current payment source. Spending therefore remains NO-GO.
  assert.deepEqual(
    await payoutAccounts(provider, expectedAccounts),
    expectedAccounts,
  );
  assert.equal(disconnects, 2);
  assert.equal(nativeReads, 1);
});
