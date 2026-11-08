import { test as base, expect } from "@playwright/test";
import { startBrowserServer } from "../browser-server";

// Each test receives a new DB, sessions and rate limiter. Never bypass security
// or reuse a listener/session belonging to another test or the real installation.
export const test = base.extend<{ isolatedApi: void }>({
  isolatedApi: [
    async ({}, use) => {
      const close = await startBrowserServer();
      try {
        await use();
      } finally {
        await close();
      }
    },
    { auto: true },
  ],
});
export { expect };
