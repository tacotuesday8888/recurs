import { createHash } from "node:crypto";

import type { ToolResult } from "@recurs/tools";

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (typeof value === "bigint") {
    return `[bigint:${value.toString()}]`;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item, seen)]),
  );
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet())) ?? "[undefined]";
}

export function createToolInteractionSignature(
  toolName: string,
  input: unknown,
  result: ToolResult,
): string {
  return createHash("sha256")
    .update(toolName.trim().toLowerCase())
    .update("\0")
    .update(stableSerialize(input))
    .update("\0")
    .update(stableSerialize(result))
    .digest("hex");
}

export class LoopDetector {
  readonly #signatures: string[] = [];

  constructor(
    private readonly threshold = 3,
    private readonly windowSize = 8,
  ) {
    if (threshold < 2 || windowSize < threshold) {
      throw new RangeError("Loop detection requires 2 <= threshold <= windowSize");
    }
  }

  observe(toolName: string, input: unknown, result: ToolResult): boolean {
    const signature = createToolInteractionSignature(toolName, input, result);
    this.#signatures.push(signature);
    if (this.#signatures.length > this.windowSize) {
      this.#signatures.shift();
    }
    return this.#signatures.filter((item) => item === signature).length >= this.threshold;
  }
}
