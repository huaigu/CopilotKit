import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { Type } from "typebox";
import {
  PiAgent,
  PiSessionStore,
  type PiSessionStoreOptions,
} from "../src/index.js";
import { fixtureModel, scriptedStream } from "./fixture.js";

const roots: string[] = [];
const stores: PiSessionStore[] = [];
async function make(options: Partial<PiSessionStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-adapter-"));
  roots.push(root);
  const store = new PiSessionStore({
    cwd: root,
    sessionDir: join(root, "sessions"),
    model: fixtureModel,
    apiKey: "fixture-key",
    streamFn: scriptedStream(["Done"]),
    ...options,
  });
  stores.push(store);
  return { store, root };
}
function input(
  text: string,
  threadId: string = randomUUID(),
  id: string = randomUUID(),
): RunAgentInput {
  return {
    threadId,
    runId: randomUUID(),
    messages: [{ id, role: "user", content: text }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}
async function collect(store: PiSessionStore, request: RunAgentInput) {
  const events: BaseEvent[] = [];
  const result = await store.run(request, (e) => events.push(e));
  return { events, result };
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

describe("real Pi SDK session management", () => {
  it("executes backend tools once, projects results and updates shared state", async () => {
    const execute = vi.fn(
      async (_id: string, { quantity }: { quantity: number }) => ({
        content: [{ type: "text" as const, text: String(quantity * 12.5) }],
        details: {},
      }),
    );
    const { store } = await make({
      tools: [
        {
          name: "quote",
          label: "Quote",
          description: "Calculate a quote",
          parameters: Type.Object({ quantity: Type.Number() }),
          execute,
        },
      ],
      streamFn: scriptedStream([
        {
          tools: [{ id: "quote-1", name: "quote", arguments: { quantity: 4 } }],
        },
        {
          tools: [
            {
              id: "state-1",
              name: "pi_update_state",
              arguments: { state: { goal: 8 } },
            },
          ],
        },
        "Quote complete",
      ]),
    });
    const request = input("Quote four items");
    const { events } = await collect(store, request);
    expect(execute).toHaveBeenCalledOnce();
    expect(
      events.some(
        (e) => e.type === "TOOL_CALL_RESULT" && (e as any).content === "50",
      ),
    ).toBe(true);
    expect((await store.history(request.threadId)).state).toEqual({ goal: 8 });
    expect(events.filter((e) => e.type === "RUN_FINISHED")).toHaveLength(1);
    expect(events.filter((e) => e.type === "RUN_ERROR")).toHaveLength(0);
  });
  it("keeps user and assistant IDs stable in snapshots and makes request replay a no-op", async () => {
    const stream = vi.fn(scriptedStream(["Hello"]));
    const { store } = await make({ streamFn: stream });
    const request = input("hello");
    const { events } = await collect(store, request);
    const first = await store.history(request.threadId);
    expect(first.messages[0].id).toBe(request.messages[0].id);
    const streamedId = (
      events.find((e) => e.type === "TEXT_MESSAGE_START") as any
    ).messageId;
    expect(first.messages[1].id).toBe(streamedId);
    await collect(store, { ...request, messages: first.messages });
    expect(stream).toHaveBeenCalledOnce();
    expect((await store.history(request.threadId)).messages).toEqual(
      first.messages,
    );
  });
  it("rejects overlapping ordinary turns without starting a second model request", async () => {
    const stream = vi.fn(
      scriptedStream([
        { tools: [{ id: "wait-1", name: "confirm", arguments: {} }] },
        "continued",
      ]),
    );
    const { store } = await make({ streamFn: stream });
    const request = {
      ...input("Wait for confirmation"),
      tools: [
        {
          name: "confirm",
          description: "Confirm",
          parameters: { type: "object", properties: {} },
        },
      ],
    };
    const { result } = await collect(store, request);
    expect(result.handoff).toBe(true);
    await expect(
      collect(store, {
        ...request,
        messages: [
          ...request.messages,
          { id: "new", role: "user", content: "Another task" },
        ],
      }),
    ).rejects.toThrow("waiting");
    expect(stream).toHaveBeenCalledOnce();
    await store.abort(request.threadId);
    const history = await store.history(request.threadId);
    expect(history.pending).toEqual([]);
    expect(history.interrupted).toBe(true);
  });
  it("isolates two threads that run through the same shared store", async () => {
    const contexts: string[] = [];
    const { store } = await make({
      streamFn: scriptedStream((context) => {
        const text = JSON.stringify(context);
        contexts.push(text);
        return text.includes("alpha") ? "alpha answer" : "beta answer";
      }),
    });
    const a = input("alpha"),
      b = input("beta");
    await Promise.all([collect(store, a), collect(store, b)]);
    expect((await store.history(a.threadId)).messages.at(-1)?.content).toBe(
      "alpha answer",
    );
    expect((await store.history(b.threadId)).messages.at(-1)?.content).toBe(
      "beta answer",
    );
    expect(
      contexts.filter((c) => c.includes("alpha") && c.includes("beta")),
    ).toEqual([]);
  });
  it("loads a controlled Skill with Pi and executes the actual read tool", async () => {
    const { store: unused, root } = await make();
    await unused.dispose();
    const skill = join(root, "skills", "greeting");
    await mkdir(skill, { recursive: true });
    const path = join(skill, "SKILL.md");
    await writeFile(
      path,
      "---\nname: greeting\ndescription: A distinctive GREETING_SKILL_MARKER for greeting users\n---\nSay hello in Chinese: 你好。\n",
    );
    const contexts: unknown[] = [];
    const { store } = await make({
      cwd: root,
      skillPaths: [skill],
      streamFn: scriptedStream((context, index) => {
        contexts.push(context);
        return index === 0
          ? { tools: [{ id: "read-skill", name: "read", arguments: { path } }] }
          : "你好。";
      }),
    });
    const { events } = await collect(store, input("Use greeting Skill"));
    expect(JSON.stringify(contexts[0])).toContain("GREETING_SKILL_MARKER");
    expect(
      events.some(
        (e) =>
          e.type === "TOOL_CALL_RESULT" &&
          (e as any).content.includes("Say hello in Chinese"),
      ),
    ).toBe(true);
  });
  it("returns a single error terminal on failed provider requests and releases the thread", async () => {
    const { store } = await make({
      streamFn: () => {
        throw new Error("fixture provider failed");
      },
    });
    const request = input("fail");
    const { events } = await collect(store, request);
    expect(events.filter((e) => e.type === "RUN_ERROR")).toHaveLength(1);
    expect(events.filter((e) => e.type === "RUN_FINISHED")).toHaveLength(0);
    expect((await store.history(request.threadId)).running).toBe(false);
  });
  it("rejects unsupported frontend schemas before calling the model", async () => {
    const stream = vi.fn(scriptedStream(["No"]));
    const { store } = await make({ streamFn: stream });
    await expect(
      collect(store, {
        ...input("Do it"),
        tools: [
          {
            name: "unsupported",
            description: "bad",
            parameters: { $ref: "#/definitions/X" },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(stream).not.toHaveBeenCalled();
  });
  it("clones configuration and middleware without sharing per-run output state", async () => {
    const { store } = await make();
    const agent = new PiAgent({ store, agentId: "pi" });
    const middleware = vi.fn((input: any, next: any) => next.run(input));
    agent.use(middleware);
    const clone = agent.clone();
    expect(clone).not.toBe(agent);
    expect(clone.agentId).toBe("pi");
    clone.addMessage({ id: "clone-user", role: "user", content: "hello" });
    await clone.runAgent();
    expect(middleware).toHaveBeenCalled();
    expect(agent.messages).toEqual([]);
    expect(clone.messages.at(-1)?.content).toBe("Done");
  });
});
