import { randomUUID } from "node:crypto";

import { AgentLoopError, CoordinatedRunError } from "@recurs/core";
import {
  ProviderError,
  safeProviderErrorMessage,
} from "@recurs/providers";

import { RuntimeError } from "./runtime.js";

function safeAgentLoopErrorMessage(error: AgentLoopError): string {
  switch (error.code) {
    case "cancelled":
      return "Agent run cancelled";
    case "invalid_run_input":
      return "Agent run input is invalid";
    case "invalid_provider_response":
      return "Provider returned an invalid response";
    case "provider_failed":
      return "Provider request failed";
    case "session_busy":
      return "Session is busy";
    case "step_budget_exceeded":
      return "Agent step limit exceeded";
    case "stuck_loop":
      return "Repeated tool interaction detected";
  }
}

export function unexpectedFailureMessage(): string {
  return `Unexpected failure (diagnostic ${randomUUID()})`;
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
    error instanceof CoordinatedRunError
  ) {
    return error.message;
  }
  return unexpectedFailureMessage();
}
