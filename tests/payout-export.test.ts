import assert from "node:assert/strict";
import test from "node:test";
import type { Campaign, Claim } from "../src/api";
import {
  buildApprovedRewardsCsv,
  buildPayoutDetails,
  getApprovedUnpaidClaims,
} from "../src/payout-export";

const campaign: Campaign = {
  id: "campaign-123",
  title: "Community contributions",
  description: "Reward verified contributors",
  amount: 1_234_567,
  slots: 3,
  expires: 1_800_000_000_000,
  created: 1_700_000_000_000,
};

const approved: Claim = {
  id: "claim-approved",
  address: "NQ81 9NKY G721 AKNG KFGB 4GGD 1ALG CRVG RE3D",
  status: "payment-ready",
  created: 1_700_000_000_000,
  history: [
    { status: "pending", at: 1_700_000_000_000 },
    { status: "payment-ready", at: 1_700_000_100_000 },
  ],
};

const pending: Claim = {
  id: "claim-pending",
  address: "NQ81 9NKY G721 AKNG KFGB 4GGD 1ALG CRVG RE3D",
  status: "pending",
  created: 1_700_000_000_000,
  history: [{ status: "pending", at: 1_700_000_000_000 }],
};

const recordedPayment: Claim = {
  ...approved,
  id: "claim-with-payment",
  payment: {} as NonNullable<Claim["payment"]>,
};

test("approved handoff includes only approved claims without a payment record", () => {
  assert.deepEqual(
    getApprovedUnpaidClaims([approved, pending, recordedPayment]).map(
      (claim) => claim.id,
    ),
    ["claim-approved"],
  );
});

test("CSV preserves exact NIM precision and labels settlement as unpaid", () => {
  const csv = buildApprovedRewardsCsv(
    campaign,
    [approved, pending],
    "mainnet",
  );
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("12.34567"));
  assert.ok(csv.includes("MAINNET"));
  assert.ok(csv.includes("Approved · unpaid"));
  assert.ok(csv.includes("Not paid by NimClaim"));
  assert.ok(csv.includes("2023-11-14T22:15:00.000Z"));
  assert.ok(!csv.includes("claim-pending"));
});

test("CSV neutralizes spreadsheet formulas in untrusted campaign titles", () => {
  const unsafeCampaign = {
    ...campaign,
    title: '=HYPERLINK("https://example.invalid","open")',
  };
  const csv = buildApprovedRewardsCsv(
    unsafeCampaign,
    [approved],
    "mainnet",
  );
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('""open""'));
});

test("copied settlement details include exact recipient, amount and unpaid warning", () => {
  const details = buildPayoutDetails(campaign, approved, "mainnet");
  assert.ok(details.includes(approved.address));
  assert.ok(details.includes("12.34567 NIM"));
  assert.ok(details.includes("Approved · unpaid"));
  assert.ok(details.includes("not proof of payment"));
});
