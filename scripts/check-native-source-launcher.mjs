import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import console from "node:console";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const debugProducts = path.join(repositoryRoot, "native/macos/.build/debug");
const launcher = path.join(debugProducts, "recurs-native-launcher");
const broker = path.join(debugProducts, "recurs-native-broker");

const empty = Buffer.alloc(0);
const unsignedHealth = Buffer.from(
  '{"nativeAuthority":{"reason":"production_signing_required","state":"unavailable"},"version":1}\n',
  "utf8",
);

function expectProcess(label, executable, arguments_, expected, options = {}) {
  const result = spawnSync(executable, arguments_, {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
    ...options,
  });

  if (result.error) {
    throw new Error(`${label}: process could not be started`);
  }
  if (result.signal !== null || result.status !== expected.status) {
    throw new Error(`${label}: unexpected process termination`);
  }
  if (!Buffer.from(result.stdout ?? empty).equals(expected.stdout)) {
    throw new Error(`${label}: unexpected standard output`);
  }
  if (!Buffer.from(result.stderr ?? empty).equals(empty)) {
    throw new Error(`${label}: unexpected standard error`);
  }
}

try {
  expectProcess(
    "unsigned launcher native health",
    launcher,
    ["native-health", "--machine"],
    { status: 0, stdout: unsignedHealth },
  );
  const hostile = mkdtempSync(path.join(tmpdir(), "recurs-source-launcher-"));
  try {
    const fakeNode = path.join(hostile, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const environment = {
      HOME: hostile,
      PATH: hostile,
      TMPDIR: hostile,
      RECURS_ENGINE_PATH: path.join(hostile, "engine.js"),
      RECURS_NATIVE_FD: "3",
      NODE_OPTIONS: "SECRET_SOURCE_LAUNCHER_CANARY",
      AWS_SECRET_ACCESS_KEY: "SECRET_SOURCE_LAUNCHER_CANARY",
    };
    for (const arguments_ of [
      [],
      [path.join(hostile, "engine.js")],
      ["doctor", "native", "--json"],
    ]) {
      expectProcess(
        "unsigned launcher engine path",
        launcher,
        arguments_,
        { status: 78, stdout: empty },
        { cwd: hostile, env: environment },
      );
    }
  } finally {
    rmSync(hostile, { recursive: true, force: true });
  }
  expectProcess("unsigned broker startup", broker, [], {
    status: 78,
    stdout: empty,
  });
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown failure";
  console.error(`native source smoke failed: ${reason}`);
  process.exit(1);
}

console.log("native source smoke passed");
