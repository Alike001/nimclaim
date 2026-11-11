import { test, expect } from "./fixtures";
import { testSigner } from "../helpers";
test.use({ network: "mainnet" });

test("MAINNET mobile campaign, organiser signature, recipient claim and unpaid approval", async ({
  page,
}) => {
  // Isolated synthetic browser data. Real PostgreSQL identity/permissions are tested separately.
  await page.route("**/api/**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (
      route.request().url().endsWith("/api/config") ||
      (body.campaign && body.paymentGate)
    )
      await route.fulfill({ response, json: { ...body, claimsOnly: true } });
    else await route.fulfill({ response });
  });
  const signer = testSigner();
  await page.exposeFunction("mainnetTestSign", (message: string) => ({
    publicKey: signer.publicKey,
    signature: signer.sign(message),
  }));
  await page.addInitScript(
    ({ address }) => {
      const win = window as any;
      win.nimiqPay = { network: "mainnet" };
      win.nimiq = {
        disconnect() {},
        on() {},
        removeListener() {},
        async listAccounts() {
          return [address];
        },
        async isConsensusEstablished() {
          return true;
        },
        async getBlockNumber() {
          return 123;
        },
        async sign(message: string) {
          return win.mainnetTestSign(message);
        },
        async sendBasicTransaction() {
          throw new Error("Spending must never be invoked");
        },
      };
    },
    { address: signer.address },
  );
  await page.goto("/");
  await expect(page.locator("header .network")).toHaveText("MAINNET");
  await expect(
    page.getByText(
      "Payments are unavailable; approval does not transfer NIM.",
      { exact: false },
    ),
  ).toBeVisible();
  await page.getByLabel("Workspace password").fill("browser-test-password");
  await page
    .getByRole("button", { name: "Sign in to workspace", exact: true })
    .click();
  await expect(page.locator("header .header-access")).toHaveText(
    "Workspace",
  );
  await page.locator("header .header-access").click();
  await expect(page.locator("#organiser-access")).toBeVisible();
  await page.getByRole("button", { name: "＋ Create campaign" }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Synthetic mainnet UI test");
  await page
    .getByLabel("Description")
    .fill("Isolated automated test; no actual NIM transfers.");
  await page.getByLabel("Reward commitment (NIM)").fill("0.12345");
  await page.getByLabel("Available claim slots").fill("1");
  await page
    .getByLabel("Expiry date and time")
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  await page
    .getByRole("button", { name: "Create campaign", exact: true })
    .click();
  await page.getByRole("button", { name: "Authorize campaign wallet" }).click();
  await expect(
    page.getByText("This campaign is permanently authorized to:"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create unique invitation" }).click();
  const url = await page.getByLabel("Save this invitation now.").inputValue();
  await page.goto(url);
  await page
    .getByRole("button", { name: "Connect Nimiq Pay", exact: true })
    .click();
  await expect(
    page.getByText(
      /This signature verifies wallet ownership and submits your claim for organiser review on MAINNET/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/does not request or authorise a NIM transfer/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign & submit claim" }).click();
  await expect(
    page.getByRole("heading", { name: "Your request is with the organiser." }),
  ).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: /Synthetic mainnet UI test/ }).click();
  await page.getByRole("button", { name: "Approve claim" }).click();
  await expect(
    page.getByText("Approved · unpaid", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Review.*payment/i }),
  ).toHaveCount(0);
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Approved · unpaid" }),
  ).toBeVisible();
  await expect(
    page.getByText("No NIM has been transferred through NimClaim."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
