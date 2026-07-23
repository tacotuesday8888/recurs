#!/usr/bin/env node

const [{ runCliProcess }, { loadPtyDriver }] = await Promise.all([
  import("./process-host.js"),
  import("./pty-driver.js"),
]);
const ptyDriver = await loadPtyDriver();
await runCliProcess(ptyDriver === undefined ? {} : { ptyDriver });
