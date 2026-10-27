# Pi Agent + CopilotKit

An open-source, single-user local example using a real Pi Agent session behind CopilotKit's TypeScript runtime. Pi owns the model/tool loop and durable conversation; CopilotKit renders the chat and executes browser tools. No Python server is needed.

## Run

Use Node.js **22.19+** and the root repository's pnpm version. From the repository root:

```sh
pnpm install
pnpm nx run @copilotkit/pi-agent:build
cp examples/v2/react/pi-agent/.env.example examples/v2/react/pi-agent/.env.local
# Set PI_PROVIDER, PI_MODEL, PI_API_KEY, and optionally PI_BASE_URL.
pnpm nx run pi-agent-example:dev
```

Open <http://127.0.0.1:3010>. The default is a real configured model. API keys remain on the server. The example listens on loopback and is intended for a trusted local operator; add authentication and thread authorization before exposing it to multiple users.

## Verify without a model key

Set `PI_TEST_MODE=true` in `.env.local`, or set the environment variable for the process. This explicitly replaces only the provider's model stream with deterministic fixture events. The actual Pi SDK still runs its agent loop, executes tools, loads the Skill, and persists sessions; CopilotKit still performs frontend tools and human interactions. The page displays **Verification mode**. This mode does not verify a real model's ability to choose tools or follow instructions.

Try each suggested prompt in the right panel. The quote is calculated on the server; target changes run in the browser; a confirmed change waits for a real click before continuing. To verify cancellation, ask `Give me a slow reply` and choose **Stop task**. Modify the target input and ask `Read the current shared state`. Reload the page to restore the same conversation. Start a new conversation to verify thread isolation. Switch the language selector to test Chinese prompts and controls.

## State and history

`localStorage` holds only a thread identifier and the UI language. Pi persists its session under `.pi-data/` (or `PI_SESSION_DIR`). `GET /api/pi/history` projects completed Pi history back to the client; `POST /api/pi/stop` cancels both active runs and a Pi task waiting for a frontend tool result. The latter matters because the AG-UI transport run may already have ended while the user is deciding.

Stopping / losing the process during a pending operation does not promise to resume that operation. Interrupted work is shown explicitly and is never automatically replayed. The example enables the read-only `quote_total` tool, the configured greeting Skill's reader, and the browser tools; it does not enable shell commands or file writes by default.

## Check

```sh
pnpm nx run pi-agent-example:check-types
pnpm nx run pi-agent-example:build
pnpm --dir examples/v2/react/pi-agent exec playwright install chromium
pnpm nx run pi-agent-example:e2e
# Verify an existing production build instead of starting a dev server:
PI_E2E_PRODUCTION=true pnpm nx run pi-agent-example:e2e
```

Browser checks assert that CopilotKit telemetry is disabled and allow only local page requests. They start their own server with `PI_TEST_MODE=true`, use a separate `.next-e2e` cache in dev mode (or the existing `.next` production build), and verify English/Chinese conversations, tools, confirmation, shared state, Skills, history and cancellation. A Chromium installation is required. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing browser in a restricted test environment.

## 中文说明

这是一个本地单用户示例：Pi 负责模型、工具、Skills 与对话持久化，CopilotKit 负责聊天页面和前端交互。启动后可直接验证报价、页面目标值修改、人工确认、共享状态、停止执行以及刷新恢复。

默认使用服务端配置的真实模型。只有显式设置 `PI_TEST_MODE=true` 才使用确定性验证模型；页面会标注验证模式。验证模式仍经过真实 Pi SDK 和工具调用链，但不能替代真实模型彩排。对话保存在当前服务器，浏览器只保存线程编号。此示例不支持多用户权限或多实例部署。
