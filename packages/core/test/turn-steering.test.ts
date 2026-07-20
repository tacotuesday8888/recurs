import { describe, expect, it } from "vitest";

import {
  MAX_PENDING_STEERING_INPUTS,
  MAX_STEERING_INPUT_BYTES,
  TurnSteeringQueue,
} from "../src/index.js";

function input(id: string, prompt = id) {
  return { id, prompt, at: "2026-07-10T00:00:00.000Z" };
}

describe("TurnSteeringQueue", () => {
  it("atomically closes only after the terminal drain finds no input", () => {
    const queue = new TurnSteeringQueue("turn-1");
    expect(queue.enqueue(input("one"))).toEqual({ accepted: true, pending: 1 });
    expect(queue.drainOrClose()).toEqual({ inputs: [input("one")], closed: false });
    expect(queue.isOpen).toBe(true);
    expect(queue.drainOrClose()).toEqual({ inputs: [], closed: true });
    expect(queue.enqueue(input("late"))).toEqual({ accepted: false, reason: "closed" });
  });

  it("bounds individual input and total pending work", () => {
    const queue = new TurnSteeringQueue("turn-1");
    expect(queue.enqueue(input("large", "x".repeat(MAX_STEERING_INPUT_BYTES + 1))))
      .toEqual({ accepted: false, reason: "too_large" });
    for (let index = 0; index < MAX_PENDING_STEERING_INPUTS; index += 1) {
      expect(queue.enqueue(input(`steer-${index}`))).toMatchObject({ accepted: true });
    }
    expect(queue.enqueue(input("overflow"))).toEqual({ accepted: false, reason: "full" });
  });
});
