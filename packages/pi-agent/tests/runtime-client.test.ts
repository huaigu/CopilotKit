import { createServer, type Server } from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpAgent,
  EventType,
  type Message,
  type BaseEvent,
} from "@ag-ui/client";
import { CopilotKitCore, ProxiedCopilotRuntimeAgent } from "@copilotkit/core";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { Type } from "typebox";
import {
  PiAgent,
  PiSessionStore,
  type PiSessionStoreOptions,
} from "../src/index.js";
import { PiAgentRunner } from "../src/pi-agent-runner.js";
import { fixtureModel, scriptedStream } from "./fixture.js";

process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "copilotkit-pi-http-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** Real HTTP transport and published Runtime, not a direct adapter invocation. */
async function host(
  root: string,
  streamFn: StreamFn,
  options: Partial<PiSessionStoreOptions> = {},
) {
  const store = new PiSessionStore({
    cwd: root,
    sessionDir: join(root, "sessions"),
    model: fixtureModel,
    apiKey: "deterministic-fixture-key",
    streamFn,
    frontendToolTimeoutMs: 5_000,
    ...options,
  });
  const runtime = new CopilotRuntime({
    agents: { pi: new PiAgent({ store, agentId: "pi" }) },
    runner: new PiAgentRunner({ store, agentId: "pi" }),
  });
  const server = createServer(
    createCopilotNodeListener({
      runtime,
      basePath: "/api/copilotkit",
      activateChannels: false,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected an HTTP address");
  const baseUrl = `http://127.0.0.1:${address.port}/api/copilotkit`;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await store.dispose();
    await close(server);
  };
  cleanups.push(dispose);
  return {
    store,
    baseUrl,
    dispose,
    client: (threadId: string = randomUUID(), messages: Message[] = []) =>
      new HttpAgent({
        agentId: "pi",
        threadId,
        initialMessages: messages,
        url: `${baseUrl}/agent/pi/run`,
      }),
  };
}

function user(content: string): Message {
  return { id: randomUUID(), role: "user", content };
}

const frontendTool = {
  name: "confirm_goal",
  description: "Ask the browser to confirm a proposed goal.",
  parameters: {
    type: "object",
    properties: { goal: { type: "integer" } },
    required: ["goal"],
    additionalProperties: false,
  },
};

describe("Pi through the CopilotKit Runtime and HTTP clients", () => {
  it("streams Chinese and English over HTTP and preserves multi-turn context through request clones", async () => {
    const contexts: Parameters<StreamFn>[1][] = [];
    const app = await host(
      await workspace(),
      scriptedStream((context, index) => {
        contexts.push(structuredClone(context));
        return index === 0 ? "你好，Brian。" : "Hello again, Brian.";
      }),
    );
    const client = app.client();
    const events: BaseEvent[] = [];
    client.addMessage(user("我叫 Brian。"));
    await client.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );
    client.addMessage(user("What is my name?"));
    await client.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );

    expect(
      events.filter((event) => event.type === EventType.RUN_ERROR),
    ).toEqual([]);
    expect(
      events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(2);
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(
      client.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual(["你好，Brian。", "Hello again, Brian."]);
    expect(client.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(contexts[1])).toContain("我叫 Brian。");
    const history = await app.store.history(client.threadId!);
    expect(
      history.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
  });

  it.each([true, false])(
    "automatically resumes the same Pi task after browser confirmation approved=%s",
    async (approved) => {
      const requests: Parameters<StreamFn>[1][] = [];
      const app = await host(
        await workspace(),
        scriptedStream((context, index) => {
          requests.push(structuredClone(context));
          return index === 0
            ? {
                tools: [
                  {
                    id: "confirm-1",
                    name: "confirm_goal",
                    arguments: { goal: 7 },
                  },
                ],
              }
            : approved
              ? "Goal 7 was approved."
              : "The goal was declined.";
        }),
      );
      const client = app.client();
      const core = new CopilotKitCore({
        agents__unsafe_dev_only: { pi: client },
      });
      let goal = 0;
      const handler = vi.fn(async ({ goal: proposed }: { goal: number }) => {
        if (approved) goal = proposed;
        return { approved, goal };
      });
      core.addTool({
        name: frontendTool.name,
        description: frontendTool.description,
        parameters: z.object({ goal: z.number().int() }),
        type: "human-in-the-loop",
        handler,
        followUp: true,
      });
      client.addMessage(user("Set my goal to 7 after asking me to confirm."));

      await core.runAgent({ agent: client });

      expect(handler).toHaveBeenCalledOnce();
      expect(goal).toBe(approved ? 7 : 0);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain("confirm-1");
      expect(JSON.stringify(requests[1])).toContain(
        `\\"approved\\":${approved}`,
      );
      expect(
        client.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      expect(
        client.messages.filter(
          (message) =>
            message.role === "tool" && message.toolCallId === "confirm-1",
        ),
      ).toHaveLength(1);
      expect(client.messages.at(-1)?.content).toBe(
        approved ? "Goal 7 was approved." : "The goal was declined.",
      );
    },
  );

  it("resumes browser tools in a sequential Pi tool batch without exposing later calls early", async () => {
    const requests: Parameters<StreamFn>[1][] = [];
    const backend = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Backend ready" }],
      details: {},
    }));
    const app = await host(
      await workspace(),
      scriptedStream((context, index) => {
        requests.push(structuredClone(context));
        return index === 0
          ? {
              tools: [
                { id: "ordered-backend", name: "prepare_goal", arguments: {} },
                {
                  id: "ordered-browser-1",
                  name: "confirm_goal",
                  arguments: { goal: 7 },
                },
                {
                  id: "ordered-browser-2",
                  name: "confirm_goal",
                  arguments: { goal: 8 },
                },
              ],
            }
          : "Both browser steps completed in Pi order.";
      }),
      {
        tools: [
          {
            name: "prepare_goal",
            label: "Prepare goal",
            description: "Prepare the workflow before browser confirmation.",
            parameters: Type.Object({}),
            executionMode: "sequential",
            execute: backend,
          },
        ],
      },
    );
    const client = app.client();
    const core = new CopilotKitCore({
      agents__unsafe_dev_only: { pi: client },
    });
    const goals: number[] = [];
    const approve = vi.fn(async ({ goal }: { goal: number }) => {
      expect(
        (await app.store.history(client.threadId!)).pending.map(
          (call) => call.args,
        ),
      ).toEqual([{ goal }]);
      goals.push(goal);
      return { approved: true, goal };
    });
    core.addTool({
      name: frontendTool.name,
      description: frontendTool.description,
      parameters: z.object({ goal: z.number().int() }),
      type: "human-in-the-loop",
      handler: approve,
      followUp: true,
    });
    client.addMessage(user("Prepare, then confirm goals 7 and 8 in order."));
    await core.runAgent({ agent: client });
    expect(backend).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledTimes(2);
    expect(goals).toEqual([7, 8]);
    expect(requests).toHaveLength(2);
    expect(client.messages.at(-1)?.content).toBe(
      "Both browser steps completed in Pi order.",
    );
    expect((await app.store.history(client.threadId!)).pending).toEqual([]);
  });

  it("closes browser calls not reached by a stopped sequential Pi batch", async () => {
    const app = await host(
      await workspace(),
      scriptedStream([
        {
          tools: [
            { id: "stop-backend", name: "prepare_goal", arguments: {} },
            {
              id: "stop-browser-1",
              name: "confirm_goal",
              arguments: { goal: 7 },
            },
            {
              id: "stop-browser-2",
              name: "confirm_goal",
              arguments: { goal: 8 },
            },
          ],
        },
      ]),
      {
        tools: [
          {
            name: "prepare_goal",
            label: "Prepare goal",
            description: "Prepare a sequential workflow.",
            parameters: Type.Object({}),
            executionMode: "sequential",
            execute: async () => ({
              content: [{ type: "text", text: "Ready" }],
              details: {},
            }),
          },
        ],
      },
    );
    const initial = app.client();
    initial.addMessage(user("Prepare, then confirm two goals."));
    await initial.runAgent({ tools: [frontendTool] });
    const waiting = await app.store.history(initial.threadId!);
    expect(waiting.pending.map((call) => call.id)).toEqual(["stop-browser-1"]);
    expect(
      waiting.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.toolCalls?.some((call) => call.id === "stop-browser-2"),
      ),
    ).toBe(false);
    await app.store.abort(initial.threadId!);
    const history = await app.store.history(initial.threadId!);
    expect(history.running).toBe(false);
    expect(history.pending).toEqual([]);
    expect(
      history.messages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "stop-browser-2",
      )?.content,
    ).toContain('"interrupted":true');
    const restored = new ProxiedCopilotRuntimeAgent({
      agentId: "pi",
      threadId: initial.threadId!,
      runtimeUrl: app.baseUrl,
      transport: "rest",
      initialMessages: history.messages,
    });
    const core = new CopilotKitCore({
      agents__unsafe_dev_only: { pi: restored },
    });
    const approval = vi.fn(async () => ({ approved: true }));
    core.addTool({
      name: frontendTool.name,
      description: frontendTool.description,
      parameters: z.object({ goal: z.number().int() }),
      type: "human-in-the-loop",
      handler: approval,
      followUp: true,
    });
    await core.connectAgent({ agent: restored });
    expect(approval).not.toHaveBeenCalled();
  });

  it("rejects a tool result from another thread and makes an identical result replay a no-op", async () => {
    const requests: Parameters<StreamFn>[1][] = [];
    const app = await host(
      await workspace(),
      scriptedStream((context, index) => {
        requests.push(structuredClone(context));
        return index === 0
          ? {
              tools: [
                {
                  id: "browser-1",
                  name: "confirm_goal",
                  arguments: { goal: 4 },
                },
              ],
            }
          : "Confirmed once.";
      }),
    );
    const client = app.client();
    client.addMessage(user("Set goal 4."));
    await client.runAgent({ tools: [frontendTool] });
    const toolResult: Message = {
      id: randomUUID(),
      role: "tool",
      toolCallId: "browser-1",
      content: '{"approved":true}',
    };
    const foreign = app.client(randomUUID(), [toolResult]);
    const foreignErrors: BaseEvent[] = [];
    await foreign.runAgent(
      { tools: [frontendTool] },
      {
        onEvent: ({ event }) => {
          foreignErrors.push(event);
        },
      },
    );
    expect(
      foreignErrors.some((event) => event.type === EventType.RUN_ERROR),
    ).toBe(true);
    expect(requests).toHaveLength(1);

    client.addMessage(toolResult);
    await client.runAgent({ tools: [frontendTool] });
    expect(requests).toHaveLength(2);
    expect(client.messages.at(-1)?.content).toBe("Confirmed once.");
    await client.runAgent({ tools: [frontendTool] });
    expect(requests).toHaveLength(2);
    const history = await app.store.history(client.threadId!);
    expect(
      history.messages.filter(
        (message) =>
          message.role === "tool" && message.toolCallId === "browser-1",
      ),
    ).toHaveLength(1);
  });

  it("restores completed Pi history in a new host with a fresh HTTP client", async () => {
    const root = await workspace();
    const first = await host(root, scriptedStream(["Your project is Pangu."]));
    const initial = first.client();
    initial.addMessage(user("Remember that my project is Pangu."));
    await initial.runAgent({});
    const threadId = initial.threadId!;
    await first.dispose();

    const resumedContexts: Parameters<StreamFn>[1][] = [];
    const second = await host(
      root,
      scriptedStream((context) => {
        resumedContexts.push(structuredClone(context));
        return "The project is Pangu.";
      }),
    );
    const restored = second.client(threadId, [
      user("What is my project called?"),
    ]);
    await restored.runAgent({});

    expect(resumedContexts).toHaveLength(1);
    expect(JSON.stringify(resumedContexts[0])).toContain(
      "Remember that my project is Pangu.",
    );
    const history = await second.store.history(threadId);
    expect(
      history.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
    expect(history.messages.at(-1)?.content).toBe("The project is Pangu.");
  });

  it("cancels a parked browser-tool promise and accepts a later task on the same thread", async () => {
    const requests: Parameters<StreamFn>[1][] = [];
    const app = await host(
      await workspace(),
      scriptedStream((context, index) => {
        requests.push(structuredClone(context));
        return index === 0
          ? {
              tools: [
                {
                  id: "waiting-1",
                  name: "confirm_goal",
                  arguments: { goal: 12 },
                },
              ],
            }
          : "A fresh task completed.";
      }),
    );
    const client = app.client();
    client.addMessage(user("Ask for confirmation before setting goal 12."));
    await client.runAgent({ tools: [frontendTool] });
    expect((await app.store.history(client.threadId!)).pending).toHaveLength(1);

    // Runtime's transmission already finished at this handoff. The application
    // must explicitly cancel the store's waiting task rather than just close SSE.
    await app.store.abort(client.threadId!);
    expect((await app.store.history(client.threadId!)).pending).toEqual([]);
    expect(requests).toHaveLength(1);

    client.addMessage(user("Start a fresh task."));
    const resumedEvents: BaseEvent[] = [];
    await client.runAgent(
      { tools: [frontendTool] },
      {
        onEvent: ({ event }) => {
          resumedEvents.push(event);
        },
      },
    );
    expect(
      resumedEvents.filter((event) => event.type === EventType.RUN_ERROR),
    ).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(client.messages.at(-1)?.content).toBe("A fresh task completed.");
  });

  it("stops an active Pi stream through the standard Runtime HTTP stop endpoint", async () => {
    const aborted = vi.fn();
    const streamFn: StreamFn = (model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Working…" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "aborted",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const abort = () => {
        aborted();
        message.errorMessage = "Cancelled by test";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      };
      if (options?.signal?.aborted) abort();
      else {
        options?.signal?.addEventListener("abort", abort, { once: true });
        queueMicrotask(() => {
          stream.push({ type: "start", partial: structuredClone(message) });
          stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: structuredClone(message),
          });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "Working…",
            partial: structuredClone(message),
          });
        });
      }
      return stream;
    };
    const app = await host(await workspace(), streamFn);
    const client = app.client();
    client.addMessage(user("Run until I stop you."));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const events: BaseEvent[] = [];
    const running = client.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          events.push(event);
          if (event.type === EventType.TEXT_MESSAGE_CONTENT) markStarted();
        },
      },
    );
    await started;
    const response = await fetch(
      `${app.baseUrl}/agent/pi/stop/${client.threadId}`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stopped: true });
    await running;
    expect(aborted).toHaveBeenCalledOnce();
    expect(
      events.filter(
        (event) =>
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR,
      ),
    ).toHaveLength(1);
    expect((await app.store.history(client.threadId!)).running).toBe(false);
  });
  it("reconnects cancelled confirmation history without reviving a browser tool", async () => {
    const requests: Parameters<StreamFn>[1][] = [];
    const app = await host(
      await workspace(),
      scriptedStream((context, index) => {
        requests.push(structuredClone(context));
        return index === 0
          ? {
              tools: [
                {
                  id: "cancel-on-reload",
                  name: "confirm_goal",
                  arguments: { goal: 12 },
                },
              ],
            }
          : "A fresh task completed.";
      }),
    );
    const initial = app.client();
    initial.addMessage(user("Ask me to confirm goal 12"));
    await initial.runAgent({ tools: [frontendTool] });
    await app.store.abort(initial.threadId!);
    const history = await app.store.history(initial.threadId!);
    const calls = history.messages.flatMap((m) =>
      m.role === "assistant" ? (m.toolCalls ?? []) : [],
    );
    expect(
      calls.every((call) =>
        history.messages.some(
          (m) => m.role === "tool" && m.toolCallId === call.id,
        ),
      ),
    ).toBe(true);
    const restored = new ProxiedCopilotRuntimeAgent({
      agentId: "pi",
      threadId: initial.threadId!,
      runtimeUrl: app.baseUrl,
      transport: "rest",
      initialMessages: history.messages,
    });
    const core = new CopilotKitCore({
      agents__unsafe_dev_only: { pi: restored },
    });
    const approval = vi.fn(async () => ({ approved: true }));
    core.addTool({
      name: frontendTool.name,
      description: frontendTool.description,
      parameters: z.object({ goal: z.number().int() }),
      type: "human-in-the-loop",
      handler: approval,
      followUp: true,
    });
    await core.connectAgent({ agent: restored });
    expect(approval).not.toHaveBeenCalled();
    const restoredCalls = restored.messages.flatMap((m) =>
      m.role === "assistant" ? (m.toolCalls ?? []) : [],
    );
    expect(
      restoredCalls.every((call) =>
        restored.messages.some(
          (m) => m.role === "tool" && m.toolCallId === call.id,
        ),
      ),
    ).toBe(true);
    restored.addMessage(user("Start a fresh task."));
    await core.runAgent({ agent: restored });
    expect(approval).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(restored.messages.at(-1)?.content).toBe("A fresh task completed.");
  });
  it("closes orphan browser calls after process loss without replaying a confirmation", async () => {
    const root = await workspace();
    const first = await host(
      root,
      scriptedStream([
        {
          tools: [
            {
              id: "process-loss-confirm",
              name: "confirm_goal",
              arguments: { goal: 15 },
            },
          ],
        },
      ]),
    );
    const original = first.client();
    original.addMessage(user("Confirm goal 15"));
    await original.runAgent({ tools: [frontendTool] });
    expect(
      (await first.store.history(original.threadId!)).pending,
    ).toHaveLength(1);
    // Capture the actual SDK files while the browser Promise is parked. Restore
    // them after closing the first test host, discarding graceful abort writes,
    // to reproduce the files a lost process leaves behind at the same path.
    const snapshot = await workspace();
    await cp(root, snapshot, { recursive: true });
    await first.dispose();
    await rm(root, { recursive: true, force: true });
    await cp(snapshot, root, { recursive: true });
    const requests: Parameters<StreamFn>[1][] = [];
    const recovered = await host(
      root,
      scriptedStream((context) => {
        requests.push(structuredClone(context));
        return "Recovered with a fresh task.";
      }),
    );
    const history = await recovered.store.history(original.threadId!);
    expect(history.interrupted).toBe(true);
    expect(history.running).toBe(false);
    expect(history.pending).toEqual([]);
    const interrupted = history.messages.find(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "process-loss-confirm",
    );
    expect(interrupted?.content).toContain('"interrupted":true');
    const restored = new ProxiedCopilotRuntimeAgent({
      agentId: "pi",
      threadId: original.threadId!,
      runtimeUrl: recovered.baseUrl,
      transport: "rest",
      initialMessages: history.messages,
    });
    const core = new CopilotKitCore({
      agents__unsafe_dev_only: { pi: restored },
    });
    const approval = vi.fn(async () => ({ approved: true }));
    core.addTool({
      name: frontendTool.name,
      description: frontendTool.description,
      parameters: z.object({ goal: z.number().int() }),
      type: "human-in-the-loop",
      handler: approval,
      followUp: true,
    });
    await core.connectAgent({ agent: restored });
    expect(approval).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(
      restored.messages.some(
        (message) => message.id === interrupted?.id && message.role === "tool",
      ),
    ).toBe(true);
    restored.addMessage(user("Start a fresh task."));
    await core.runAgent({ agent: restored });
    expect(approval).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(restored.messages.at(-1)?.content).toBe(
      "Recovered with a fresh task.",
    );
    const completed = await recovered.store.history(original.threadId!);
    expect(
      completed.messages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "process-loss-confirm",
      )?.id,
    ).toBe(interrupted?.id);
  });
});
