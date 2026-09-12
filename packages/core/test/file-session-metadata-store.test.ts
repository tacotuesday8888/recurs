import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FileSessionMetadataStore } from "../src/file-session-metadata-store.js";

let directory: string;
beforeEach(async () => { directory = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-chat-metadata-"))); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it("preserves independent updates from concurrent chat organizers", async () => {
  const first = new FileSessionMetadataStore(path.join(directory, "metadata"));
  const second = new FileSessionMetadataStore(path.join(directory, "metadata"));
  await first.update("chat", { title: "Parser review" });
  await Promise.all([first.update("chat", { pinned: true }), second.update("chat", { archived: true })]);
  expect(await first.list()).toEqual([{ id: "chat", title: "Parser review", pinned: true, archived: true }]);
});
it("rejects empty, oversized and terminal control titles without corrupting saved metadata", async () => {
  const store = new FileSessionMetadataStore(path.join(directory, "metadata"));
  await store.update("chat", { title: "Safe title" });
  for (const title of ["", "   ", "a".repeat(121), "unsafe\u001b[31m", "hidden\u202e"]) {
    await expect(store.update("chat", { title })).rejects.toThrow("printable characters");
  }
  expect((await store.list())[0]?.title).toBe("Safe title");
});
