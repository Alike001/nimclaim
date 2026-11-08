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
}
export const nim = (luna: number) =>
  (luna / 100_000).toLocaleString(undefined, { maximumFractionDigits: 5 });
export const date = (time: number) => new Date(time).toLocaleString();
export const statusLabel = (status: string) =>
  ({
    pending: "Awaiting review",
    "payment-ready": "Payment-ready · unpaid",
    rejected: "Rejected",
    expired: "Expired",
  })[status] ?? status;
