import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { ToolError } from "./types.js";

interface StableFileHandle {
  stat(): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

interface StableTextFileOperations {
  lstat(file: string): Promise<BigIntStats>;
  open(file: string, flags: number): Promise<StableFileHandle>;
}

const liveOperations: StableTextFileOperations = {
  lstat(file) {
    return lstat(file, { bigint: true });
  },
  async open(file, flags) {
    const handle = await open(file, flags);
    return {
      stat() {
        return handle.stat({ bigint: true });
      },
      read(buffer, offset, length, position) {
        return handle.read(buffer, offset, length, position);
      },
      close() {
        return handle.close();
      },
    };
  },
};

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

interface StableTextFile {
  readonly bytes: Buffer;
  readonly content: string;
}

export async function readStableTextFile(
  file: string,
  displayPath: string,
  maximumBytes: number,
  operations: StableTextFileOperations = liveOperations,
): Promise<StableTextFile> {
  let initial: BigIntStats;
  try {
    initial = await operations.lstat(file);
  } catch (error) {
    throw new ToolError(
      "stale_file",
      `File changed before it could be read: ${displayPath}`,
      { cause: error },
    );
  }
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new ToolError("invalid_input", `Cannot read non-file: ${displayPath}`);
  }
  if (initial.size > BigInt(maximumBytes)) {
    throw new ToolError(
      "output_limit",
      `File exceeds the ${maximumBytes}-byte read limit: ${displayPath}`,
    );
  }
  let handle: StableFileHandle;
  try {
    handle = await operations.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new ToolError(
      "stale_file",
      `File changed before it could be read: ${displayPath}`,
      { cause: error },
    );
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameStat(initial, before)) {
      throw new ToolError(
        "stale_file",
        `File changed while it was opened: ${displayPath}`,
      );
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== bytes.length || !sameStat(before, after)) {
      throw new ToolError(
        "stale_file",
        `File changed while it was read: ${displayPath}`,
      );
    }
    if (bytes.includes(0)) {
      throw new ToolError(
        "invalid_input",
        `Cannot read binary or invalid UTF-8 file: ${displayPath}`,
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new ToolError(
        "invalid_input",
        `Cannot read binary or invalid UTF-8 file: ${displayPath}`,
        { cause: error },
      );
    }
    return { bytes, content };
  } finally {
    await handle.close();
  }
}
