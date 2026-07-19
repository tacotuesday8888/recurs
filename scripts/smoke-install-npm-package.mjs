import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "recurs-install-smoke-"));
const packageDirectory = path.join(temporaryDirectory, "package");
const installDirectory = path.join(temporaryDirectory, "install");
const cacheDirectory = path.join(temporaryDirectory, "cache");
const homeDirectory = path.join(temporaryDirectory, "home");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
  ]);
  const { stdout: packOutput } = await execFileAsync(npm, [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packageDirectory,
    "--cache",
    cacheDirectory,
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const packReport = JSON.parse(packOutput);
  const filename = packReport[0]?.filename;
  assert(typeof filename === "string", "npm pack did not report an artifact filename.");
  const archive = path.join(packageDirectory, filename);
  await readFile(archive);

  await execFileAsync(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    cacheDirectory,
    archive,
  ], {
    cwd: installDirectory,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const executable = process.platform === "win32"
    ? path.join(installDirectory, "node_modules/.bin/recurs.cmd")
    : path.join(installDirectory, "node_modules/.bin/recurs");
  const environment = {
    HOME: homeDirectory,
    LANG: "C.UTF-8",
    PATH: process.env.PATH ?? "",
    RECURS_HOME: path.join(homeDirectory, ".recurs"),
    USERPROFILE: homeDirectory,
  };
  const { stdout: help, stderr: helpError } = await execFileAsync(executable, ["--help"], {
    cwd: installDirectory,
    encoding: "utf8",
    env: environment,
  });
  assert(help.includes("Recurs coding-agent harness"), "The installed CLI did not render its help.");
  assert(helpError === "", "The installed CLI wrote unexpected help diagnostics.");

  const { stdout: accounts, stderr: accountError } = await execFileAsync(
    executable,
    ["account", "list", "--json"],
    {
      cwd: installDirectory,
      encoding: "utf8",
      env: environment,
    },
  );
  assert(JSON.parse(accounts).accounts?.length === 0, "A fresh install must start with no accounts.");
  assert(accountError === "", "The installed CLI wrote unexpected account diagnostics.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write("npm package install smoke passed\n");
