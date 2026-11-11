import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { testSigner } from "../helpers";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("browser-test-password");
  await page
    .getByRole("button", { name: "Sign in to workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your campaigns" }),
  ).toBeVisible();
}

test("organiser login is accessible after application readiness", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Workspace password")).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("landing makes organiser and contributor paths clear and password visibility accessible", async ({
  page,
}) => {
  await page.goto("/");
  if (test.info().project.name === "mobile-chromium")
    await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator("header .header-access")).toHaveText("Workspace");
  await expect(page.getByText("Contributor?", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/No account or organiser password is needed/),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Set a campaign title, reward commitment, available slots and expiry/,
    ),
  ).toBeVisible();

  const password = page.getByLabel("Workspace password");
  await password.fill("temporary-test-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).toHaveValue("temporary-test-password");
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveValue("temporary-test-password");

  await page.locator("header .header-access").click();
  await expect(
    page.getByRole("heading", { name: "Sign in to manage campaigns" }),
  ).toBeVisible();
  await expect(page.locator(".landing")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
async function invitation(page: Page, staging = false) {
  await login(page);
  const firstCampaignButton = page.getByRole("button", {
    name: "Create your first campaign",
    exact: true,
  });
  if (await firstCampaignButton.isVisible()) {
    await firstCampaignButton.click();
  } else {
    await page
      .getByRole("button", { name: "＋ Create campaign", exact: true })
      .click();
  }
  await page
    .getByLabel("Title", { exact: true })
    .fill(`Browser test ${Date.now()}`);
  await page
    .getByLabel("Description")
    .fill("Synthetic campaign for automated browser verification.");
  await page
    .getByLabel(
      staging ? "Illustrative TESTNET amount (NIM)" : "Reward amount (NIM)",
    )
    .fill("3.25");
  await page
    .getByLabel(staging ? "Available testing slots" : "Available rewards")
    .fill("1");
  await expect(
    page.getByText(
      staging
        ? "TESTNET testing only. This amount is illustrative and non-redeemable. No NIM is held, owed, reserved, transferred or paid. Approval records an organiser review decision only."
        : "No funds are held or sent. The amount is a reward commitment for organiser review.",
      { exact: true },
    ),
  ).toBeVisible();
  const tomorrow = new Date(Date.now() + 86400_000);
  // datetime-local takes wall-clock text; UTC tomorrow is safely in the future in all test zones.
  await page
    .getByLabel("Expiry date and time")
    .fill(tomorrow.toISOString().slice(0, 16));
  await page
    .getByRole("button", { name: "Create campaign", exact: true })
    .click();
  await page.getByRole("button", { name: "Create unique invitation" }).click();
  const invitationField = page.getByLabel(
    "Save your private invitation link before leaving this page.",
  );
  const url = await invitationField.inputValue();
  expect(url).toMatch(/#claim=[a-f0-9]{64}$/);
  if (test.info().project.name === "mobile-chromium") {
    const copyBox = await page
      .getByRole("button", { name: "Copy invitation", exact: true })
      .boundingBox();
    const savedBox = await page
      .getByRole("button", { name: "I have saved this link", exact: true })
      .boundingBox();
    expect(copyBox).not.toBeNull();
    expect(savedBox).not.toBeNull();
    expect(savedBox!.y).toBeGreaterThan(copyBox!.y + copyBox!.height);
  }
  await page
    .getByRole("button", { name: "I have saved this link", exact: true })
    .click();
  await expect(invitationField).toHaveValue(url);
  await expect(page.locator(".link-status")).toHaveText(
    "Saved. Keep this link private. It remains visible until you leave this page.",
  );
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
      const accountListeners = new Set<(accounts: string[]) => void>();

      win.nimiq = {
        disconnect() {},
        on(event: string, listener: (accounts: string[]) => void) {
          if (event === "accountsChanged") {
            accountListeners.add(listener);
          }
          return this;
        },
        removeListener(event: string, listener: (accounts: string[]) => void) {
          if (event === "accountsChanged") {
            accountListeners.delete(listener);
          }
          return this;
        },
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
  await expect(
    recipient.getByText("Your reward commitment", { exact: true }),
  ).toBeVisible();
  await expect(
    recipient.getByText(
      "Subject to organiser approval. Funds have not been reserved or sent.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    recipient.getByText("Illustrative TESTNET amount", { exact: true }),
  ).toHaveCount(0);
  await expect(recipient.locator("footer")).toContainText(
    "Native spending is gated on the server.",
  );
  await recipient
    .getByRole("button", { name: "Connect Nimiq Pay", exact: true })
    .click();
  await expect(recipient.getByText("Nimiq Pay connected")).toBeVisible();
  await expect(
    recipient.getByText("This signature requests 3.25 NIM from this campaign", {
      exact: false,
    }),
  ).toBeVisible();
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
  ).toContainText("HTLC transaction sender");
  await expect(
    page.getByRole("button", { name: "Connect wallet for payment review" }),
  ).toBeDisabled();

  await expect(
    page.getByRole("region", { name: "Payment review" }),
  ).toContainText("Verified independently before reservation");

  // Synthetic review gate only: no server spending setting is changed.
  // A host exposing only the local address must stop before a challenge or transfer.
  let paymentChallenges = 0;
  await page.route("**/api/claims/*/payment/review", async (route) => {
    const response = await route.fetch();
    const review = await response.json();
    await route.fulfill({
      response,
      json: {
        ...review,
        gate: {
          enabled: true,
          senderBindingSupported: false,
          htlcVerificationSupported: true,
          reasons: [],
        },
      },
    });
  });
  await page.route("**/api/claims/*/payment/challenge", async (route) => {
    paymentChallenges++;
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Review native NIM payment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect wallet for payment review" })
    .click();
  await expect(page.getByRole("alert")).toContainText("active remote HTLC");
  expect(paymentChallenges).toBe(0);

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

test("staging presents real test claims as illustrative and approval never promises payment", async ({
  page,
  context,
}) => {
  // Change presentation flags only. Campaigns, invitations, signatures and
  // decisions still use the real isolated API; no claims or receipts are mocked.
  await context.route(
    /\/api\/(?:config|campaigns\/[a-f0-9-]{36})$/,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), staging: true },
      });
    },
  );
  const url = await invitation(page, true);
  const title = await page.locator(".campaign-summary h2").innerText();
  await expect(
    page.getByText("TESTNET testing campaign", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Illustrative TESTNET amount", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Invitations are for claim-workflow testing only.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Authorize campaign wallet",
      exact: true,
    }),
  ).toHaveCount(0);
  const recipient = await context.newPage();
  await injectWallet(recipient, "success");
  await recipient.goto(url);
  await expect(
    recipient.getByText("Illustrative TESTNET amount", { exact: true }),
  ).toBeVisible();
  await expect(
    recipient.getByText("Your reward commitment", { exact: true }),
  ).toHaveCount(0);
  await expect(
    recipient.getByText("Signing verifies wallet ownership only.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    recipient.getByText("does not trigger a payment.", { exact: false }),
  ).toBeVisible();
  await recipient
    .getByRole("button", { name: "Connect Nimiq Pay", exact: true })
    .click();
  await expect(
    recipient.getByText(
      "This signature verifies wallet ownership for claim-workflow testing",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    recipient.getByText("This signature requests", { exact: false }),
  ).toHaveCount(0);
  await recipient.getByRole("button", { name: "Sign & submit claim" }).click();
  await expect(
    recipient.getByRole("heading", {
      name: "Your request is with the organiser.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Approve for payment", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Approve claim", exact: true })
    .click();
  await expect(
    page.getByText("Approved for testing — no payment will be made", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".badge.payment-ready")).toHaveText(
    "Approved for testing",
  );
  await expect(
    page.getByRole("button", {
      name: "Review native NIM payment",
      exact: true,
    }),
  ).toHaveCount(0);
  await recipient.reload();
  await expect(
    recipient.getByRole("heading", {
      name: "Approved for testing — no payment will be made",
      exact: true,
    }),
  ).toBeVisible();
  await expect(recipient.locator(".history")).toContainText(
    "Approved for testing",
  );
  await expect(
    recipient.getByText(/Awaiting payment|Payment-ready · unpaid/),
  ).toHaveCount(0);
  for (const current of [page, recipient]) {
    await expect(current.locator("footer")).toHaveText(
      "TESTNET claim testing only. Native NIM spending is disabled.",
    );
    expect(
      await current.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page
    .getByRole("button", { name: "← All campaigns", exact: true })
    .click();
  await expect(
    page.getByText("NIM · illustrative TESTNET amount", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .click();
  await expect(
    page.getByText("Approved for testing — no payment will be made", {
      exact: true,
    }),
  ).toBeVisible();
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
