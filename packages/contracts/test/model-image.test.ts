import { describe, expect, it } from "vitest";

import {
  MAX_MODEL_IMAGE_TOTAL_BYTES,
  isModelImageInput,
  modelImageByteLength,
  modelImagesByteLength,
  modelRequestImagesByteLength,
} from "../src/index.js";

describe("model image inputs", () => {
  it("accepts canonical bounded image data", () => {
    const image = { mediaType: "image/png" as const, data: "AAE=" };

    expect(modelImageByteLength(image.data)).toBe(2);
    expect(isModelImageInput(image)).toBe(true);
    expect(modelImagesByteLength([image])).toBe(2);
  });

  it("rejects non-canonical data, unsupported media, and extra fields", () => {
    expect(modelImageByteLength("A")).toBeNull();
    expect(isModelImageInput({ mediaType: "image/gif", data: "AA==" })).toBe(false);
    expect(isModelImageInput({
      mediaType: "image/png",
      data: "AA==",
      path: "/private/input.png",
    })).toBe(false);
  });

  it("enforces count and total decoded byte limits", () => {
    const tiny = { mediaType: "image/jpeg" as const, data: "AA==" };
    expect(modelImagesByteLength([tiny, tiny, tiny, tiny])).toBe(4);
    expect(modelImagesByteLength([tiny, tiny, tiny, tiny, tiny])).toBeNull();

    const tooLarge = Buffer.alloc(MAX_MODEL_IMAGE_TOTAL_BYTES + 1).toString("base64");
    expect(modelImagesByteLength([{ mediaType: "image/webp", data: tooLarge }]))
      .toBeNull();
  });

  it("enforces the aggregate image budget across durable messages", () => {
    const half = Buffer.alloc(MAX_MODEL_IMAGE_TOTAL_BYTES / 2).toString("base64");
    const messages = ["first", "second"].map((id) => ({
      id,
      role: "user" as const,
      content: id,
      images: [{ mediaType: "image/png" as const, data: half }],
    }));

    expect(modelRequestImagesByteLength(messages)).toBe(
      MAX_MODEL_IMAGE_TOTAL_BYTES,
    );
    expect(modelRequestImagesByteLength([
      ...messages,
      {
        id: "third",
        role: "user",
        content: "third",
        images: [{ mediaType: "image/png", data: "AA==" }],
      },
    ])).toBeNull();
  });
});
