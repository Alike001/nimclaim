import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { PublicKey } from "@nimiq/core";
// Synthetic ephemeral Ed25519 keys, never connected to a wallet or funded.
export function testSigner() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("hex");
  const key = PublicKey.fromHex(publicKey),
    addr = key.toAddress();
  const address = addr.toUserFriendlyAddress();
  key.free();
  addr.free();
  return {
    publicKey,
    address,
    sign(message: string) {
      // Independent implementation of the official Nimiq signed-message envelope.
      const bytes = Buffer.from(message, "utf8");
      const envelope = Buffer.concat([
        Buffer.from("\x16Nimiq Signed Message:\n"),
        Buffer.from(String(bytes.length)),
        bytes,
      ]);
      return sign(
        null,
        createHash("sha256").update(envelope).digest(),
        keys.privateKey,
      ).toString("hex");
    },
    rawSign(message: string) {
      return sign(null, Buffer.from(message), keys.privateKey).toString("hex");
    },
  };
}
