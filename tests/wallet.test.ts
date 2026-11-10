import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { NimiqProvider } from "@nimiq/mini-app-sdk";
import { signChallenge, watchWalletAccounts } from "../src/wallet.js";

const origin = "https://nimclaim.example";

const message = JSON.stringify({
  domain: "NimClaim/claim/v1",
  network: "testnet",
  origin,
  nonce: "synthetic",
});

function installHost() {
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;

  globalThis.window = {
    nimiqPay: { network: "testnet" },
  } as unknown as Window & typeof globalThis;

  globalThis.location = { origin } as Location;

  return () => {
    globalThis.window = previousWindow;
    globalThis.location = previousLocation;
  };
}

function fakeProvider(
  initialAccounts: string[],
  onSign?: (
    setAccounts: (accounts: string[], emit?: boolean) => void,
  ) => Promise<{ publicKey: string; signature: string }>,
) {
  const events = new EventEmitter();
  let accounts = [...initialAccounts];
  let signs = 0;
  let cachedAccounts: string[] | undefined;

  const setAccounts = (next: string[], emit = true) => {
    accounts = [...next];
    if (emit) {
      if (cachedAccounts) cachedAccounts = [...accounts];
      events.emit("accountsChanged", [...accounts]);
    }
  };

  const provider = Object.assign(events, {
    disconnect() {
      cachedAccounts = undefined;
    },
    listAccounts: async () => (cachedAccounts ??= [...accounts]),
    sign: async () => {
      signs++;
      if (onSign) return onSign(setAccounts);
      return { publicKey: "synthetic", signature: "synthetic" };
    },
  });

  return {
    provider: provider as unknown as NimiqProvider,
    setAccounts,
    get signs() {
      return signs;
    },
    listenerCount: () => events.listenerCount("accountsChanged"),
  };
}

test("HTLC replacement does not invalidate a claim signing operation", async () => {
  const restore = installHost();
  const fake = fakeProvider(["wallet-1", "htlc-old"], async (setAccounts) => {
    setAccounts(["wallet-1", "htlc-new"]);
    return { publicKey: "synthetic", signature: "synthetic" };
  });

  try {
    const signed = await signChallenge(
      fake.provider,
      message,
      "testnet",
      "wallet-1",
    );

    assert.equal(signed.publicKey, "synthetic");
    assert.equal(fake.signs, 1);
    assert.equal(fake.listenerCount(), 0);
  } finally {
    restore();
  }
});

test("primary wallet change during signing blocks the stale signature", async () => {
  const restore = installHost();
  const fake = fakeProvider(["wallet-1", "htlc-1"], async (setAccounts) => {
    setAccounts(["wallet-2", "htlc-2"]);
    return { publicKey: "synthetic", signature: "synthetic" };
  });

  try {
    await assert.rejects(
      signChallenge(fake.provider, message, "testnet", "wallet-1"),
      /wallet changed during signing/i,
    );

    assert.equal(fake.signs, 1);
    assert.equal(fake.listenerCount(), 0);
  } finally {
    restore();
  }
});

test("changing away and back during signing still blocks the stale signature", async () => {
  const restore = installHost();
  const fake = fakeProvider(["wallet-1", "htlc-1"], async (setAccounts) => {
    setAccounts(["wallet-2", "htlc-2"]);
    setAccounts(["wallet-1", "htlc-new"]);
    return { publicKey: "synthetic", signature: "synthetic" };
  });

  try {
    await assert.rejects(
      signChallenge(fake.provider, message, "testnet", "wallet-1"),
      /wallet changed during signing/i,
    );

    assert.equal(fake.listenerCount(), 0);
  } finally {
    restore();
  }
});

test("wallet already changed before signing is rejected", async () => {
  const restore = installHost();
  const fake = fakeProvider(["wallet-2", "htlc-2"]);

  try {
    await assert.rejects(
      signChallenge(fake.provider, message, "testnet", "wallet-1"),
      /wallet address changed/i,
    );

    assert.equal(fake.signs, 0);
    assert.equal(fake.listenerCount(), 0);
  } finally {
    restore();
  }
});

test("account watcher reports HTLC updates, empty accounts and cleans up", () => {
  const fake = fakeProvider(["wallet-1", "htlc-1"]);
  const received: Array<{
    walletAddress: string;
    htlcAddress: string | null;
  } | null> = [];

  const stop = watchWalletAccounts(fake.provider, (state) => {
    received.push(
      state
        ? {
            walletAddress: state.walletAddress,
            htlcAddress: state.htlcAddress,
          }
        : null,
    );
  });

  fake.setAccounts(["wallet-1", "htlc-2"]);
  fake.setAccounts([]);

  assert.deepEqual(received, [
    { walletAddress: "wallet-1", htlcAddress: "htlc-2" },
    null,
  ]);

  stop();
  assert.equal(fake.listenerCount(), 0);
});

test("fresh pre-sign read rejects a silently changed wallet behind the SDK cache", async () => {
  const restore = installHost();
  const fake = fakeProvider(["wallet-1", "htlc-1"]);
  try {
    await fake.provider.listAccounts();
    fake.setAccounts(["wallet-2", "htlc-2"], false);
    await assert.rejects(
      signChallenge(fake.provider, message, "testnet", "wallet-1"),
      /wallet address changed/i,
    );
    assert.equal(fake.signs, 0);
    assert.equal(fake.listenerCount(), 0);
  } finally {
    restore();
  }
});

test("fresh post-sign read rejects a silent wallet change without an event", async () => {
  const restore = installHost();
  const fake = fakeProvider(["wallet-1", "htlc-1"], async (setAccounts) => {
    setAccounts(["wallet-2", "htlc-2"], false);
    return { publicKey: "synthetic", signature: "synthetic" };
  });
  try {
    await assert.rejects(
      signChallenge(fake.provider, message, "testnet", "wallet-1"),
      /wallet changed during signing/i,
    );
    assert.equal(fake.signs, 1);
    assert.equal(fake.listenerCount(), 0);
  } finally {
    restore();
  }
});

for (const failure of ["before", "sign", "after"] as const) {
  test(`${failure} rejection fails closed and removes only the signing listener`, async () => {
    const restore = installHost();
    const fake = fakeProvider(["wallet-1", "htlc-1"], async () => {
      if (failure === "sign") throw new Error("Signing rejected");
      return { publicKey: "synthetic", signature: "synthetic" };
    });
    const stop = watchWalletAccounts(fake.provider, () => {});
    const read = fake.provider.listAccounts.bind(fake.provider);
    let reads = 0;
    fake.provider.listAccounts = async () => {
      reads++;
      if (reads === (failure === "before" ? 1 : 2)) {
        throw new Error("Account access rejected");
      }
      return read();
    };
    try {
      await assert.rejects(
        signChallenge(fake.provider, message, "testnet", "wallet-1"),
        /rejected/i,
      );
      assert.equal(fake.signs, failure === "before" ? 0 : 1);
      assert.equal(fake.listenerCount(), 1);
    } finally {
      stop();
      assert.equal(fake.listenerCount(), 0);
      restore();
    }
  });
}

test("MAINNET signing accepts the exact origin and rejects host network changes during the prompt", async () => {
  const restore = installHost();
  const mainnetMessage = JSON.stringify({
    domain: "NimClaim/claim/v1",
    network: "mainnet",
    origin,
  });
  try {
    (window as any).nimiqPay.network = "mainnet";
    const stable = fakeProvider(["wallet-1"]);
    await signChallenge(stable.provider, mainnetMessage, "mainnet", "wallet-1");
    assert.equal(stable.signs, 1);
    const changed = fakeProvider(["wallet-1"], async () => {
      (window as any).nimiqPay.network = "testnet";
      return { publicKey: "synthetic", signature: "synthetic" };
    });
    await assert.rejects(
      signChallenge(changed.provider, mainnetMessage, "mainnet", "wallet-1"),
      /network changed/,
    );
    assert.equal(changed.listenerCount(), 0);
    await assert.rejects(
      signChallenge(stable.provider, mainnetMessage, "mainnet", "wallet-1"),
      /network changed/,
    );
  } finally {
    restore();
  }
});
