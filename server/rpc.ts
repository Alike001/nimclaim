import { Address, PublicKey, HashedTimeLockedContract } from "@nimiq/core";
import { z } from "zod";

import type { Network, Intent, Receipt } from "../shared/payments.js";
export type { Network, Intent } from "../shared/payments.js";
export const chain = {
  testnet: {
    id: 5,
    name: "TestAlbatross",
    explorer: "https://test.nimiq.watch",
  },
  mainnet: { id: 24, name: "MainAlbatross", explorer: "https://nimiq.watch" },
} as const;
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export function address(value: string) {
  const parsed = Address.fromString(value);
  try {
    return parsed.toUserFriendlyAddress();
  } finally {
    parsed.free();
  }
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const transaction = z.object({
  hash: hashSchema,
  from: z.string(),
  to: z.string(),
  fromType: integer,
  toType: integer,
  value: integer,
  fee: integer,
  networkId: integer,
  validityStartHeight: integer,
  flags: integer,
  senderData: z.string(),
  recipientData: z.string(),
  blockNumber: integer,
  executionResult: z.boolean(),
  proof: z.string().regex(/^(?:[a-f0-9]{2})+$/i),
});
export interface Rpc {
  call(method: string, params: unknown[]): Promise<unknown>;
}
const READ_METHODS = new Set([
  "getAccountByAddress",
  "getNetworkId",
  "isConsensusEstablished",
  "getBlockNumber",
  "getTransactionByHash",
  "getBlockByNumber",
  "getMacroBlockAfter",
]);
export class HttpRpc implements Rpc {
  constructor(
    private url: string,
    private authorization?: string,
    private timeout = 7000,
  ) {
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      (parsed.protocol !== "https:" &&
        !(
          parsed.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        ))
    )
      throw new Error(
        "RPC_URL must use HTTPS or loopback HTTP, without URL credentials/fragments.",
      );
  }
  async call(method: string, params: unknown[]) {
    if (!READ_METHODS.has(method))
      throw new Error("Only read-only Nimiq RPC methods are allowed.");
    const id = crypto.randomUUID();
    const response = await fetch(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeout),
      headers: {
        "Content-Type": "application/json",
        ...(this.authorization ? { Authorization: this.authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error("Independent RPC is unavailable.");
    const reader = response.body!.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) throw new Error("RPC response too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      result.jsonrpc !== "2.0" ||
      result.id !== id ||
      result.error ||
      !result.result ||
      !Object.hasOwn(result.result, "data")
    )
      throw new Error("Invalid or unsuccessful independent RPC response.");
    return result.result.data as unknown;
  }
}

export class FailoverRpc implements Rpc {
  constructor(private readonly providers: Rpc[]) {
    if (!providers.length)
      throw new Error("At least one read-only Nimiq RPC endpoint is required.");
  }

  async call(method: string, params: unknown[]) {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        const result = await provider.call(method, params);
        if (
          (method === "getTransactionByHash" ||
            method === "getBlockByNumber" ||
            method === "getMacroBlockAfter") &&
          (result === null || result === undefined)
        )
          throw new Error("RPC endpoint has no indexed result for this query.");
        if (method === "isConsensusEstablished" && result !== true)
          throw new Error("RPC endpoint has not established consensus.");
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All configured read-only Nimiq RPC endpoints failed.");
  }
}
export async function verifiedHead(rpc: Rpc, network: Network) {
  if ((await rpc.call("getNetworkId", [])) !== chain[network].name)
    throw new Error("RPC chain mismatch.");
  if ((await rpc.call("isConsensusEstablished", [])) !== true)
    throw new Error("RPC consensus unavailable.");
  return integer.parse(await rpc.call("getBlockNumber", []));
}
// Official nimiq-pay-app/src/lib/index.ts keys, reviewed 2026-11-10.
// Rotation requires a source review; never accept client-configured cosigners.
export const cosignerPublicKeys = {
  testnet: [
    "c1534c708122968212c6709526801d18218ce9303590f2bca473213d99b24aaf",
    "1a0fc4eb1376b604c7df66d098b29bbb2fcfd68ef328ce98ae0f7d19f4f6d456",
  ],
  mainnet: ["91b21f4b100273bd7034f6369c29d1f7ba72dba7de6720ad3cd8b81916218913"],
} as const;
export function publicKeyAddress(hex: string) {
  const key = PublicKey.fromHex(hex);
  try {
    const derived = key.toAddress();
    try {
      return derived.toUserFriendlyAddress();
    } finally {
      derived.free();
    }
  } finally {
    key.free();
  }
}
export function trustedCosigners(network: Network) {
  return cosignerPublicKeys[network].map(publicKeyAddress);
}
const htlcAccount = z.object({
  address: z.string(),
  type: z.literal("htlc"),
  balance: integer,
  sender: z.string(),
  recipient: z.string(),
  timeout: integer,
});
export async function verifyHtlc(
  rpc: Rpc,
  network: Network,
  htlc: string,
  organiser: string,
  amount: number,
  fee: number,
  now: number,
) {
  await verifiedHead(rpc, network);
  const account = htlcAccount.parse(
    await rpc.call("getAccountByAddress", [address(htlc)]),
  );
  if (
    address(account.address) !== address(htlc) ||
    address(account.sender) !== organiser
  )
    throw new Error(
      "HTLC address or owner does not match the authenticated organiser.",
    );
  if (!trustedCosigners(network).includes(address(account.recipient)))
    throw new Error(
      "HTLC recipient is not a trusted Nimiq Pay cosigner for this network.",
    );
  // Albatross HTLC timeout is a Unix timestamp in milliseconds, not a block height.
  if (account.timeout <= now) throw new Error("HTLC has expired.");
  if (
    !Number.isSafeInteger(amount + fee) ||
    amount < 0 ||
    fee < 0 ||
    account.balance < amount + fee
  )
    throw new Error("HTLC balance is insufficient for reward plus fee.");
  return {
    sender: address(htlc),
    organiser,
    htlcRecipient: address(account.recipient),
    htlcTimeout: account.timeout,
  };
}
export type Verification = {
  state: "CONFIRMED" | "FAILED" | "UNKNOWN";
  reason: string;
  receipt?: Receipt;
};
export class EvidenceMismatch extends Error {}
export type BasicTransferExpected = {
  sender: string;
  recipient: string;
  amount: number;
  network: "mainnet";
};

function matchesBasicTransfer(
  tx: z.infer<typeof transaction>,
  expected: BasicTransferExpected,
  hash: string,
) {
  if (
    tx.hash !== hash ||
    tx.fromType !== 0 ||
    tx.toType !== 0 ||
    tx.flags !== 0 ||
    tx.senderData !== "" ||
    tx.recipientData !== "" ||
    tx.networkId !== chain.mainnet.id ||
    address(tx.from) !== address(expected.sender) ||
    address(tx.to) !== address(expected.recipient) ||
    tx.value !== expected.amount ||
    tx.validityStartHeight > tx.blockNumber ||
    tx.blockNumber <= 0
  ) {
    throw new EvidenceMismatch(
      "Transaction does not match the campaign payer, recipient, exact NIM amount and MAINNET network.",
    );
  }
}

/**
 * Verifies a transfer already sent in Nimiq Pay. This function is read-only:
 * it never creates, signs, broadcasts or retries a transaction.
 */
export async function verifyBasicTransfer(
  rpc: Rpc,
  expected: BasicTransferExpected,
  hash: string,
  now: number,
): Promise<Verification> {
  hashSchema.parse(hash);
  try {
    if ((await rpc.call("isConsensusEstablished", [])) !== true)
      return {
        state: "UNKNOWN",
        reason: "The independent MAINNET node has not established consensus.",
      };
    const head = integer.parse(await rpc.call("getBlockNumber", []));
    const headBlock = z
      .object({
        number: integer,
        hash: hashSchema,
        network: z.literal(chain.mainnet.name),
      })
      .passthrough()
      .parse(await rpc.call("getBlockByNumber", [head, false]));
    if (headBlock.number !== head)
      return {
        state: "UNKNOWN",
        reason: "The independent node returned an inconsistent MAINNET head.",
      };

    const tx = transaction.parse(
      await rpc.call("getTransactionByHash", [hash]),
    );
    matchesBasicTransfer(tx, expected, hash);
    if (tx.blockNumber > head)
      return {
        state: "UNKNOWN",
        reason: "Transaction inclusion is ahead of the verified MAINNET head.",
      };

    const blockSchema = z.object({
      number: integer,
      hash: hashSchema,
      network: z.literal(chain.mainnet.name),
      type: z.literal("micro"),
      transactions: z.array(z.unknown()),
    });
    const block = blockSchema.parse(
      await rpc.call("getBlockByNumber", [tx.blockNumber, true]),
    );
    if (block.number !== tx.blockNumber)
      throw new EvidenceMismatch("Transaction block number mismatch.");
    const included = block.transactions.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "hash" in item &&
        item.hash === hash,
    );
    if (!included)
      return {
        state: "UNKNOWN",
        reason: "Transaction is not present in its canonical MAINNET block.",
      };
    const canonical = transaction.parse(included);
    matchesBasicTransfer(canonical, expected, hash);
    if (
      canonical.blockNumber !== tx.blockNumber ||
      canonical.executionResult !== tx.executionResult ||
      canonical.proof !== tx.proof ||
      canonical.validityStartHeight !== tx.validityStartHeight
    )
      return {
        state: "UNKNOWN",
        reason: "RPC transaction evidence changed during verification.",
      };

    const macroNumber = integer.parse(
      await rpc.call("getMacroBlockAfter", [tx.blockNumber]),
    );
    if (macroNumber > head || macroNumber <= tx.blockNumber)
      return {
        state: "UNKNOWN",
        reason: "The macro block needed to establish finality is not available yet.",
      };
    const macro = z
      .object({
        number: integer,
        hash: hashSchema,
        network: z.literal(chain.mainnet.name),
        type: z.literal("macro"),
        justification: z.record(z.string(), z.unknown()),
      })
      .parse(await rpc.call("getBlockByNumber", [macroNumber, false]));
    if (macro.number !== macroNumber || !Object.keys(macro.justification).length)
      return {
        state: "UNKNOWN",
        reason: "MAINNET macro-block finality evidence is unavailable.",
      };

    const finalBlock = blockSchema.parse(
      await rpc.call("getBlockByNumber", [tx.blockNumber, true]),
    );
    const finalTx = transaction.safeParse(
      finalBlock.transactions.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "hash" in item &&
          item.hash === hash,
      ),
    );
    if (
      !finalTx.success ||
      finalTx.data.executionResult !== tx.executionResult ||
      finalTx.data.blockNumber !== tx.blockNumber ||
      finalTx.data.proof !== tx.proof ||
      finalTx.data.validityStartHeight !== tx.validityStartHeight ||
      finalBlock.hash !== block.hash ||
      finalBlock.number !== block.number
    )
      return {
        state: "UNKNOWN",
        reason: "Canonical MAINNET block evidence changed during finality verification.",
      };
    matchesBasicTransfer(finalTx.data, expected, hash);

    if (!tx.executionResult)
      return {
        state: "FAILED",
        reason: "The transaction was finalized but execution failed; no reward was paid.",
      };
    return {
      state: "CONFIRMED",
      reason:
        "Exact external NIM transfer independently verified and finalized. NimClaim did not broadcast or custody funds.",
      receipt: {
        hash,
        blockNumber: tx.blockNumber,
        validityStartHeight: tx.validityStartHeight,
        blockHash: block.hash,
        macroNumber,
        macroHash: macro.hash,
        executionResult: true,
        verifiedAt: now,
        sender: address(tx.from),
        recipient: address(tx.to),
        amount: tx.value,
        fee: tx.fee,
        network: "mainnet",
        source: "external",
      },
    };
  } catch (error) {
    if (error instanceof EvidenceMismatch) throw error;
    return {
      state: "UNKNOWN",
      reason:
        "The transaction is not indexed, does not yet have finality evidence, or the independent MAINNET RPC is unavailable. No payment was recorded.",
    };
  }
}

function matches(
  tx: z.infer<typeof transaction>,
  intent: Intent,
  hash: string,
  organiser: string,
) {
  if (
    tx.fromType !== 2 ||
    tx.toType !== 0 ||
    tx.flags !== 0 ||
    tx.senderData !== "" ||
    tx.recipientData !== "" ||
    tx.hash !== hash ||
    tx.networkId !== chain[intent.network].id ||
    address(tx.from) !== intent.sender ||
    address(tx.to) !== intent.recipient ||
    tx.value !== intent.amount ||
    tx.fee !== intent.fee ||
    tx.validityStartHeight > tx.blockNumber ||
    tx.blockNumber < intent.validity_start_height ||
    tx.blockNumber <= 0
  )
    throw new EvidenceMismatch(
      "Transaction does not match the immutable payment intent.",
    );
  // Decode both identities locally; the independently queried full node verifies
  // the signatures and execution. This is not light-client consensus verification.
  try {
    const proof = HashedTimeLockedContract.proofToPlain(
      Buffer.from(tx.proof, "hex"),
    );
    if (
      proof.type !== "early-resolve" ||
      address(proof.creator) !== organiser ||
      !cosignerPublicKeys[intent.network].some(
        (key) => key === proof.publicKey,
      ) ||
      address(proof.signer) !== publicKeyAddress(proof.publicKey) ||
      proof.pathLength !== 0 ||
      proof.creatorPathLength !== 0 ||
      address(proof.creator) !== publicKeyAddress(proof.creatorPublicKey)
    )
      throw new Error("Invalid HTLC early-resolve proof");
  } catch {
    throw new EvidenceMismatch("Invalid HTLC early-resolve sender proof.");
  }
}
// A hash is only a lookup hint. All receipt fields below come from our configured node.
export async function verifyPayment(
  rpc: Rpc,
  intent: Intent,
  hash: string,
  now: number,
  organiser: string,
): Promise<Verification> {
  hashSchema.parse(hash);
  try {
    const head = await verifiedHead(rpc, intent.network);
    const tx = transaction.parse(
      await rpc.call("getTransactionByHash", [hash]),
    );
    matches(tx, intent, hash, organiser);
    if (tx.blockNumber > head)
      return {
        state: "UNKNOWN",
        reason: "Transaction inclusion is ahead of the verified node head.",
      };
    const blockSchema = z.object({
      number: integer,
      hash: hashSchema,
      network: z.literal(chain[intent.network].name),
      type: z.literal("micro"),
      transactions: z.array(z.unknown()),
    });
    const block = blockSchema.parse(
      await rpc.call("getBlockByNumber", [tx.blockNumber, true]),
    );
    if (block.number !== tx.blockNumber)
      throw new EvidenceMismatch("Transaction block number mismatch.");
    const included = block.transactions.find(
      (t) =>
        typeof t === "object" && t !== null && "hash" in t && t.hash === hash,
    );
    if (!included)
      return {
        state: "UNKNOWN",
        reason: "Transaction is not in the canonical block. Do not retry.",
      };
    const canonical = transaction.parse(included);
    matches(canonical, intent, hash, organiser);
    if (
      canonical.blockNumber !== tx.blockNumber ||
      canonical.executionResult !== tx.executionResult ||
      canonical.proof !== tx.proof ||
      canonical.validityStartHeight !== tx.validityStartHeight
    )
      return {
        state: "UNKNOWN",
        reason: "RPC evidence changed during verification. Do not retry.",
      };
    const macroNumber = integer.parse(
      await rpc.call("getMacroBlockAfter", [tx.blockNumber]),
    );
    if (macroNumber > head || macroNumber <= tx.blockNumber)
      return {
        state: "UNKNOWN",
        reason: "Following macro block is unavailable.",
      };
    const macro = z
      .object({
        number: integer,
        hash: hashSchema,
        network: z.literal(chain[intent.network].name),
        type: z.literal("macro"),
        justification: z.record(z.string(), z.unknown()),
      })
      .parse(await rpc.call("getBlockByNumber", [macroNumber, false]));
    if (
      macro.number !== macroNumber ||
      !Object.keys(macro.justification).length
    )
      return { state: "UNKNOWN", reason: "Finality evidence is unavailable." };
    const finalBlock = blockSchema.parse(
      await rpc.call("getBlockByNumber", [tx.blockNumber, true]),
    );
    const finalTx = transaction.safeParse(
      finalBlock.transactions.find(
        (t) =>
          typeof t === "object" && t !== null && "hash" in t && t.hash === hash,
      ),
    );
    if (
      !finalTx.success ||
      finalTx.data.executionResult !== tx.executionResult ||
      finalTx.data.blockNumber !== tx.blockNumber ||
      finalTx.data.proof !== tx.proof ||
      finalTx.data.validityStartHeight !== tx.validityStartHeight ||
      finalBlock.hash !== block.hash ||
      finalBlock.number !== block.number
    )
      return {
        state: "UNKNOWN",
        reason: "Canonical block changed. Do not retry.",
      };
    matches(finalTx.data, intent, hash, organiser);
    return {
      state: tx.executionResult ? "CONFIRMED" : "FAILED",
      reason: tx.executionResult
        ? "Exact payment independently verified and finalized."
        : "Transaction finalized with execution failure; reward not paid.",
      receipt: {
        hash,
        blockNumber: tx.blockNumber,
        validityStartHeight: tx.validityStartHeight,
        blockHash: block.hash,
        macroNumber,
        macroHash: macro.hash,
        executionResult: tx.executionResult,
        verifiedAt: now,
        sender: intent.sender,
        recipient: intent.recipient,
        amount: intent.amount,
        fee: intent.fee,
        network: intent.network,
      },
    };
  } catch (error) {
    if (error instanceof EvidenceMismatch) throw error;
    return {
      state: "UNKNOWN",
      reason:
        "Independent RPC evidence is missing, invalid, not final, or unavailable. Do not retry.",
    };
  }
}
