import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startProcessSession } from "../src/process.js";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("process session descendant cleanup", () => {
  it.each(["ignore", "inherit"])("reaps descendants with %s stdio before normal completion", async (stdio) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "recurs-session-cleanup-"));
    let pid: number | undefined;
    let session: Awaited<ReturnType<typeof startProcessSession>> | undefined;
    try {
      session = await startProcessSession(process.execPath, ["-e", `
        const child = require('node:child_process').spawn('/bin/sleep', ['10'], { stdio: ${JSON.stringify(stdio)} });
        console.log(child.pid);
        child.unref();
      `], { cwd, timeoutMs: 3_000 });
      let output = "";
      session.stdout.on("data", (chunk) => { output += chunk.toString(); });
      expect(await session.completion).toBe(0);
      pid = Number(output.trim());
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(alive(pid)).toBe(false);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      await session?.close().catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
