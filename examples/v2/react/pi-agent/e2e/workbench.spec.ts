import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function send(page: Page, text: string) {
  const input = page.locator("textarea");
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press("Enter");
}

async function idle(page: Page) {
  await expect(page.locator(".stop-button")).toBeDisabled();
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus)
    await page.screenshot({
      path: testInfo.outputPath("workbench.png"),
      fullPage: true,
    });
});

test.beforeAll(async ({ request }) => {
  const response = await request.get("/api/copilotkit/info", {
    timeout: 120_000,
  });
  expect(response.ok()).toBe(true);
  expect((await response.json()).telemetryDisabled).toBe(true);
});

test.beforeEach(async ({ page }) => {
  // Acceptance runs are local-only, including optional SDK telemetry requests.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
      ? route.continue()
      : route.abort();
  });
  await page.goto("/");
  // The first request compiles the Node API routes as well as the page.
  await expect(page.getByTestId("pi-chat")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".mode")).toContainText("Verification mode");
});

test("streams bilingual conversation and restores its history after reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await send(page, "Remember the project name Orchard.");
  await expect(page.getByTestId("pi-chat")).toContainText("Hello from Pi");
  await idle(page);
  await page.reload();
  await expect(page.getByTestId("pi-chat")).toContainText("Orchard");
  await page.getByRole("combobox").selectOption("zh");
  await send(page, "之前的项目叫什么？");
  await expect(page.getByTestId("pi-chat")).toContainText("此前你提到");
  await idle(page);
  expect(errors).toEqual([]);
});

test("executes a backend tool and uses its real result", async ({ page }) => {
  await page
    .getByRole("button", { name: /Calculate a quote for 4 units/ })
    .click();
  await expect(page.getByTestId("pi-chat")).toContainText("quote_total");
  await expect(page.getByTestId("pi-chat")).toContainText('"total":50');
  await idle(page);
});

test("runs frontend tools and resumes after both decline and approval", async ({
  page,
}) => {
  await page.getByRole("button", { name: /Set the target to 7/ }).click();
  await expect(page.getByTestId("goal-input")).toHaveValue("7");
  await idle(page);
  await page
    .getByRole("button", { name: /Ask me to confirm a target of 9/ })
    .click();
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByTestId("pi-chat")).toContainText(
    "You declined the change",
  );
  await idle(page);
  await expect(page.getByTestId("goal-input")).toHaveValue("7");
  await page
    .getByRole("button", { name: /Ask me to confirm a target of 9/ })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByTestId("goal-input")).toHaveValue("9");
  await expect(page.getByTestId("pi-chat")).toContainText(
    "Updated after your confirmation",
  );
  await idle(page);
});

test("reads shared state and a Skill through actual Pi tools", async ({
  page,
}) => {
  await page.getByTestId("goal-input").fill("42");
  await send(page, "Read the current shared state");
  await expect(page.getByTestId("pi-chat")).toContainText('"goal":42');
  await idle(page);
  await send(page, "Update shared state to 55");
  await expect(page.getByTestId("goal-input")).toHaveValue("55");
  await idle(page);
  await page
    .getByRole("button", { name: /Read and use the greeting Skill/ })
    .click();
  await expect(page.getByTestId("pi-chat")).toContainText("I read the Skill");
  await expect(page.getByTestId("pi-chat")).toContainText(
    "welcome to the Pi workbench",
  );
  await idle(page);
});

test("stops a pending approval and permits a later turn", async ({ page }) => {
  await page
    .getByRole("button", { name: /Ask me to confirm a target of 9/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm", exact: true }),
  ).toBeVisible();
  await page.locator(".stop-button").click();
  await expect(page.getByRole("status")).toContainText("Task stopped");
  await expect(page.getByTestId("goal-input")).toHaveValue("3");
  await page.reload();
  await send(page, "Continue after the cancelled task");
  await expect(page.getByTestId("pi-chat")).toContainText("Hello from Pi");
  await idle(page);
});

test("stops active output and remains usable on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await send(page, "slow streaming please");
  await expect(page.getByTestId("pi-chat")).toContainText("This is a slow");
  await page.locator(".stop-button").click();
  await expect(page.getByRole("status")).toContainText("Task stopped");
  await idle(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
