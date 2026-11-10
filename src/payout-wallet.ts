import {
  getHostNetwork,
  NimiqProviderError,
  type NimiqProvider,
} from "@nimiq/mini-app-sdk";
import { payoutAccounts, type PayoutAccounts } from "./wallet";
import { api } from "./api";
import type { Intent, Network } from "../shared/payments";

// Once reservation is requested, even a lost response must prevent resubmission
// in this page. The durable server lock protects reloads and other clients.
const submissions = new WeakMap<NimiqProvider, Set<string>>();

// Must be called only from an explicit organiser action after reviewing the immutable intent.
// Native Nimiq Pay uses the active remote HTLC; there is no sender parameter.
export async function submitNativePayment(
  provider: NimiqProvider,
  claimId: string,
  network: Network,
  expectedAccounts: PayoutAccounts,
  proof: { challengeId: string; publicKey: string; signature: string },
  request: typeof api = api,
  timeoutMs = 60_000,
) {
  let claims = submissions.get(provider);
  if (!claims) {
    claims = new Set();
    submissions.set(provider, claims);
  }
  if (claims.has(claimId))
    throw new Error(
      "Payment already requested. Do not retry; reconcile the existing attempt.",
    );
  claims.add(claimId);
  let reservationRequested = false;
  try {
    return await performNativePayment(
      provider,
      claimId,
      network,
      { ...expectedAccounts },
      proof,
      request,
      timeoutMs,
      () => {
        reservationRequested = true;
      },
    );
  } finally {
    // Access rejection before any reservation is safe to review again explicitly.
    if (!reservationRequested) claims.delete(claimId);
  }
}

async function performNativePayment(
  provider: NimiqProvider,
  claimId: string,
  network: Network,
  expectedAccounts: PayoutAccounts,
  proof: { challengeId: string; publicKey: string; signature: string },
  request: typeof api,
  timeoutMs: number,
  reserving: () => void,
) {
  if (getHostNetwork() !== network)
    throw new Error("Wallet network changed. Payment blocked.");
  await payoutAccounts(provider, expectedAccounts);
  if (getHostNetwork() !== network)
    throw new Error("Wallet network changed. Payment blocked.");
  let reservation: { id: string; permit: string; intent: Intent };
  try {
    reserving();
    reservation = await request(`/claims/${claimId}/payment/reserve`, proof);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "Reservation response unavailable."} Do not repeat a payment request. Refresh and reconcile any existing attempt.`,
    );
  }
  // Do not repeat either request after a lost response. The durable reservation remains locked.
  let dispatch: {
    broadcastAllowed: boolean;
    intent: Intent;
    attemptId: string;
  };
  try {
    dispatch = await request(`/payments/${reservation.id}/dispatch`, {
      permit: reservation.permit,
    });
  } catch {
    throw new Error(
      "Broadcast permission response unavailable. Do not retry payment. Refresh and reconcile the reserved attempt.",
    );
  }
  if (
    !dispatch.broadcastAllowed ||
    dispatch.attemptId !== reservation.id ||
    JSON.stringify(dispatch.intent) !== JSON.stringify(reservation.intent)
  )
    throw new Error(
      "Invalid broadcast authorization. Reconcile the reserved attempt.",
    );
  if (
    getHostNetwork() !== network ||
    dispatch.intent.network !== network ||
    dispatch.intent.claim_id !== claimId ||
    dispatch.intent.sender !== expectedAccounts.htlc
  ) {
    await request(`/payments/${reservation.id}/outcome`, {
      outcome: "error",
    }).catch(() => {});
    throw new Error(
      "Network or intent changed. Payment blocked; reconcile the reservation.",
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: {
    outcome: "hash" | "cancelled" | "timeout" | "error";
    hash?: string;
  };
  try {
    const intent = dispatch.intent;
    await payoutAccounts(provider, expectedAccounts);
    if (getHostNetwork() !== network)
      throw new Error("Wallet network changed. Payment blocked.");
    const hash = await Promise.race([
      provider.sendBasicTransaction({
        recipient: intent.recipient,
        value: intent.amount,
        fee: intent.fee,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Payment response timed out")),
          timeoutMs,
        );
      }),
    ]);
    outcome =
      typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)
        ? { outcome: "hash", hash }
        : { outcome: "error" };
  } catch (error) {
    outcome = {
      outcome:
        NimiqProviderError.is(error) && error.type === "PERMISSION_DENIED"
          ? "cancelled"
          : error instanceof Error &&
              error.message === "Payment response timed out"
            ? "timeout"
            : "error",
    };
  } finally {
    clearTimeout(timer);
  }
  // A timeout does not cancel a native wallet prompt. Late results must be reconciled, never resubmitted.
  try {
    await request(`/payments/${reservation.id}/outcome`, outcome);
  } catch {
    throw new Error(
      "Wallet outcome could not be saved. Do not retry payment. Refresh and reconcile the existing attempt.",
    );
  }
  return { id: reservation.id, outcome: outcome.outcome };
}
