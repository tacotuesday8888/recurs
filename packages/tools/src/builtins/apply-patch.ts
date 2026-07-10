import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  isExternalPathApproved,
  pathPermissionIntents,
  WorkspacePathPolicy,
  type PathPolicyOptions,
  type ResolvedWorkspacePath,
} from "../path-policy.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool, type ToolContext } from "../types.js";

const MAX_PATCH_BYTES = 1024 * 1024;

export interface PatchFileRevision {
  path: string;
  expected_hash: string | null;
}

export interface ApplyPatchInput {
  patch: string;
  files: PatchFileRevision[];
}

function parseApplyPatchInput(value: unknown): ApplyPatchInput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("patch" in value) ||
    typeof value.patch !== "string" ||
    value.patch.length === 0 ||
    !("files" in value) ||
    !Array.isArray(value.files)
  ) {
    throw new ToolError(
      "invalid_input",
      "apply_patch requires patch text and a files array",
    );
  }
  if (Buffer.byteLength(value.patch, "utf8") > MAX_PATCH_BYTES) {
    throw new ToolError(
      "output_limit",
      `Patch exceeds the ${MAX_PATCH_BYTES}-byte limit`,
    );
  }
  const files = value.files.map((file, index): PatchFileRevision => {
    if (
      typeof file !== "object" ||
      file === null ||
      !("path" in file) ||
      typeof file.path !== "string" ||
      !("expected_hash" in file) ||
      (file.expected_hash !== null &&
        (typeof file.expected_hash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(file.expected_hash)))
    ) {
      throw new ToolError(
        "invalid_input",
        `Invalid file revision at index ${index}`,
      );
    }
    return { path: file.path, expected_hash: file.expected_hash };
  });
  const uniquePaths = new Set(files.map((file) => file.path));
  if (uniquePaths.size !== files.length) {
    throw new ToolError("invalid_input", "Patch file declarations must be unique");
  }
  return { patch: value.patch, files };
}

function decodePatchMarker(raw: string): string | null {
  const withoutTimestamp = raw.split("\t", 1)[0] ?? "";
  if (withoutTimestamp === "/dev/null") {
    return null;
  }
  let decoded = withoutTimestamp;
  if (decoded.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(decoded);
      if (typeof parsed !== "string") {
        throw new TypeError("Patch path is not a string");
      }
      decoded = parsed;
    } catch (error) {
      throw new ToolError("invalid_input", "Invalid quoted path in patch", {
        cause: error,
      });
    }
  }
  if (decoded.startsWith("a/") || decoded.startsWith("b/")) {
    return decoded.slice(2);
  }
  throw new ToolError("external_path", `Unsafe path in patch: ${decoded}`);
}

function extractPatchFiles(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const decoded = decodePatchMarker(line.slice(4));
      if (decoded !== null) {
        paths.add(decoded);
      }
    }
  }
  if (paths.size === 0) {
    throw new ToolError("invalid_input", "Patch does not declare any file paths");
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

async function sha256FileOrNull(file: string): Promise<string | null> {
  try {
    const content = await readFile(file);
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

interface ResolvedRevision {
  declared: PatchFileRevision;
  resolved: ResolvedWorkspacePath;
}

async function assertFresh(
  revisions: readonly ResolvedRevision[],
  context: ToolContext,
): Promise<void> {
  for (const { declared, resolved } of revisions) {
    if (
      declared.expected_hash !== null &&
      context.readRevisions.get(resolved.absolute) !== declared.expected_hash
    ) {
      throw new ToolError(
        "unread_file",
        `Read ${declared.path} in the current turn before editing it`,
      );
    }
    const current = await sha256FileOrNull(resolved.absolute);
    if (current !== declared.expected_hash) {
      throw new ToolError(
        "stale_file",
        `${declared.path} changed after it was read`,
      );
    }
  }
}

function assertDeclaredFiles(input: ApplyPatchInput): void {
  const actual = extractPatchFiles(input.patch);
  const declared = input.files
    .map((file) => file.path.replaceAll("\\", "/"))
    .sort((left, right) => left.localeCompare(right));
  if (
    actual.length !== declared.length ||
    actual.some((file, index) => file !== declared[index])
  ) {
    throw new ToolError(
      "patch_files_mismatch",
      `Patch paths (${actual.join(", ")}) do not match declared files (${declared.join(", ")})`,
    );
  }
}

export function createApplyPatchTool(
  options: PathPolicyOptions = {},
): Tool<ApplyPatchInput> {
  return {
    definition: {
      name: "apply_patch",
      description: "Apply a validated Git patch to declared workspace files",
      inputSchema: {
        type: "object",
        properties: {
          patch: { type: "string", minLength: 1 },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                expected_hash: { type: ["string", "null"] },
              },
              required: ["path", "expected_hash"],
              additionalProperties: false,
            },
          },
        },
        required: ["patch", "files"],
        additionalProperties: false,
      },
    },
    mutating: true,
    parse: parseApplyPatchInput,
    permissions(input) {
      return input.files.flatMap((file) =>
        pathPermissionIntents(
          "write",
          file.path,
          options.sensitivePatterns,
        ),
      );
    },
    async execute(input, context) {
      assertDeclaredFiles(input);
      const policy = new WorkspacePathPolicy(context.cwd, options);
      const revisions: ResolvedRevision[] = [];
      for (const declared of input.files) {
        revisions.push({
          declared,
          resolved: await policy.resolveWritable(
            declared.path,
            isExternalPathApproved(context, declared.path),
          ),
        });
      }
      await assertFresh(revisions, context);
      try {
        await runProcess("git", ["apply", "--check", "-"], {
          cwd: context.cwd,
          stdin: input.patch,
          signal: context.signal,
        });
        await assertFresh(revisions, context);
        await runProcess("git", ["apply", "--whitespace=nowarn", "-"], {
          cwd: context.cwd,
          stdin: input.patch,
          signal: context.signal,
        });
      } catch (error) {
        if (
          error instanceof ToolError &&
          (error.code === "cancelled" ||
            error.code === "stale_file" ||
            error.code === "unread_file")
        ) {
          throw error;
        }
        throw new ToolError("patch_failed", "Patch could not be applied", {
          cause: error,
        });
      }
      const changedFiles = input.files.map((file) =>
        file.path.replaceAll("\\", "/"),
      );
      return {
        output: `Applied patch to ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}\n`,
        metadata: { changedFiles },
      };
    },
  };
}
