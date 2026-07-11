import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { permissionIntentKey } from "./permissions.js";
import {
  ToolError,
  type PermissionIntent,
  type ToolContext,
} from "./types.js";

export interface ResolvedWorkspacePath {
  absolute: string;
  relative: string;
}

export interface PathPolicyOptions {
  sensitivePatterns?: readonly RegExp[];
}

const CREDENTIAL_BASENAMES = [
  ".env",
  "id_rsa",
  "id_ed25519",
  "credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
] as const;
const CREDENTIAL_BASENAME_PREFIXES = [".env."] as const;
const CREDENTIAL_BASENAME_SUFFIXES = [".pem", ".key", ".p12"] as const;
const CREDENTIAL_DIRECTORIES = [
  ".ssh",
  ".aws",
  ".azure",
  ".docker",
  ".gnupg",
  ".kube",
] as const;
const CREDENTIAL_DIRECTORY_PATHS = [".config/gcloud"] as const;

function rootAndNested(pattern: string): string[] {
  return [pattern, `**/${pattern}`];
}

function credentialGlobPatterns(): string[] {
  return [
    ...CREDENTIAL_BASENAMES.flatMap(rootAndNested),
    ...CREDENTIAL_BASENAME_PREFIXES.flatMap((prefix) =>
      rootAndNested(`${prefix}*`),
    ),
    ...CREDENTIAL_BASENAME_SUFFIXES.flatMap((suffix) =>
      rootAndNested(`*${suffix}`),
    ),
    ...CREDENTIAL_DIRECTORIES.flatMap((directory) =>
      rootAndNested(`${directory}/**`),
    ),
    ...CREDENTIAL_DIRECTORY_PATHS.flatMap((directory) =>
      rootAndNested(`${directory}/**`),
    ),
  ];
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

function normalizedRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function validateInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    throw new ToolError("invalid_input", "A valid workspace path is required");
  }
  return trimmed;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function matchesSensitivePattern(
  input: string,
  patterns: readonly RegExp[],
): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}

export function isCredentialPath(input: string): boolean {
  const normalized = input.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? "";
  const segmented = `/${parts.join("/")}/`;
  return (
    CREDENTIAL_BASENAMES.some((candidate) => basename === candidate) ||
    CREDENTIAL_BASENAME_PREFIXES.some((prefix) =>
      basename.startsWith(prefix),
    ) ||
    CREDENTIAL_BASENAME_SUFFIXES.some((suffix) => basename.endsWith(suffix)) ||
    CREDENTIAL_DIRECTORIES.some((directory) => parts.includes(directory)) ||
    CREDENTIAL_DIRECTORY_PATHS.some((directory) =>
      segmented.includes(`/${directory}/`),
    )
  );
}

export function credentialRipgrepGlobs(): readonly string[] {
  return credentialGlobPatterns().map((pattern) => `!${pattern}`);
}

export function credentialGitPathspecs(): readonly string[] {
  return credentialGlobPatterns().map(
    (pattern) => `:(glob,icase,exclude)${pattern}`,
  );
}

export function assertNonCredentialPath(input: string): void {
  if (isCredentialPath(input)) {
    throw new ToolError(
      "permission_denied",
      "Credential paths are unavailable to model tools",
    );
  }
}

export function isSensitivePath(
  input: string,
  patterns: readonly RegExp[] = [],
): boolean {
  return isCredentialPath(input) || matchesSensitivePattern(input, patterns);
}

export function pathPermissionIntents(
  operation: "read" | "write",
  input: string,
  patterns: readonly RegExp[] = [],
): PermissionIntent[] {
  const intents: PermissionIntent[] = [];
  if (path.isAbsolute(input) || input.split(/[\\/]/u).includes("..")) {
    intents.push({
      category: "external_path",
      resource: input,
      risk: "elevated",
    });
  }
  if (isCredentialPath(input)) {
    intents.push({ category: "credential", resource: input, risk: "elevated" });
  } else if (matchesSensitivePattern(input, patterns)) {
    intents.push({ category: "sensitive", resource: input, risk: "elevated" });
  }
  if (intents.length === 0) {
    intents.push({ category: operation, resource: input, risk: "normal" });
  }
  return intents;
}

export function isExternalPathApproved(
  context: ToolContext,
  input: string,
): boolean {
  return (
    context.approvedIntents?.has(
      permissionIntentKey({
        category: "external_path",
        resource: input,
        risk: "elevated",
      }),
    ) ?? false
  );
}

export class WorkspacePathPolicy {
  readonly #root: Promise<string>;

  constructor(
    cwd: string,
    readonly options: PathPolicyOptions = {},
  ) {
    this.#root = realpath(cwd);
  }

  async #lexical(
    input: string,
    allowExternal: boolean,
  ): Promise<ResolvedWorkspacePath> {
    const root = await this.#root;
    const absolute = path.resolve(root, validateInput(input));
    if (!allowExternal && !isWithin(root, absolute)) {
      throw new ToolError(
        "external_path",
        `Path is outside the workspace: ${input}`,
      );
    }
    return { absolute, relative: normalizedRelative(root, absolute) };
  }

  async resolveReadable(
    input: string,
    allowExternal = false,
  ): Promise<ResolvedWorkspacePath> {
    const root = await this.#root;
    const lexical = await this.#lexical(input, allowExternal);
    let resolved: string;
    try {
      resolved = await realpath(lexical.absolute);
    } catch (error) {
      if (isMissing(error)) {
        throw new ToolError("not_found", `Path does not exist: ${input}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (!allowExternal && !isWithin(root, resolved)) {
      throw new ToolError(
        "external_path",
        `Path resolves outside the workspace: ${input}`,
      );
    }
    return { absolute: resolved, relative: normalizedRelative(root, resolved) };
  }

  async resolveWritable(
    input: string,
    allowExternal = false,
  ): Promise<ResolvedWorkspacePath> {
    const root = await this.#root;
    const lexical = await this.#lexical(input, allowExternal);
    try {
      await lstat(lexical.absolute);
      const resolved = await realpath(lexical.absolute);
      if (!allowExternal && !isWithin(root, resolved)) {
        throw new ToolError(
          "external_path",
          `Path resolves outside the workspace: ${input}`,
        );
      }
      return { absolute: resolved, relative: normalizedRelative(root, resolved) };
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    let ancestor = lexical.absolute;
    const suffix: string[] = [];
    for (;;) {
      try {
        const resolvedAncestor = await realpath(ancestor);
        const resolved = path.resolve(resolvedAncestor, ...suffix);
        if (!allowExternal && !isWithin(root, resolved)) {
          throw new ToolError(
            "external_path",
            `Path resolves outside the workspace: ${input}`,
          );
        }
        return {
          absolute: resolved,
          relative: normalizedRelative(root, resolved),
        };
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new ToolError("external_path", `Cannot resolve path: ${input}`);
        }
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
}
