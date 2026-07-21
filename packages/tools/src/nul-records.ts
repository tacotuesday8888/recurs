import { ToolError } from "./types.js";

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeUtf8Record(bytes: Uint8Array): string | null {
  try {
    return FATAL_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export function splitNulTerminatedRecords(
  bytes: Buffer,
  label: string,
): readonly Buffer[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) {
    throw new ToolError("process_failed", `${label} was not NUL-terminated`);
  }
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) {
      throw new ToolError("process_failed", `${label} contained an empty record`);
    }
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return records;
}
