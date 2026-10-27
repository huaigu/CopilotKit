import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:3010",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote"],
        }
      : undefined,
  },
  webServer: {
    command: "next dev --hostname 127.0.0.1 --port 3010",
    url: "http://127.0.0.1:3010",
    timeout: 300_000,
    stdout: "pipe",
    reuseExistingServer: !process.env.CI,
    env: {
      PI_TEST_MODE: "true",
      PI_SESSION_DIR: ".pi-data-e2e",
      PI_NEXT_DIST_DIR: ".next-e2e",
      NEXT_TELEMETRY_DISABLED: "1",
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
      NODE_OPTIONS: "--max-old-space-size=3072",
    },
  },
});
