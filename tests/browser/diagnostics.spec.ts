import { test, expect } from "@playwright/test";

test("mobile diagnostics reads host and API metadata without requesting accounts, signatures or transfers", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const win = window as any;
    win.nimiqPay = { network: "testnet" };
    win.privateCalls = 0;
    win.nimiq = {
      isConsensusEstablished: async () => true,
      getBlockNumber: async () => 456,
      listAccounts: () => {
        win.privateCalls++;
        throw new Error("Must not request private accounts");
      },
      sign: () => {
        win.privateCalls++;
        throw new Error("Must not sign");
      },
      sendBasicTransaction: () => {
        win.privateCalls++;
        throw new Error("Must not spend");
      },
    };
  });
  await page.goto("/#diagnostics");
  await page
    .getByRole("button", { name: "Refresh wallet diagnostics" })
    .click();
  const panel = page.getByRole("region", {
    name: "Read-only wallet diagnostics",
  });
  await expect(panel).toContainText("MATCH — API and host metadata agree");
  await expect(panel).toContainText("established");
  await expect(panel).toContainText("456");
  expect(await page.evaluate(() => (window as any).privateCalls)).toBe(0);
});
test("diagnostics does not accept host network mismatch as readiness", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const win = window as any;
    win.nimiqPay = { network: "mainnet" };
    win.nimiq = {
      isConsensusEstablished: async () => true,
      getBlockNumber: async () => 1,
    };
  });
  await page.goto("/#diagnostics");
  await page
    .getByRole("button", { name: "Refresh wallet diagnostics" })
    .click();
  await expect(
    page.getByRole("region", { name: "Read-only wallet diagnostics" }),
  ).toContainText("NOT VERIFIED — do not sign a claim");
});
