import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FrontendToolBridge,
  assertToolArguments,
  validateFrontendTools,
} from "./frontend-tool-bridge.js";

afterEach(() => vi.useRealTimers());

describe("FrontendToolBridge", () => {
  it("keeps a tool waiting until a later request delivers its matching result", async () => {
    const dispatched = vi.fn();
    const bridge = new FrontendToolBridge({ onCall: dispatched });
    const tool = bridge.invoke({
      id: "call-1",
      name: "confirm",
      args: { amount: 12 },
    });
    expect(dispatched).toHaveBeenCalledWith({
      id: "call-1",
      name: "confirm",
      args: { amount: 12 },
    });
    expect(bridge.pending.map(({ id }) => id)).toEqual(["call-1"]);
    await Promise.resolve();
    expect(bridge.hasPending).toBe(true);

    expect(bridge.resolve("call-1", { approved: true, amount: 12 })).toBe(true);
    await expect(tool).resolves.toEqual({ approved: true, amount: 12 });
    expect(bridge.hasPending).toBe(false);
    expect(bridge.resolve("call-1", { amount: 12, approved: true })).toBe(
      false,
    );
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(() => bridge.resolve("call-1", { approved: false })).toThrow(
      "conflicts",
    );
  });

  it("rejects foreign-session and expired results without resolving a pending call", async () => {
    const first = new FrontendToolBridge({ onCall: () => {} });
    const other = new FrontendToolBridge({ onCall: () => {} });
    const pending = first.invoke({
      id: "owned-call",
      name: "change_color",
      args: {},
    });
    const rejection = expect(pending).rejects.toThrow("stopped");
    expect(() => other.resolve("owned-call", "blue")).toThrow("Unknown");
    expect(first.hasPending).toBe(true);
    first.cancel("stopped");
    await rejection;
    expect(() => first.resolve("owned-call", "blue")).toThrow("Unknown");
  });

  it("cleans timers and abort listeners on completion and explicit cancellation", async () => {
    vi.useFakeTimers();
    const bridge = new FrontendToolBridge({ timeoutMs: 50, onCall: () => {} });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const promise = bridge.invoke(
      { id: "a", name: "confirm", args: {} },
      controller.signal,
    );
    bridge.resolve("a", false);
    await expect(promise).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));

    const wait = bridge.invoke(
      { id: "b", name: "confirm", args: {} },
      controller.signal,
    );
    const rejection = expect(wait).rejects.toThrow("cancelled");
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    expect(bridge.hasPending).toBe(false);
  });

  it("times out while a browser is absent and releases every waiting resource", async () => {
    vi.useFakeTimers();
    const bridge = new FrontendToolBridge({ timeoutMs: 50, onCall: () => {} });
    const wait = bridge.invoke({ id: "slow", name: "confirm", args: {} });
    const rejection = expect(wait).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(bridge.pending).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not dispatch duplicate invocations or already-aborted work", async () => {
    const onCall = vi.fn();
    const bridge = new FrontendToolBridge({ onCall });
    const first = bridge.invoke({ id: "same", name: "confirm", args: {} });
    await expect(
      bridge.invoke({ id: "same", name: "confirm", args: {} }),
    ).rejects.toThrow("Duplicate");
    bridge.resolve("same", true);
    await first;
    await expect(
      bridge.invoke({ id: "same", name: "confirm", args: {} }),
    ).rejects.toThrow("Duplicate");
    const controller = new AbortController();
    controller.abort();
    await expect(
      bridge.invoke(
        { id: "aborted", name: "confirm", args: {} },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("releases a failed transport dispatch and snapshots arguments", async () => {
    const args = { amount: 1 };
    const bridge = new FrontendToolBridge({ onCall: () => {} });
    const promise = bridge.invoke({ id: "a", name: "confirm", args });
    args.amount = 99;
    expect(bridge.pending[0].args).toEqual({ amount: 1 });
    bridge.resolve("a", "ok");
    await promise;
    const broken = new FrontendToolBridge({
      onCall: () => {
        throw new Error("offline");
      },
    });
    await expect(
      broken.invoke({ id: "b", name: "confirm", args: {} }),
    ).rejects.toThrow("offline");
    expect(broken.hasPending).toBe(false);
  });
});

describe("frontend tool schema admission", () => {
  const schema = {
    type: "object",
    properties: {
      amount: { type: "integer", minimum: 1, maximum: 100 },
      tags: {
        type: "array",
        items: { type: "string", minLength: 1 },
        uniqueItems: true,
      },
      approval: {
        type: "object",
        properties: { approved: { type: "boolean" } },
        required: ["approved"],
        additionalProperties: false,
      },
    },
    required: ["amount", "approval"],
    additionalProperties: false,
  };

  it("admits schemas and validates nested model-supplied values before browser execution", () => {
    expect(
      validateFrontendTools([{ name: "confirmPurchase", parameters: schema }]),
    ).toHaveLength(1);
    expect(() =>
      assertToolArguments(schema, {
        amount: 12,
        approval: { approved: true },
        tags: ["a", "b"],
      }),
    ).not.toThrow();
    expect(() =>
      assertToolArguments(schema, { amount: 0, approval: { approved: true } }),
    ).toThrow("range");
    expect(() =>
      assertToolArguments(schema, { amount: 1, approval: {} }),
    ).toThrow("required");
    expect(() =>
      assertToolArguments(schema, { amount: 1, approval: { approved: "yes" } }),
    ).toThrow("boolean");
    expect(() =>
      assertToolArguments(schema, {
        amount: 1,
        approval: { approved: true },
        tags: ["a", "a"],
      }),
    ).toThrow("unique");
    expect(() =>
      assertToolArguments(schema, {
        amount: 1,
        approval: { approved: true },
        extra: true,
      }),
    ).toThrow("not allowed");
  });

  it("explicitly refuses schema features that this adapter cannot guarantee", () => {
    for (const parameters of [
      { type: "object", $ref: "https://remote/schema" },
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      { type: "array", items: { type: "string" } },
      { type: "object", properties: { value: { type: ["string", "null"] } } },
    ])
      expect(() =>
        validateFrontendTools([{ name: "tool", parameters }]),
      ).toThrow();
  });

  it("rejects duplicate, unsafe, invalid names and JSON values", () => {
    for (const name of ["__proto__", "constructor", "a.b", "a/b", ""]) {
      expect(() =>
        validateFrontendTools([{ name, parameters: { type: "object" } }]),
      ).toThrow();
    }
    expect(() =>
      validateFrontendTools([
        { name: "same", parameters: schema },
        { name: "same", parameters: schema },
      ]),
    ).toThrow("Duplicate");
    const prototypeSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    );
    expect(() =>
      validateFrontendTools([{ name: "tool", parameters: prototypeSchema }]),
    ).toThrow("Unsafe");
    expect(() => assertToolArguments({ type: "number" }, Infinity)).toThrow(
      "JSON",
    );
    expect(() =>
      assertToolArguments({ type: "object" }, JSON.parse('{"__proto__":{}}')),
    ).toThrow("unsafe");
  });
});
