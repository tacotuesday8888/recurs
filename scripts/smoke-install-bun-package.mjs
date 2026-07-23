import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "recurs-bun-install-smoke-"),
);
const archiveDirectory = path.join(temporaryDirectory, "archive");
const bunBinDirectory = path.join(temporaryDirectory, "bun-bin");
const bunCacheDirectory = path.join(temporaryDirectory, "bun-cache");
const bunGlobalDirectory = path.join(temporaryDirectory, "bun-global");
const homeDirectory = path.join(temporaryDirectory, "home");
const npmCacheDirectory = path.join(temporaryDirectory, "npm-cache");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const bun = process.platform === "win32" ? "bun.exe" : "bun";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nodeVersionTuple(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  assert(match, `Invalid Node version: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function requiredNodeVersion() {
  const match = /^>=(\d+\.\d+\.\d+)$/u.exec(packageJson.engines?.node);
  assert(match, "The package must declare one exact minimum Node version.");
  return match[1];
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

try {
  assert(packageJson.name === "recurs", "The Bun smoke test only accepts Recurs.");
  const minimumNode = requiredNodeVersion();
  assert(
    compareVersions(
      nodeVersionTuple(process.version),
      nodeVersionTuple(minimumNode),
    ) >= 0,
    `The Bun-installed CLI requires Node ${minimumNode} or newer.`,
  );

  await Promise.all([
    mkdir(archiveDirectory),
    mkdir(bunBinDirectory),
    mkdir(bunCacheDirectory),
    mkdir(bunGlobalDirectory),
    mkdir(homeDirectory),
    mkdir(npmCacheDirectory),
  ]);

  const { stdout: packOutput } = await execFileAsync(npm, [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    archiveDirectory,
    "--cache",
    npmCacheDirectory,
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const packReport = JSON.parse(packOutput);
  const filename = packReport[0]?.filename;
  assert(
    typeof filename === "string",
    "npm pack did not report the Bun smoke artifact.",
  );
  const archive = path.join(archiveDirectory, filename);
  await access(archive);

  const bunEnvironment = {
    ...process.env,
    BUN_INSTALL_BIN: bunBinDirectory,
    BUN_INSTALL_CACHE_DIR: bunCacheDirectory,
    BUN_INSTALL_GLOBAL_DIR: bunGlobalDirectory,
    CI: "1",
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
  };
  const { stdout: bunVersion } = await execFileAsync(bun, ["--version"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: bunEnvironment,
  });
  await execFileAsync(
    bun,
    ["install", "--global", "--ignore-scripts", archive],
    {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: bunEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const executable = path.join(
    bunBinDirectory,
    process.platform === "win32" ? "recurs.exe" : "recurs",
  );
  assert(
    await pathExists(executable),
    "Bun did not link the installed Recurs executable.",
  );
  const executableTarget = await realpath(executable);
  const executableSource = await readFile(executableTarget, "utf8");
  assert(
    executableSource.startsWith("#!/usr/bin/env node\n"),
    "The Bun-installed Recurs executable must retain its Node shebang.",
  );

  const runtimeEnvironment = {
    ...bunEnvironment,
    PATH: [
      bunBinDirectory,
      path.dirname(process.execPath),
      process.env.PATH ?? "",
    ].join(path.delimiter),
  };
  const { stdout: version, stderr: versionError } = await execFileAsync(
    executable,
    ["--version"],
    {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: runtimeEnvironment,
    },
  );
  assert(
    version === `recurs ${packageJson.version}\n`,
    "The Bun-installed CLI did not report the packed Recurs version.",
  );
  assert(
    versionError === "",
    "The Bun-installed CLI wrote unexpected version diagnostics.",
  );

  const { stdout: directNodeVersion, stderr: directNodeError } =
    await execFileAsync(process.execPath, [executableTarget, "--version"], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: runtimeEnvironment,
    });
  assert(
    directNodeVersion === version && directNodeError === "",
    "Node could not execute the exact CLI linked by Bun.",
  );

  let missingNodeFailure;
  try {
    await execFileAsync(executable, ["--version"], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: { ...bunEnvironment, PATH: bunBinDirectory },
    });
  } catch (error) {
    missingNodeFailure = error;
  }
  assert(
    missingNodeFailure !== undefined,
    "The Bun-installed CLI unexpectedly ran without the required Node runtime.",
  );

  process.stdout.write(
    `Bun ${bunVersion.trim()} installed the npm tarball; Node ${process.version.slice(1)} ran Recurs ${packageJson.version}\n`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
