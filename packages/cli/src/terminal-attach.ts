import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";

import {
  MAX_PROCESS_SESSION_COLUMNS,
  MAX_PROCESS_SESSION_INPUT_BYTES,
  MAX_PROCESS_SESSION_ROWS,
  MIN_PROCESS_SESSION_COLUMNS,
  MIN_PROCESS_SESSION_ROWS,
  ToolError,
  type OwnedProcessSnapshot,
  type PtySize,
} from "@recurs/tools";

import type { RecursRuntime } from "./runtime.js";
import { writeOutput } from "./render.js";

const DETACH_BYTE = 0x1d;
const ATTACH_POLL_MS = 100;

type RawTerminalInput = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
};

type TerminalOutput = Writable & {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
};

export type ProcessAttachmentHost = (
  runtime: RecursRuntime,
  sessionId: string,
  input: Readable,
  output: Writable,
) => Promise<void>;

function terminalSize(output: TerminalOutput): PtySize | undefined {
  if (!Number.isSafeInteger(output.columns) || !Number.isSafeInteger(output.rows)) {
    return undefined;
  }
  return {
    columns: Math.max(
      MIN_PROCESS_SESSION_COLUMNS,
      Math.min(MAX_PROCESS_SESSION_COLUMNS, output.columns!),
    ),
    rows: Math.max(
      MIN_PROCESS_SESSION_ROWS,
      Math.min(MAX_PROCESS_SESSION_ROWS, output.rows!),
    ),
  };
}

function renderTerminalSnapshot(
  snapshot: OwnedProcessSnapshot,
  output: Writable,
): Promise<void> {
  if (!snapshot.terminal) {
    throw new ToolError(
      "invalid_input",
      "Only an interactive terminal process can be attached",
    );
  }
  if (snapshot.status === "failed") {
    throw new ToolError(
      snapshot.failure?.code ?? "process_failed",
      snapshot.failure?.message ?? "The process session failed",
    );
  }
  const writes = snapshot.output.length === 0
    ? Promise.resolve()
    : writeOutput(output, snapshot.output);
  if (snapshot.status === "running") return writes;
  return writes.then(() =>
    writeOutput(
      output,
      `${snapshot.output.endsWith("\n") || snapshot.output.length === 0 ? "" : "\r\n"}Process exited with code ${snapshot.exitCode ?? -1}.\r\n`,
    )
  );
}

function takeInput(
  queue: Buffer[],
  onRead: (bytes: number) => void,
): Uint8Array | undefined {
  const first = queue.shift();
  if (first === undefined) return undefined;
  onRead(first.byteLength);
  return first;
}

export const attachOwnedTerminalProcess: ProcessAttachmentHost = async (
  runtime,
  sessionId,
  rawInput,
  rawOutput,
) => {
  const input = rawInput as RawTerminalInput;
  const output = rawOutput as TerminalOutput;
  if (
    input.isTTY !== true || output.isTTY !== true ||
    typeof input.setRawMode !== "function"
  ) {
    throw new ToolError(
      "invalid_input",
      "Process attachment requires an interactive terminal",
    );
  }

  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let detached = false;
  let inputFailure: ToolError | undefined;
  let pendingSize = terminalSize(output);
  const onData = (chunk: Buffer | string): void => {
    if (detached) return;
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
    const detachAt = bytes.indexOf(DETACH_BYTE);
    const forwarded = detachAt < 0 ? bytes : bytes.subarray(0, detachAt);
    if (forwarded.byteLength > MAX_PROCESS_SESSION_INPUT_BYTES - queuedBytes) {
      queue.length = 0;
      queuedBytes = 0;
      inputFailure = new ToolError(
        "invalid_input",
        "Attached terminal input exceeded the bounded queue",
      );
      detached = true;
      return;
    }
    if (forwarded.length > 0) {
      queue.push(forwarded);
      queuedBytes += forwarded.byteLength;
    }
    if (detachAt >= 0) detached = true;
  };
  const onResize = (): void => {
    pendingSize = terminalSize(output);
  };
  const wasRaw = input.isRaw === true;

  await writeOutput(
    output,
    `Attached to ${sessionId}. Press Ctrl-] to detach.\r\n`,
  );
  let rawModeRequested = false;
  try {
    rawModeRequested = true;
    input.setRawMode(true);
    input.on("data", onData);
    output.on("resize", onResize);
    input.resume();
    while (!detached || queue.length > 0) {
      if (inputFailure !== undefined) throw inputFailure;
      let snapshot: OwnedProcessSnapshot;
      if (pendingSize !== undefined) {
        const resize = pendingSize;
        pendingSize = undefined;
        snapshot = await runtime.interactWithOwnedProcess({
          sessionId,
          resize,
          yieldTimeMs: 0,
        });
      } else {
        const bytes = takeInput(queue, (read) => {
          queuedBytes -= read;
        });
        snapshot = await runtime.interactWithOwnedProcess({
          sessionId,
          ...(bytes === undefined ? {} : { input: bytes }),
          yieldTimeMs: bytes === undefined ? ATTACH_POLL_MS : 0,
        });
      }
      await renderTerminalSnapshot(snapshot, output);
      if (inputFailure !== undefined) throw inputFailure;
      if (snapshot.status !== "running") return;
    }
    await writeOutput(output, `\r\nDetached from ${sessionId}; process continues.\r\n`);
  } finally {
    input.pause();
    input.off("data", onData);
    output.off("resize", onResize);
    if (rawModeRequested) input.setRawMode(wasRaw);
  }
};
