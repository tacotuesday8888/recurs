import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import console from "node:console";
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

function expectProcess(label, executable, arguments_, expected) {
  const result = spawnSync(executable, arguments_, {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
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
  expectProcess("launcher invalid arguments", launcher, [], {
    status: 2,
    stdout: empty,
  });
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
