import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GITHUB_COPILOT_SDK_VERSION = "1.0.8";
const PACKAGE_NAME = "@github/copilot-sdk";

export interface GitHubCopilotSdkModule {
  readonly CopilotClient: new (config: unknown) => unknown;
}

export type GitHubCopilotSdkResolution =
  | {
      readonly status: "available";
      readonly source: "peer" | "recurs_addon";
      readonly module: GitHubCopilotSdkModule;
      readonly loginCommand: {
        readonly command: string;
        readonly arguments: readonly [];
        readonly environment: {
          readonly COPILOT_DISABLE_KEYTAR: "1";
          readonly COPILOT_HOME: string;
        };
        readonly thenEnter: "/login";
      };
    }
  | {
      readonly status: "unavailable";
      readonly addonPrefix: string;
      readonly installArguments: readonly string[];
    };

export class GitHubCopilotSdkInstallationError extends Error {
  readonly code = "invalid_response";

  constructor() {
    super("The installed GitHub Copilot SDK is not the reviewed release");
    this.name = "GitHubCopilotSdkInstallationError";
  }
}

export interface ResolveGitHubCopilotSdkInput {
  readonly dataDirectory: string;
  readonly resolvePeer?: () => {
    readonly entry: string;
    readonly packageJson: string;
  };
}

export function githubCopilotSdkAddonPrefix(dataDirectory: string): string {
  if (dataDirectory.includes("\0")) {
    throw new TypeError("The Recurs data directory is invalid");
  }
  return path.join(path.resolve(dataDirectory), "runtimes", "github-copilot-sdk");
}

export function githubCopilotRuntimeHome(dataDirectory: string): string {
  if (dataDirectory.includes("\0")) {
    throw new TypeError("The Recurs data directory is invalid");
  }
  return path.join(path.resolve(dataDirectory), "runtimes", "github-copilot-home");
}

export function githubCopilotSdkInstallArguments(
  dataDirectory: string,
): readonly string[] {
  return Object.freeze([
    "--prefix",
    githubCopilotSdkAddonPrefix(dataDirectory),
    "install",
    "--save-exact",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `${PACKAGE_NAME}@${GITHUB_COPILOT_SDK_VERSION}`,
  ]);
}

function checkedModule(value: unknown): GitHubCopilotSdkModule {
  if (
    value === null ||
    typeof value !== "object" ||
    !("CopilotClient" in value) ||
    typeof value.CopilotClient !== "function"
  ) {
    throw new GitHubCopilotSdkInstallationError();
  }
  return value as GitHubCopilotSdkModule;
}

function missingModule(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND");
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

interface ReviewedSdk {
  readonly module: GitHubCopilotSdkModule;
  readonly packageRoot: string;
}

async function importFixedAddon(prefix: string): Promise<ReviewedSdk | null> {
  const expectedPackageRoot = path.join(
    prefix,
    "node_modules",
    "@github",
    "copilot-sdk",
  );
  let realPrefix: string;
  let packageRoot: string;
  try {
    [realPrefix, packageRoot] = await Promise.all([
      realpath(prefix),
      realpath(expectedPackageRoot),
    ]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new GitHubCopilotSdkInstallationError();
  }
  if (!isContained(realPrefix, packageRoot) || !(await stat(packageRoot)).isDirectory()) {
    throw new GitHubCopilotSdkInstallationError();
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new GitHubCopilotSdkInstallationError();
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !("name" in metadata) || metadata.name !== PACKAGE_NAME ||
    !("version" in metadata) || metadata.version !== GITHUB_COPILOT_SDK_VERSION
  ) {
    throw new GitHubCopilotSdkInstallationError();
  }
  const require = createRequire(path.join(prefix, "package.json"));
  let entry: string;
  try {
    entry = await realpath(require.resolve(PACKAGE_NAME));
  } catch {
    throw new GitHubCopilotSdkInstallationError();
  }
  if (!isContained(packageRoot, entry) || !(await stat(entry)).isFile()) {
    throw new GitHubCopilotSdkInstallationError();
  }
  try {
    return {
      module: checkedModule(await import(pathToFileURL(entry).href)),
      packageRoot,
    };
  } catch (error) {
    if (error instanceof GitHubCopilotSdkInstallationError) throw error;
    throw new GitHubCopilotSdkInstallationError();
  }
}

function scopedPackageRoot(entry: string): string {
  let current = path.dirname(entry);
  while (true) {
    if (
      path.basename(current) === "copilot-sdk" &&
      path.basename(path.dirname(current)) === "@github" &&
      path.basename(path.dirname(path.dirname(current))) === "node_modules"
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new GitHubCopilotSdkInstallationError();
    current = parent;
  }
}

function defaultPeerResolution(): { readonly entry: string; readonly packageJson: string } {
  const require = createRequire(import.meta.url);
  const entry = require.resolve(PACKAGE_NAME);
  return {
    entry,
    packageJson: path.join(scopedPackageRoot(entry), "package.json"),
  };
}

async function importReviewedPeer(input: {
  readonly entry: string;
  readonly packageJson: string;
}): Promise<ReviewedSdk> {
  let entry: string;
  let packageJson: string;
  let metadata: unknown;
  try {
    [entry, packageJson] = await Promise.all([
      realpath(input.entry),
      realpath(input.packageJson),
    ]);
    metadata = JSON.parse(await readFile(packageJson, "utf8"));
  } catch {
    throw new GitHubCopilotSdkInstallationError();
  }
  const packageRoot = path.dirname(packageJson);
  if (
    !isContained(packageRoot, entry) ||
    !(await stat(entry)).isFile() ||
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !("name" in metadata) || metadata.name !== PACKAGE_NAME ||
    !("version" in metadata) || metadata.version !== GITHUB_COPILOT_SDK_VERSION
  ) {
    throw new GitHubCopilotSdkInstallationError();
  }
  try {
    return {
      module: checkedModule(await import(pathToFileURL(entry).href)),
      packageRoot,
    };
  } catch (error) {
    if (error instanceof GitHubCopilotSdkInstallationError) throw error;
    throw new GitHubCopilotSdkInstallationError();
  }
}

async function loginCommand(packageRoot: string, dataDirectory: string): Promise<{
  readonly command: string;
  readonly arguments: readonly [];
  readonly environment: {
    readonly COPILOT_DISABLE_KEYTAR: "1";
    readonly COPILOT_HOME: string;
  };
  readonly thenEnter: "/login";
}> {
  const nodeModulesRoot = path.dirname(path.dirname(packageRoot));
  let command: string;
  try {
    command = await realpath(path.join(
      nodeModulesRoot,
      ".bin",
      process.platform === "win32" ? "copilot.cmd" : "copilot",
    ));
  } catch {
    throw new GitHubCopilotSdkInstallationError();
  }
  const realNodeModulesRoot = await realpath(nodeModulesRoot);
  if (!isContained(realNodeModulesRoot, command) || !(await stat(command)).isFile()) {
    throw new GitHubCopilotSdkInstallationError();
  }
  return Object.freeze({
    command,
    arguments: Object.freeze([] as const),
    environment: Object.freeze({
      COPILOT_DISABLE_KEYTAR: "1" as const,
      COPILOT_HOME: githubCopilotRuntimeHome(dataDirectory),
    }),
    thenEnter: "/login" as const,
  });
}

export async function resolveGitHubCopilotSdk(
  input: ResolveGitHubCopilotSdkInput,
): Promise<GitHubCopilotSdkResolution> {
  let peer: { readonly entry: string; readonly packageJson: string } | null = null;
  try {
    peer = (input.resolvePeer ?? defaultPeerResolution)();
  } catch (error) {
    if (!missingModule(error)) throw new GitHubCopilotSdkInstallationError();
  }
  if (peer !== null) {
    const reviewed = await importReviewedPeer(peer);
    return {
      status: "available",
      source: "peer",
      module: reviewed.module,
      loginCommand: await loginCommand(reviewed.packageRoot, input.dataDirectory),
    };
  }
  const addonPrefix = githubCopilotSdkAddonPrefix(input.dataDirectory);
  const addon = await importFixedAddon(addonPrefix);
  if (addon !== null) {
    return {
      status: "available",
      source: "recurs_addon",
      module: addon.module,
      loginCommand: await loginCommand(addon.packageRoot, input.dataDirectory),
    };
  }
  return {
    status: "unavailable",
    addonPrefix,
    installArguments: githubCopilotSdkInstallArguments(input.dataDirectory),
  };
}
