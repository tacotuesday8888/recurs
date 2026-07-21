import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionEngine,
  ToolRegistry,
  createTypeScriptDiagnosticsTool,
  type ApprovalHandler,
  type ToolContext,
} from "../src/index.js";

let cwd: string;
let outside: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "recurs-ts-diagnostics-"));
  outside = await mkdtemp(path.join(tmpdir(), "recurs-ts-diagnostics-outside-"));
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

function context(signal = new AbortController().signal): ToolContext {
  return {
    sessionId: "typescript-diagnostics-session",
    cwd,
    signal,
    executionMode: "plan",
    readRevisions: new Map(),
  };
}

async function invoke(arguments_: unknown, toolContext = context()) {
  const tool = createTypeScriptDiagnosticsTool();
  return new ToolRegistry([tool]).invoke(
    {
      id: "typescript-diagnostics-call",
      name: tool.definition.name,
      arguments: arguments_,
    },
    toolContext,
    new PermissionEngine("full_access"),
    deny,
  );
}

describe("typescript_diagnostics", () => {
  it("type-checks the default project in Plan mode without emitting files", async () => {
    await writeFile(path.join(cwd, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        incremental: true,
        outDir: "dist",
        strict: true,
        target: "ES2022",
      },
      include: ["src/**/*.ts"],
    }));
    await mkdir(path.join(cwd, "src"));
    await writeFile(
      path.join(cwd, "src", "index.ts"),
      "export const answer: number = 42;\n",
    );

    const result = await invoke({});

    expect(result.output).toBe("No TypeScript diagnostics in tsconfig.json.\n");
    expect(result.metadata).toEqual({
      project: "tsconfig.json",
      status: "clean",
      diagnosticCount: 0,
      exitCode: 0,
      evidence: ["tsconfig.json type-check passed without emit"],
    });
    await expect(readFile(path.join(cwd, "tsconfig.tsbuildinfo")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(cwd, "dist", "index.js")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns compiler issues as evidence instead of hiding a nonzero exit", async () => {
    await mkdir(path.join(cwd, "packages", "app"), { recursive: true });
    await writeFile(
      path.join(cwd, "packages", "app", "tsconfig.build.json"),
      JSON.stringify({ compilerOptions: { strict: true }, files: ["index.ts"] }),
    );
    await writeFile(
      path.join(cwd, "packages", "app", "index.ts"),
      "const count: number = 'wrong';\nconst enabled: boolean = 1;\n",
    );

    const result = await invoke({ project: "packages/app/tsconfig.build.json" });

    expect(result.output).toContain("error TS2322");
    expect(result.output).toContain("Type 'string' is not assignable to type 'number'");
    expect(result.metadata).toEqual({
      project: "packages/app/tsconfig.build.json",
      status: "issues",
      diagnosticCount: 2,
      exitCode: 2,
      evidence: [
        "packages/app/tsconfig.build.json reported 2 TypeScript diagnostics",
      ],
    });
  });

  it("rejects projects that resolve outside the workspace", async () => {
    const outsideProject = path.join(outside, "tsconfig.json");
    await writeFile(outsideProject, "{}");
    await symlink(outsideProject, path.join(cwd, "tsconfig.json"));

    await expect(invoke({ project: "tsconfig.json" }))
      .rejects.toMatchObject({ code: "external_path" });
  });

  it("validates project files, options, and cancellation", async () => {
    await mkdir(path.join(cwd, "config"));
    await expect(invoke({ project: "config" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke({ unexpected: true }))
      .rejects.toMatchObject({ code: "invalid_input" });

    await writeFile(path.join(cwd, "tsconfig.json"), "{}");
    const controller = new AbortController();
    controller.abort();
    await expect(invoke({}, context(controller.signal)))
      .rejects.toMatchObject({ code: "cancelled" });
  });
});
