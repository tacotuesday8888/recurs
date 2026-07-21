import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ImageInputError,
  loadImageInputs,
  normalizeInlineImage,
} from "../src/image-input.js";

const PNG = Buffer.from("iVBORw0KGgo=", "base64");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("image input", () => {
  it("reads explicit regular files into path-free normalized image data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-images-"));
    directories.push(root);
    await writeFile(path.join(root, "screen.bin"), PNG);

    const images = await loadImageInputs(["screen.bin"], root);

    expect(images).toEqual([{
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    }]);
    expect(JSON.stringify(images)).not.toContain(root);
  });

  it("rejects symlinks, unsupported bytes, and claimed media mismatches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-images-"));
    directories.push(root);
    await writeFile(path.join(root, "screen.png"), PNG);
    await writeFile(path.join(root, "notes.bin"), "not an image");
    await symlink(path.join(root, "screen.png"), path.join(root, "linked.png"));

    await expect(loadImageInputs(["linked.png"], root)).rejects
      .toBeInstanceOf(ImageInputError);
    await expect(loadImageInputs(["notes.bin"], root)).rejects
      .toThrow("PNG, JPEG, or WebP");
    expect(() => normalizeInlineImage("iVBORw0KGgo=", "image/jpeg"))
      .toThrow("does not match");
  });
});
