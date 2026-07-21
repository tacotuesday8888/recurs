import { Buffer } from "node:buffer";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import {
  MAX_MODEL_IMAGES,
  MAX_MODEL_IMAGE_TOTAL_BYTES,
  modelImageByteLength,
  modelImagesByteLength,
  type ModelImageInput,
  type ModelImageMediaType,
} from "@recurs/contracts";

const MAX_IMAGE_PATH_BYTES = 4_096;
const READ_CHUNK_BYTES = 64 * 1024;

export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

function imageMediaType(bytes: Uint8Array): ModelImageMediaType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function normalizeInlineImage(
  data: string,
  claimedMediaType: string,
): ModelImageInput {
  const byteLength = modelImageByteLength(data);
  if (byteLength === null || byteLength > MAX_MODEL_IMAGE_TOTAL_BYTES) {
    throw new ImageInputError("Image data is invalid or exceeds the Recurs limit");
  }
  const bytes = Buffer.from(data, "base64");
  const mediaType = imageMediaType(bytes);
  if (mediaType === null || mediaType !== claimedMediaType) {
    throw new ImageInputError("Image data does not match a supported PNG, JPEG, or WebP type");
  }
  return { mediaType, data };
}

async function readStableFile(
  file: string,
  remainingBytes: number,
): Promise<Buffer> {
  let before;
  try {
    before = await lstat(file);
  } catch {
    throw new ImageInputError("Image input could not be read");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1) {
    throw new ImageInputError("Image input must be a non-empty regular file");
  }
  if (before.size > remainingBytes) {
    throw new ImageInputError("Image input exceeds the five MiB total limit");
  }
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    throw new ImageInputError("Image input could not be read");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ImageInputError("Image input changed while it was opened");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, remainingBytes - total + 1),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > remainingBytes) {
        throw new ImageInputError("Image input exceeds the five MiB total limit");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new ImageInputError("Image input changed while it was read");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function loadImageInputs(
  paths: readonly string[],
  cwd: string,
): Promise<readonly ModelImageInput[]> {
  if (paths.length === 0 || paths.length > MAX_MODEL_IMAGES) {
    throw new ImageInputError(`Provide between one and ${MAX_MODEL_IMAGES} images`);
  }
  const images: ModelImageInput[] = [];
  let total = 0;
  for (const candidate of paths) {
    if (
      candidate.length === 0 || candidate.includes("\0") ||
      Buffer.byteLength(candidate, "utf8") > MAX_IMAGE_PATH_BYTES
    ) {
      throw new ImageInputError("Image path is invalid");
    }
    const bytes = await readStableFile(
      path.resolve(cwd, candidate),
      MAX_MODEL_IMAGE_TOTAL_BYTES - total,
    );
    const mediaType = imageMediaType(bytes);
    if (mediaType === null) {
      throw new ImageInputError("Image input must be PNG, JPEG, or WebP");
    }
    images.push(Object.freeze({ mediaType, data: bytes.toString("base64") }));
    total += bytes.length;
  }
  if (modelImagesByteLength(images) !== total) {
    throw new ImageInputError("Image input could not be normalized safely");
  }
  return Object.freeze(images);
}
