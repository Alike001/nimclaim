import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { Hash, PublicKey, Signature } from "@nimiq/core";
export const randomToken = () => randomBytes(32).toString("hex");
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function passwordHash(password: string) {
  const salt = randomToken();
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function checkPassword(password: string, stored: string) {
  const [salt, hex] = stored.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
// Challenges are ASCII JSON, so byte length and JS string length are identical.
// Nimiq's standard signed-message envelope; never accept raw/unprefixed signatures.
export function messageHash(message: string) {
  return Hash.computeSha256(
    new TextEncoder().encode(
      `\x16Nimiq Signed Message:\n${message.length}${message}`,
    ),
  );
}
export function verifyOwner(
  message: string,
  publicKey: string,
  signature: string,
): string | null {
  try {
    if (
      !/^[a-f0-9]{64}$/i.test(publicKey) ||
      !/^[a-f0-9]{128}$/i.test(signature)
    )
      return null;
    const key = new PublicKey(Buffer.from(publicKey, "hex"));
    const sig = Signature.fromHex(signature);
    try {
      if (!key.verify(sig, messageHash(message))) return null;
      const address = key.toAddress();
      try {
        return address.toUserFriendlyAddress();
      } finally {
        address.free();
      }
    } finally {
      sig.free();
      key.free();
    }
  } catch {
    return null;
  }
}
