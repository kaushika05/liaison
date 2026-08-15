import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx src/server/index.ts",
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: "3100",
      PUBLIC_BASE_URL: "http://127.0.0.1:3100",
      PUBLIC_WSS_URL: "ws://127.0.0.1:3100",
      DATABASE_PATH: ":memory:",
      NODE_ENV: "test",
      LLM_MODE: "mock",
      TELEPHONY_MODE: "simulator",
      OWNER_DISPLAY_NAME: "Avery",
      APP_ACCESS_KEY: "",
      SESSION_SECRET: "e2e-session-secret-that-is-long-enough",
      CALL_TOKEN_SECRET: "e2e-call-secret-that-is-long-enough",
      ACTION_LINK_SECRET: "e2e-action-secret-that-is-long-enough",
    },
  },
});
