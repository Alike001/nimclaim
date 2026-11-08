import { Address } from "@nimiq/core";
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
});
export interface Rpc {
  call(method: string, params: unknown[]): Promise<unknown>;
}
const READ_METHODS = new Set([
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
export async function verifiedHead(rpc: Rpc, network: Network) {
  if ((await rpc.call("getNetworkId", [])) !== chain[network].name)
    throw new Error("RPC chain mismatch.");
  if ((await rpc.call("isConsensusEstablished", [])) !== true)
    throw new Error("RPC consensus unavailable.");
  return integer.parse(await rpc.call("getBlockNumber", []));
}
export type Verification = {
  state: "CONFIRMED" | "FAILED" | "UNKNOWN";
  reason: string;
  receipt?: Receipt;
};
export class EvidenceMismatch extends Error {}
function matches(
  tx: z.infer<typeof transaction>,
  intent: Intent,
  hash: string,
) {
  if (
    tx.fromType !== 0 ||
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
    tx.validityStartHeight !== intent.validity_start_height ||
    tx.blockNumber < intent.validity_start_height ||
    tx.blockNumber <= 0
  )
    throw new EvidenceMismatch(
      "Transaction does not match the immutable payment intent.",
    );
}
// A hash is only a lookup hint. All receipt fields below come from our configured node.
export async function verifyPayment(
  rpc: Rpc,
  intent: Intent,
  hash: string,
  now: number,
): Promise<Verification> {
  hashSchema.parse(hash);
  try {
    const head = await verifiedHead(rpc, intent.network);
    const tx = transaction.parse(
      await rpc.call("getTransactionByHash", [hash]),
    );
    matches(tx, intent, hash);
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
    matches(canonical, intent, hash);
    if (
      canonical.blockNumber !== tx.blockNumber ||
      canonical.executionResult !== tx.executionResult
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
      finalBlock.hash !== block.hash ||
      finalBlock.number !== block.number
    )
      return {
        state: "UNKNOWN",
        reason: "Canonical block changed. Do not retry.",
      };
    matches(finalTx.data, intent, hash);
    return {
      state: tx.executionResult ? "CONFIRMED" : "FAILED",
      reason: tx.executionResult
        ? "Exact payment independently verified and finalized."
        : "Transaction finalized with execution failure; reward not paid.",
      receipt: {
        hash,
        blockNumber: tx.blockNumber,
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
