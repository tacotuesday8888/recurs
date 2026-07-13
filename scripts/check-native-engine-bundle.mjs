import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(root, "scripts/build-native-engine-bundle.mjs");
const fakePeer = path.join(
  root,
  "packages/native-engine/test/fixtures/fake-native-peer.mjs",
);
const componentVersion = await readComponentVersion();
const timeoutMilliseconds = 5_000;
const outputLimit = 64 * 1024;
const canary = "RECURS_NATIVE_BUNDLE_CANARY_7a16b14e";
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "recurs-native-engine-bundle-"),
);

try {
  await assertBuilderRejects([]);
  await assertBuilderRejects(["relative/main.js"]);
  await assertBuilderRejects([
    path.join(temporaryRoot, "invalid.js"),
  ]);
  await assertBuilderRejects([
    path.join(temporaryRoot, "extra", "main.js"),
    "unexpected",
  ]);

  const outputs = ["first", "second"].map((name) =>
    path.join(temporaryRoot, name, "main.js")
  );
  for (const output of outputs) {
    await execFileAsync(process.execPath, [builder, output], { cwd: root });
    await assertSingleArtifact(output);
  }

  const [first, second] = await Promise.all(outputs.map((file) => readFile(file)));
  if (!first.equals(second)) {
    throw new Error("Native engine bundle output is not deterministic.");
  }
  assertBundleShape(first.toString("utf8"));
  await runDoctorSmoke(outputs[0]);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("native engine bundle smoke passed\n");

async function assertSingleArtifact(output) {
  const directory = path.dirname(output);
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0]?.name !== "main.js" ||
    !entries[0].isFile() ||
    entries[0].isSymbolicLink()
  ) {
    throw new Error("Native engine bundle did not produce exactly one main.js file.");
  }
  const metadata = await lstat(output);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Native engine bundle output is not a regular file.");
  }
  await access(output, constants.R_OK);
}

function assertBundleShape(source) {
  const forbidden = [
    [/(?:^|\n)\s*\/\/# sourceMappingURL=/u, "source map reference"],
    [/\b(?:from\s*|import\s*\()\s*["']@recurs\//u, "workspace import"],
    [/\b(?:from\s*|import\s*\()\s*["']\.\.?\//u, "relative import"],
    [/node_modules/u, "node_modules lookup"],
    [/(?:^|["'])packages\//u, "workspace source path"],
    [new RegExp(escapeRegExp(root), "u"), "absolute repository path"],
  ];
  for (const [pattern, description] of forbidden) {
    if (pattern.test(source)) {
      throw new Error(`Native engine bundle contains a ${description}.`);
    }
  }

  const specifiers = [
    ...source.matchAll(
      /\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
    ),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
  ].map((match) => match[1]);
  if (specifiers.some((specifier) => !specifier?.startsWith("node:"))) {
    throw new Error("Native engine bundle externalizes a non-node import.");
  }

  const claim = source.indexOf("const input = claimPrivateEngineInput();");
  const widerHost = source.indexOf(
    "init_native_authority(), native_authority_exports",
    claim,
  );
  if (claim < 0 || widerHost < claim) {
    throw new Error("Native engine bundle changed private bootstrap ordering.");
  }
}

async function assertBuilderRejects(args) {
  try {
    await execFileAsync(process.execPath, [builder, ...args], { cwd: root });
  } catch {
    return;
  }
  throw new Error("Native engine bundle builder accepted invalid arguments.");
}

async function runDoctorSmoke(engine) {
  if (process.platform !== "darwin") return;

  const normal = startFakePeer([]);
  try {
    const result = await runChild(engine, normal.channel);
    if (result.code !== 0 || result.signal !== null || result.stderr !== "") {
      throw new Error("Bundled native engine returned an unexpected process result.");
    }
    if (result.stdout.includes(canary) || result.stderr.includes(canary)) {
      throw new Error("Bundled native engine emitted the environment canary.");
    }
    const expected = {
      version: 1,
      nativeAuthority: {
        state: "unavailable",
        reason: "peer_identity_unverified",
      },
    };
    if (JSON.stringify(JSON.parse(result.stdout)) !== JSON.stringify(expected)) {
      throw new Error("Bundled native engine did not preserve the downgraded health result.");
    }
  } finally {
    normal.channel.destroy();
    normal.peer.kill();
  }

  const interrupted = startFakePeer(["--hang-health"], true);
  let interruptedChild;
  interrupted.peer.stdout.once("data", () => {
    interruptedChild?.kill("SIGINT");
  });
  try {
    const result = await runChild(engine, interrupted.channel, (child) => {
      interruptedChild = child;
    });
    if (
      result.code !== 130 ||
      result.signal !== null ||
      result.stdout !== "" ||
      result.stderr !== "Error: Native authority check was cancelled\n"
    ) {
      throw new Error("Bundled native engine returned an invalid cancellation.");
    }
  } finally {
    interrupted.channel.destroy();
    interrupted.peer.kill();
  }
}

function startFakePeer(args, observeHealth = false) {
  const peer = spawn(
    process.execPath,
    [fakePeer, "--component-version", componentVersion, ...args],
    {
      cwd: root,
      stdio: ["ignore", observeHealth ? "pipe" : "ignore", "ignore", "pipe"],
    },
  );
  peer.once("error", () => {});
  const channel = peer.stdio[3];
  if (channel === null || (observeHealth && peer.stdout === null)) {
    peer.kill();
    throw new Error("Native engine bundle smoke could not create descriptor 3.");
  }
  return { channel, peer };
}

function runChild(engine, descriptor, onSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [engine, "doctor", "native", "--json"], {
      cwd: root,
      env: {
        ...process.env,
        RECURS_HOME: temporaryRoot,
        RECURS_NATIVE_FD: "3",
        RECURS_NATIVE_BUNDLE_CANARY: canary,
      },
      stdio: ["ignore", "pipe", "pipe", descriptor],
    });
    descriptor.destroy();
    let stdout = "";
    let stderr = "";
    let failure;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      if (failure === undefined) resolve(result);
      else reject(failure);
    };
    const append = (current, chunk) => {
      const output = current + chunk;
      if (Buffer.byteLength(output) > outputLimit) {
        terminate(new Error("Bundled native engine smoke exceeded its output bound."));
        return current;
      }
      return output;
    };
    function onStdout(chunk) {
      stdout = append(stdout, chunk);
    }
    function onStderr(chunk) {
      stderr = append(stderr, chunk);
    }
    function onError() {
      terminate(new Error("Bundled native engine smoke could not start."));
    }
    function terminate(error) {
      if (failure !== undefined) return;
      failure = error;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      try {
        child.kill("SIGKILL");
      } catch {
        // The close event remains the single settlement point.
      }
    }

    timer = setTimeout(() => {
      terminate(new Error("Bundled native engine smoke timed out."));
    }, timeoutMilliseconds);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", (code, signal) => {
      finish({ code, signal, stdout, stderr });
    });
    try {
      onSpawn?.(child);
    } catch {
      terminate(new Error("Bundled native engine smoke setup failed."));
    }
  });
}

async function readComponentVersion() {
  let value;
  try {
    value = JSON.parse(
      await readFile(path.join(root, "native/component-version.json"), "utf8"),
    );
  } catch {
    throw new Error("Native engine bundle smoke could not read the component version.");
  }
  if (
    value?.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(
      value.version,
    )
  ) {
    throw new Error("Native engine bundle smoke found an invalid component version.");
  }
  return value.version;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
