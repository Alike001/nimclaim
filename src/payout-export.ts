import type { Campaign, Claim } from "./api";

export function getApprovedUnpaidClaims(claims: Claim[]): Claim[] {
  return claims.filter(
    (claim) => claim.status === "payment-ready" && !claim.payment,
  );
}

function canonicalNim(luna: number): string {
  if (!Number.isSafeInteger(luna) || luna < 0) {
    throw new RangeError(
      "Reward amount must be a non-negative safe integer in Luna.",
    );
  }
  const whole = Math.trunc(luna / 100_000);
  const fraction = String(luna % 100_000)
    .padStart(5, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function csvCell(value: string | number): string {
  const raw = String(value);
  const safe = /^[\u0000-\u0020]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildApprovedRewardsCsv(
  campaign: Campaign,
  claims: Claim[],
  network: string,
): string {
  const rows: (string | number)[][] = [
    [
      "Campaign title",
      "Campaign ID",
      "Claim ID",
      "Recipient NIM address",
      "Reward amount (NIM)",
      "Network",
      "Claim status",
      "Settlement status",
      "Approved at (UTC)",
    ],
    ...getApprovedUnpaidClaims(claims).map((claim) => {
      const approvedAt = [...claim.history]
        .reverse()
        .find((event) => event.status === "payment-ready")?.at;
      return [
        campaign.title,
        campaign.id,
        claim.id,
        claim.address,
        canonicalNim(campaign.amount),
        network.toUpperCase(),
        "Approved · unpaid",
        "Not paid by NimClaim",
        approvedAt ? new Date(approvedAt).toISOString() : "",
      ];
    }),
  ];
  return (
    "\uFEFF" +
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}

export function buildPayoutDetails(
  campaign: Campaign,
  claim: Claim,
  network: string,
): string {
  return [
    "NimClaim approved reward handoff",
    `Campaign: ${campaign.title}`,
    `Campaign ID: ${campaign.id}`,
    `Claim reference: ${claim.id}`,
    `Network: ${network.toUpperCase()}`,
    `Recipient NIM address: ${claim.address}`,
    `Reward amount: ${canonicalNim(campaign.amount)} NIM`,
    "Claim status: Approved · unpaid",
    "Settlement status: Not paid or verified by NimClaim",
    "Arrange any transfer separately. This text is not proof of payment.",
  ].join("\n");
}
