import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ToolError } from "./types.js";

const SYSTEM_TEMPORARY_DIRECTORY = "/tmp";
const PRIVATE_DIRECTORY_MODE = 0o700;
const STICKY_BIT = 0o1000;
const ALLOWED_PARENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "TERM"] as const;
const execFileAsync = promisify(execFile);
let developerDirectoryPromise: Promise<string | undefined> | undefined;
let xcrunDatabasePromise: Promise<Buffer | undefined> | undefined;
const MAX_XCRUN_DATABASE_BYTES = 64 * 1024;
const FORBIDDEN_RECURS_AUTHORITY_SEGMENTS = new Set([
  "AUTHORITY",
  "BROKER",
  "DESCRIPTOR",
  "FD",
  "LAUNCHER",
  "NATIVE",
]);
const FORBIDDEN_SECRET_ENVIRONMENT_SEGMENTS = new Set([
  "KEY",
  "KEYCHAIN",
  "PROXY",
  "SECRET",
  "TOKEN",
]);

export interface IsolatedProcessEnvironment {
  environment: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export interface ProcessEnvironmentOptions {
  readonly seedAppleDeveloperToolCache?: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isForbiddenChildEnvironmentKey(key: string): boolean {
  const segments = key.toUpperCase().split("_");
  if (
    segments.some((segment) =>
      FORBIDDEN_SECRET_ENVIRONMENT_SEGMENTS.has(segment),
    )
  ) {
    return true;
  }
  return (
    segments[0] === "RECURS" &&
    segments.some((segment) =>
      FORBIDDEN_RECURS_AUTHORITY_SEGMENTS.has(segment),
    )
  );
}

function removeForbiddenChildEnvironmentVariables(
  environment: NodeJS.ProcessEnv,
): void {
  for (const key of Object.keys(environment)) {
    if (isForbiddenChildEnvironmentKey(key)) {
      delete environment[key];
    }
  }
}

async function selectedDeveloperDirectory(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  developerDirectoryPromise ??= (async () => {
    try {
      const result = await execFileAsync(
        "/usr/bin/xcode-select",
        ["-p"],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
          timeout: 5_000,
          maxBuffer: 4 * 1024,
        },
      );
      const candidate = result.stdout.trim();
      if (
        candidate.length === 0 ||
        candidate.length > 4096 ||
        !path.isAbsolute(candidate) ||
        candidate.includes("\0") ||
        candidate.includes("\n") ||
        candidate.includes("\r")
      ) {
        return undefined;
      }
      const canonical = await realpath(candidate);
      const details = await stat(canonical);
      if (
        !details.isDirectory() ||
        details.uid !== 0 ||
        (details.mode & 0o022) !== 0
      ) {
        return undefined;
      }
      return canonical;
    } catch {
      return undefined;
    }
  })();
  return developerDirectoryPromise;
}

async function trustedXcrunDatabase(
  temporaryDirectory: string,
  developerDirectory: string | undefined,
): Promise<Buffer | undefined> {
  if (process.platform !== "darwin" || developerDirectory === undefined) {
    return undefined;
  }
  xcrunDatabasePromise ??= (async () => {
    const root = await mkdtemp(path.join(temporaryDirectory, "recurs-xcrun-"));
    try {
      const home = path.join(root, "home");
      const temporary = path.join(root, "tmp");
      await Promise.all([
        mkdir(home, { mode: PRIVATE_DIRECTORY_MODE }),
        mkdir(temporary, { mode: PRIVATE_DIRECTORY_MODE }),
      ]);
      const result = await execFileAsync(
        "/usr/bin/xcrun",
        ["--find", "git"],
        {
          encoding: "utf8",
          env: {
            HOME: home,
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
            PATH: "/usr/bin:/bin",
            DEVELOPER_DIR: developerDirectory,
          },
          timeout: 5_000,
          maxBuffer: 4 * 1024,
        },
      );
      const selectedGit = result.stdout.trim();
      if (!path.isAbsolute(selectedGit)) return undefined;
      const canonicalGit = await realpath(selectedGit);
      const gitDetails = await stat(canonicalGit);
      if (
        !gitDetails.isFile() ||
        gitDetails.uid !== 0 ||
        (gitDetails.mode & 0o022) !== 0
      ) {
        return undefined;
      }
      const databasePath = path.join(temporary, "xcrun_db");
      const databaseDetails = await lstat(databasePath);
      if (
        !databaseDetails.isFile() ||
        databaseDetails.size === 0 ||
        databaseDetails.size > MAX_XCRUN_DATABASE_BYTES
      ) {
        return undefined;
      }
      return await readFile(databasePath);
    } catch {
      return undefined;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  })();
  return xcrunDatabasePromise;
}

async function canonicalSystemTemporaryDirectory(): Promise<string> {
  try {
    const root = await realpath(SYSTEM_TEMPORARY_DIRECTORY);
    const rootStats = await stat(root);
    if (
      !rootStats.isDirectory() ||
      rootStats.uid !== 0 ||
      (rootStats.mode & STICKY_BIT) === 0
    ) {
      throw new ToolError(
        "process_failed",
        "The system temporary directory is not a root-owned sticky directory",
      );
    }
    return root;
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError(
      "process_failed",
      "The system temporary directory is unavailable",
      { cause: error },
    );
  }
}

async function filteredPath(
  rawPath: string | undefined,
  workspaceRoot: string,
): Promise<string | undefined> {
  if (rawPath === undefined) {
    return undefined;
  }
  const entries = new Set<string>();
  for (const entry of rawPath.split(path.delimiter)) {
    if (entry.length === 0 || !path.isAbsolute(entry)) {
      continue;
    }
    const lexical = path.resolve(entry);
    if (isWithin(workspaceRoot, lexical)) {
      continue;
    }
    try {
      const canonical = await realpath(lexical);
      if (!isWithin(workspaceRoot, canonical)) {
        entries.add(canonical);
      }
    } catch {
      // A missing or unreadable PATH entry cannot help launch a child.
    }
  }
  return entries.size === 0 ? undefined : [...entries].join(path.delimiter);
}

export async function createIsolatedProcessEnvironment(
  cwd: string,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
  options: ProcessEnvironmentOptions = {},
): Promise<IsolatedProcessEnvironment> {
  const parent = { ...parentEnvironment };
  removeForbiddenChildEnvironmentVariables(parent);
  const workspaceRoot = await realpath(cwd);
  const temporaryDirectory = await canonicalSystemTemporaryDirectory();
  const developerDirectory = await selectedDeveloperDirectory();
  const xcrunDatabase = options.seedAppleDeveloperToolCache === true
    ? await trustedXcrunDatabase(temporaryDirectory, developerDirectory)
    : undefined;
  const privateRoot = await mkdtemp(
    path.join(temporaryDirectory, "recurs-process-"),
  );
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= rm(privateRoot, { recursive: true, force: true });
    return cleanupPromise;
  };

  try {
    await chmod(privateRoot, PRIVATE_DIRECTORY_MODE);
    const home = path.join(privateRoot, "home");
    const config = path.join(privateRoot, "config");
    const cache = path.join(privateRoot, "cache");
    const temporary = path.join(privateRoot, "tmp");
    const emptyBin = path.join(privateRoot, "bin");
    const directories = [home, config, cache, temporary, emptyBin];
    await Promise.all(
      directories.map(async (directory) => {
        await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
        await chmod(directory, PRIVATE_DIRECTORY_MODE);
      }),
    );
    if (xcrunDatabase !== undefined) {
      await writeFile(path.join(temporary, "xcrun_db"), xcrunDatabase, {
        flag: "wx",
        mode: 0o600,
      });
    }

    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    };
    if (developerDirectory !== undefined) {
      // Apple Git otherwise performs xcodebuild discovery for each isolated
      // process. The value is host-discovered, canonical, root-owned, and not
      // writable by an unprivileged user.
      environment.DEVELOPER_DIR = developerDirectory;
    }
    const safePath = await filteredPath(parent.PATH, workspaceRoot);
    environment.PATH = safePath ?? emptyBin;
    for (const key of ALLOWED_PARENT_KEYS) {
      const value = parent[key];
      if (value !== undefined) {
        environment[key] = value;
      }
    }
    removeForbiddenChildEnvironmentVariables(environment);
    return { environment, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
