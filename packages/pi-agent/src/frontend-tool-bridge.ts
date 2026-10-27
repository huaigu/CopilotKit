/** A browser tool invocation waiting for a result on a later AG-UI run. */
export interface FrontendToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface FrontendToolBridgeOptions {
  timeoutMs?: number;
  onCall: (call: FrontendToolCall) => void;
}

interface PendingCall {
  call: FrontendToolCall;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  dispose: () => void;
}

const unsafeNames = new Set(["__proto__", "prototype", "constructor"]);
const has = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Canonical JSON makes replay comparison independent of object key order. */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== "object" || value === null)
    throw new Error("Tool values must be JSON data");
  if (ancestors.has(value))
    throw new Error("Tool values cannot contain cycles");
  ancestors.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("Tool values must be plain JSON objects");
    result = `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], ancestors)}`,
      )
      .join(",")}}`;
  }
  ancestors.delete(value);
  return result;
}

/**
 * Keeps Pi's tool Promise alive across the AG-UI frontend handoff. This broker is
 * scoped to one Pi session. Closing an HTTP subscription must not cancel it;
 * explicit stop/session disposal calls cancel instead.
 */
export class FrontendToolBridge {
  private readonly calls = new Map<string, PendingCall>();
  private readonly settled = new Map<string, string>();
  private readonly invocations = new Set<string>();
  private readonly timeoutMs: number;

  constructor(private readonly options: FrontendToolBridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2_147_483_647
    ) {
      throw new Error(
        "frontendToolTimeoutMs must be an integer between 1 and 2147483647",
      );
    }
  }

  get pending(): FrontendToolCall[] {
    return Array.from(this.calls.values(), ({ call }) => call);
  }

  get hasPending(): boolean {
    return this.calls.size > 0;
  }

  invoke(call: FrontendToolCall, signal?: AbortSignal): Promise<unknown> {
    if (!call.id || this.invocations.has(call.id))
      return Promise.reject(
        new Error("Duplicate or empty frontend tool call id"),
      );
    if (signal?.aborted)
      return Promise.reject(new Error("Frontend tool cancelled"));
    // Snapshot arguments before yielding to a different request.
    const snapshot = {
      ...call,
      args: JSON.parse(canonical(call.args)) as unknown,
    };
    this.invocations.add(call.id);
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        const pending = this.calls.get(call.id);
        if (!pending) return;
        this.calls.delete(call.id);
        pending.dispose();
        reject(new Error(message));
      };
      const abort = () => fail("Frontend tool cancelled");
      const timer = setTimeout(
        () => fail(`Frontend tool ${call.name} timed out`),
        this.timeoutMs,
      );
      // Waiting for a browser should not keep an otherwise stopped Node host alive.
      timer.unref?.();
      const dispose = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.calls.set(call.id, { call: snapshot, resolve, reject, dispose });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.options.onCall(snapshot);
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : "Frontend tool dispatch failed",
        );
      }
    });
  }

  /** Returns false for an identical result replay; mismatched/unknown results fail. */
  resolve(toolCallId: string, result: unknown): boolean {
    const serialized = canonical(result);
    if (this.settled.has(toolCallId)) {
      if (this.settled.get(toolCallId) !== serialized)
        throw new Error(
          "Frontend tool result conflicts with its previous result",
        );
      return false;
    }
    const pending = this.calls.get(toolCallId);
    if (!pending)
      throw new Error("Unknown, cancelled, or expired frontend tool result");
    this.calls.delete(toolCallId);
    pending.dispose();
    this.settled.set(toolCallId, serialized);
    pending.resolve(JSON.parse(serialized));
    return true;
  }

  cancel(reason = "Frontend tool cancelled"): void {
    for (const [id, pending] of this.calls) {
      this.calls.delete(id);
      pending.dispose();
      pending.reject(new Error(reason));
    }
  }
}

export type JsonToolSchema = Record<string, unknown>;

const schemaKeywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

/** Validate the JSON Schema subset shared with the Pi tool validator. */
function validateSchema(
  value: unknown,
  depth = 0,
): asserts value is JsonToolSchema {
  if (!record(value) || depth > 16)
    throw new Error(
      "Unsupported frontend tool schema: expected a bounded object schema",
    );
  for (const key of Object.keys(value)) {
    if (!schemaKeywords.has(key))
      throw new Error(`Unsupported frontend tool schema keyword: ${key}`);
  }
  if (
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(value.type as string)
  ) {
    throw new Error(
      "Unsupported frontend tool schema: an explicit single type is required",
    );
  }
  if (value.properties !== undefined) {
    if (value.type !== "object" || !record(value.properties))
      throw new Error("Invalid frontend tool properties");
    for (const [key, child] of Object.entries(value.properties)) {
      if (unsafeNames.has(key))
        throw new Error("Unsafe frontend tool property name");
      validateSchema(child, depth + 1);
    }
  }
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) ||
      value.required.some(
        (key) =>
          typeof key !== "string" ||
          !record(value.properties) ||
          !has(value.properties, key),
      ))
  ) {
    throw new Error(
      "Frontend tool required fields must name declared properties",
    );
  }
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== "boolean"
  )
    validateSchema(value.additionalProperties, depth + 1);
  if (value.type === "array") validateSchema(value.items, depth + 1);
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || value.enum.length === 0)
  )
    throw new Error("Invalid frontend tool enum");
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    )
      throw new Error(`Invalid schema ${key}`);
  }
  if (value.multipleOf !== undefined && (value.multipleOf as number) <= 0)
    throw new Error("Invalid schema multipleOf");
  for (const key of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ]) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    )
      throw new Error(`Invalid schema ${key}`);
  }
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== "string" || value.pattern.length > 256)
      throw new Error("Invalid schema pattern");
    try {
      new RegExp(value.pattern);
    } catch {
      throw new Error("Invalid schema pattern");
    }
  }
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean")
    throw new Error("Invalid schema uniqueItems");
  canonical(value);
}

export function validateFrontendTools<
  T extends { name: string; parameters: unknown },
>(tools: readonly T[]): T[] {
  const names = new Set<string>();
  for (const tool of tools) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) ||
      unsafeNames.has(tool.name)
    )
      throw new Error("Invalid frontend tool name");
    if (names.has(tool.name))
      throw new Error(`Duplicate frontend tool name: ${tool.name}`);
    names.add(tool.name);
    validateSchema(tool.parameters);
    if (tool.parameters.type !== "object")
      throw new Error("Frontend tool parameters must be object-rooted");
  }
  return [...tools];
}

/** Reject arguments that do not satisfy the admitted JSON Schema subset. */
export function assertToolArguments(
  schema: JsonToolSchema,
  value: unknown,
  path = "arguments",
): void {
  canonical(value);
  const type = schema.type;
  const valid =
    type === "null"
      ? value === null
      : type === "array"
        ? Array.isArray(value)
        : type === "object"
          ? record(value)
          : type === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : typeof value === type;
  if (!valid) throw new Error(`${path} must be ${String(type)}`);
  if (
    schema.enum &&
    !(schema.enum as unknown[]).some(
      (item) => canonical(item) === canonical(value),
    )
  )
    throw new Error(`${path} is not in enum`);
  if (has(schema, "const") && canonical(value) !== canonical(schema.const))
    throw new Error(`${path} does not match const`);
  if (typeof value === "string") {
    if (
      (schema.minLength !== undefined &&
        [...value].length < (schema.minLength as number)) ||
      (schema.maxLength !== undefined &&
        [...value].length > (schema.maxLength as number))
    )
      throw new Error(`${path} has invalid length`);
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern as string).test(value)
    )
      throw new Error(`${path} does not match pattern`);
  }
  if (typeof value === "number") {
    if (
      (schema.minimum !== undefined && value < (schema.minimum as number)) ||
      (schema.maximum !== undefined && value > (schema.maximum as number)) ||
      (schema.exclusiveMinimum !== undefined &&
        value <= (schema.exclusiveMinimum as number)) ||
      (schema.exclusiveMaximum !== undefined &&
        value >= (schema.exclusiveMaximum as number))
    )
      throw new Error(`${path} is outside its range`);
    if (
      schema.multipleOf !== undefined &&
      Math.abs(
        value / (schema.multipleOf as number) -
          Math.round(value / (schema.multipleOf as number)),
      ) > 1e-10
    )
      throw new Error(`${path} is not a multipleOf`);
  }
  if (Array.isArray(value)) {
    if (
      (schema.minItems !== undefined &&
        value.length < (schema.minItems as number)) ||
      (schema.maxItems !== undefined &&
        value.length > (schema.maxItems as number))
    )
      throw new Error(`${path} has invalid item count`);
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => canonical(item))).size !== value.length
    )
      throw new Error(`${path} items must be unique`);
    value.forEach((item, index) =>
      assertToolArguments(
        schema.items as JsonToolSchema,
        item,
        `${path}[${index}]`,
      ),
    );
  } else if (record(value)) {
    const properties = (schema.properties ?? {}) as Record<
      string,
      JsonToolSchema
    >;
    for (const key of (schema.required ?? []) as string[])
      if (!has(value, key)) throw new Error(`${path}.${key} is required`);
    const keys = Object.keys(value);
    if (
      (schema.minProperties !== undefined &&
        keys.length < (schema.minProperties as number)) ||
      (schema.maxProperties !== undefined &&
        keys.length > (schema.maxProperties as number))
    )
      throw new Error(`${path} has invalid property count`);
    for (const key of keys) {
      if (unsafeNames.has(key))
        throw new Error(`${path} contains unsafe property name`);
      if (has(properties, key))
        assertToolArguments(properties[key], value[key], `${path}.${key}`);
      else if (schema.additionalProperties === false)
        throw new Error(`${path}.${key} is not allowed`);
      else if (record(schema.additionalProperties))
        assertToolArguments(
          schema.additionalProperties,
          value[key],
          `${path}.${key}`,
        );
    }
  }
}
