import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_PROJECT_INSTRUCTION_BYTES = 32 * 1024;
export const PROJECT_INSTRUCTION_FILENAMES = Object.freeze([
  "AGENTS.override.md",
  "AGENTS.md",
] as const);

const MAX_BRIEF_FIELD_LENGTH = 2_000;

export interface ProjectInstructionDocument {
  readonly source: string;
  readonly contents: string;
}

export interface ProjectBriefInput {
  readonly purpose?: string;
  readonly notes?: string;
}

export class ProjectInstructionsError extends Error {
  constructor(
    public readonly code: "invalid" | "too_large" | "changed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectInstructionsError";
  }
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function projectDirectories(cwd: string): Promise<readonly string[]> {
  const resolved = await realpath(cwd);
  const upward: string[] = [];
  let cursor = resolved;
  let root: string | null = null;
  for (;;) {
    upward.push(cursor);
    if (await exists(path.join(cursor, ".git"))) {
      root = cursor;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (root === null) return Object.freeze([resolved]);
  return Object.freeze(upward.slice(0, upward.indexOf(root) + 1).reverse());
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function readExactRegularFile(
  file: string,
  remainingBytes: number,
): Promise<string> {
  let initial: BigIntStats;
  try {
    initial = await lstat(file, { bigint: true });
  } catch (error) {
    throw new ProjectInstructionsError(
      "invalid",
      "Project instructions must be a readable regular file, not a symlink",
      { cause: error },
    );
  }
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new ProjectInstructionsError(
      "invalid",
      "Project instructions must be a readable regular file, not a symlink",
    );
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new ProjectInstructionsError(
      "invalid",
      "Project instructions must be a readable regular file, not a symlink",
      { cause: error },
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameStat(initial, before)) {
      throw new ProjectInstructionsError(
        "changed",
        "Project instructions changed while they were read; retry the turn",
      );
    }
    if (before.size > BigInt(remainingBytes)) {
      throw new ProjectInstructionsError(
        "too_large",
        `Project instructions exceed the ${MAX_PROJECT_INSTRUCTION_BYTES}-byte workspace limit`,
      );
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== buffer.length || !sameStat(before, after)) {
      throw new ProjectInstructionsError(
        "changed",
        "Project instructions changed while they were read; retry the turn",
      );
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error) {
      throw new ProjectInstructionsError(
        "invalid",
        "Project instructions must contain valid UTF-8 text",
        { cause: error },
      );
    }
    if (contents.includes("\0")) {
      throw new ProjectInstructionsError(
        "invalid",
        "Project instructions must contain valid UTF-8 text",
      );
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export async function discoverProjectInstructions(
  cwd: string,
): Promise<readonly ProjectInstructionDocument[]> {
  const directories = await projectDirectories(cwd);
  const root = directories[0]!;
  const documents: ProjectInstructionDocument[] = [];
  let remaining = MAX_PROJECT_INSTRUCTION_BYTES;
  for (const directory of directories) {
    let selected: string | null = null;
    for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
      const candidate = path.join(directory, filename);
      if (await exists(candidate)) {
        selected = candidate;
        break;
      }
    }
    if (selected === null) continue;
    const contents = await readExactRegularFile(selected, remaining);
    remaining -= Buffer.byteLength(contents);
    if (contents.trim().length === 0) continue;
    documents.push(Object.freeze({
      source: path.relative(root, selected) || path.basename(selected),
      contents,
    }));
  }
  return Object.freeze(documents);
}

export async function hasWorkspaceProjectInstructions(
  cwd: string,
): Promise<boolean> {
  const resolved = await realpath(cwd);
  for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
    if (await exists(path.join(resolved, filename))) return true;
  }
  return false;
}

export async function projectContextInstructions(
  cwd: string,
): Promise<readonly string[]> {
  return Object.freeze((await discoverProjectInstructions(cwd)).map((document) =>
    [
      `Project instructions from ${document.source}.`,
      "Follow them when they are consistent with higher-priority user requests, host permissions, and safety policy.",
      document.contents,
    ].join("\n")
  ));
}

function briefText(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (
    normalized.length === 0 || normalized.length > MAX_BRIEF_FIELD_LENGTH ||
    normalized.includes("\0")
  ) return null;
  return normalized;
}

export function isValidProjectBriefText(value: string): boolean {
  return briefText(value) !== null;
}

export function renderProjectInstructions(
  input: ProjectBriefInput = {},
): string {
  const purpose = input.purpose === undefined
    ? "Describe what this project does and what success looks like."
    : briefText(input.purpose);
  const notes = input.notes === undefined
    ? "Add project-specific build, test, architecture, and safety instructions here."
    : briefText(input.notes);
  if (purpose === null || notes === null) {
    throw new ProjectInstructionsError(
      "invalid",
      "Project brief fields must contain between 1 and 2000 valid text characters",
    );
  }
  return `# Recurs project instructions

## Project

${purpose}

## Working agreements

${notes}

Keep this file concise and safe to share with every coding-agent session.
`;
}

export async function createProjectInstructions(
  cwd: string,
  input: ProjectBriefInput = {},
): Promise<"created" | "exists"> {
  const contents = renderProjectInstructions(input);
  const file = path.join(await realpath(cwd), "AGENTS.md");
  let handle;
  try {
    handle = await open(file, "wx", 0o644);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
      error.code === "EEXIST") return "exists";
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return "created";
}
