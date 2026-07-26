import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { deepFreeze } from "./acp-profile.js";

export const CODEX_CLI_VERSION = "0.145.0";
export const CODEX_CLI_INTEGRITY =
  "sha512-/PSPSFujjjmiyVFvG2yu/grOFhsWdokTH8t2KGWhXSo/M5n/dIDsnbsnO82/7bLtIoDuzQf7ATBUMWqPWQINlQ==";

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly os?: unknown;
  readonly cpu?: unknown;
}

interface PlatformArtifact {
  readonly id: string;
  readonly suffix: string;
  readonly targetTriple: string;
  readonly integrity: string;
  readonly os: string;
  readonly cpu: string;
}

const platformArtifacts: Readonly<Record<string, PlatformArtifact>> = deepFreeze({
  "darwin-arm64": {
    id: "@openai/codex-darwin-arm64",
    suffix: "darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
    integrity:
      "sha512-h6aQ0UxnaP8mIM/9/qPAH9MNkRliJo88toq1T36IxNM2L5JSU0TFamu+MZn7YkFgDsrp0RfiI+97Tm8AVVxqtA==",
    os: "darwin",
    cpu: "arm64",
  },
  "darwin-x64": {
    id: "@openai/codex-darwin-x64",
    suffix: "darwin-x64",
    targetTriple: "x86_64-apple-darwin",
    integrity:
      "sha512-FCYzVKCa9VoLtg9gVyzKpqylonfgZrfcWZN6HsXAZPeuo8CukdMqdgTUOhDn2V6h3MbqS0z6VqQVKUllN/yKhA==",
    os: "darwin",
    cpu: "x64",
  },
  "linux-arm64": {
    id: "@openai/codex-linux-arm64",
    suffix: "linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
    integrity:
      "sha512-8OLcPXaAol/FOrRoDxWhIiHIFa73KRsM41EKocjRZOwiT4TcelzJWn3dHyiuSb7teWF25rrslvSPyvhULYRRCQ==",
    os: "linux",
    cpu: "arm64",
  },
  "linux-x64": {
    id: "@openai/codex-linux-x64",
    suffix: "linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
    integrity:
      "sha512-u8w8LLv3DvsfrDCoswLIemZ0SoNEXyi511WsfFsSiYUazk9qMsB/NtU8N9vhAfN7mZAxLFoMex4v66JjHuZWwA==",
    os: "linux",
    cpu: "x64",
  },
  "win32-arm64": {
    id: "@openai/codex-win32-arm64",
    suffix: "win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc",
    integrity:
      "sha512-sub61rjEFevi1i3Zx7nAd4JM5XxoNFqMqFc5LfTo2xSI8ixHjFvEYDFDXwXOftT04n3Ht1Wh271ioUZpDiEjEg==",
    os: "win32",
    cpu: "arm64",
  },
  "win32-x64": {
    id: "@openai/codex-win32-x64",
    suffix: "win32-x64",
    targetTriple: "x86_64-pc-windows-msvc",
    integrity:
      "sha512-u0h9lk094CaXRSqE34SBW2dRaQTPa6fASXqehczWH9QdsU62mBsiAgAdp6tCG4i+YzPmmhjD8FdXNnYGNmwuMg==",
    os: "win32",
    cpu: "x64",
  },
});

export interface BundledCodexInstallation {
  readonly source: "bundled_package";
  readonly codexPackageJson: string;
  readonly codexVersion: typeof CODEX_CLI_VERSION;
  readonly platformPackageId: string;
  readonly platformPackageJson: string;
  readonly codexExecutable: string;
  readonly platformVersion: string;
  readonly platformIntegrity: string;
}

export interface CodexCliInstallation {
  readonly source: "bundled_package" | "external_path";
  readonly codexVersion: typeof CODEX_CLI_VERSION;
  readonly codexExecutable: string;
}

export interface CodexCliResolutionDependencies {
  readonly resolveBundled?: () => BundledCodexInstallation | null;
}

function readPackage(packageJsonPath: string): PackageJson {
  const value = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Installed Codex package metadata is invalid");
  }
  return value as PackageJson;
}

function realContainedFile(root: string, candidate: string, label: string): string {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !statSync(realCandidate).isFile()
  ) {
    throw new TypeError(`${label} is outside its reviewed package`);
  }
  return realCandidate;
}

function missingModule(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === "MODULE_NOT_FOUND";
}

export function resolveBundledCodexInstallation():
  BundledCodexInstallation | null {
  const require = createRequire(import.meta.url);
  let codexPackageJson: string;
  try {
    codexPackageJson = realpathSync(
      require.resolve("@openai/codex/package.json"),
    );
  } catch (error) {
    if (missingModule(error)) return null;
    throw error;
  }
  const codexPackage = readPackage(codexPackageJson);
  if (
    codexPackage.name !== "@openai/codex" ||
    codexPackage.version !== CODEX_CLI_VERSION
  ) {
    throw new TypeError("Installed Codex CLI is not the reviewed release");
  }

  const artifact = platformArtifacts[`${process.platform}-${process.arch}`];
  if (artifact === undefined) {
    throw new TypeError("This platform has no reviewed Codex executable artifact");
  }
  const platformPackageJson = realpathSync(
    require.resolve(`${artifact.id}/package.json`),
  );
  const platformPackage = readPackage(platformPackageJson);
  const platformVersion = `${CODEX_CLI_VERSION}-${artifact.suffix}`;
  if (
    platformPackage.name !== "@openai/codex" ||
    platformPackage.version !== platformVersion ||
    !Array.isArray(platformPackage.os) ||
    platformPackage.os.length !== 1 ||
    platformPackage.os[0] !== artifact.os ||
    !Array.isArray(platformPackage.cpu) ||
    platformPackage.cpu.length !== 1 ||
    platformPackage.cpu[0] !== artifact.cpu
  ) {
    throw new TypeError("Installed Codex platform artifact is not the reviewed release");
  }
  const platformRoot = path.dirname(platformPackageJson);
  return deepFreeze({
    source: "bundled_package",
    codexPackageJson,
    codexVersion: CODEX_CLI_VERSION,
    platformPackageId: artifact.id,
    platformPackageJson,
    codexExecutable: realContainedFile(
      platformRoot,
      path.join(
        platformRoot,
        "vendor",
        artifact.targetTriple,
        "bin",
        process.platform === "win32" ? "codex.exe" : "codex",
      ),
      "Codex executable",
    ),
    platformVersion,
    platformIntegrity: artifact.integrity,
  });
}

function externalCandidates(
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  const explicit = environment.RECURS_CODEX_PATH;
  if (explicit !== undefined) {
    if (
      explicit.trim() !== explicit ||
      !path.isAbsolute(explicit) ||
      explicit.includes("\0")
    ) {
      throw new TypeError(
        "RECURS_CODEX_PATH must name an existing absolute Codex executable",
      );
    }
    return [explicit];
  }
  const pathValue = environment.PATH;
  if (pathValue === undefined || pathValue.length === 0) return [];
  const names = process.platform === "win32"
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT")
      .split(";")
      .filter(Boolean)
      .map((extension) => `codex${extension.toLocaleLowerCase("en-US")}`)
    : ["codex"];
  return pathValue.split(path.delimiter)
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    .flatMap((entry) => names.map((name) => path.join(entry, name)));
}

function resolveExternalExecutable(
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const explicit = environment.RECURS_CODEX_PATH !== undefined;
  for (const candidate of externalCandidates(environment)) {
    let executable: string;
    try {
      executable = realpathSync(candidate);
      if (!statSync(executable).isFile()) continue;
      if (process.platform !== "win32") accessSync(executable, constants.X_OK);
    } catch {
      if (explicit) {
        throw new TypeError(
          "RECURS_CODEX_PATH must name an existing executable file",
        );
      }
      continue;
    }
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      env: {},
      maxBuffer: 16 * 1_024,
      timeout: 5_000,
      windowsHide: true,
    });
    if (
      result.error === undefined &&
      result.status === 0 &&
      result.stdout.trim() === `codex-cli ${CODEX_CLI_VERSION}`
    ) {
      return executable;
    }
    if (explicit) {
      throw new TypeError(
        `RECURS_CODEX_PATH must point to Codex CLI ${CODEX_CLI_VERSION}`,
      );
    }
  }
  throw new TypeError(
    `Codex CLI ${CODEX_CLI_VERSION} is required for ChatGPT subscription access; install that exact official release or set RECURS_CODEX_PATH`,
  );
}

export function resolveCodexCliInstallation(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  dependencies: CodexCliResolutionDependencies = {},
): CodexCliInstallation {
  if (environment.RECURS_CODEX_PATH === undefined) {
    const bundled = (dependencies.resolveBundled ??
      resolveBundledCodexInstallation)();
    if (bundled !== null) return bundled;
  }
  return deepFreeze({
    source: "external_path",
    codexVersion: CODEX_CLI_VERSION,
    codexExecutable: resolveExternalExecutable(environment),
  });
}
