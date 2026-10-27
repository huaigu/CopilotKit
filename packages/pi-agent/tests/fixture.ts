import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const fixtureModel: Model<"openai-completions"> = {
  id: "pi-test",
  name: "Pi deterministic test",
  api: "openai-completions",
  provider: "pi-test",
  baseUrl: "http://127.0.0.1/unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 1024,
};
export type FixtureReply =
  | string
  | {
      text?: string;
      tools?: Array<{
        id?: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;
    };
export function scriptedStream(
  script:
    | FixtureReply[]
    | ((context: Parameters<StreamFn>[1], index: number) => FixtureReply),
): StreamFn {
  let index = 0;
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const current = index++;
    queueMicrotask(() => {
      if (options?.signal?.aborted) {
        const error: AssistantMessage = {
          role: "assistant",
          content: [],
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
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        stream.push({ type: "error", reason: "aborted", error });
        return;
      }
      const answer =
        typeof script === "function"
          ? script(context, current)
          : (script[current] ?? "Done");
      const reply = typeof answer === "string" ? { text: answer } : answer;
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: reply.tools?.length ? "toolUse" : "stop",
        timestamp: Date.now() + current,
      };
      stream.push({ type: "start", partial: structuredClone(message) });
      if (reply.text) {
        message.content.push({ type: "text", text: reply.text });
        stream.push({
          type: "text_start",
          contentIndex: 0,
          partial: structuredClone(message),
        });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: reply.text,
          partial: structuredClone(message),
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: reply.text,
          partial: structuredClone(message),
        });
      }
      for (const [n, call] of (reply.tools ?? []).entries())
        message.content.push({
          type: "toolCall",
          id: call.id ?? `call-${current}-${n}`,
          name: call.name,
          arguments: call.arguments as any,
        });
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end(message);
    });
    return stream;
  };
}
