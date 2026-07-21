import {
  MAX_MODEL_IMAGES,
  MAX_MODEL_IMAGE_TOTAL_BYTES,
  MODEL_IMAGE_MEDIA_TYPES,
  type ModelImageInput,
  type ModelMessage,
} from "./model.js";

const MEDIA_TYPES = new Set<string>(MODEL_IMAGE_MEDIA_TYPES);

function isBase64Character(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
}

function base64Value(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  return code === 0x2b ? 62 : 63;
}

export function modelImageByteLength(data: string): number | null {
  if (
    data.length === 0 ||
    data.length > Math.ceil(MAX_MODEL_IMAGE_TOTAL_BYTES / 3) * 4 ||
    data.length % 4 !== 0
  ) {
    return null;
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  for (let index = 0; index < data.length - padding; index += 1) {
    if (!isBase64Character(data.charCodeAt(index))) return null;
  }
  for (let index = data.length - padding; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 0x3d) return null;
  }
  if (
    (padding === 2 &&
      (base64Value(data.charCodeAt(data.length - 3)) & 0x0f) !== 0) ||
    (padding === 1 &&
      (base64Value(data.charCodeAt(data.length - 2)) & 0x03) !== 0)
  ) {
    return null;
  }
  return (data.length / 4) * 3 - padding;
}

export function isModelImageInput(value: unknown): value is ModelImageInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2 &&
    MEDIA_TYPES.has(String(candidate.mediaType)) &&
    typeof candidate.data === "string" &&
    modelImageByteLength(candidate.data) !== null;
}

export function modelImagesByteLength(
  images: readonly ModelImageInput[],
): number | null {
  if (images.length === 0 || images.length > MAX_MODEL_IMAGES) return null;
  let total = 0;
  for (const image of images) {
    if (!isModelImageInput(image)) return null;
    const bytes = modelImageByteLength(image.data);
    if (bytes === null) return null;
    total += bytes;
    if (total > MAX_MODEL_IMAGE_TOTAL_BYTES) return null;
  }
  return total;
}

export function modelRequestImagesByteLength(
  messages: readonly ModelMessage[],
): number | null {
  let total = 0;
  for (const message of messages) {
    if (message.images === undefined) continue;
    const bytes = modelImagesByteLength(message.images);
    if (bytes === null) return null;
    total += bytes;
    if (total > MAX_MODEL_IMAGE_TOTAL_BYTES) return null;
  }
  return total;
}
