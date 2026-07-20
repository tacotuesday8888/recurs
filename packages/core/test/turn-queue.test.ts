import { describe, expect, it } from "vitest";

import {
  MAX_PENDING_QUEUED_TURNS,
  MAX_QUEUED_TURN_BYTES,
  QueuedTurnAdmissionQueue,
} from "../src/index.js";

function input(id: string, prompt = id) {
  return { id, prompt, at: "2026-07-10T00:00:00.000Z" };
}

describe("QueuedTurnAdmissionQueue", () => {
  it("acknowledges admission only after durable persistence", async () => {
    const queue = new QueuedTurnAdmissionQueue("turn-1");
    const admitted = queue.enqueue(input("one"));
    expect(admitted).toMatchObject({ accepted: true, pending: 1 });
    if (!admitted.accepted) throw new Error("Expected queue admission");

    let acknowledged = false;
    void admitted.persisted.then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(queue.drain()).toEqual([input("one")]);

    queue.persisted("one");
    await admitted.persisted;
    expect(acknowledged).toBe(true);
    expect(queue.pending).toBe(0);
  });

  it("atomically closes only after every admitted item is drained", async () => {
    const queue = new QueuedTurnAdmissionQueue("turn-1");
    const admitted = queue.enqueue(input("one"));
    if (!admitted.accepted) throw new Error("Expected queue admission");
    expect(queue.drainOrClose()).toEqual({
      inputs: [input("one")],
      closed: false,
    });
    queue.persisted("one");
    await admitted.persisted;
    expect(queue.drainOrClose()).toEqual({ inputs: [], closed: true });
    expect(queue.enqueue(input("late"))).toEqual({
      accepted: false,
      reason: "closed",
    });
  });

  it("rejects unsettled admissions when the active turn closes", async () => {
    const queue = new QueuedTurnAdmissionQueue("turn-1");
    const admitted = queue.enqueue(input("one"));
    if (!admitted.accepted) throw new Error("Expected queue admission");

    expect(queue.close("cancelled")).toEqual([input("one")]);
    await expect(admitted.persisted).rejects.toThrow("cancelled");
    expect(queue.pending).toBe(0);
  });

  it("lets an in-flight durable append settle after admission closes", async () => {
    const queue = new QueuedTurnAdmissionQueue("turn-1");
    const admitted = queue.enqueue(input("one"));
    if (!admitted.accepted) throw new Error("Expected queue admission");
    expect(queue.drain()).toEqual([input("one")]);

    queue.close("cancelled");
    queue.persisted("one");

    await expect(admitted.persisted).resolves.toBeUndefined();
    expect(queue.pending).toBe(0);
  });

  it("bounds individual prompts and pending admission count", () => {
    const queue = new QueuedTurnAdmissionQueue("turn-1");
    expect(queue.enqueue(input(
      "large",
      "x".repeat(MAX_QUEUED_TURN_BYTES + 1),
    ))).toEqual({ accepted: false, reason: "too_large" });
    for (let index = 0; index < MAX_PENDING_QUEUED_TURNS; index += 1) {
      const admitted = queue.enqueue(input(`queued-${index}`));
      expect(admitted).toMatchObject({
        accepted: true,
      });
      if (admitted.accepted) void admitted.persisted.catch(() => undefined);
    }
    expect(queue.enqueue(input("overflow"))).toEqual({
      accepted: false,
      reason: "full",
    });
    queue.close();
  });
});
