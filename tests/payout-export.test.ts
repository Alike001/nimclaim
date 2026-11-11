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


const paid: Claim = {
  ...approved,
  id: "claim-paid",
  payment: {
    id: "payment-paid",
    state: "CONFIRMED",
    reason: "External NIM transfer independently verified.",
    candidateHash: "a".repeat(64),
    explorerUrl: "https://nimiq.watch/#" + "a".repeat(64),
    intent: {
      id: "payment-paid",
      claim_id: "claim-paid",
      campaign_id: campaign.id,
      sender: "NQ81 9NKY G721 AKNG KFGB 4GGD 1ALG CRVG RE3D",
      recipient: approved.address,
      amount: 1_234_567,
      fee: 1000,
      network: "mainnet",
      validity_start_height: 100,
      created: 1_700_000_200_000,
      expires: 1_800_000_000_000,
    },
    receipt: {
      hash: "a".repeat(64),
      blockNumber: 101,
      validityStartHeight: 100,
      blockHash: "b".repeat(64),
      macroNumber: 128,
      macroHash: "c".repeat(64),
      executionResult: true,
      verifiedAt: 1_700_000_200_000,
      sender: "NQ81 9NKY G721 AKNG KFGB 4GGD 1ALG CRVG RE3D",
      recipient: approved.address,
      amount: 1_234_567,
      fee: 1000,
      network: "mainnet",
      source: "external",
    },
    history: [
      {
        state: "CONFIRMED",
        reason: "External NIM transfer independently verified.",
        at: 1_700_000_200_000,
      },
    ],
  },
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
  const csv = buildApprovedRewardsCsv(campaign, [approved, pending], "mainnet");
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("12.34567"));
  assert.ok(csv.includes("MAINNET"));
  assert.ok(csv.includes("Approved · unpaid"));
  assert.ok(csv.includes("No verified payment recorded"));
  assert.ok(csv.includes("2023-11-14T22:15:00.000Z"));
  assert.ok(!csv.includes("claim-pending"));
});


test("approved CSV includes both unpaid rewards and independently verified external payments", () => {
  const csv = buildApprovedRewardsCsv(campaign, [approved, paid], "mainnet");
  assert.ok(csv.includes("Approved · unpaid"));
  assert.ok(csv.includes("Paid · verified on-chain"));
  assert.ok(csv.includes("Verified MAINNET transaction"));
  assert.ok(csv.includes("a".repeat(64)));
  assert.equal(getApprovedUnpaidClaims([approved, paid]).length, 1);
});

test("copied settlement details show the verified transaction for a paid claim", () => {
  const details = buildPayoutDetails(campaign, paid, "mainnet");
  assert.ok(details.includes("Paid · verified on-chain"));
  assert.ok(details.includes("a".repeat(64)));
  assert.ok(details.includes("2023-11-14T22:16:40.000Z"));
});

test("CSV neutralizes spreadsheet formulas in untrusted campaign titles", () => {
  const unsafeCampaign = {
    ...campaign,
    title: '=HYPERLINK("https://example.invalid","open")',
  };
  const csv = buildApprovedRewardsCsv(unsafeCampaign, [approved], "mainnet");
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('""open""'));
});

test("copied settlement details include exact recipient, amount and unpaid warning", () => {
  const details = buildPayoutDetails(campaign, approved, "mainnet");
  assert.ok(details.includes(approved.address));
  assert.ok(details.includes("12.34567 NIM"));
  assert.ok(details.includes("Approved · unpaid"));
  assert.ok(details.includes("No verified payment recorded"));
  assert.ok(details.includes("not proof of payment"));
});
