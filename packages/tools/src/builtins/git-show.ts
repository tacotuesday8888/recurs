import {
  assertNonCredentialPath,
  credentialGitPathspecs,
  pathPermissionIntents,
  WorkspacePathPolicy,
} from "../path-policy.js";
import { safeGitArguments } from "../git-safety.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_AUTHOR_BYTES = 512;
const MAX_SUBJECT_BYTES = 4 * 1024;
const METADATA_FORMAT = "%H%x00%aI%x00%an%x00%s%x00";
const FULL_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export interface GitShowInput {
  readonly commit: string;
  readonly path?: string;
}

interface CommitMetadata {
  readonly commit: string;
  readonly authoredAt: string;
  readonly author: string;
  readonly subject: string;
}

function parseInput(value: unknown): GitShowInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "git_show expects an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "commit" && key !== "path")) {
    throw new ToolError("invalid_input", "git_show received an unknown option");
  }
  if (typeof record.commit !== "string" || !FULL_OBJECT_ID.test(record.commit)) {
    throw new ToolError(
      "invalid_input",
      "commit must be one full lowercase Git object id",
    );
  }
  if (record.path !== undefined && typeof record.path !== "string") {
    throw new ToolError("invalid_input", "path must be a string");
  }
  return {
    commit: record.commit,
    ...(record.path === undefined ? {} : { path: record.path }),
  };
}

function truncateUtf8(value: string, maximum: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximum) return value;
  let end = maximum;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return `${encoded.subarray(0, end).toString("utf8")}…`;
}

function parseMetadata(output: string): CommitMetadata {
  if (!output.endsWith("\0\n")) {
    throw new ToolError("process_failed", "Git commit metadata was malformed");
  }
  const fields = output.slice(0, -2).split("\0");
  if (fields.length !== 4) {
    throw new ToolError("process_failed", "Git commit metadata was malformed");
  }
  const [commit = "", authoredAt = "", author = "", subject = ""] = fields;
  if (!FULL_OBJECT_ID.test(commit)) {
    throw new ToolError("process_failed", "Git returned an invalid object id");
  }
  return {
    commit,
    authoredAt,
    author: truncateUtf8(author, MAX_AUTHOR_BYTES),
    subject: truncateUtf8(subject, MAX_SUBJECT_BYTES),
  };
}

export function createGitShowTool(): Tool<GitShowInput> {
  return {
    definition: {
      name: "git_show",
      description:
        "Show a bounded patch for one full commit reachable from the current HEAD",
      inputSchema: {
        type: "object",
        properties: {
          commit: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
          path: { type: "string" },
        },
        required: ["commit"],
        additionalProperties: false,
      },
    },
    executionClass: "fixed_process",
    mutating: false,
    parallelSafe: true,
    parse: parseInput,
    permissions(input) {
      return input.path === undefined
        ? [{ category: "read", resource: ".git/objects", risk: "normal" }]
        : pathPermissionIntents("read", input.path);
    },
    async execute(input, context) {
      let target = ".";
      if (input.path !== undefined) {
        const resolved = await new WorkspacePathPolicy(context.cwd)
          .resolveWritable(input.path);
        assertNonCredentialPath(resolved.relative);
        target = resolved.relative;
      }
      const targetPathspec = target === "." ? target : `:(top,literal)${target}`;
      const gitPrefix = await safeGitArguments(context.cwd, [], context.signal);
      const head = await runProcess("git", [
        ...gitPrefix,
        "--no-replace-objects",
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD^{commit}",
      ], {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: 4 * 1024,
        acceptableExitCodes: [0, 1],
      });
      if (head.exitCode === 1) {
        throw new ToolError("invalid_input", "The workspace has no current commit");
      }
      const headCommit = head.stdout.trim();
      if (!FULL_OBJECT_ID.test(headCommit)) {
        throw new ToolError("process_failed", "Git returned an invalid HEAD object id");
      }
      const object = await runProcess("git", [
        ...gitPrefix,
        "--no-replace-objects",
        "cat-file",
        "-e",
        `${input.commit}^{commit}`,
      ], {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: 4 * 1024,
        acceptableExitCodes: [0, 1, 128],
      });
      if (object.exitCode !== 0) {
        throw new ToolError(
          "invalid_input",
          "commit does not identify an available commit object",
        );
      }
      const ancestor = await runProcess("git", [
        ...gitPrefix,
        "--no-replace-objects",
        "merge-base",
        "--is-ancestor",
        input.commit,
        headCommit,
      ], {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: 4 * 1024,
        acceptableExitCodes: [0, 1],
      });
      if (ancestor.exitCode === 1) {
        throw new ToolError(
          "permission_denied",
          "commit is not reachable from the current HEAD",
        );
      }
      const patch = await runProcess("git", [
        ...gitPrefix,
        "--no-replace-objects",
        "show",
        "--format=",
        "--patch",
        "--root",
        "--first-parent",
        "--diff-merges=first-parent",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--submodule=short",
        "--ignore-submodules=dirty",
        "--no-notes",
        "--no-show-signature",
        input.commit,
        "--",
        targetPathspec,
        ...credentialGitPathspecs(),
      ], {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: MAX_PATCH_BYTES,
      });
      if (patch.stdout.length === 0) {
        return {
          output: `No accessible changes found for commit ${input.commit}.\n`,
          metadata: {
            commit: input.commit,
            path: target,
            patchBytes: 0,
            exitCode: patch.exitCode,
            sources: [`inspected commit ${input.commit} for ${JSON.stringify(target)}`],
          },
        };
      }
      const metadataResult = await runProcess("git", [
        ...gitPrefix,
        "--no-replace-objects",
        "show",
        "--no-notes",
        "--no-show-signature",
        "--no-patch",
        `--format=${METADATA_FORMAT}`,
        input.commit,
      ], {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: MAX_METADATA_BYTES,
      });
      const metadata = parseMetadata(metadataResult.stdout);
      const header = `${JSON.stringify(metadata)}\n`;
      return {
        output: `${header}${patch.stdout}`,
        metadata: {
          commit: metadata.commit,
          path: target,
          patchBytes: Buffer.byteLength(patch.stdout, "utf8"),
          exitCode: patch.exitCode,
          sources: [
            `inspected commit ${metadata.commit} for ${JSON.stringify(target)}`,
          ],
        },
      };
    },
  };
}
