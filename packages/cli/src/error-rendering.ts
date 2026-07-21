import { randomUUID } from "node:crypto";

import {
  AgentLoopError,
  CoordinatedRunError,
  safeAgentLoopErrorMessage,
  unexpectedFailureMessage as coreUnexpectedFailureMessage,
} from "@recurs/core";
import {
  ProviderError,
  ProviderDiscoveryError,
  safeProviderErrorMessage,
} from "@recurs/providers";
import {
  CodexOnboardingError,
  ConnectionLifecycleError,
  EnvironmentConnectionError,
} from "@recurs/app";

import { RuntimeError } from "./runtime.js";
import { ImageInputError } from "./image-input.js";
import { LocalConnectionError } from "./local-connection.js";

export function unexpectedFailureMessage(
  diagnosticId: string = randomUUID(),
): string {
  return coreUnexpectedFailureMessage(diagnosticId);
}

export function safeCliErrorMessage(
  error: unknown,
  diagnosticId?: string,
): string {
  if (error instanceof ProviderDiscoveryError) {
    return error.message;
  }
  if (error instanceof ProviderError) {
    return safeProviderErrorMessage(error);
  }
  if (error instanceof AgentLoopError) {
    return safeAgentLoopErrorMessage(error);
  }
  if (
    error instanceof RuntimeError ||
    error instanceof ImageInputError ||
    error instanceof LocalConnectionError ||
    error instanceof CodexOnboardingError ||
    error instanceof EnvironmentConnectionError ||
    error instanceof ConnectionLifecycleError ||
    error instanceof CoordinatedRunError
  ) {
    return error.message;
  }
  return unexpectedFailureMessage(diagnosticId);
}
