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
import { LocalConnectionError } from "./local-connection.js";

export function unexpectedFailureMessage(): string {
  return coreUnexpectedFailureMessage(randomUUID());
}

export function safeCliErrorMessage(error: unknown): string {
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
    error instanceof LocalConnectionError ||
    error instanceof CodexOnboardingError ||
    error instanceof EnvironmentConnectionError ||
    error instanceof ConnectionLifecycleError ||
    error instanceof CoordinatedRunError
  ) {
    return error.message;
  }
  return unexpectedFailureMessage();
}
