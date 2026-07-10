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

export function isSensitivePath(
  input: string,
  patterns: readonly RegExp[] = [],
): boolean {
  const normalized = input.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? "";
  const builtIn =
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    basename === "credentials" ||
    basename === ".netrc" ||
    basename === ".npmrc" ||
    basename === ".pypirc" ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    parts.includes(".ssh") ||
    parts.includes(".aws") ||
    parts.includes(".azure") ||
    parts.includes(".docker") ||
    parts.includes(".gnupg") ||
    parts.includes(".kube") ||
    normalized.includes(".config/gcloud/");
  return (
    builtIn ||
    patterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(input);
    })
  );
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
  if (isSensitivePath(input, patterns)) {
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

    let ancestor = path.dirname(lexical.absolute);
    for (;;) {
      try {
        const resolvedAncestor = await realpath(ancestor);
        if (!allowExternal && !isWithin(root, resolvedAncestor)) {
          throw new ToolError(
            "external_path",
            `Path resolves outside the workspace: ${input}`,
          );
        }
        return lexical;
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new ToolError("external_path", `Cannot resolve path: ${input}`);
        }
        ancestor = parent;
      }
    }
  }
}
