import type { PaymentView } from "../shared/payments";
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed.");
  return result;
}
export interface Campaign {
  id: string;
  title: string;
  description: string;
  amount: number;
  slots: number;
  expires: number;
  created: number;
  issued?: number;
  claimed?: number;
}
export interface Claim {
  id: string;
  address: string;
  status: string;
  created: number;
  history: { status: string; at: number }[];
  payment?: PaymentView | null;
}
// Keep integer Luna exact even near Number.MAX_SAFE_INTEGER; do not round a floating NIM value.
export function nim(luna: number) {
  const whole = Math.trunc(luna / 100_000);
  const fraction = String(luna % 100_000)
    .padStart(5, "0")
    .replace(/0+$/, "");
  const decimal =
    new Intl.NumberFormat()
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  return whole.toLocaleString() + (fraction ? decimal + fraction : "");
}
export const date = (time: number) => new Date(time).toLocaleString();
export const statusLabel = (status: string) =>
  ({
    pending: "Awaiting review",
    "payment-ready": "Payment-ready · unpaid",
    rejected: "Rejected",
    expired: "Expired",
    paid: "Paid · verified on-chain",
    failed: "Failed · unpaid",
    submitting: "Submission pending",
    unknown: "Outcome unknown",
  })[status] ?? status;

export const claimStatus = (claim: Claim) =>
  !claim.payment
    ? claim.status
    : claim.payment.state === "CONFIRMED" &&
        claim.payment.receipt?.executionResult === true
      ? "paid"
      : claim.payment.state === "FAILED"
        ? "failed"
        : claim.payment.state === "SUBMITTING"
          ? "submitting"
          : "unknown";
