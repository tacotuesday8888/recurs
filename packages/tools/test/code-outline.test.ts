import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionEngine,
  ToolRegistry,
  createCodeOutlineTool,
  type ApprovalHandler,
  type ToolContext,
} from "../src/index.js";

let cwd: string;
let outside: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "recurs-code-outline-"));
  outside = await mkdtemp(path.join(tmpdir(), "recurs-code-outline-outside-"));
  await mkdir(path.join(cwd, "src"));
});

afterEach(async () => {
  await Promise.all([
    rm(cwd, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

function context(): ToolContext {
  return {
    sessionId: "outline-owner",
    cwd,
    signal: new AbortController().signal,
    executionMode: "act",
    readRevisions: new Map(),
  };
}

async function invoke(
  arguments_: unknown,
  toolContext = context(),
  approvals: ApprovalHandler = deny,
) {
  const tool = createCodeOutlineTool();
  return new ToolRegistry([tool]).invoke(
    { id: "outline-call", name: tool.definition.name, arguments: arguments_ },
    toolContext,
    new PermissionEngine("full_access"),
    approvals,
  );
}

describe("code_outline", () => {
  it("returns deterministic lexical declarations across supported languages", async () => {
    await writeFile(path.join(cwd, "src", "index.ts"), [
      "export interface Config { enabled: boolean }",
      "export class Runner {}",
      "export async function start() {}",
      "const helper = (value: string) => value;",
      "// class CommentedOut {}",
      "",
    ].join("\n"));
    await writeFile(path.join(cwd, "src", "worker.py"), [
      "class Worker:",
      "    async def execute(self):",
      "        return None",
      "",
    ].join("\n"));
    await writeFile(path.join(cwd, "src", "types.rs"), [
      "pub struct Job {}",
      "pub(crate) async fn run() {}",
      "",
    ].join("\n"));

    const result = await invoke({ path: "src" });

    expect(result.output).toBe([
      "src/index.ts [TypeScript/JavaScript]",
      "  1  interface Config",
      "  2  class Runner",
      "  3  function start",
      "  4  function helper",
      "src/types.rs [Rust]",
      "  1  struct Job",
      "  2  function run",
      "src/worker.py [Python]",
      "  1  class Worker",
      "  2  function execute",
      "",
    ].join("\n"));
    expect(result.metadata).toMatchObject({
      path: "src",
      scannedFiles: 3,
      matchedFiles: 3,
      symbols: 8,
      lexical: true,
      truncated: false,
      languages: ["Python", "Rust", "TypeScript/JavaScript"],
      sources: ["outlined 3 files under src (8 lexical declarations)"],
    });
  });

  it("uses a query to locate and filter declarations without returning references", async () => {
    await writeFile(path.join(cwd, "src", "tasks.ts"), [
      "export class Worker {}",
      "export function unrelated() {}",
      "",
    ].join("\n"));
    await writeFile(
      path.join(cwd, "src", "consumer.ts"),
      "const active = new Worker();\n",
    );

    const result = await invoke({ path: ".", query: "worker" });

    expect(result.output).toBe([
      "src/tasks.ts [TypeScript/JavaScript]",
      "  1  class Worker",
      "",
    ].join("\n"));
    expect(result.metadata).toMatchObject({ query: "worker", symbols: 1 });
    expect(result.output).not.toContain("unrelated");
    expect(result.output).not.toContain("consumer.ts");
  });

  it("includes all declarations when the query matches the source path", async () => {
    await writeFile(path.join(cwd, "src", "helpers.ts"), [
      "export function first() {}",
      "export function second() {}",
      "",
    ].join("\n"));

    const result = await invoke({ path: "src", query: "helpers" });

    expect(result.output).toContain("function first");
    expect(result.output).toContain("function second");
  });

  it("ranks central declarations by distinct cross-file references", async () => {
    await writeFile(path.join(cwd, "src", "core.ts"), "export class Coordinator {}\n");
    await writeFile(path.join(cwd, "src", "first.ts"), [
      "export function first() {",
      "  return new Coordinator();",
      "}",
      "",
    ].join("\n"));
    await writeFile(path.join(cwd, "src", "second.ts"), [
      "export function second() {",
      "  return Coordinator;",
      "}",
      "",
    ].join("\n"));
    await writeFile(path.join(cwd, "src", "orphan.ts"), "export class Orphan {}\n");

    const result = await invoke({
      path: "src",
      ranking: "references",
      maxSymbols: 1,
    });

    expect(result.output).toBe([
      "src/core.ts [TypeScript/JavaScript] (referenced by 2 files)",
      "  1  class Coordinator (referenced by 2 files)",
      "",
    ].join("\n"));
    expect(result.metadata).toMatchObject({
      ranking: "references",
      scannedFiles: 4,
      matchedFiles: 1,
      symbols: 1,
      indexedSymbols: 4,
      referenceEdges: 2,
      lexical: true,
      truncated: true,
    });
  });

  it("uses exact lexical identifiers and counts each referring file once", async () => {
    await writeFile(path.join(cwd, "src", "types.ts"), [
      "export class Run {}",
      "export class Runner {}",
      "",
    ].join("\n"));
    await writeFile(path.join(cwd, "src", "consumer.ts"), [
      "export function consume() {",
      "  return [Runner, Runner];",
      "}",
      "",
    ].join("\n"));

    const result = await invoke({ path: "src", ranking: "references", maxSymbols: 2 });

    expect(result.output).toContain("class Runner (referenced by 1 file)");
    expect(result.output).toContain("class Run (referenced by 0 files)");
  });

  it("lets a query focus a ranked map without excluding surrounding symbols", async () => {
    await writeFile(path.join(cwd, "src", "central.ts"), "export class Central {}\n");
    await writeFile(path.join(cwd, "src", "consumer.ts"), [
      "export function use() {",
      "  return [Central, Needle];",
      "}",
      "",
    ].join("\n"));
    await writeFile(path.join(cwd, "src", "target.ts"), "export class Needle {}\n");

    const result = await invoke({
      path: "src",
      query: "needle",
      ranking: "references",
      maxSymbols: 1,
    });

    expect(result.output).toContain("class Needle");
    expect(result.output).not.toContain("class Central");
    expect(result.metadata).toMatchObject({ query: "needle", ranking: "references" });
  });

  it("enforces file and symbol bounds and reports truncation", async () => {
    await writeFile(path.join(cwd, "src", "a.ts"), [
      "export class Alpha {}",
      "export class Beta {}",
      "",
    ].join("\n"));
    await writeFile(path.join(cwd, "src", "b.ts"), "export class Gamma {}\n");

    const symbolBound = await invoke({ path: "src", maxSymbols: 1 });
    const fileBound = await invoke({ path: "src", maxFiles: 1 });

    expect(symbolBound.metadata).toMatchObject({ symbols: 1, truncated: true });
    expect(fileBound.metadata).toMatchObject({ scannedFiles: 1, truncated: true });
  });

  it("omits credentials, binary files, oversized files, and generated trees", async () => {
    await mkdir(path.join(cwd, "dist"));
    await writeFile(path.join(cwd, "src", "safe.ts"), "export class Safe {}\n");
    await writeFile(path.join(cwd, "src", ".env.ts"), "export class Secret {}\n");
    await writeFile(path.join(cwd, "src", "binary.ts"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(cwd, "src", "large.ts"), "x".repeat(256 * 1024 + 1));
    await writeFile(path.join(cwd, "dist", "bundle.js"), "export class Generated {}\n");

    const result = await invoke({ path: "." });

    expect(result.output).toContain("class Safe");
    expect(result.output).not.toContain("Secret");
    expect(result.output).not.toContain("Generated");
    expect(result.metadata).toMatchObject({
      skippedBinaryFiles: 1,
      skippedLargeFiles: 1,
      skippedGeneratedFiles: 1,
    });
  });

  it("does not treat an outline as a complete-file read revision", async () => {
    await writeFile(path.join(cwd, "src", "safe.ts"), "export class Safe {}\n");
    const toolContext = context();

    await invoke({ path: "src/safe.ts" }, toolContext);

    expect(toolContext.readRevisions.size).toBe(0);
  });

  it("is an approval-free parallel read in Plan mode", async () => {
    await writeFile(path.join(cwd, "src", "safe.ts"), "export class Safe {}\n");
    const tool = createCodeOutlineTool();
    const registry = new ToolRegistry([tool]);
    const toolContext = { ...context(), executionMode: "plan" as const };
    const call = {
      id: "outline-call",
      name: "code_outline",
      arguments: { path: "src" },
    };

    expect(registry.canRunConcurrently(
      call,
      toolContext,
      new PermissionEngine("approved_for_me"),
    )).toBe(true);
    await expect(registry.invoke(
      call,
      toolContext,
      new PermissionEngine("approved_for_me"),
      deny,
    )).resolves.toMatchObject({ output: expect.stringContaining("class Safe") });
  });

  it("omits configured sensitive descendants from aggregate scans", async () => {
    await writeFile(path.join(cwd, "src", "safe.ts"), "export class Safe {}\n");
    await writeFile(path.join(cwd, "src", "private.ts"), "export class Private {}\n");
    const tool = createCodeOutlineTool({ sensitivePatterns: [/private\.ts$/u] });
    const result = await new ToolRegistry([tool]).invoke(
      { id: "outline-call", name: "code_outline", arguments: { path: "src" } },
      context(),
      new PermissionEngine("full_access"),
      deny,
    );

    expect(result.output).toContain("class Safe");
    expect(result.output).not.toContain("Private");
    expect(result.metadata).toMatchObject({ skippedSensitiveFiles: 1 });
  });

  it("requires explicit external-path approval and blocks credential paths", async () => {
    await writeFile(path.join(outside, "external.ts"), "export class External {}\n");
    await writeFile(path.join(cwd, ".env.ts"), "export class Secret {}\n");

    await expect(invoke({ path: path.join(outside, "external.ts") }))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(invoke(
      { path: path.join(outside, "external.ts") },
      context(),
      { async request() { return "allow_once"; } },
    )).resolves.toMatchObject({ output: expect.stringContaining("class External") });
    await expect(invoke({ path: ".env.ts" }, context(), {
      async request() { return "allow_once"; },
    })).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects symlink escapes, unsupported files, invalid bounds, and cancellation", async () => {
    await writeFile(path.join(outside, "escape.ts"), "export class Escape {}\n");
    await symlink(path.join(outside, "escape.ts"), path.join(cwd, "src", "escape.ts"));
    await writeFile(path.join(cwd, "README.md"), "# docs\n");

    await expect(invoke({ path: "src/escape.ts" }))
      .rejects.toMatchObject({ code: "external_path" });
    await expect(invoke({ path: "README.md" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke({ maxFiles: 0 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke({ ranking: "semantic" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke({ query: " ".repeat(2) }))
      .rejects.toMatchObject({ code: "invalid_input" });

    const controller = new AbortController();
    controller.abort();
    await expect(invoke({ path: "src" }, {
      ...context(),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "cancelled" });
  });
});
