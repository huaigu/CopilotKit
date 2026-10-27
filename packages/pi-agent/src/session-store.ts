import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { BaseEvent, Message, RunAgentInput, Tool } from "@ag-ui/core";
import { Type } from "typebox";
import {
  FrontendToolBridge,
  validateFrontendTools,
  assertToolArguments,
} from "./frontend-tool-bridge.js";

type Json = Record<string, unknown>;
type Emit = (event: BaseEvent) => void;
export interface PiSessionStoreOptions {
  cwd: string;
  sessionDir: string;
  model?: Model<any>;
  provider?: string;
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
  streamFn?: StreamFn;
  tools?: ToolDefinition<any>[];
  builtinTools?: string[];
  skillPaths?: string[];
  systemPrompt?: string;
  frontendToolTimeoutMs?: number;
  idleMs?: number;
}
interface Metadata {
  sessionFile?: string;
  seenUsers: string[];
  ids: Record<string, string>;
  state: Json;
  interrupted: boolean;
  receipts?: Record<string, string>;
}
interface Channel {
  emit: Emit;
  finish: (handoff: boolean) => void;
  finished: boolean;
  runId: string;
}
interface Thread {
  key: string;
  dir: string;
  session: AgentSession;
  meta: Metadata;
  bridge: FrontendToolBridge;
  catalog: string;
  channel?: Channel;
  task?: Promise<void>;
  unsubscribe: () => void;
  lastUsed: number;
  currentId?: string;
  textOpen: boolean;
  textSent: boolean;
  sentTools: Set<string>;
  failure?: string;
  cancelled?: boolean;
  pendingIds: Array<{ message: unknown; id: string }>;
  saveTail: Promise<void>;
}
const stableJson = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((v) => JSON.parse(stableJson(v)))
        : Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, JSON.parse(stableJson(v))]),
          )
      : value,
  );
const parsedResult = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const stringResult = (result: unknown): string =>
  typeof result === "string" ? result : (JSON.stringify(result) ?? "null");
const textContent = (message: any): string =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("");

/** One process owns active tasks; Pi's SessionManager owns their durable transcript. */
export class PiSessionStore {
  private readonly threads = new Map<string, Promise<Thread>>();
  private readonly options: PiSessionStoreOptions;
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private disposed = false;
  constructor(options: PiSessionStoreOptions) {
    this.options = {
      ...options,
      cwd: resolve(options.cwd),
      sessionDir: resolve(options.sessionDir),
    };
    const idleMs = options.idleMs ?? 1800000;
    if (!Number.isFinite(idleMs) || idleMs < 1)
      throw new Error("idleMs must be positive");
    this.idleTimer = setInterval(
      () => {
        void this.pruneIdle().catch(() => {});
      },
      Math.min(idleMs, 30000),
    );
    this.idleTimer.unref();
  }
  async pruneIdle() {
    for (const [key, promise] of this.threads) {
      const t = await promise;
      if (
        !t.task &&
        !t.channel &&
        !t.bridge.hasPending &&
        Date.now() - t.lastUsed > (this.options.idleMs ?? 1800000)
      ) {
        t.unsubscribe();
        t.session.dispose();
        this.threads.delete(key);
        this.threadIds.delete(key);
      }
    }
  }
  private key(threadId: string, scope: string) {
    if (!threadId || threadId.length > 256 || !scope || scope.length > 256)
      throw new Error("Invalid thread or scope");
    return createHash("sha256")
      .update(scope + "\0" + threadId)
      .digest("hex");
  }
  private syncIds(t: Thread) {
    const entries = t.session.sessionManager
      .getBranch()
      .filter((e) => e.type === "message");
    t.pendingIds = t.pendingIds.filter((binding) => {
      const entry = entries.find(
        (e) => e.type === "message" && e.message === binding.message,
      );
      if (entry) {
        t.meta.ids[entry.id] = binding.id;
        return false;
      }
      return true;
    });
  }
  private async save(t: Thread) {
    this.syncIds(t);
    t.meta.sessionFile = t.session.sessionManager.getSessionFile();
    const temporary = join(t.dir, `binding.${randomUUID()}.tmp`);
    const snapshot = JSON.stringify(t.meta);
    const saved = t.saveTail.then(async () => {
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, join(t.dir, "binding.json"));
    });
    t.saveTail = saved.catch(() => {});
    await saved;
  }
  private emit(t: Thread, event: BaseEvent) {
    if (t.channel && !t.channel.finished) t.channel.emit(event);
  }
  private finish(t: Thread, handoff: boolean) {
    const channel = t.channel;
    if (!channel || channel.finished) return;
    channel.finished = true;
    channel.emit({
      type: "RUN_FINISHED",
      threadId: this.threadIds.get(t.key)!,
      runId: channel.runId,
    } as BaseEvent);
    channel.finish(handoff);
    t.channel = undefined;
  }
  private readonly threadIds = new Map<string, string>();
  private async make(
    threadId: string,
    scope: string,
    tools: Tool[],
  ): Promise<Thread> {
    const key = this.key(threadId, scope),
      dir = join(this.options.sessionDir, key);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const agentDir = join(dir, "config");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    let meta: Metadata = {
      seenUsers: [],
      ids: {},
      state: {},
      interrupted: false,
    };
    try {
      meta = JSON.parse(await readFile(join(dir, "binding.json"), "utf8"));
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    let manager: SessionManager;
    if (meta.sessionFile) {
      if (!resolve(meta.sessionFile).startsWith(dir + "/"))
        throw new Error("Invalid persisted session path");
      try {
        await access(meta.sessionFile);
        manager = SessionManager.open(meta.sessionFile, dir, this.options.cwd);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        manager = SessionManager.create(this.options.cwd, dir);
      }
    } else manager = SessionManager.create(this.options.cwd, dir);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    });
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const provider =
      this.options.model?.provider ?? this.options.provider ?? "openai";
    let model =
      this.options.model ??
      runtime.getModel(provider, this.options.modelId ?? "gpt-4.1-mini");
    if (!model)
      throw new Error(
        `Pi model not found: ${provider}/${this.options.modelId ?? "gpt-4.1-mini"}`,
      );
    if (this.options.baseUrl)
      model = { ...model, baseUrl: this.options.baseUrl };
    if (this.options.model || this.options.baseUrl)
      runtime.registerProvider(provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        apiKey: this.options.apiKey,
        models: [{ ...model, input: [...model.input] }],
      });
    if (this.options.apiKey)
      await runtime.setRuntimeApiKey(provider, this.options.apiKey);
    const loader = new DefaultResourceLoader({
      cwd: this.options.cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: this.options.skillPaths ?? [],
      systemPrompt: this.options.systemPrompt,
    });
    await loader.reload();
    let t: Thread;
    const bridge = new FrontendToolBridge({
      timeoutMs: this.options.frontendToolTimeoutMs ?? 300000,
      onCall: () => {
        void this.save(t)
          .then(() => this.finish(t, true))
          .catch((error) => {
            t.failure = String(error);
            bridge.cancel("Session persistence failed");
            t.session.agent.abort();
          });
      },
    });
    const custom: ToolDefinition<any>[] = [
      ...(this.options.tools ?? []),
      ...tools.map((tool) => ({
        name: tool.name,
        label: tool.name,
        description: tool.description ?? "",
        parameters: Type.Unsafe(tool.parameters),
        execute: async (id: string, args: unknown, signal?: AbortSignal) => {
          assertToolArguments(tool.parameters as any, args);
          try {
            const result = await bridge.invoke(
              { id, name: tool.name, args: args as Json },
              signal,
            );
            return {
              content: [{ type: "text" as const, text: stringResult(result) }],
              details: {},
            };
          } catch (error) {
            t.failure =
              error instanceof Error ? error.message : "Frontend tool failed";
            t.session.agent.abort();
            throw error;
          }
        },
      })),
      {
        name: "pi_get_state",
        label: "Read page state",
        description: "Read the current application state supplied by the page.",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [
            { type: "text" as const, text: JSON.stringify(t.meta.state) },
          ],
          details: {},
        }),
      },
      {
        name: "pi_update_state",
        label: "Update page state",
        description: "Replace the shared page state with a JSON object.",
        parameters: Type.Object({
          state: Type.Record(Type.String(), Type.Unknown()),
        }),
        execute: async (_id: string, args: { state: Json }) => {
          t.meta.state = structuredClone(args.state);
          this.emit(t, {
            type: "STATE_SNAPSHOT",
            snapshot: t.meta.state,
          } as BaseEvent);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(t.meta.state) },
            ],
            details: {},
          };
        },
      },
    ];
    const names = custom.map((x) => x.name);
    if (new Set(names).size !== names.length)
      throw new Error("Frontend and backend tool names must be unique");
    const { session } = await createAgentSession({
      cwd: this.options.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: manager,
      customTools: custom,
      tools: [
        ...(this.options.builtinTools ??
          (this.options.skillPaths?.length ? ["read"] : [])),
        ...names,
      ],
      thinkingLevel: "off",
    });
    if (this.options.streamFn)
      session.agent.streamFunction = this.options.streamFn;
    t = {
      key,
      dir,
      session,
      meta,
      bridge,
      catalog: JSON.stringify(tools),
      unsubscribe: () => {},
      lastUsed: Date.now(),
      textOpen: false,
      textSent: false,
      sentTools: new Set(),
      pendingIds: [],
      saveTail: Promise.resolve(),
    };
    this.threadIds.set(key, threadId);
    t.unsubscribe = session.subscribe((event) => this.onEvent(t, event));
    await this.save(t);
    return t;
  }
  private async get(
    threadId: string,
    scope: string,
    tools: Tool[] = [],
  ): Promise<Thread> {
    if (this.disposed) throw new Error("Pi session store is disposed");
    const key = this.key(threadId, scope);
    let promise = this.threads.get(key);
    if (!promise) {
      promise = this.make(threadId, scope, tools);
      this.threads.set(key, promise);
      promise.catch(() => this.threads.delete(key));
    }
    const t = await promise;
    t.lastUsed = Date.now();
    return t;
  }
  private project(t: Thread): Message[] {
    this.syncIds(t);
    const messages: Message[] = [];
    for (const entry of t.session.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const m = entry.message as any;
      const id = t.meta.ids[entry.id] ?? `${t.key.slice(0, 12)}:${entry.id}`;
      if (m.role === "user")
        messages.push({ id, role: "user", content: textContent(m) });
      if (m.role === "assistant") {
        const calls = (m.content ?? [])
          .filter((p: any) => p.type === "toolCall")
          .map((p: any) => ({
            id: p.id,
            type: "function" as const,
            function: { name: p.name, arguments: JSON.stringify(p.arguments) },
          }));
        const text = textContent(m);
        if (text || calls.length)
          messages.push({
            id,
            role: "assistant",
            content: text,
            ...(calls.length ? { toolCalls: calls } : {}),
          });
      }
      if (m.role === "toolResult")
        messages.push({
          id,
          role: "tool",
          toolCallId: m.toolCallId,
          content: textContent(m),
        });
    }
    return messages;
  }
  private onEvent(t: Thread, event: any) {
    if (event.type === "message_start" && event.message.role === "assistant") {
      t.currentId = randomUUID();
      t.textOpen = false;
      t.textSent = false;
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      if (!t.textOpen) {
        this.emit(t, {
          type: "TEXT_MESSAGE_START",
          messageId: t.currentId!,
          role: "assistant",
        } as BaseEvent);
        t.textOpen = true;
      }
      this.emit(t, {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: t.currentId!,
        delta: event.assistantMessageEvent.delta,
      } as BaseEvent);
      t.textSent = true;
    }
    if (event.type === "message_end") {
      const m = event.message;
      if (m.role === "user" && t.meta.seenUsers.length)
        t.pendingIds.push({ message: m, id: t.meta.seenUsers.at(-1)! });
      if (m.role === "assistant") {
        t.currentId ??= randomUUID();
        t.pendingIds.push({ message: m, id: t.currentId });
        const text = textContent(m);
        if (text && !t.textSent) {
          this.emit(t, {
            type: "TEXT_MESSAGE_START",
            messageId: t.currentId,
            role: "assistant",
          } as BaseEvent);
          this.emit(t, {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: t.currentId,
            delta: text,
          } as BaseEvent);
          t.textOpen = true;
        }
        if (t.textOpen)
          this.emit(t, {
            type: "TEXT_MESSAGE_END",
            messageId: t.currentId,
          } as BaseEvent);
        t.textOpen = false;
        for (const call of m.content.filter(
          (p: any) => p.type === "toolCall",
        )) {
          if (t.sentTools.has(call.id)) continue;
          t.sentTools.add(call.id);
          this.emit(t, {
            type: "TOOL_CALL_START",
            toolCallId: call.id,
            toolCallName: call.name,
            parentMessageId: t.currentId,
          } as BaseEvent);
          this.emit(t, {
            type: "TOOL_CALL_ARGS",
            toolCallId: call.id,
            delta: JSON.stringify(call.arguments),
          } as BaseEvent);
          this.emit(t, {
            type: "TOOL_CALL_END",
            toolCallId: call.id,
          } as BaseEvent);
        }
        if (m.stopReason === "error")
          t.failure = m.errorMessage ?? "Pi model request failed";
      }
      if (m.role === "toolResult") {
        const id = `${m.toolCallId}:result`;
        t.pendingIds.push({ message: m, id });
        this.emit(t, {
          type: "TOOL_CALL_RESULT",
          toolCallId: m.toolCallId,
          messageId: id,
          role: "tool",
          content: textContent(m),
        } as BaseEvent);
      }
    }
  }
  async run(
    input: RunAgentInput,
    emit: Emit,
    scope = "local",
  ): Promise<{ handoff: boolean }> {
    const tools = validateFrontendTools(
      (input.tools ?? []).map((tool) => ({
        ...tool,
        parameters: tool.parameters ?? { type: "object", properties: {} },
      })),
    );
    const t = await this.get(input.threadId, scope, tools);
    if (t.channel) throw new Error("This Pi thread is already running");
    const knownToolIds = new Set(
      this.project(t)
        .filter((m) => m.role === "tool")
        .map((m) => (m.role === "tool" ? m.toolCallId : "")),
    );
    for (const m of input.messages)
      if (m.role === "tool") {
        if (
          !knownToolIds.has(m.toolCallId) &&
          !t.bridge.pending.some((p) => p.id === m.toolCallId)
        )
          throw new Error("Unknown or expired frontend tool result");
        if (
          t.meta.receipts?.[m.toolCallId] !== undefined &&
          t.meta.receipts[m.toolCallId] !== stableJson(parsedResult(m.content))
        )
          throw new Error(
            "Frontend tool result conflicts with its previous result",
          );
      }
    if (t.catalog !== JSON.stringify(tools)) {
      if (t.task) throw new Error("Cannot change tools during an active turn");
      t.unsubscribe();
      t.session.dispose();
      this.threads.delete(t.key);
      const replacement = await this.make(input.threadId, scope, tools);
      this.threads.set(t.key, Promise.resolve(replacement));
      return this.run(input, emit, scope);
    }
    t.meta.state = structuredClone((input.state ?? {}) as Json);
    const finished = new Promise<{ handoff: boolean }>((resolve) => {
      t.channel = {
        emit,
        finish: (handoff) => resolve({ handoff }),
        finished: false,
        runId: input.runId,
      };
    });
    emit({
      type: "RUN_STARTED",
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent);
    emit({
      type: "MESSAGES_SNAPSHOT",
      messages: [
        ...this.project(t),
        ...input.messages.filter(
          (m) => m.role === "user" && !t.meta.seenUsers.includes(m.id),
        ),
      ],
    } as BaseEvent);
    emit({ type: "STATE_SNAPSHOT", snapshot: t.meta.state } as BaseEvent);
    if (t.bridge.hasPending) {
      try {
        if (
          input.messages.some(
            (m) => m.role === "user" && !t.meta.seenUsers.includes(m.id),
          )
        )
          throw new Error("Pi is waiting for a frontend tool result");
        const results = input.messages.filter(
          (m) =>
            m.role === "tool" &&
            t.bridge.pending.some((p) => p.id === m.toolCallId),
        );
        if (!results.length)
          throw new Error("Pi is waiting for a frontend tool result");
        for (const result of results)
          if (result.role === "tool") {
            let content: unknown = result.content;
            try {
              content =
                typeof result.content === "string"
                  ? JSON.parse(result.content)
                  : result.content;
            } catch {}
            t.meta.receipts ??= {};
            t.meta.receipts[result.toolCallId] = stableJson(content);
            t.bridge.resolve(result.toolCallId, content);
          }
        if (t.bridge.hasPending) this.finish(t, true);
      } catch (error) {
        t.channel = undefined;
        throw error;
      }
      return finished;
    }
    if (t.task) {
      t.channel = undefined;
      throw new Error("This Pi thread is already running");
    }
    const unseen = input.messages.filter(
      (m) => m.role === "user" && !t.meta.seenUsers.includes(m.id),
    );
    if (!unseen.length) {
      this.finish(t, false);
      return finished;
    }
    if (unseen.length !== 1 || typeof unseen[0].content !== "string") {
      t.channel = undefined;
      throw new Error("Send one new text user message per run");
    }
    t.failure = undefined;
    t.cancelled = false;
    t.sentTools.clear();
    t.meta.seenUsers.push(unseen[0].id);
    t.meta.interrupted = true;
    try {
      await this.save(t);
      if (input.context?.length)
        await t.session.sendCustomMessage(
          {
            customType: "copilot-context",
            content: JSON.stringify(input.context),
            display: false,
          },
          { triggerTurn: false },
        );
    } catch (error) {
      t.meta.seenUsers.pop();
      t.channel = undefined;
      throw error;
    }
    const userText = unseen[0].content;
    if (t.cancelled) {
      this.finish(t, false);
      return finished;
    }
    t.task = (async () => {
      try {
        await t.session.prompt(userText);
        if (t.failure) throw new Error(t.failure);
        t.meta.interrupted = !!t.cancelled;
      } catch (error: any) {
        t.meta.interrupted = true;
        t.failure = error?.message ?? "Pi run failed";
      } finally {
        this.emit(t, {
          type: "MESSAGES_SNAPSHOT",
          messages: this.project(t),
        } as BaseEvent);
        this.emit(t, {
          type: "STATE_SNAPSHOT",
          snapshot: t.meta.state,
        } as BaseEvent);
        try {
          await this.save(t);
        } catch (error) {
          t.failure = "Could not persist Pi session";
          t.meta.interrupted = true;
        }
        t.task = undefined;
        if (t.failure && t.channel && !t.channel.finished) {
          const channel = t.channel;
          channel.finished = true;
          channel.emit({ type: "RUN_ERROR", message: t.failure } as BaseEvent);
          channel.finish(false);
          t.channel = undefined;
        } else this.finish(t, false);
      }
    })();
    return finished;
  }
  async abort(threadId: string, scope = "local") {
    const pending = this.threads.get(this.key(threadId, scope));
    if (!pending) return;
    const t = await pending;
    t.cancelled = true;
    t.meta.interrupted = !!t.task;
    t.session.agent.abort();
    t.bridge.cancel("Cancelled by user");
    await t.session.abort();
    await t.task;
    await this.save(t);
  }
  async history(threadId: string, scope = "local") {
    const t = await this.get(threadId, scope);
    return {
      messages: this.project(t),
      state: structuredClone(t.meta.state),
      interrupted: t.meta.interrupted,
      running: !!t.task,
      pending: t.bridge.pending,
    };
  }
  async dispose() {
    clearInterval(this.idleTimer);
    this.disposed = true;
    await Promise.all(
      [...this.threads.values()].map(async (p) => {
        const t = await p;
        t.session.agent.abort();
        t.bridge.cancel("Store disposed");
        await t.session.abort();
        await t.task;
        t.unsubscribe();
        t.session.dispose();
      }),
    );
    this.threads.clear();
    this.threadIds.clear();
  }
}
