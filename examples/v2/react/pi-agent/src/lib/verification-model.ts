/** A deterministic provider for acceptance tests. Pi still owns the actual agent/tool loop. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const verificationModel: Model<"openai-completions"> = {
  id: "pi-verification",
  name: "Pi verification model",
  api: "openai-completions",
  provider: "verification",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function createVerificationStream(skillPath: string): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const messages = context.messages;
      const lastUserIndex = messages.findLastIndex(
        (message) => message.role === "user",
      );
      const user = messages[lastUserIndex];
      const prompt =
        user?.role === "user"
          ? typeof user.content === "string"
            ? user.content
            : user.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
          : "";
      const chinese = /[\u3400-\u9fff]/.test(prompt);
      const results = messages
        .slice(lastUserIndex + 1)
        .filter((message) => message.role === "toolResult");
      const result = (name: string) =>
        results.findLast((message) => message.toolName === name);
      const resultText = (name: string) =>
        result(name)
          ?.content.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n") ?? "";
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "start", partial: output });
      const call = (name: string, args: ToolCall["arguments"]) => {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: crypto.randomUUID(),
          name,
          arguments: args,
        };
        output.content.push(toolCall);
        output.stopReason = "toolUse";
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          partial: output,
        });
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(args),
          partial: output,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall,
          partial: output,
        });
      };
      let answer = "";
      if (/slow|慢/.test(prompt)) {
        answer = chinese
          ? "这是一段缓慢输出，用来验证停止功能。".repeat(10)
          : "This is a slow reply for verifying cancellation. ".repeat(10);
      } else if (/skill/i.test(prompt)) {
        if (!result("read")) call("read", { path: skillPath });
        else
          answer = chinese
            ? `已读取 Skill，按其中的要求问候：你好，欢迎来到 Pi 工作台。\n\n${resultText("read")}`
            : `I read the Skill: Hello, welcome to the Pi workbench.\n\n${resultText("read")}`;
      } else if (/quote|报价/i.test(prompt)) {
        if (!result("quote_total"))
          call("quote_total", {
            quantity: Number(prompt.match(/\d+/)?.[0] ?? 4),
          });
        else
          answer = `${chinese ? "服务端工具返回的报价" : "The server tool returned the quote"}: ${resultText("quote_total")}`;
      } else if (/update.*state|更新.*共享状态/i.test(prompt)) {
        if (!result("pi_update_state"))
          call("pi_update_state", {
            state: { goal: Number(prompt.match(/\d+/)?.[0] ?? 55) },
          });
        else
          answer = `${chinese ? "Pi 已更新共享状态" : "Pi updated shared state"}: ${resultText("pi_update_state")}`;
      } else if (/confirm|确认/i.test(prompt)) {
        const goal = Number(prompt.match(/\d+/)?.[0] ?? 9);
        if (!result("request_confirmation"))
          call("request_confirmation", {
            message: chinese
              ? `将目标值改为 ${goal}，是否确认？`
              : `Set the target to ${goal}?`,
          });
        else if (!resultText("request_confirmation").includes("true"))
          answer = chinese
            ? "你拒绝了这次修改，目标值保持不变。"
            : "You declined the change. The target stays as it was.";
        else if (!result("set_goal")) call("set_goal", { goal });
        else
          answer = chinese
            ? `已按你的确认修改目标值：${resultText("set_goal")}`
            : `Updated after your confirmation: ${resultText("set_goal")}`;
      } else if (/set|改为|改成/i.test(prompt) && /target|目标/i.test(prompt)) {
        if (!result("set_goal"))
          call("set_goal", { goal: Number(prompt.match(/\d+/)?.[0] ?? 7) });
        else
          answer = `${chinese ? "浏览器已更新目标值" : "The browser updated the target"}: ${resultText("set_goal")}`;
      } else if (/state|target|目标|状态/i.test(prompt)) {
        if (!result("pi_get_state")) call("pi_get_state", {});
        else
          answer = `${chinese ? "当前共享状态" : "Current shared state"}: ${resultText("pi_get_state")}`;
      } else {
        const remembered = messages
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
          )
          .slice(0, -1)
          .join(" / ");
        answer = chinese
          ? `你好，我是 Pi。你说的是：${prompt}${remembered ? `\n\n此前你提到：${remembered}` : ""}`
          : `Hello from Pi. You said: ${prompt}${remembered ? `\n\nEarlier you said: ${remembered}` : ""}`;
      }
      if (answer) {
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        for (const chunk of answer.match(/.{1,10}/gs) ?? []) {
          await new Promise((resolve) =>
            setTimeout(resolve, /slow|慢/.test(prompt) ? 150 : 12),
          );
          if (options?.signal?.aborted) {
            output.stopReason = "aborted";
            output.errorMessage = "Stopped by user";
            stream.push({ type: "error", reason: "aborted", error: output });
            return;
          }
          const content = output.content[0];
          if (content.type === "text") content.text += chunk;
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: chunk,
            partial: output,
          });
        }
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: answer,
          partial: output,
        });
      }
      stream.push({
        type: "done",
        reason: output.stopReason === "toolUse" ? "toolUse" : "stop",
        message: output,
      });
    })().catch((error: unknown) => {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
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
        },
      });
    });
    return stream;
  };
}
