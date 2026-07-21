import {
  modelImagesByteLength,
  modelRequestImagesByteLength,
  type ModelImageInput,
  type ModelMessage,
} from "@recurs/contracts";

import { ProviderError } from "./types.js";

export function validatedMessageImages(
  message: ModelMessage,
): readonly ModelImageInput[] {
  if (message.images === undefined) return [];
  if (message.role !== "user" || modelImagesByteLength(message.images) === null) {
    throw new ProviderError("invalid_response", "Provider image input is invalid", false);
  }
  return message.images;
}

export function imageDataUrl(image: ModelImageInput): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function validateRequestImageBudget(
  messages: readonly ModelMessage[],
): void {
  if (modelRequestImagesByteLength(messages) === null) {
    throw new ProviderError("context_overflow", "Provider image input is too large", false);
  }
}
