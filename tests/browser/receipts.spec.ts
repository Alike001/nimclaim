import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { PaymentState, PaymentView } from "../../shared/payments";
import { testSigner } from "../helpers";

// Presentation fixtures only: never presented as actual chain evidence or stored in the app database.
for (const state of [
  "SUBMITTING",
  "UNKNOWN",
  "FAILED",
  "CONFIRMED",
] as PaymentState[]) {
  test(`recipient renders ${state} accurately without implying payment before verified success`, async ({
    page,
  }) => {
    const sender = testSigner().address,
      recipient = testSigner().address,
      now = Date.now();
    const intent = {
      id: "fixture-intent",
      claim_id: "fixture-claim",
      campaign_id: "fixture-campaign",
      sender,
      recipient,
      amount: 1234567,
      fee: 1000,
      network: "testnet" as const,
      validity_start_height: 100,
      created: now,
      expires: now + 60_000,
    };
    const receipt = ["CONFIRMED", "FAILED"].includes(state)
      ? {
          hash: "a".repeat(64),
          blockNumber: 101,
          blockHash: "c".repeat(64),
          macroNumber: 128,
          macroHash: "b".repeat(64),
          executionResult: state === "CONFIRMED",
          verifiedAt: now,
          sender,
          recipient,
          amount: 1234567,
          fee: 1000,
          network: "testnet" as const,
        }
      : null;
    const payment: PaymentView = {
      id: "fixture-attempt",
      intent,
      state,
      reason: "Synthetic UI fixture; no actual transaction.",
      candidateHash: null,
      receipt,
      explorerUrl: receipt ? `https://test.nimiq.watch/#${receipt.hash}` : null,
      history: [{ state, reason: "Synthetic UI fixture", at: now }],
    };
    await page.route("**/api/config", (route) =>
      route.fulfill({
        json: { network: "testnet", origin: "http://localhost:5173" },
      }),
    );
    await page.route("**/api/invitation", (route) =>
      route.fulfill({
        json: {
          expired: false,
          campaign: {
            id: intent.campaign_id,
            title: "Synthetic receipt rendering",
            description: "Isolated automated UI test",
            amount: intent.amount,
            slots: 1,
            expires: now + 60_000,
            created: now,
          },
          claim: {
            id: intent.claim_id,
            address: recipient,
            status: "payment-ready",
            created: now,
            history: [{ status: "payment-ready", at: now }],
            payment,
          },
        },
      }),
    );
    await page.goto(`/#claim=${"0".repeat(64)}`);
    if (state === "CONFIRMED") {
      await expect(
        page.getByRole("heading", { name: "Your reward is paid." }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Paid · independently verified" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: "View testnet transaction in explorer",
        }),
      ).toHaveAttribute("href", payment.explorerUrl!);
      await expect(
        page.getByText("Funds have not been reserved or sent.", {
          exact: false,
        }),
      ).toHaveCount(0);
    } else {
      await expect(
        page.getByRole("heading", { name: "Your reward is paid." }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Payment-ready · unpaid", { exact: true }),
      ).toHaveCount(1); // Approval history only, not the current-status badge.
      await expect(page.locator(".badge.payment-ready")).toHaveCount(0);
      if (state === "UNKNOWN")
        await expect(
          page.getByRole("heading", {
            name: "Payment outcome unknown · do not retry",
          }),
        ).toBeVisible();
      if (state === "FAILED")
        await expect(
          page.getByRole("heading", { name: "Failed · reward unpaid" }),
        ).toBeVisible();
    }
    if (state === "CONFIRMED")
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
