import { credentialGitPathspecs, isCredentialPath } from "../path-policy.js";
import { safeGitArguments } from "../git-safety.js";
import { decodeUtf8Record, splitNulTerminatedRecords } from "../nul-records.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

const MAX_RAW_STATUS_BYTES = 1024 * 1024;
const MAX_STATUS_OUTPUT_BYTES = 512 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MODE = /^[0-7]{6}$/u;
const STATUS = /^[.MTADRCU]{2}$/u;
const SUBMODULE = /^(?:N\.\.\.|S[C.][M.][U.])$/u;
const SIMILARITY = /^[RC](?:100|[0-9]{1,2})$/u;

interface GitBranchStatus {
  readonly type: "branch";
  readonly oid: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
}

interface GitChangeStatus {
  readonly type: "change";
  readonly kind: "ordinary" | "rename" | "copy" | "unmerged" | "untracked";
  readonly path: string;
  readonly index: string;
  readonly worktree: string;
  readonly originalPath?: string;
  readonly similarity?: number;
  readonly submodule?: string;
}

interface ParsedStatus {
  readonly branch: GitBranchStatus;
  readonly changes: readonly GitChangeStatus[];
  readonly omitted: number;
}

function parseInput(value: unknown): Record<string, never> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    throw new ToolError("invalid_input", "git_status does not accept arguments");
  }
  return {};
}

function splitFields(value: string, separators: number): string[] | null {
  const fields: string[] = [];
  let start = 0;
  for (let count = 0; count < separators; count += 1) {
    const end = value.indexOf(" ", start);
    if (end <= start) return null;
    fields.push(value.slice(start, end));
    start = end + 1;
  }
  if (start >= value.length) return null;
  fields.push(value.slice(start));
  return fields;
}

function validObjectFields(
  fields: readonly string[],
  modeIndexes: readonly number[],
  objectIndexes: readonly number[],
): boolean {
  return modeIndexes.every((index) => MODE.test(fields[index] ?? "")) &&
    objectIndexes.every((index) => OBJECT_ID.test(fields[index] ?? ""));
}

function commonChange(
  kind: GitChangeStatus["kind"],
  xy: string,
  submodule: string,
  filePath: string,
): GitChangeStatus | null {
  if (
    !STATUS.test(xy) || !SUBMODULE.test(submodule) || filePath.length === 0
  ) {
    throw new ToolError("process_failed", "Git status change was malformed");
  }
  if (isCredentialPath(filePath)) return null;
  return {
    type: "change",
    kind,
    path: filePath,
    index: xy[0]!,
    worktree: xy[1]!,
    ...(submodule === "N..." ? {} : { submodule }),
  };
}

function parseTracked(record: string): GitChangeStatus | null {
  const marker = record[0];
  if (marker === "1") {
    const fields = splitFields(record, 8);
    if (
      fields === null || fields[0] !== "1" ||
      !validObjectFields(fields, [3, 4, 5], [6, 7])
    ) {
      throw new ToolError("process_failed", "Git status record was malformed");
    }
    return commonChange("ordinary", fields[1]!, fields[2]!, fields[8]!);
  }
  if (marker === "u") {
    const fields = splitFields(record, 10);
    if (
      fields === null || fields[0] !== "u" ||
      !validObjectFields(fields, [3, 4, 5, 6], [7, 8, 9])
    ) {
      throw new ToolError("process_failed", "Git unmerged record was malformed");
    }
    return commonChange("unmerged", fields[1]!, fields[2]!, fields[10]!);
  }
  throw new ToolError("process_failed", "Git status returned an unknown record");
}

function parseStatus(bytes: Buffer): ParsedStatus {
  const records = splitNulTerminatedRecords(bytes, "Git status output");
  let oid: string | null | undefined;
  let head: string | null | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const changes: GitChangeStatus[] = [];
  let omitted = 0;

  for (let index = 0; index < records.length; index += 1) {
    const recordBytes = records[index]!;
    const marker = recordBytes[0];
    if (marker === 0x23) {
      const record = decodeUtf8Record(recordBytes);
      if (record === null) {
        throw new ToolError("process_failed", "Git status header was not valid UTF-8");
      }
      if (record.startsWith("# branch.oid ")) {
        if (oid !== undefined) {
          throw new ToolError("process_failed", "Git status repeated its object id");
        }
        const value = record.slice(13);
        if (value !== "(initial)" && !OBJECT_ID.test(value)) {
          throw new ToolError("process_failed", "Git status returned an invalid object id");
        }
        oid = value === "(initial)" ? null : value;
      } else if (record.startsWith("# branch.head ")) {
        if (head !== undefined) {
          throw new ToolError("process_failed", "Git status repeated its branch head");
        }
        const value = record.slice(14);
        if (value.length === 0) {
          throw new ToolError("process_failed", "Git status returned an empty branch head");
        }
        head = value === "(detached)" ? null : value;
      } else if (record.startsWith("# branch.upstream ")) {
        if (upstream !== undefined) {
          throw new ToolError("process_failed", "Git status repeated its upstream");
        }
        upstream = record.slice(18);
        if (upstream.length === 0) {
          throw new ToolError("process_failed", "Git status returned an empty upstream");
        }
      } else if (record.startsWith("# branch.ab ")) {
        if (ahead !== undefined || behind !== undefined) {
          throw new ToolError("process_failed", "Git status repeated ahead/behind data");
        }
        const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
        if (match === null) {
          throw new ToolError("process_failed", "Git status returned invalid ahead/behind data");
        }
        ahead = Number.parseInt(match[1]!, 10);
        behind = Number.parseInt(match[2]!, 10);
        if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
          throw new ToolError("process_failed", "Git status ahead/behind data was too large");
        }
      }
      continue;
    }

    if (marker === 0x32) {
      const originalBytes = records[index + 1];
      if (originalBytes === undefined) {
        throw new ToolError("process_failed", "Git rename record was incomplete");
      }
      index += 1;
      const record = decodeUtf8Record(recordBytes);
      const originalPath = decodeUtf8Record(originalBytes);
      if (record === null || originalPath === null) {
        omitted += 1;
        continue;
      }
      const fields = splitFields(record, 9);
      if (
        fields === null || fields[0] !== "2" ||
        !validObjectFields(fields, [3, 4, 5], [6, 7]) ||
        !SIMILARITY.test(fields[8] ?? "")
      ) {
        throw new ToolError("process_failed", "Git rename record was malformed");
      }
      const score = fields[8]!;
      const change = commonChange(
        score[0] === "R" ? "rename" : "copy",
        fields[1]!,
        fields[2]!,
        fields[9]!,
      );
      if (change === null || isCredentialPath(originalPath)) {
        omitted += 1;
        continue;
      }
      changes.push({
        ...change,
        originalPath,
        similarity: Number.parseInt(score.slice(1), 10),
      });
      continue;
    }

    const record = decodeUtf8Record(recordBytes);
    if (record === null) {
      omitted += 1;
      continue;
    }
    if (marker === 0x3f) {
      if (!record.startsWith("? ") || record.length === 2) {
        throw new ToolError("process_failed", "Git untracked record was malformed");
      }
      const filePath = record.slice(2);
      if (isCredentialPath(filePath)) {
        omitted += 1;
        continue;
      }
      changes.push({
        type: "change",
        kind: "untracked",
        path: filePath,
        index: "?",
        worktree: "?",
      });
      continue;
    }
    const change = parseTracked(record);
    if (change === null) {
      omitted += 1;
    } else {
      changes.push(change);
    }
  }

  if (oid === undefined || head === undefined) {
    throw new ToolError("process_failed", "Git status omitted required branch data");
  }
  if ((ahead !== undefined || behind !== undefined) && upstream === undefined) {
    throw new ToolError("process_failed", "Git status returned unbound ahead/behind data");
  }
  changes.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")) ||
    (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
  );
  return {
    branch: {
      type: "branch",
      oid,
      head,
      detached: head === null,
      ...(upstream === undefined ? {} : { upstream }),
      ...(ahead === undefined || behind === undefined ? {} : { ahead, behind }),
    },
    changes,
    omitted,
  };
}

function renderStatus(parsed: ParsedStatus): {
  readonly output: string;
  readonly renderedChanges: number;
  readonly truncated: boolean;
} {
  let output = `${JSON.stringify(parsed.branch)}\n`;
  let outputBytes = Buffer.byteLength(output, "utf8");
  let renderedChanges = 0;
  for (const change of parsed.changes) {
    const line = `${JSON.stringify(change)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (outputBytes + lineBytes > MAX_STATUS_OUTPUT_BYTES) {
      return { output, renderedChanges, truncated: true };
    }
    output += line;
    outputBytes += lineBytes;
    renderedChanges += 1;
  }
  return { output, renderedChanges, truncated: false };
}

export function createGitStatusTool(): Tool<Record<string, never>> {
  return {
    definition: {
      name: "git_status",
      description: "Show structured branch and workspace status from Git porcelain v2",
      inputSchema: { type: "object", additionalProperties: false },
    },
    executionClass: "fixed_process",
    mutating: false,
    parallelSafe: true,
    parse: parseInput,
    permissions() {
      return [{ category: "read", resource: ".git/status", risk: "normal" }];
    },
    async execute(_input, context) {
      const args = await safeGitArguments(
        context.cwd,
        [
          "status",
          "--porcelain=v2",
          "--branch",
          "--ahead-behind",
          "--untracked-files=all",
          "--ignore-submodules=dirty",
          "--renames",
          "--find-renames=50%",
          "-z",
          "--",
          ".",
          ...credentialGitPathspecs(),
        ],
        context.signal,
      );
      const result = await runProcess("git", args, {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: MAX_RAW_STATUS_BYTES,
        captureStdoutBytes: true,
      });
      if (result.stdoutBytes === undefined) {
        throw new ToolError("process_failed", "Git status bytes were unavailable");
      }
      const parsed = parseStatus(result.stdoutBytes);
      const rendered = renderStatus(parsed);
      const truncated = rendered.truncated || parsed.omitted > 0;
      return {
        output: rendered.output,
        metadata: {
          branch: parsed.branch.head,
          oid: parsed.branch.oid,
          upstream: parsed.branch.upstream ?? null,
          ahead: parsed.branch.ahead ?? null,
          behind: parsed.branch.behind ?? null,
          changes: rendered.renderedChanges,
          totalChanges: parsed.changes.length,
          omitted: parsed.omitted,
          clean: parsed.changes.length === 0 && parsed.omitted === 0,
          truncated,
          exitCode: result.exitCode,
          sources: ["inspected git status"],
        },
      };
    },
  };
}
