import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReadFileTool, PermissionEngine, ToolRegistry, runProcess } from "../src/index.js";

const canary = "TEST_ONLY_RECURS_MCP_CREDENTIAL_CANARY";

describe("MCP credential directory boundary", () => {
  it.each(["inside", "outside"])("blocks direct tools and real subprocesses for credentials %s the workspace", async (location) => {
    const temporary = await mkdtemp(path.join(tmpdir(), "recurs-credential-boundary-"));
    const root = await realpath(temporary);
    const workspace = path.join(root, "workspace");
    const auth = path.join(location === "inside" ? workspace : root, "custom-home", "auth");
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(path.join(auth, "mcp", "server"), { recursive: true, mode: 0o700 });
    const credentials = path.join(auth, "mcp", "server", "credentials");
    await writeFile(credentials, canary, { mode: 0o600 });
    await writeFile(path.join(workspace, "public.txt"), "public-readable", { mode: 0o600 });
    try {
      const registry = new ToolRegistry([], { securityProfile: "workspace_sandboxed", deniedReadPaths: [auth] });
      registry.register(createReadFileTool());
      await expect(registry.invoke({ id: "read", name: "read_file", arguments: { path: credentials } }, {
        sessionId: "test", cwd: workspace, executionMode: "act", signal: new AbortController().signal, readRevisions: new Map(),
      }, new PermissionEngine("full_access"), { request: async () => "allow_once" })).rejects.toMatchObject({ code: "permission_denied" });
      const sandbox = { mode: "workspace" as const, network: "deny" as const, deniedReadPaths: [auth] };
      // Positive control proves a real sandbox launch; an outer-host sandbox failure cannot pass.
      const positive = await runProcess(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync('public.txt','utf8'))"], { cwd: workspace, sandbox });
      expect(positive.stdout).toBe("public-readable");
      const negative = await runProcess(process.execPath, ["-e", "try { process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8')); } catch { process.stdout.write('DENIED'); }", credentials], { cwd: workspace, sandbox });
      expect(negative.stdout).toBe("DENIED");
      expect(JSON.stringify(negative)).not.toContain(canary);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  it("fails closed if a protected directory is replaced by a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-credential-symlink-"));
    try {
      const auth = path.join(root, "auth");
      const target = path.join(root, "target");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, auth);
      await expect(runProcess(process.execPath, ["-e", "console.log('unsafe')"], {
        cwd: root, sandbox: { mode: "workspace", network: "deny", deniedReadPaths: [auth] },
      })).rejects.toMatchObject({ code: "sandbox_unavailable" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
