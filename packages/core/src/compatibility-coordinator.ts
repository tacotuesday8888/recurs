import { randomUUID } from "node:crypto";

import type {
  CoordinatedRun,
  CoordinatedRunInput,
  IntegrationFailure,
  RunCoordinator,
  RunOutcome,
} from "@recurs/contracts";

import {
  AgentLoopError,
  safeAgentLoopErrorMessage,
  unexpectedFailureMessage,
  type AgentLoop,
} from "./agent-loop.js";

function noEvents(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<never>> {
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

function compatibilityFailure(error: unknown): IntegrationFailure {
  const diagnosticId = randomUUID();
  if (error instanceof AgentLoopError) {
    return {
      domain: "provider",
      phase: error.code === "invalid_run_input" ? "preflight" : "started",
      code: error.code === "cancelled" ? "cancelled" : "runtime_failed",
      safeMessage: safeAgentLoopErrorMessage(error),
      diagnosticId,
      retryable: false,
    };
  }
  return {
    domain: "provider",
    phase: "started",
    code: "runtime_failed",
    safeMessage: unexpectedFailureMessage(diagnosticId),
    diagnosticId,
    retryable: false,
  };
}

export class CompatibilityRunCoordinator implements RunCoordinator {
  constructor(private readonly loop: AgentLoop) {}

  async start(input: CoordinatedRunInput): Promise<CoordinatedRun> {
    const outcome: Promise<RunOutcome> = this.loop.run({
      sessionId: input.sessionId,
      prompt: input.prompt,
      signal: input.signal,
      ...(input.steering === undefined ? {} : { steering: input.steering }),
      ...(input.queuedTurns === undefined ? {} : { queuedTurns: input.queuedTurns }),
      ...(input.queuedInputId === undefined
        ? {}
        : { queuedInputId: input.queuedInputId }),
      ...(input.executionMode === undefined
        ? {}
        : { executionMode: input.executionMode }),
    }).then(
      (result) => ({
        ok: true,
        result: {
          finalText: result.finalText,
          usage: result.usage,
          usageSource: "provider",
          steps: result.steps,
          changedFiles: result.changedFiles,
          changedFilesSource: "host_tools",
          evidence: result.evidence,
          evidenceSource: result.evidence.length > 0 ? "host_tools" : "none",
        },
      }),
      (error: unknown) => ({ ok: false, failure: compatibilityFailure(error) }),
    );
    return { events: noEvents(), outcome };
  }
}
