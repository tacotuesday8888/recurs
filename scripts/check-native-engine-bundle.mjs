import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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
const builderTimeoutMilliseconds = 30_000;
const peerShutdownMilliseconds = 500;
const outputLimit = 64 * 1024;
const canary = "RECURS_NATIVE_BUNDLE_CANARY_7a16b14e";
const sealedRuntimeUnavailable =
  "Delegated Codex runtime is unavailable in the sealed native engine";
const sealedCliUnavailable =
  "The official Codex onboarding runtime could not be prepared";
const sealedWebSocketUnavailable =
  "Public WebSocket transport is unavailable in the sealed native engine";
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "recurs-native-engine-bundle-"),
);
const isolatedCwd = path.join(temporaryRoot, "isolated-cwd");
const isolatedHome = path.join(temporaryRoot, "isolated-home");
const isolatedData = path.join(temporaryRoot, "isolated-data");
const ambientModules = path.join(temporaryRoot, "ambient-node-modules");
const ambientCanaryMarker = path.join(temporaryRoot, "ambient-canary-loaded");

try {
  await Promise.all([
    mkdir(isolatedCwd, { mode: 0o700 }),
    mkdir(isolatedHome, { mode: 0o700 }),
    mkdir(isolatedData, { mode: 0o700 }),
    createAmbientCanaryPackages(),
  ]);
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
    await runBuilder([output]);
    await assertSingleArtifact(output);
  }

  const [first, second] = await Promise.all(outputs.map((file) => readFile(file)));
  if (!first.equals(second)) {
    throw new Error("Native engine bundle output is not deterministic.");
  }
  assertBundleShape(first.toString("utf8"));
  await runArtifactSmoke(outputs[0]);
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

  const ambientModuleResolvers = [
    [/\bcreateRequire\b/u, "createRequire"],
    [/\brequire\s*(?:\.\s*resolve\s*)?\(/u, "CommonJS module resolution"],
    [/\bimport\.meta\.resolve\s*\(/u, "import.meta.resolve"],
    [
      /\b(?:Module|module)\s*\.\s*(?:createRequire|require|_findPath|_load|_resolveFilename)\b/u,
      "Node module resolver access",
    ],
    [/\bprocess\s*\.\s*(?:dlopen|getBuiltinModule)\s*\(/u, "runtime loader access"],
  ];
  for (const [pattern, description] of ambientModuleResolvers) {
    if (pattern.test(source)) {
      throw new Error(
        `Native engine bundle uses ambient module resolution via ${description}.`,
      );
    }
  }
  if (!source.includes(sealedRuntimeUnavailable)) {
    throw new Error("Native engine bundle omitted the sealed runtime boundary.");
  }
  if (!source.includes(sealedWebSocketUnavailable)) {
    throw new Error("Native engine bundle omitted the sealed WebSocket boundary.");
  }

  const specifiers = [
    ...source.matchAll(
      /\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
    ),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
    ...source.matchAll(
      /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gu,
    ),
  ].map((match) => match[1]);
  if (specifiers.some((specifier) => !specifier?.startsWith("node:"))) {
    throw new Error("Native engine bundle externalizes a non-node import.");
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/gu)) {
    if (!/^["']node:[^"']+["']$/u.test(match[1] ?? "")) {
      throw new Error("Native engine bundle contains a computed dynamic import.");
    }
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

function runBuilder(args) {
  return execFileAsync(process.execPath, [builder, ...args], {
    cwd: root,
    killSignal: "SIGKILL",
    maxBuffer: outputLimit,
    timeout: builderTimeoutMilliseconds,
  });
}

async function assertBuilderRejects(args) {
  try {
    await runBuilder(args);
  } catch {
    return;
  }
  throw new Error("Native engine bundle builder accepted invalid arguments.");
}

async function runArtifactSmoke(engine) {
  const help = await runProgram(process.execPath, [engine, "--help"]);
  assertSuccessfulCommand(help, "bundled native engine help");
  if (!help.stdout.includes("Recurs coding-agent harness")) {
    throw new Error("Bundled native engine did not render help.");
  }

  const catalog = await runProgram(process.execPath, [
    engine,
    "provider",
    "list",
    "--all",
    "--json",
  ]);
  assertSuccessfulCommand(catalog, "bundled native engine provider catalog");
  let catalogDocument;
  try {
    catalogDocument = JSON.parse(catalog.stdout);
  } catch {
    throw new Error("Bundled native engine returned an invalid provider catalog.");
  }
  if (
    catalogDocument?.version !== 1 ||
    !Array.isArray(catalogDocument.providers) ||
    !catalogDocument.providers.some(
      (provider) => provider?.id === "openai-codex-chatgpt",
    )
  ) {
    throw new Error("Bundled native engine omitted the reviewed provider catalog.");
  }

  if (process.platform === "darwin") {
    await runDoctorSmoke(engine);
    await runSealedCodexSmoke(engine);
  }
  await assertAmbientCanaryAbsent(help, catalog);
}

async function runDoctorSmoke(engine) {

  const normal = startFakePeer([]);
  try {
    const result = await runProgram(
      process.execPath,
      [engine, "doctor", "native", "--json"],
      {
        descriptor: normal.channel,
        environment: { RECURS_NATIVE_FD: "3" },
      },
    );
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
    await stopPeer(normal.peer);
  }

  const interrupted = startFakePeer(["--hang-health"], true);
  let interruptedChild;
  interrupted.peer.stdout.once("data", () => {
    interruptedChild?.kill("SIGINT");
  });
  try {
    const result = await runProgram(
      process.execPath,
      [engine, "doctor", "native", "--json"],
      {
        descriptor: interrupted.channel,
        environment: { RECURS_NATIVE_FD: "3" },
        onSpawn(child) {
          interruptedChild = child;
        },
      },
    );
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
    await stopPeer(interrupted.peer);
  }
}

async function runSealedCodexSmoke(engine) {
  const expectProgram = [
    "set timeout 5",
    "set node $env(RECURS_SMOKE_NODE)",
    "set engine $env(RECURS_SMOKE_ENGINE)",
    "unset env(RECURS_SMOKE_NODE)",
    "unset env(RECURS_SMOKE_ENGINE)",
    "spawn -noecho $node $engine setup codex",
    "expect {",
    "  -exact {Continue? [y/N] } { send \"y\\r\"; exp_continue }",
    "  eof {}",
    "  timeout { exit 124 }",
    "}",
    "set result [wait]",
    "exit [lindex $result 3]",
  ].join("\n");
  const result = await runProgram(
    "/usr/bin/expect",
    ["-c", expectProgram],
    {
      environment: {
        RECURS_SMOKE_ENGINE: engine,
        RECURS_SMOKE_NODE: process.execPath,
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`.replaceAll("\r", "");
  const expected = `Error: ${sealedCliUnavailable}\n`;
  if (
    result.code === 0 ||
    result.signal !== null ||
    !output.includes(expected) ||
    output.includes(root) ||
    output.includes(temporaryRoot)
  ) {
    throw new Error("Sealed Codex runtime did not fail with its fixed safe error.");
  }
  await assertAmbientCanaryAbsent(result);
}

function assertSuccessfulCommand(result, label) {
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.stderr !== "" ||
    result.stdout.includes(canary)
  ) {
    throw new Error(`${label} returned an unexpected process result.`);
  }
}

function isolatedEnvironment(overrides = {}) {
  return {
    HOME: isolatedHome,
    LANG: "C",
    LC_ALL: "C",
    NODE_PATH: ambientModules,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    RECURS_HOME: isolatedData,
    RECURS_NATIVE_BUNDLE_CANARY: canary,
    TERM: "dumb",
    TMPDIR: temporaryRoot,
    ...overrides,
  };
}

async function createAmbientCanaryPackages() {
  const canaryProgram = [
    '"use strict";',
    `require("node:fs").writeFileSync(${JSON.stringify(ambientCanaryMarker)}, ${JSON.stringify(canary)}, { mode: 0o600 });`,
    `process.stdout.write(${JSON.stringify(`${canary}\n`)});`,
    "",
  ].join("\n");
  const packages = [
    {
      directory: "@recurs/runtimes",
      manifest: { name: "@recurs/runtimes", version: "0.0.0", main: "index.cjs" },
      files: [["index.cjs", canaryProgram]],
    },
    {
      directory: "@agentclientprotocol/codex-acp",
      manifest: {
        name: "@agentclientprotocol/codex-acp",
        version: "1.1.2",
        main: "dist/index.js",
        bin: { "codex-acp": "dist/index.js" },
      },
      files: [["dist/index.js", canaryProgram]],
    },
    {
      directory: "@openai/codex",
      manifest: { name: "@openai/codex", version: "0.144.0" },
      files: [],
    },
    {
      directory: `@openai/codex-${process.platform}-${process.arch}`,
      manifest: {
        name: "@openai/codex",
        version: `0.144.0-${process.platform}-${process.arch}`,
        os: [process.platform],
        cpu: [process.arch],
      },
      files: [],
    },
  ];
  for (const entry of packages) {
    const directory = path.join(ambientModules, entry.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify(entry.manifest)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    for (const [relative, source] of entry.files) {
      const filename = path.join(directory, relative);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, source, { flag: "wx", mode: 0o600 });
    }
  }
}

async function assertAmbientCanaryAbsent(...results) {
  if (
    results.some((result) =>
      result.stdout.includes(canary) || result.stderr.includes(canary)
    )
  ) {
    throw new Error("Bundled native engine loaded an ambient canary package.");
  }
  let markerExists = true;
  try {
    await access(ambientCanaryMarker);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    markerExists = false;
  }
  if (markerExists) {
    throw new Error("Bundled native engine executed an ambient canary package.");
  }
}

async function stopPeer(peer) {
  if (await waitForExit(peer, peerShutdownMilliseconds)) return;
  peer.kill("SIGTERM");
  if (await waitForExit(peer, peerShutdownMilliseconds)) return;
  peer.kill("SIGKILL");
  if (!(await waitForExit(peer, peerShutdownMilliseconds))) {
    throw new Error("Native engine bundle fake peer did not exit.");
  }
}

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      if (timer !== undefined) clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const onError = () => finish(true);
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => finish(false), milliseconds);
  });
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

function runProgram(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const descriptor = options.descriptor;
    const child = spawn(command, args, {
      cwd: isolatedCwd,
      env: isolatedEnvironment(options.environment),
      stdio: descriptor === undefined
        ? [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", descriptor],
    });
    descriptor?.destroy();
    let stdout = "";
    let stderr = "";
    let failure;
    let settled = false;
    let inputSent = false;
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
      if (
        !inputSent &&
        options.input !== undefined &&
        options.inputPrompt !== undefined &&
        stdout.includes(options.inputPrompt)
      ) {
        inputSent = true;
        child.stdin.end(options.input);
      }
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
      options.onSpawn?.(child);
      if (options.input !== undefined && options.inputPrompt === undefined) {
        inputSent = true;
        child.stdin.end(options.input);
      }
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
