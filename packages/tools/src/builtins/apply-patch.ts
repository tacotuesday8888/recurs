import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  assertNonCredentialPath,
  isExternalPathApproved,
  pathPermissionIntents,
  WorkspacePathPolicy,
  type PathPolicyOptions,
  type ResolvedWorkspacePath,
} from "../path-policy.js";
import { safeGitArguments } from "../git-safety.js";
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
    Array.isArray(value)
  ) {
    throw new ToolError("invalid_input", "apply_patch expects an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "patch" && key !== "files") ||
    typeof record.patch !== "string" ||
    record.patch.length === 0 ||
    !Array.isArray(record.files)
  ) {
    throw new ToolError(
      "invalid_input",
      "apply_patch requires patch text and a files array",
    );
  }
  if (Buffer.byteLength(record.patch, "utf8") > MAX_PATCH_BYTES) {
    throw new ToolError(
      "output_limit",
      `Patch exceeds the ${MAX_PATCH_BYTES}-byte limit`,
    );
  }
  if (
    !record.patch.startsWith("diff --git ") &&
    !record.patch.startsWith("--- ")
  ) {
    throw new ToolError(
      "invalid_input",
      'patch must be a standard unified diff beginning with "diff --git " or "--- "; Codex "*** Begin Patch" envelopes are not supported',
    );
  }
  const files = record.files.map((file, index): PatchFileRevision => {
    if (
      typeof file !== "object" ||
      file === null ||
      Array.isArray(file)
    ) {
      throw new ToolError(
        "invalid_input",
        `Invalid file revision at index ${index}`,
      );
    }
    const revision = file as Record<string, unknown>;
    if (
      Object.keys(revision).sort().join(",") !== "expected_hash,path" ||
      typeof revision.path !== "string" ||
      revision.path.length === 0 ||
      revision.path !== revision.path.trim() ||
      revision.path.includes("\\") ||
      revision.path.includes("\0") ||
      (revision.expected_hash !== null &&
        (typeof revision.expected_hash !== "string" ||
          revision.expected_hash !== "observed" &&
          !/^[a-f0-9]{64}$/u.test(revision.expected_hash)))
    ) {
      throw new ToolError(
        "invalid_input",
        `Invalid file revision at index ${index}`,
      );
    }
    return {
      path: revision.path,
      expected_hash: revision.expected_hash as string | null,
    };
  });
  const uniquePaths = new Set(files.map((file) => file.path));
  if (uniquePaths.size !== files.length) {
    throw new ToolError("invalid_input", "Patch file declarations must be unique");
  }
  return { patch: record.patch, files };
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
  const lines = patch.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ")
    ) {
      throw new ToolError(
        "invalid_input",
        "Rename and copy patches are unsupported",
      );
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      for (const marker of [line, lines[index + 1]!]) {
        const decoded = decodePatchMarker(marker.slice(4));
        if (decoded !== null) {
          paths.add(decoded);
        }
      }
      index += 1;
    }
  }
  if (paths.size === 0) {
    throw new ToolError("invalid_input", "Patch does not declare any file paths");
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function normalizeHunkCounts(patch: string): string {
  const lines = patch.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(
      lines[index] ?? "",
    );
    if (header === null) continue;
    let oldLines = 0;
    let newLines = 0;
    for (let body = index + 1; body < lines.length; body += 1) {
      const line = lines[body] ?? "";
      if (
        line.length === 0 ||
        line.startsWith("@@ ") ||
        line.startsWith("diff --git ") ||
        (line.startsWith("--- ") && lines[body + 1]?.startsWith("+++ "))
      ) {
        break;
      }
      if (line.startsWith(" ") || line.startsWith("-")) oldLines += 1;
      if (line.startsWith(" ") || line.startsWith("+")) newLines += 1;
      if (
        !line.startsWith(" ") &&
        !line.startsWith("+") &&
        !line.startsWith("-") &&
        line !== "\\ No newline at end of file"
      ) {
        break;
      }
    }
    lines[index] =
      `@@ -${header[1]},${oldLines} +${header[2]},${newLines} @@${header[3]}`;
  }
  return lines.join("\n");
}

function parseNumstatPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    const file = secondTab < 0 ? "" : record.slice(secondTab + 1);
    if (firstTab < 1 || secondTab <= firstTab + 1 || file.length === 0) {
      throw new ToolError("invalid_input", "Patch paths could not be verified");
    }
    paths.add(file);
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
    const observed = context.readRevisions.get(resolved.absolute);
    const expected = declared.expected_hash === "observed"
      ? observed
      : declared.expected_hash;
    if (declared.expected_hash === "observed" && observed === undefined ||
      declared.expected_hash !== null &&
        declared.expected_hash !== "observed" &&
        observed !== declared.expected_hash) {
      throw new ToolError(
        "unread_file",
        `Read ${declared.path} in the current turn before editing it`,
      );
    }
    const current = await sha256FileOrNull(resolved.absolute);
    if (current !== expected) {
      throw new ToolError(
        "stale_file",
        `${declared.path} changed after it was read`,
      );
    }
  }
}

function declaredFiles(input: ApplyPatchInput): string[] {
  return input.files
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
}

function assertSameDeclaredFiles(
  actual: readonly string[],
  declared: readonly string[],
): void {
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

function assertDeclaredFiles(input: ApplyPatchInput): void {
  assertSameDeclaredFiles(
    extractPatchFiles(input.patch),
    declaredFiles(input),
  );
}

async function resolveValidatedRevisions(
  input: ApplyPatchInput,
  context: ToolContext,
  options: PathPolicyOptions,
): Promise<ResolvedRevision[]> {
  assertDeclaredFiles(input);
  const policy = new WorkspacePathPolicy(context.cwd, options);
  const revisions: ResolvedRevision[] = [];
  for (const declared of input.files) {
    const resolved = await policy.resolveWritable(
      declared.path,
      isExternalPathApproved(context, declared.path),
    );
    assertNonCredentialPath(resolved.relative);
    revisions.push({ declared, resolved });
  }
  return revisions;
}

export function createApplyPatchTool(
  options: PathPolicyOptions = {},
): Tool<ApplyPatchInput> {
  return {
    definition: {
      name: "apply_patch",
      description:
        'Apply a standard Git unified diff beginning with "diff --git " to declared workspace files. Never use Codex "*** Begin Patch" markers. Read every existing file first and set expected_hash to "observed"; use null only for a new file.',
      inputSchema: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            minLength: 1,
            description:
              'Standard Git unified diff beginning with "diff --git ". Do not wrap it in "*** Begin Patch" or "*** End Patch" markers.',
          },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                expected_hash: {
                  type: ["string", "null"],
                  description:
                    "Use \"observed\" for an existing file read in this turn, or null only for a new file.",
                },
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
    executionClass: "fixed_process",
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
    async preflight(input, context) {
      await resolveValidatedRevisions(input, context, options);
    },
    async execute(input, context) {
      const revisions = await resolveValidatedRevisions(
        input,
        context,
        options,
      );
      await assertFresh(revisions, context);
      const safeGitPrefix = await safeGitArguments(
        context.cwd,
        [],
        context.signal,
      );
      const patch = normalizeHunkCounts(input.patch);
      let numstat: string;
      try {
        numstat = (await runProcess("git", [
          ...safeGitPrefix,
          "apply",
          "--numstat",
          "-z",
          "-",
        ], {
          cwd: context.cwd,
          stdin: patch,
          signal: context.signal,
          maxOutputBytes: MAX_PATCH_BYTES,
        })).stdout;
      } catch (error) {
        if (error instanceof ToolError && error.code === "cancelled") {
          throw error;
        }
        throw new ToolError("invalid_input", "Patch could not be parsed");
      }
      assertSameDeclaredFiles(
        parseNumstatPaths(numstat),
        declaredFiles(input),
      );
      try {
        await runProcess("git", [
          ...safeGitPrefix,
          "apply",
          "--check",
          "-",
        ], {
          cwd: context.cwd,
          stdin: patch,
          signal: context.signal,
        });
        await assertFresh(revisions, context);
        await runProcess("git", [
          ...safeGitPrefix,
          "apply",
          "--whitespace=nowarn",
          "-",
        ], {
          cwd: context.cwd,
          stdin: patch,
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
      const changedFiles = input.files.map((file) => file.path);
      return {
        output: `Applied patch to ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}\n`,
        metadata: { changedFiles },
      };
    },
  };
}
