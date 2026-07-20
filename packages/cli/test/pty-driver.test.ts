import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  OwnedProcessManager,
  PermissionEngine,
  ToolRegistry,
  createProcessSessionTool,
  createRunCommandTool,
  type ApprovalHandler,
  type ToolContext,
} from "@recurs/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPtyDriver } from "../src/pty-driver.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "recurs-pty-driver-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

function context(): ToolContext {
  return {
    sessionId: "pty-owner",
    cwd,
    signal: new AbortController().signal,
    executionMode: "act",
    readRevisions: new Map(),
  };
}

describe("ordinary CLI PTY driver", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "runs a real TTY and applies terminal resize and input",
    async () => {
      const driver = await loadPtyDriver();
      expect(driver).toBeDefined();
      const processes = new OwnedProcessManager({ ptyDriver: driver });
      const registry = new ToolRegistry([
        createRunCommandTool(processes),
        createProcessSessionTool(processes),
      ]);
      const invoke = (name: string, arguments_: unknown) => registry.invoke(
        { id: `${name}-call`, name, arguments: arguments_ },
        context(),
        new PermissionEngine("full_access"),
        deny,
      );

      try {
        const started = await invoke("run_command", {
          command: "test -t 0 && test -t 1 && printf 'READY\\n'; read value; stty size; printf 'VALUE:%s\\n' \"$value\"",
          tty: true,
          timeoutMs: 5_000,
          yieldTimeMs: 250,
        });
        expect(started.metadata).toMatchObject({
          status: "running",
          terminal: true,
        });
        const sessionId = started.metadata?.sessionId;
        const ready = started.output.includes("READY")
          ? started
          : await invoke("process_session", {
              action: "poll",
              sessionId,
              yieldTimeMs: 2_000,
            });
        expect(ready.output).toContain("READY");

        await invoke("process_session", {
          action: "resize",
          sessionId,
          columns: 100,
          rows: 40,
        });
        const written = await invoke("process_session", {
          action: "write",
          sessionId,
          input: "hello\n",
          yieldTimeMs: 5_000,
        });
        let finished = written;
        let output = written.output;
        for (let attempt = 0; attempt < 5 && finished.metadata?.status === "running"; attempt += 1) {
          finished = await invoke("process_session", {
            action: "poll",
            sessionId,
            yieldTimeMs: 5_000,
          });
          output += `\n${finished.output}`;
        }
        expect(output).toContain("40 100");
        expect(output).toContain("VALUE:hello");
        expect(finished.metadata).toMatchObject({
          status: "exited",
          exitCode: 0,
          terminal: true,
        });
      } finally {
        await processes.close();
      }
    },
  );

  it("returns unavailable when the optional PTY module cannot load", async () => {
    const driver = await loadPtyDriver(async () => {
      throw new Error("optional package unavailable");
    });
    expect(driver).toBeUndefined();
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "keeps a real terminal inside the workspace process sandbox",
    async () => {
      const driver = await loadPtyDriver();
      expect(driver).toBeDefined();
      const processes = new OwnedProcessManager({ ptyDriver: driver });
      const registry = new ToolRegistry([
        createRunCommandTool(processes),
      ], { securityProfile: "workspace_sandboxed" });
      const inside = path.join(cwd, "inside.txt");
      const outside = path.join(
        tmpdir(),
        `recurs-pty-outside-${process.pid}-${Date.now()}`,
      );
      try {
        await expect(registry.invoke(
          {
            id: "sandboxed-terminal-call",
            name: "run_command",
            arguments: {
              command: `printf inside > ${JSON.stringify(inside)}; printf outside > ${JSON.stringify(outside)}`,
              tty: true,
              timeoutMs: 5_000,
              yieldTimeMs: 5_000,
            },
          },
          context(),
          new PermissionEngine("full_access"),
          deny,
        )).rejects.toMatchObject({ code: "process_failed" });
        expect(await readFile(inside, "utf8")).toBe("inside");
        await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await processes.close();
        await rm(outside, { force: true });
      }
    },
  );
});
