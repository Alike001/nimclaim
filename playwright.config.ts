import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "npx tsx tests/browser-server.ts",
      url: "http://127.0.0.1:3001/api/config",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev:web",
      url: "http://localhost:5173",
      reuseExistingServer: false,
    },
  ],
});
