import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 8080);
// E2E_BASE_URL aponta a suíte para um deploy real (ex.: Vercel); sem ela,
// sobe o dev server local em modo staging.
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --mode staging",
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
