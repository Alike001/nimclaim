import { test, expect } from "./fixtures";
import { readFile } from "node:fs/promises";
import { testSigner } from "../helpers";
test.use({ network: "mainnet" });

test("MAINNET mobile campaign, organiser signature, recipient claim and unpaid approval", async ({
  page,
}) => {
  // Isolated synthetic browser data. Real PostgreSQL identity/permissions are tested separately.
  const authChallenges = new Map<string, string>();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/challenge") {
      const id = "00000000-0000-4000-8000-000000000001";
      const expires = Date.now() + 300_000;
      const intent = (
        request.postDataJSON() as { intent: "login" | "register" | "link" }
      ).intent;
      const purpose = {
        login: "Sign in to your existing NimClaim organiser workspace",
        register: "Create a new NimClaim organiser workspace",
        link: "Link your previous NimClaim organiser workspace",
      }[intent];
      const message = JSON.stringify({
        domain: "NimClaim/organiser/auth/v1",
        intent,
        purpose:
          purpose + ". This is a signature only; no transaction or payment.",
        origin: url.origin,
        network: "mainnet",
        nonce: "a".repeat(64),
        expires,
      });
      authChallenges.set(id, message);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id, message, expires, network: "mainnet" }),
      });
      return;
    }
    if (url.pathname === "/api/auth/verify") {
      const body = request.postDataJSON() as {
        challengeId: string;
        publicKey: string;
        signature: string;
      };
      const message = authChallenges.get(body.challengeId);
      if (
        !message ||
        body.publicKey !== signer.publicKey ||
        body.signature !== signer.sign(message)
      ) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic wallet proof rejected." }),
        });
        return;
      }
      const loginResponse = await route.fetch({
        url: new URL("/api/login", url.origin).toString(),
        method: "POST",
        postData: JSON.stringify({ password: "browser-test-password" }),
      });
      await route.fulfill({
        response: loginResponse,
        json: {
          authenticated: true,
          organiser: { walletAddress: signer.address, created: Date.now() },
        },
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    if (url.pathname === "/api/config" || (body.campaign && body.paymentGate))
      await route.fulfill({ response, json: { ...body, claimsOnly: true, manualPaymentVerification: false } });
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
    page.getByRole("heading", { name: "Create or open your workspace" }),
  ).toBeVisible();
  await expect(
    page.getByText(/NimClaim confirms wallet ownership with a sign-in message/),
  ).toBeVisible();
  await expect(
    page.getByText(
      "MAINNET payments are sent through Nimiq Pay; NimClaim verifies matching finalized transfers by transaction hash. It never sends or holds NIM.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create a new workspace", exact: true })
    .click();
  await expect(page.locator("header .header-access")).toHaveText("Workspace");
  await expect(page.locator(".wallet-identity")).toContainText(
    "Signed in with Nimiq Pay",
  );
  await expect(page.locator(".wallet-identity code")).toContainText(" … ");
  await expect(page.locator(".wallet-identity code")).toHaveAttribute(
    "title",
    signer.address,
  );
  await page.locator("header .header-access").click();
  await expect(page.locator("#organiser-access")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "＋ Create campaign" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Create your first campaign", exact: true })
    .click();
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
  const invitationField = page.getByLabel(
    "Save your private invitation link before leaving this page.",
  );
  const url = await invitationField.inputValue();
  await page
    .getByRole("button", { name: "I have saved this link", exact: true })
    .click();
  await expect(invitationField).toHaveValue(url);
  await expect(page.locator(".link-status")).toContainText(
    "Saved. Keep this link private.",
  );
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
    page.getByRole("heading", { name: "Approved rewards" }),
  ).toBeVisible();
  await expect(
    page.getByText("1 reward approved", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy settlement details" }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download approved rewards CSV" })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^nimclaim-approved-rewards-/);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("CSV download did not produce a file.");
  const csv = await readFile(downloadPath, "utf8");
  expect(csv).toContain(signer.address);
  expect(csv).toContain("0.12345");
  expect(csv).toContain("Approved · unpaid");
  expect(csv).toContain("No verified payment recorded");
  await expect(
    page.getByText(/Read-only MAINNET verification is not configured/),
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
  await expect(page.locator(".claim-next-step")).toContainText(
    "This screen changes to Paid · verified on-chain only after the sender, recipient, amount and finality checks succeed.",
  );
  await expect(page.locator(".claim-next-step")).toContainText(
    "NimClaim never sends or holds NIM.",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
