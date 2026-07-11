import { randomUUID } from "node:crypto";

import {
  AgentLoopError,
  CoordinatedRunError,
  safeAgentLoopErrorMessage,
  unexpectedFailureMessage as coreUnexpectedFailureMessage,
} from "@recurs/core";
import {
  ProviderError,
  safeProviderErrorMessage,
} from "@recurs/providers";
import { CodexOnboardingError } from "@recurs/app";

import { RuntimeError } from "./runtime.js";
import { LocalConnectionError } from "./local-connection.js";

export function unexpectedFailureMessage(): string {
  return coreUnexpectedFailureMessage(randomUUID());
}

export function safeCliErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    return safeProviderErrorMessage(error);
  }
  if (error instanceof AgentLoopError) {
    return safeAgentLoopErrorMessage(error);
  }
  if (
    error instanceof RuntimeError ||
    error instanceof LocalConnectionError ||
    error instanceof CodexOnboardingError ||
    error instanceof CoordinatedRunError
  ) {
    return error.message;
  }
  return unexpectedFailureMessage();
}
