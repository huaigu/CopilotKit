import { AbstractAgent, type AgentConfig } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import { PiSessionStore } from "./session-store.js";
export interface PiAgentOptions extends AgentConfig {
  store: PiSessionStore;
  scope?: string;
}
/** AG-UI façade over a server-owned Pi session store. */
export class PiAgent extends AbstractAgent {
  private store: PiSessionStore;
  private scope: string;
  constructor(options: PiAgentOptions) {
    super(options);
    this.store = options.store;
    this.scope = options.scope ?? "local";
  }
  override clone(): PiAgent {
    const copy = super.clone() as PiAgent;
    copy.store = this.store;
    copy.scope = this.scope;
    return copy;
  }
  override abortRun(): void {
    super.abortRun();
    if (this.threadId)
      void this.store.abort(this.threadId, this.scope).catch(() => {});
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      let completed = false;
      void this.store
        .run(
          input,
          (event) => {
            if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")
              completed = true;
            subscriber.next(event);
          },
          this.scope,
        )
        .then(
          () => {
            completed = true;
            subscriber.complete();
          },
          (error) => {
            completed = true;
            subscriber.error(error);
          },
        );
      return () => {
        if (!completed)
          void this.store.abort(input.threadId, this.scope).catch(() => {});
      };
    });
  }
}
