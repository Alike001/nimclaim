import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { testSigner } from "../helpers";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Organiser password").fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your campaigns" }),
  ).toBeVisible();
}

test("organiser login is accessible after application readiness", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Organiser password")).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
async function invitation(page: Page) {
  await login(page);
  await page.getByRole("button", { name: "＋ Create campaign" }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill(`Browser test ${Date.now()}`);
  await page
    .getByLabel("Description")
    .fill("Synthetic campaign for automated browser verification.");
  await page.getByLabel("Reward amount (NIM)").fill("3.25");
  await page.getByLabel("Available rewards").fill("1");
  const tomorrow = new Date(Date.now() + 86400_000);
  // datetime-local takes wall-clock text; UTC tomorrow is safely in the future in all test zones.
  await page
    .getByLabel("Expiry date and time")
    .fill(tomorrow.toISOString().slice(0, 16));
  await page
    .getByRole("button", { name: "Create campaign", exact: true })
    .click();
  await page.getByRole("button", { name: "Create unique invitation" }).click();
  const url = await page.getByLabel("Save this invitation now.").inputValue();
  expect(url).toMatch(/#claim=[a-f0-9]{64}$/);
  return url;
}
async function injectWallet(
  page: Page,
  mode:
    | "success"
    | "rejected"
    | "legacy"
    | "network"
    | "status-failure"
    | "sign-rejected"
    | "unknown",
) {
  const signer = testSigner(),
    shared = testSigner();
  await page.exposeFunction("nimclaimTestSign", async (message: string) => ({
    publicKey: signer.publicKey,
    signature: signer.sign(message),
  }));
  await page.addInitScript(
    ({ mode, account }) => {
      const win = window as any;
      win.nimiqPay = { network: mode === "network" ? "mainnet" : "testnet" };
      win.nimiq = {
        async listAccounts() {
          if (mode === "rejected") throw { code: 4001, message: "Rejected" };
          if (mode === "legacy")
            return {
              error: { type: "PERMISSION_DENIED", message: "Legacy rejection" },
            };
          if (mode === "unknown")
            throw {
              type: "FUTURE_HOST_ERROR",
              message: "New host error",
              code: 9999,
            };
          return [account];
        },
        async isConsensusEstablished() {
          if (mode === "status-failure") throw new Error("Offline");
          return true;
        },
        async getBlockNumber() {
          if (mode === "status-failure") throw new Error("Offline");
          return 123;
        },
        async sign(message: string) {
          if (mode === "sign-rejected")
            throw { code: 4001, message: "Signing rejected" };
          return win.nimclaimTestSign(message);
        },
      };
    },
    { mode, account: shared.address },
  );
  return signer;
}

test("organiser, synthetic wallet signature, review and recipient status survive reload", async ({
  page,
  context,
}) => {
  if (test.info().project.name === "mobile-chromium")
    await page.setViewportSize({ width: 320, height: 700 });
  await injectWallet(page, "success");
  const url = await invitation(page),
    recipient = await context.newPage();
  if (test.info().project.name === "mobile-chromium")
    await recipient.setViewportSize({ width: 320, height: 700 });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  const signer = await injectWallet(recipient, "success");
  await recipient.goto(url);
  await recipient
    .getByRole("button", { name: "Connect Nimiq Pay", exact: true })
    .click();
  await expect(recipient.getByText("Nimiq Pay connected")).toBeVisible();
  await recipient.getByRole("button", { name: "Sign & submit claim" }).click();
  await expect(
    recipient.getByRole("heading", {
      name: "Your request is with the organiser.",
    }),
  ).toBeVisible();
  await expect(
    recipient.getByText(signer.address, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Approve for payment" }).click();
  await expect(page.locator(".badge.payment-ready")).toBeVisible();
  await page
    .getByRole("button", { name: "Authorize campaign wallet", exact: true })
    .click();
  await expect(
    page.getByText("This campaign is permanently authorized to:"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review native NIM payment", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Payment review" }),
  ).toContainText("Unverifiable with the current SDK");
  await expect(
    page.getByRole("button", { name: "Connect wallet for payment review" }),
  ).toBeDisabled();

  await expect(
    page.getByRole("button", { name: "Approve for payment" }),
  ).toHaveCount(0);
  await recipient.reload();
  await expect(
    recipient.getByRole("heading", { name: "Approved. Awaiting payment." }),
  ).toBeVisible();
  await expect(
    recipient.getByText("No NIM has been transferred through NimClaim."),
  ).toBeVisible();
  expect(
    await recipient.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page: recipient })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await recipient.screenshot({
    path: `test-results/recipient-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("ordinary browser shows wallet unavailable and keeps invitation usable", async ({
  page,
}) => {
  const url = await invitation(page);
  await page.goto(url);
  await page.reload();
  await page
    .getByRole("button", { name: "Connect Nimiq Pay", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Nimiq Pay is unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Connect Nimiq Pay", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Sign & submit claim" }),
  ).toHaveCount(0);
});

for (const mode of [
  "rejected",
  "legacy",
  "network",
  "sign-rejected",
  "unknown",
] as const) {
  test(`SDK ${mode} fails safely and allows retry`, async ({ page }) => {
    const url = await invitation(page);
    await injectWallet(page, mode);
    await page.goto(url);
    await page.reload();
    await page
      .getByRole("button", { name: "Connect Nimiq Pay", exact: true })
      .click();
    if (mode === "sign-rejected")
      await page.getByRole("button", { name: "Sign & submit claim" }).click();
    await expect(page.getByRole("alert")).toContainText(
      mode === "network"
        ? "Network mismatch"
        : mode === "unknown"
          ? "FUTURE_HOST_ERROR"
          : "Request cancelled",
    );
    await expect(
      page.getByRole("heading", {
        name: "Your request is with the organiser.",
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name:
          mode === "sign-rejected"
            ? "Refresh signing request"
            : "Connect Nimiq Pay",
        exact: true,
      }),
    ).toBeEnabled();
  });
}

test("status RPC errors display unavailable without fabricating consensus or block", async ({
  page,
}) => {
  const url = await invitation(page);
  await injectWallet(page, "status-failure");
  await page.goto(url);
  await page.reload();
  await page
    .getByRole("button", { name: "Connect Nimiq Pay", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Consensus: unavailable · Block: unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Sign & submit claim" }),
  ).toBeEnabled();
});

test("invalid invitation presents an accessible error", async ({ page }) => {
  await page.goto("/#claim=broken");
  await expect(
    page.getByRole("heading", { name: "Invalid invitation" }),
  ).toBeVisible();
});
