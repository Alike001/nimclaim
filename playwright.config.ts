import { defineConfig, devices } from "@playwright/test";
const apiPort = Number(process.env.NIMCLAIM_TEST_API_PORT ?? 3001);
const webPort = Number(process.env.NIMCLAIM_TEST_WEB_PORT ?? 5173);
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://localhost:${webPort}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "npx tsx tests/browser-server.ts",
      url: `http://127.0.0.1:${apiPort}/api/config`,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev:web",
      url: `http://localhost:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});
