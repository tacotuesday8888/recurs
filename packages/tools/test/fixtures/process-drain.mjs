/* global process, setImmediate, setInterval */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [stateFile, terminatedFile, mode] = process.argv.slice(2);

if (mode === "descendant") {
  const parentPid = process.ppid;

  process.on("SIGHUP", () => {});
  process.on("SIGTERM", () => writeFileSync(terminatedFile, "terminated"));
  process.on("SIGUSR1", () => {
    process.stdout.write("drained\n", () => process.exit(0));
  });

  setInterval(() => {}, 60_000);
  process.send?.("ready", waitForParentExit);

  function waitForParentExit() {
    try {
      process.kill(parentPid, 0);
      setImmediate(waitForParentExit);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      writeFileSync(stateFile, String(process.pid));
    }
  }
} else {
  const fixture = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [fixture, stateFile, terminatedFile, "descendant"],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );

  child.once("message", () => {
    child.disconnect();
    child.unref();
  });
}
