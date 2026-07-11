import path from "node:path";

import { runProcess } from "./process.js";
import { ToolError } from "./types.js";

const FILTER_KEY_PATTERN = /^filter\.(.+)\.(clean|smudge|process|required)$/u;
const SAFE_FILTER_DRIVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FILTER_DRIVERS = 64;
const MINIMUM_GIT_MAJOR = 2;
const MINIMUM_GIT_MINOR = 45;
type GitProcessRunner = typeof runProcess;

function safeGitGlobalArguments(cwd: string): string[] {
  return [
    "--no-optional-locks",
    "--no-lazy-fetch",
    `--work-tree=${path.resolve(cwd)}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
  ];
}

async function assertSupportedGitVersion(
  cwd: string,
  signal: AbortSignal | undefined,
  processRunner: GitProcessRunner,
): Promise<void> {
  const result = await processRunner("git", ["--version"], {
    cwd,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: 5_000,
    maxOutputBytes: 4 * 1024,
  });
  const match = /^git version (\d+)\.(\d+)(?:\.\d+)?(?:[.\s-]|$)/u.exec(
    result.stdout.trim(),
  );
  const major = match?.[1] === undefined
    ? undefined
    : Number.parseInt(match[1], 10);
  const minor = match?.[2] === undefined
    ? undefined
    : Number.parseInt(match[2], 10);
  if (
    major === undefined ||
    minor === undefined ||
    major < MINIMUM_GIT_MAJOR ||
    (major === MINIMUM_GIT_MAJOR && minor < MINIMUM_GIT_MINOR)
  ) {
    throw new ToolError(
      "unsupported_git_version",
      "Git 2.45 or newer is required for protected Git operations",
    );
  }
}

async function configuredFilterDrivers(
  cwd: string,
  signal?: AbortSignal,
  processRunner: GitProcessRunner = runProcess,
): Promise<string[]> {
  const result = await processRunner(
    "git",
    [
      ...safeGitGlobalArguments(cwd),
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    {
      cwd,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      acceptableExitCodes: [0, 1],
    },
  );
  const drivers = new Set<string>();
  for (const key of result.stdout.split("\0")) {
    if (key.length === 0) {
      continue;
    }
    const match = FILTER_KEY_PATTERN.exec(key);
    const driver = match?.[1];
    if (driver === undefined || !SAFE_FILTER_DRIVER.test(driver)) {
      throw new ToolError(
        "permission_denied",
        "Repository filter configuration cannot be inspected safely",
      );
    }
    drivers.add(driver);
    if (drivers.size > MAX_FILTER_DRIVERS) {
      throw new ToolError(
        "permission_denied",
        "Repository filter configuration is too large to inspect safely",
      );
    }
  }
  return [...drivers].sort((left, right) => left.localeCompare(right));
}

export async function safeGitArguments(
  cwd: string,
  command: readonly string[],
  signal?: AbortSignal,
  processRunner: GitProcessRunner = runProcess,
): Promise<string[]> {
  await assertSupportedGitVersion(cwd, signal, processRunner);
  const filterOverrides = (
    await configuredFilterDrivers(cwd, signal, processRunner)
  ).flatMap((driver) => [
    "-c",
    `filter.${driver}.clean=`,
    "-c",
    `filter.${driver}.smudge=`,
    "-c",
    `filter.${driver}.process=`,
    "-c",
    `filter.${driver}.required=false`,
  ]);
  return [
    ...safeGitGlobalArguments(cwd),
    ...filterOverrides,
    ...command,
  ];
}
