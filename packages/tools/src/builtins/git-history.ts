import {
  assertNonCredentialPath,
  credentialGitPathspecs,
  pathPermissionIntents,
  WorkspacePathPolicy,
} from "../path-policy.js";
import { safeGitArguments } from "../git-safety.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MAX_AUTHOR_BYTES = 512;
const MAX_SUBJECT_BYTES = 4 * 1024;
const LOG_FORMAT = "%H%x00%aI%x00%an%x00%s%x00";

export interface GitHistoryInput {
  readonly path?: string;
  readonly limit: number;
}

interface GitHistoryEntry {
  readonly commit: string;
  readonly authoredAt: string;
  readonly author: string;
  readonly subject: string;
}

function parseInput(value: unknown): GitHistoryInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "git_history expects an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "path" && key !== "limit")) {
    throw new ToolError("invalid_input", "git_history received an unknown option");
  }
  const inputPath = record.path;
  const limit = record.limit ?? DEFAULT_LIMIT;
  if (inputPath !== undefined && typeof inputPath !== "string") {
    throw new ToolError("invalid_input", "path must be a string");
  }
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_LIMIT
  ) {
    throw new ToolError(
      "invalid_input",
      `limit must be between 1 and ${MAX_LIMIT}`,
    );
  }
  return {
    ...(inputPath === undefined ? {} : { path: inputPath }),
    limit: limit as number,
  };
}

function truncateUtf8(value: string, maximum: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximum) return value;
  let end = maximum;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return `${encoded.subarray(0, end).toString("utf8")}…`;
}

function parseHistory(output: string): GitHistoryEntry[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0\n")) {
    throw new ToolError("process_failed", "Git history output was malformed");
  }
  return output.slice(0, -2).split("\0\n").map((raw) => {
    const fields = raw.split("\0");
    if (fields.length !== 4) {
      throw new ToolError("process_failed", "Git history output was malformed");
    }
    const [commit = "", authoredAt = "", author = "", subject = ""] = fields;
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) {
      throw new ToolError("process_failed", "Git history returned an invalid object id");
    }
    return {
      commit,
      authoredAt,
      author: truncateUtf8(author, MAX_AUTHOR_BYTES),
      subject: truncateUtf8(subject, MAX_SUBJECT_BYTES),
    };
  });
}

function renderHistory(entries: readonly GitHistoryEntry[]): {
  readonly output: string;
  readonly rendered: number;
  readonly truncated: boolean;
} {
  let output = "";
  let rendered = 0;
  for (const entry of entries) {
    const line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(line, "utf8") >
      MAX_TOOL_OUTPUT_BYTES) {
      return { output, rendered, truncated: true };
    }
    output += line;
    rendered += 1;
  }
  return { output, rendered, truncated: false };
}

export function createGitHistoryTool(): Tool<GitHistoryInput> {
  return {
    definition: {
      name: "git_history",
      description:
        "Show bounded recent commit metadata for the workspace or one path",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
        additionalProperties: false,
      },
    },
    executionClass: "fixed_process",
    mutating: false,
    parallelSafe: true,
    parse: parseInput,
    permissions(input) {
      return input.path === undefined
        ? [{ category: "read", resource: ".git/history", risk: "normal" }]
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
      const gitPrefix = await safeGitArguments(
        context.cwd,
        [],
        context.signal,
      );
      const head = await runProcess("git", [
        ...gitPrefix,
        "--no-replace-objects",
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD",
      ], {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: 4 * 1024,
        acceptableExitCodes: [0, 1],
      });
      if (head.exitCode === 1) {
        return {
          output: `No commits found for path ${JSON.stringify(target)}.\n`,
          metadata: {
            path: target,
            returnedCommits: 0,
            requestedLimit: input.limit,
            truncated: false,
            exitCode: 0,
            sources: [`inspected 0 recent commits for ${JSON.stringify(target)}`],
          },
        };
      }
      const result = await runProcess("git", [
        ...gitPrefix,
        "--no-replace-objects",
        "log",
        "--no-decorate",
        "--no-notes",
        "--no-patch",
        "--no-show-signature",
        "--topo-order",
        `--max-count=${input.limit + 1}`,
        `--format=${LOG_FORMAT}`,
        "--",
        targetPathspec,
        ...credentialGitPathspecs(),
      ], {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      });
      const available = parseHistory(result.stdout);
      const hasMore = available.length > input.limit;
      const rendered = renderHistory(available.slice(0, input.limit));
      const truncated = hasMore || rendered.truncated;
      return {
        output: rendered.rendered === 0
          ? `No commits found for path ${JSON.stringify(target)}.\n`
          : rendered.output,
        metadata: {
          path: target,
          returnedCommits: rendered.rendered,
          requestedLimit: input.limit,
          truncated,
          exitCode: result.exitCode,
          sources: [
            `inspected ${rendered.rendered} recent commit${rendered.rendered === 1 ? "" : "s"} for ${JSON.stringify(target)}`,
          ],
        },
      };
    },
  };
}
