import { defineConfig, devices } from "@playwright/test";
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
      // The built client has no HMR navigation or shared dev optimizer cache.
      // Build here as well so a direct project invocation cannot test stale JS.
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://localhost:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});
