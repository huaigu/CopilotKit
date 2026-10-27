import { randomUUID } from "node:crypto";
import {
  InMemoryAgentRunner,
  type AgentRunnerConnectRequest,
} from "@copilotkit/runtime/v2";
import type { BaseEvent } from "@ag-ui/core";
import { defer, of, switchMap, type Observable } from "rxjs";
import { PiSessionStore } from "./session-store.js";

export interface PiAgentRunnerOptions {
  store: PiSessionStore;
  agentId?: string;
  scope?: string;
}

/**
 * Reuses Runtime execution/stop handling, but reconnects settled Pi threads from
 * Pi's durable history. An in-memory handoff replay can predate a cancellation
 * received by the Pi store and would otherwise reopen a completed browser tool.
 */
export class PiAgentRunner extends InMemoryAgentRunner {
  constructor(private readonly pi: PiAgentRunnerOptions) {
    super();
  }
  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    if (request.agentId && request.agentId !== (this.pi.agentId ?? "pi"))
      return super.connect(request);
    return defer(async () => {
      const history = await this.pi.store.history(
        request.threadId,
        this.pi.scope ?? "local",
      );
      const active = await super.isRunning({ threadId: request.threadId });
      return { history, active };
    }).pipe(
      switchMap(({ history, active }) => {
        if (active || history.running || history.pending.length)
          return super.connect(request);
        const runId = randomUUID();
        return of<BaseEvent[]>(
          {
            type: "RUN_STARTED",
            threadId: request.threadId,
            runId,
          } as BaseEvent,
          {
            type: "MESSAGES_SNAPSHOT",
            messages: history.messages,
          } as BaseEvent,
          { type: "STATE_SNAPSHOT", snapshot: history.state } as BaseEvent,
          {
            type: "RUN_FINISHED",
            threadId: request.threadId,
            runId,
          } as BaseEvent,
        );
      }),
    );
  }
}
