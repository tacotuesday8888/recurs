import { Buffer } from "node:buffer";

import {
  MAX_PENDING_QUEUED_TURN_BYTES,
  MAX_PENDING_QUEUED_TURNS,
  MAX_QUEUED_TURN_BYTES,
  type QueuedTurnDrain,
  type QueuedTurnInput,
  type QueuedTurnSource,
} from "@recurs/contracts";

export {
  MAX_PENDING_QUEUED_TURN_BYTES,
  MAX_PENDING_QUEUED_TURNS,
  MAX_QUEUED_TURN_BYTES,
} from "@recurs/contracts";

export type QueuedTurnEnqueueResult =
  | { accepted: true; pending: number; persisted: Promise<void> }
  | { accepted: false; reason: "closed" | "full" | "too_large" };

interface QueueEntry {
  readonly input: QueuedTurnInput;
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  drained: boolean;
}

export class QueuedTurnAdmissionQueue implements QueuedTurnSource {
  readonly #entries = new Map<string, QueueEntry>();
  #pendingBytes = 0;
  #closed = false;

  constructor(readonly turnId: string) {
    if (turnId.trim().length === 0) {
      throw new Error("A queued-turn source id is required");
    }
  }

  get isOpen(): boolean {
    return !this.#closed;
  }

  get pending(): number {
    return this.#entries.size;
  }

  enqueue(input: QueuedTurnInput): QueuedTurnEnqueueResult {
    if (this.#closed) return { accepted: false, reason: "closed" };
    const bytes = Buffer.byteLength(input.prompt, "utf8");
    if (bytes > MAX_QUEUED_TURN_BYTES) {
      return { accepted: false, reason: "too_large" };
    }
    if (
      this.#entries.has(input.id) ||
      this.#entries.size >= MAX_PENDING_QUEUED_TURNS ||
      this.#pendingBytes + bytes > MAX_PENDING_QUEUED_TURN_BYTES
    ) {
      return { accepted: false, reason: "full" };
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const persisted = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#entries.set(input.id, {
      input: structuredClone(input),
      bytes,
      resolve,
      reject,
      drained: false,
    });
    this.#pendingBytes += bytes;
    return { accepted: true, pending: this.#entries.size, persisted };
  }

  drain(): readonly QueuedTurnInput[] {
    const inputs: QueuedTurnInput[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.drained) continue;
      entry.drained = true;
      inputs.push(structuredClone(entry.input));
    }
    return inputs;
  }

  drainOrClose(): QueuedTurnDrain {
    const inputs = this.drain();
    if (inputs.length > 0) return { inputs, closed: false };
    this.#closed = true;
    return { inputs, closed: true };
  }

  persisted(id: string): void {
    this.#settle(id, undefined);
  }

  rejected(id: string, reason: string): void {
    this.#settle(id, new Error(reason));
  }

  close(reason = "The active turn ended before the queued prompt was persisted"):
    readonly QueuedTurnInput[] {
    this.#closed = true;
    const inputs = [...this.#entries.values()].map((entry) =>
      structuredClone(entry.input)
    );
    for (const [id, entry] of [...this.#entries.entries()]) {
      if (!entry.drained) this.#settle(id, new Error(reason));
    }
    return inputs;
  }

  #settle(id: string, error: Error | undefined): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    this.#pendingBytes -= entry.bytes;
    if (error === undefined) entry.resolve();
    else entry.reject(error);
  }
}
