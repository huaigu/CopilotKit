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
  await expect(
    page.getByTestId("copilot-assistant-message").last(),
  ).not.toContainText("Earlier you said");
  await page.reload();
  await expect(page.getByTestId("pi-chat")).toContainText("Orchard");
  await page.getByRole("combobox").selectOption("zh");
  await send(page, "之前的项目叫什么？");
  const latestReply = page.getByTestId("copilot-assistant-message").last();
  await expect(latestReply).toContainText("此前你提到");
  await expect(latestReply).toContainText("Orchard");
  await idle(page);
  await expect(latestReply).not.toContainText("Preferred reply language");
  await expect(latestReply).not.toContainText('"description":');
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
  const cancelled = page.getByTestId("confirmation");
  await expect(cancelled).toContainText("Interrupted");
  await expect(cancelled).not.toContainText("Confirmed");
  await expect(cancelled.getByRole("button")).toHaveCount(0);
  await send(page, "Continue after the cancelled task");
  await expect(page.getByTestId("pi-chat")).toContainText("Hello from Pi");
  await idle(page);
});

test("shows interrupted and failed confirmations without claiming approval", async ({
  page,
}) => {
  const threadId = await page.evaluate(() =>
    localStorage.getItem("pi-demo-thread"),
  );
  let result = JSON.stringify({
    interrupted: true,
    error: "The previous task ended before a result was recorded",
  });
  const history = () => ({
    messages: [
      {
        id: "recovered-user",
        role: "user",
        content: "Ask me to confirm a target of 9",
      },
      {
        id: "recovered-assistant",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "recovered-call",
            type: "function",
            function: {
              name: "request_confirmation",
              arguments: JSON.stringify({ message: "Set the target to 9?" }),
            },
          },
        ],
      },
      {
        id: "recovered-result",
        role: "tool",
        toolCallId: "recovered-call",
        content: result,
      },
    ],
    state: { goal: 3 },
    interrupted: true,
    running: false,
    pending: [],
  });
  // Project the same settled recovery events as PiAgentRunner. The real SDK
  // crash-file recovery is exercised separately in the HTTP/Core tests.
  await page.route("**/api/pi/history?**", (route) =>
    route.fulfill({ json: history() }),
  );
  await page.route("**/api/copilotkit/agent/pi/connect", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: [
        { type: "RUN_STARTED", threadId, runId: "recovered-run" },
        { type: "MESSAGES_SNAPSHOT", messages: history().messages },
        { type: "STATE_SNAPSHOT", snapshot: history().state },
        { type: "RUN_FINISHED", threadId, runId: "recovered-run" },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    }),
  );

  for (const [content, english, chinese] of [
    [result, "Interrupted", "已中断"],
    [
      JSON.stringify({ error: "Tool failed", retryable: true }),
      "Confirmation failed",
      "确认未完成",
    ],
  ]) {
    result = content;
    await page.reload();
    await page.getByRole("combobox").selectOption("en");
    const card = page.getByTestId("confirmation");
    await expect(card).toContainText(english);
    await expect(card).not.toContainText("Confirmed");
    await expect(card).not.toContainText("Declined");
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("goal-input")).toHaveValue("3");
    await idle(page);
    await page.getByRole("combobox").selectOption("zh");
    await expect(card).toContainText(chinese);
    await expect(card).not.toContainText("已确认");
    await expect(card).not.toContainText("已拒绝");
  }
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
