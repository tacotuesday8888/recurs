import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./types.js";

const SYSTEM_TEMPORARY_DIRECTORY = "/tmp";
const PRIVATE_DIRECTORY_MODE = 0o700;
const STICKY_BIT = 0o1000;
const ALLOWED_PARENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "TERM"] as const;

export interface IsolatedProcessEnvironment {
  environment: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
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
): Promise<IsolatedProcessEnvironment> {
  const parent = { ...parentEnvironment };
  const workspaceRoot = await realpath(cwd);
  const temporaryDirectory = await canonicalSystemTemporaryDirectory();
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

    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    };
    const safePath = await filteredPath(parent.PATH, workspaceRoot);
    environment.PATH = safePath ?? emptyBin;
    for (const key of ALLOWED_PARENT_KEYS) {
      const value = parent[key];
      if (value !== undefined) {
        environment[key] = value;
      }
    }
    return { environment, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
