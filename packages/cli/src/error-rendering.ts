import { randomUUID } from "node:crypto";

import {
  AgentLoopError,
  CompanyAmendmentError,
  CompanyLearningError,
  CompanyStateStoreError,
  CoordinatedRunError,
  TeamControlAdaptationError,
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
import { LifecycleHookConfigurationError } from "./lifecycle-hooks.js";
import { PermissionRuleConfigurationError } from "./permission-rules.js";
import { CompanyEvaluationStoreError } from "./company-evaluation-store.js";

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
  if (error instanceof CompanyStateStoreError) {
    if (error.code === "invalid_id") {
      return "Private Recurs state uses an invalid identifier.";
    }
    if (error.code === "not_found") {
      return "Private Recurs state was not found.";
    }
    if (error.code === "conflict" || error.code === "sequence_conflict") {
      return "Private Recurs state changed concurrently. Reload and retry.";
    }
    return "Private Recurs state is unsafe or corrupt. Check RECURS_HOME safety and integrity before retrying.";
  }
  if (
    error instanceof RuntimeError ||
    error instanceof CompanyEvaluationStoreError ||
    error instanceof CompanyAmendmentError ||
    error instanceof CompanyLearningError ||
    error instanceof TeamControlAdaptationError ||
    error instanceof ImageInputError ||
    error instanceof LocalConnectionError ||
    error instanceof LifecycleHookConfigurationError ||
    error instanceof PermissionRuleConfigurationError ||
    error instanceof CodexOnboardingError ||
    error instanceof EnvironmentConnectionError ||
    error instanceof ConnectionLifecycleError ||
    error instanceof CoordinatedRunError
  ) {
    return error.message;
  }
  return unexpectedFailureMessage(diagnosticId);
}
