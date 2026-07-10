import { describe, expect, it } from "vitest";

import {
  LoopDetector,
  createToolInteractionSignature,
} from "../src/index.js";

describe("LoopDetector", () => {
  it("normalizes object key order when creating signatures", () => {
    const first = createToolInteractionSignature("echo", { a: 1, b: 2 }, {
      output: "same",
      metadata: { z: true, a: false },
    });
    const second = createToolInteractionSignature(" echo ", { b: 2, a: 1 }, {
      metadata: { a: false, z: true },
      output: "same",
    });

    expect(first).toBe(second);
  });

  it("declares a loop after three matching interactions in the latest eight", () => {
    const detector = new LoopDetector();

    expect(detector.observe("echo", { text: "same" }, { output: "same" })).toBe(false);
    expect(detector.observe("echo", { text: "other" }, { output: "other" })).toBe(false);
    expect(detector.observe("echo", { text: "same" }, { output: "same" })).toBe(false);
    expect(detector.observe("echo", { text: "same" }, { output: "same" })).toBe(true);
  });

  it("forgets matching interactions that leave the rolling window", () => {
    const detector = new LoopDetector(3, 3);
    detector.observe("echo", { value: "same" }, { output: "same" });
    detector.observe("echo", { value: 1 }, { output: "1" });
    detector.observe("echo", { value: 2 }, { output: "2" });
    detector.observe("echo", { value: 3 }, { output: "3" });

    expect(detector.observe("echo", { value: "same" }, { output: "same" })).toBe(false);
  });
});
