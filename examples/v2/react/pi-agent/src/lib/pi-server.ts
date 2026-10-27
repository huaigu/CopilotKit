import { resolve } from "node:path";
import { Type } from "typebox";
import { PiAgent, PiSessionStore } from "@copilotkit/pi-agent";
import { PiAgentRunner } from "@copilotkit/pi-agent/runtime";
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import {
  createVerificationStream,
  verificationModel,
} from "./verification-model";

const skillDir = resolve(process.cwd(), "skills/greeting");
const skillPath = resolve(skillDir, "SKILL.md");

function createServer() {
  const testMode = process.env.PI_TEST_MODE === "true";
  const store = new PiSessionStore({
    cwd: process.cwd(),
    sessionDir:
      process.env.PI_SESSION_DIR || resolve(process.cwd(), ".pi-data"),
    provider: process.env.PI_PROVIDER || "openai",
    modelId: process.env.PI_MODEL || "gpt-5.2",
    apiKey: process.env.PI_API_KEY,
    baseUrl: process.env.PI_BASE_URL,
    ...(testMode
      ? {
          model: verificationModel,
          streamFn: createVerificationStream(skillPath),
          apiKey: "verification-only",
        }
      : {}),
    skillPaths: [skillDir],
    tools: [
      {
        name: "quote_total",
        label: "Calculate quote",
        description:
          "Calculate a sample quote. Unit price is 12.50 USD. This is a read-only calculation, not a purchase.",
        parameters: Type.Object({
          quantity: Type.Number({ minimum: 0, maximum: 1000 }),
        }),
        execute: async (_callId, { quantity }) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                quantity,
                unitPrice: 12.5,
                total: quantity * 12.5,
                currency: "USD",
              }),
            },
          ],
          details: {},
        }),
      },
    ],
  });
  const runtime = new CopilotRuntime({
    agents: { pi: new PiAgent({ store, agentId: "pi" }) },
    runner: new PiAgentRunner({ store, agentId: "pi" }),
  });
  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: "/api/copilotkit",
  });
  return { store, handler };
}

const host = globalThis as typeof globalThis & {
  piExampleServer?: ReturnType<typeof createServer>;
};
export const server = (host.piExampleServer ??= createServer());

export function requireThreadId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error("Invalid threadId");
  return value;
}
