import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  FileCompanyBlueprintV2Store,
  isPinnedSessionState,
  JsonlCompanyGoalStore,
  JsonlSessionStore,
} from "@recurs/core";
import type { CompanyEvaluationReportV1 } from "@recurs/contracts";

import { evaluateCompanyGoalExecution } from "./company-evaluation.js";
import type { CompanyEvaluationProgress } from "./company-evaluation.js";

export class CompanyEvaluationStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompanyEvaluationStoreError";
  }
}

function completedAt(startedAt: string, candidate: string): string {
  const start = Date.parse(startedAt);
  const completion = Date.parse(candidate);
  if (!Number.isFinite(start) || !Number.isFinite(completion)) {
    throw new CompanyEvaluationStoreError(
      "The durable company goal contains an invalid timestamp.",
    );
  }
  return completion < start ? startedAt : new Date(completion).toISOString();
}

function interrupted(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true ||
    error instanceof DOMException && error.name === "AbortError";
}

export async function evaluateStoredCompanyGoal(input: {
  readonly dataDirectory: string;
  readonly projectRoot: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly onProgress?: (
    progress: CompanyEvaluationProgress,
  ) => void | Promise<void>;
}): Promise<CompanyEvaluationReportV1> {
  input.signal?.throwIfAborted();
  const projectRoot = await realpath(input.projectRoot);
  const projectId = createHash("sha256").update(projectRoot).digest("hex")
    .slice(0, 24);
  const projectData = path.join(
    path.resolve(input.dataDirectory),
    "projects",
    projectId,
  );
  try {
    await input.onProgress?.({
      phase: "preparing",
      message: "Preparing company_goal_execution_v1.",
    });
    const run = (await new JsonlCompanyGoalStore(
      path.join(projectData, "company-goals"),
    ).loadReadOnly(input.runId, input.signal)).state;
    const blueprint = await new FileCompanyBlueprintV2Store(
      path.join(projectData, "company-blueprints-v2"),
    ).load(run.company.blueprintId, input.signal);
    input.signal?.throwIfAborted();
    const session = await new JsonlSessionStore(
      path.join(projectData, "sessions"),
    ).loadStateReadOnly(run.parentSessionId);
    input.signal?.throwIfAborted();
    if (!isPinnedSessionState(session)) {
      throw new CompanyEvaluationStoreError(
        "The durable company goal parent session is not a pinned V2 session.",
      );
    }
    await input.onProgress?.({
      phase: "scoring",
      message: "Scoring company_goal_execution_v1.",
    });
    return evaluateCompanyGoalExecution({
      run,
      blueprint,
      mode: "configured",
      backend: {
        providerId: session.backend.pin.providerId,
        modelId: session.backend.pin.modelId,
      },
      startedAt: run.createdAt,
      completedAt: completedAt(
        run.createdAt,
        (input.now ?? (() => new Date().toISOString()))(),
      ),
    });
  } catch (error) {
    if (interrupted(input.signal, error)) throw error;
    if (error instanceof CompanyEvaluationStoreError) throw error;
    throw new CompanyEvaluationStoreError(
      "The selected durable company goal could not be read.",
      { cause: error },
    );
  }
}
