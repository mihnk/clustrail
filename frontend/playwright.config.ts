import { defineConfig, devices } from "@playwright/test";

// Runs against the production build served by vite preview. Desktop-mode
// tests fake the Wails transport (e2e/fake-backend.ts); no cluster is needed.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:9246",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite preview --port 9246 --strictPort",
    url: "http://localhost:9246",
    reuseExistingServer: !process.env.CI,
  },
});
