import type { RunResult as CoordinatedRunResult } from "@recurs/contracts";

import {
  AgentLoop,
  type AgentLoopDependencies,
} from "./agent-loop.js";
import type {
  DirectRunExecutor,
  DirectRunExecutorInput,
} from "./run-coordinator.js";

export type AgentLoopDirectExecutorDependencies = Omit<
  AgentLoopDependencies,
  "provider"
>;

export class AgentLoopDirectExecutor implements DirectRunExecutor {
  constructor(private readonly dependencies: AgentLoopDirectExecutorDependencies) {}

  async run(input: DirectRunExecutorInput): Promise<CoordinatedRunResult> {
    const loop = new AgentLoop({
      ...this.dependencies,
      provider: input.provider,
      authorization: input.authorization,
    });
    const result = await loop.runWithMutation(
      {
        sessionId: input.session.id,
        turnId: input.turnId,
        prompt: input.prompt,
        executionMode: input.executionMode,
        context: input.context,
        ...(input.steering === undefined ? {} : { steering: input.steering }),
        ...(input.queuedTurns === undefined ? {} : { queuedTurns: input.queuedTurns }),
        ...(input.queuedInputId === undefined
          ? {}
          : { queuedInputId: input.queuedInputId }),
        maxSteps: input.session.agent.role === "child"
          ? Math.min(
              input.authorization.maxRequests,
              input.session.agent.limits.maxRequests,
            )
          : input.authorization.maxRequests,
        signal: input.signal,
      },
      input.mutation,
    );
    return {
      finalText: result.finalText,
      usage: result.usage,
      usageSource: "provider",
      steps: result.steps,
      changedFiles: result.changedFiles,
      changedFilesSource: "host_tools",
      evidence: result.evidence,
      evidenceSource: result.evidence.length > 0 ? "host_tools" : "none",
    };
  }
}
