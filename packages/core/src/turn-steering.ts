import { Buffer } from "node:buffer";

import type {
  TurnSteeringDrain,
  TurnSteeringInput,
  TurnSteeringSource,
} from "@recurs/contracts";

export const MAX_PENDING_STEERING_INPUTS = 4;
export const MAX_STEERING_INPUT_BYTES = 16 * 1024;
export const MAX_PENDING_STEERING_BYTES = 32 * 1024;

export type TurnSteeringEnqueueResult =
  | { accepted: true; pending: number }
  | { accepted: false; reason: "closed" | "full" | "too_large" };

export class TurnSteeringQueue implements TurnSteeringSource {
  readonly #inputs: TurnSteeringInput[] = [];
  #pendingBytes = 0;
  #closed = false;

  constructor(readonly turnId: string) {
    if (turnId.trim().length === 0) {
      throw new Error("A steering turn id is required");
    }
  }

  get isOpen(): boolean {
    return !this.#closed;
  }

  get pending(): number {
    return this.#inputs.length;
  }

  enqueue(input: TurnSteeringInput): TurnSteeringEnqueueResult {
    if (this.#closed) return { accepted: false, reason: "closed" };
    const bytes = Buffer.byteLength(input.prompt, "utf8");
    if (bytes > MAX_STEERING_INPUT_BYTES) {
      return { accepted: false, reason: "too_large" };
    }
    if (
      this.#inputs.length >= MAX_PENDING_STEERING_INPUTS ||
      this.#pendingBytes + bytes > MAX_PENDING_STEERING_BYTES
    ) {
      return { accepted: false, reason: "full" };
    }
    this.#inputs.push(structuredClone(input));
    this.#pendingBytes += bytes;
    return { accepted: true, pending: this.#inputs.length };
  }

  drain(): readonly TurnSteeringInput[] {
    if (this.#inputs.length === 0) return [];
    const inputs = this.#inputs.splice(0);
    this.#pendingBytes = 0;
    return inputs;
  }

  drainOrClose(): TurnSteeringDrain {
    const inputs = this.drain();
    if (inputs.length > 0) return { inputs, closed: false };
    this.#closed = true;
    return { inputs, closed: true };
  }

  close(): readonly TurnSteeringInput[] {
    this.#closed = true;
    return this.drain();
  }
}
