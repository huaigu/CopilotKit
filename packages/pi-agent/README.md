# Pi Agent for CopilotKit

A private, server-side AG-UI adapter for Pi Coding Agent. Pi runs the model/tool loop, Skills and context compaction. CopilotKit supplies the chat surface, browser tools and shared page state. Node.js **22.19+** is required. There is no Python or FastAPI service.

## Setup

From the repository root:

```sh
pnpm install
pnpm nx run @copilotkit/pi-agent:build
pnpm nx run @copilotkit/pi-agent:check-types
pnpm nx run @copilotkit/pi-agent:test
```

The adapter pins Pi `1.4.0` and AG-UI `1.0.2`. It is private and is not published to npm. The runnable application is [the Pi React example](../../examples/v2/react/pi-agent/README.md).

```ts
import { PiAgent, PiSessionStore } from "@copilotkit/pi-agent";
import { PiAgentRunner } from "@copilotkit/pi-agent/runtime";
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";

const store = new PiSessionStore({
  cwd: "/absolute/path/to/workspace",
  sessionDir: "/absolute/path/to/session-data",
  provider: "openai",
  modelId: "gpt-5.2",
  apiKey: process.env.PI_API_KEY,
  skillPaths: ["/absolute/path/to/approved-skills"],
});
const runtime = new CopilotRuntime({
  agents: { pi: new PiAgent({ store, agentId: "pi" }) },
  runner: new PiAgentRunner({ store, agentId: "pi" }),
});
export const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
});
```

Use `<CopilotKitProvider runtimeUrl="/api/copilotkit" agent="pi" useSingleEndpoint={false}>` on the frontend. All imports of this package belong in server code. Pi's filesystem/model dependencies must not enter browser bundles.

## Configuration

`cwd` and `sessionDir` are required, absolute paths are recommended. Other options:

| Option                  | Behavior                                                                          |
| ----------------------- | --------------------------------------------------------------------------------- |
| `provider`, `modelId`   | Select a model in Pi's catalog; defaults are `openai` / `gpt-4.1-mini`            |
| `model`                 | Supply a complete Pi model descriptor, including a custom provider/model          |
| `apiKey`, `baseUrl`     | Server-owned credentials and compatible endpoint override; never browser input    |
| `tools`                 | Pi `ToolDefinition[]` for backend tools, executed by the actual Pi agent loop     |
| `builtinTools`          | Explicit builtin tool names; defaults to none, or `read` when `skillPaths` is set |
| `skillPaths`            | Additional approved Skill directories loaded by Pi's `DefaultResourceLoader`      |
| `systemPrompt`          | Server-provided Pi system prompt                                                  |
| `frontendToolTimeoutMs` | Browser tool result wait, defaults to 300000 ms                                   |
| `idleMs`                | Idle session eviction, defaults to 1800000 ms; persisted history remains          |
| `streamFn`              | Optional provider stream injection, used by deterministic SDK integration tests   |

The adapter creates an isolated Pi configuration directory under `sessionDir`. It does not read the host's personal Pi settings/auth or load arbitrary executable extensions. `DefaultResourceLoader` loads Skills from the configured workspace and explicit Skill paths; context files, prompt templates and executable extensions are disabled. Supply `apiKey` explicitly for a known, reproducible credential source.

Backend tools and frontend tools must have unique names. `pi_get_state` and `pi_update_state` are reserved backend tools. The former reads the state supplied with each request; the latter replaces it with a JSON object and emits `STATE_SNAPSHOT`.

A working directory is not a sandbox. If file, shell or write tools are enabled, they execute with the Node host's permissions. The example enables a harmless calculation and a read tool for its checked-in Skill. The application is a local single-user example; a multi-user deployment must assign trusted `scope` values and authorize run/history/stop access itself.

## Browser tools and cancellation

Declare tools using CopilotKit's normal frontend tools / human-in-the-loop APIs. Their object-root JSON Schemas are admitted before starting Pi. Primitive, object and array properties are supported; unsupported schema keywords such as `$ref` and schema composition are rejected explicitly.

Pi's backend tool Promise remains parked while an AG-UI run finishes its handoff to the browser. CopilotKit executes the frontend tool, then its next request supplies a tool result. The adapter checks the thread and call ID, resolves the parked Promise and resumes the same Pi prompt. No extra user prompt is created. Identical result replay is a no-op; conflicting or foreign results are rejected.

```ts
await store.abort(threadId, scope); // default scope: "local"
const { messages, state, running, pending, interrupted } = await store.history(
  threadId,
  scope,
);
await store.dispose(); // shutdown: abort tasks, release subscriptions and sessions
```

During a normal active run, `PiAgent.abortRun()` reaches Pi cancellation. While waiting for browser confirmation, the Runtime's HTTP run has already finished, so wire the application stop control to a server endpoint calling `store.abort()` as well. The example demonstrates this. Finishing a normal transport handoff does not cancel Pi.

## History and lifecycle

Use the optional `@copilotkit/pi-agent/runtime` entry when hosting Pi in CopilotRuntime. `PiAgentRunner` extends the standard in-memory runner for execution and active connections. On reconnect to a settled thread it emits the authoritative Pi history and state, including cancellation results. This prevents an older in-memory browser-tool handoff replay from reopening a confirmation after it was stopped. Its Runtime peer is pinned to `1.81.0`; the base adapter entry remains independent of Runtime.

One trusted scope/thread pair owns one Pi session. Ordinary runs accept one new text user message. Input IDs are deduplicated, previously completed browser history is not re-imported, and Pi controls its own model-context compaction.

Pi's JSONL session is the durable conversation source. A small adapter metadata file preserves client IDs, state and frontend result receipts. Completed history survives a single-instance restart; `history()` projects it into AG-UI messages. An unfinished operation after process loss is marked interrupted; the adapter does not automatically replay side effects or restore a JavaScript Promise from a previous process. Orphaned tool calls receive stable, explicit interrupted results in the UI projection, so browser confirmation controls do not reopen after process loss. Those receipts are adapter metadata; they do not fabricate a successful tool execution or modify Pi's native transcript. A subsequent new user message can start a new task.

Idle sessions are evicted without deleting their history. Live tasks and browser waits are not evicted. `pruneIdle()` is exposed for explicit host lifecycle management, and the store's unreferenced timer also performs idle cleanup. Call `dispose()` on shutdown.

## Verification and limits

The test suite uses **the actual Pi SDK**, a deterministic provider stream, real backend tools, AG-UI event handling and CopilotKit's Runtime / HTTP client / Core frontend-tool continuation. It covers Chinese/English multi-turn conversations, tool results, confirmation acceptance/rejection, cancellation, thread separation, shared state, Skill loading/reading, stable message IDs and completed-session restart recovery.

A deterministic provider does not verify a live LLM or model quality. Real-provider acceptance needs a current server API key; the example README describes live and deterministic modes separately. This first integration supports text conversations, JSON browser tool results and simple shared state. Multi-instance storage, Edge runtimes, media attachments and complete plugin/MCP management are outside its scope.

## 中文说明

Pi 负责真实的模型、工具和 Skills 执行，CopilotKit 负责对话与页面交互。前端工具或人工确认会暂停同一轮 Pi 任务，浏览器返回结果后继续执行。服务端重启可恢复已完成对话；未完成任务显示中断，不自动重放写操作。请从 React 示例启动，真实模型验证需要服务端配置的 API key。
