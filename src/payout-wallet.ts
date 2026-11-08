import {
  getHostNetwork,
  NimiqProviderError,
  type NimiqProvider,
} from "@nimiq/mini-app-sdk";
import { api } from "./api";
import type { Intent, Network } from "../shared/payments";

// Must be called only from an explicit organiser action after reviewing the immutable intent.
// Current production backend denies reservation: SDK 0.2.5 cannot commit the selected sender.
export async function submitNativePayment(
  provider: NimiqProvider,
  claimId: string,
  network: Network,
  proof: { challengeId: string; publicKey: string; signature: string },
  request: typeof api = api,
  timeoutMs = 60_000,
) {
  if (getHostNetwork() !== network)
    throw new Error("Wallet network changed. Payment blocked.");
  let reservation: { id: string; permit: string; intent: Intent };
  try {
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
    dispatch.intent.claim_id !== claimId
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
    const hash = await Promise.race([
      provider.sendBasicTransaction({
        recipient: intent.recipient,
        value: intent.amount,
        fee: intent.fee,
        validityStartHeight: intent.validity_start_height,
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
