import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  FileConnectionRegistry,
  ConnectionRecord,
} from "@recurs/app";
import {
  parseModelTeamEvaluation,
  type ModelTeamEvaluationV1,
  type ModelTeamRouteV1,
  type ModelTeamSelectionV1,
  type SessionBackendPin,
  type TeamRunRole,
} from "@recurs/contracts";
import {
  isPinnedSessionState,
  selectEvaluatedModelTeam,
} from "@recurs/core";
import type {
  FileCompanyBlueprintV2Store,
  FileModelTeamEvaluationStore,
  FileModelTeamSelectionStore,
  JsonlCompanyGoalStore,
  JsonlSessionStore,
  JsonlTeamRunStore,
} from "@recurs/core";

import { evaluateCompanyGoalExecution } from "./company-evaluation.js";

export class ModelTeamServiceError extends Error {
  constructor(
    public readonly code:
      | "connection_changed"
      | "evaluation_invalid"
      | "no_evidence"
      | "run_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelTeamServiceError";
  }
}

export interface ModelTeamStatus {
  readonly mode: "auto" | "custom";
  readonly selection: ModelTeamSelectionV1 | null;
}

function routeFromPin(
  role: ModelTeamRouteV1["role"],
  pin: SessionBackendPin,
): ModelTeamRouteV1 {
  return {
    role,
    providerId: pin.providerId,
    adapterId: pin.adapterId,
    connectionId: pin.connectionId,
    modelId: pin.modelId,
    reasoningEffort: pin.reasoningEffortAtCreation ?? null,
  };
}

function connectionMatches(
  connection: ConnectionRecord,
  route: ModelTeamRouteV1,
): boolean {
  return connection.id === route.connectionId &&
    connection.providerId === route.providerId &&
    connection.adapterId === route.adapterId &&
    connection.modelId === route.modelId &&
    (connection.kind === "delegated_agent" ||
        connection.kind === "environment_model_provider"
      ? connection.reasoningEffort ?? null
      : null) === route.reasoningEffort;
}

function routeMap(
  selection: ModelTeamSelectionV1,
): Readonly<Record<ModelTeamRouteV1["role"], ModelTeamRouteV1>> {
  return Object.fromEntries(selection.lineup.map((route) => [
    route.role,
    route,
  ])) as unknown as Readonly<
    Record<ModelTeamRouteV1["role"], ModelTeamRouteV1>
  >;
}

function routesMatch(
  selection: ModelTeamSelectionV1,
  document: Awaited<ReturnType<FileConnectionRegistry["read"]>>,
): boolean {
  const routes = routeMap(selection);
  if (document.primaryConnectionId !== routes.parent.connectionId) return false;
  if (selection.lineup.some((route) => {
    const connection = document.connections.find((candidate) =>
      candidate.id === route.connectionId
    );
    return connection === undefined || !connectionMatches(connection, route);
  })) {
    return false;
  }
  return (["implement", "review", "repair"] as const).every((role) => {
    const expected = routes[role].connectionId === routes.parent.connectionId
      ? null
      : routes[role].connectionId;
    return document.agentRoutes[role] === expected;
  });
}

function evaluationId(
  runId: string,
  lineup: readonly ModelTeamRouteV1[],
): string {
  return `model-team-evaluation-${createHash("sha256").update(JSON.stringify({
    runId,
    lineup,
  })).digest("hex").slice(0, 32)}`;
}

function exactLineup(
  parent: SessionBackendPin,
  teamRoutes: readonly {
    readonly role: TeamRunRole;
    readonly pin: SessionBackendPin;
  }[],
): readonly ModelTeamRouteV1[] {
  const byRole = new Map(teamRoutes.map((route) => [route.role, route.pin]));
  const implement = byRole.get("implement");
  const review = byRole.get("review");
  const repair = byRole.get("repair");
  if (implement === undefined || review === undefined || repair === undefined) {
    throw new ModelTeamServiceError(
      "evaluation_invalid",
      "The company goal does not contain a complete model-team route snapshot",
    );
  }
  return [
    routeFromPin("parent", parent),
    routeFromPin("implement", implement),
    routeFromPin("review", review),
    routeFromPin("repair", repair),
  ];
}

export function findRecordedModelTeamEvaluation(
  evaluations: readonly ModelTeamEvaluationV1[],
  runId: string,
  lineup: readonly ModelTeamRouteV1[],
): ModelTeamEvaluationV1 | null {
  const existing = evaluations.find((evaluation) =>
    evaluation.companyGoalRunId === runId
  );
  if (existing === undefined) return null;
  if (!isDeepStrictEqual(existing.lineup, lineup)) {
    throw new ModelTeamServiceError(
      "evaluation_invalid",
      "Recorded model-team evidence has a different route snapshot",
    );
  }
  return existing;
}

export class ModelTeamService {
  constructor(readonly dependencies: {
    readonly registry: FileConnectionRegistry;
    readonly sessions: JsonlSessionStore;
    readonly goals: JsonlCompanyGoalStore;
    readonly teams: JsonlTeamRunStore;
    readonly blueprints: FileCompanyBlueprintV2Store;
    readonly evaluations: FileModelTeamEvaluationStore;
    readonly selections: FileModelTeamSelectionStore;
    readonly now?: () => string;
  }) {}

  async status(signal?: AbortSignal): Promise<ModelTeamStatus> {
    signal?.throwIfAborted();
    const [selection, document] = await Promise.all([
      this.dependencies.selections.latest(signal),
      this.dependencies.registry.read(signal === undefined ? {} : { signal }),
    ]);
    return {
      mode: selection !== null && routesMatch(selection, document)
        ? "auto"
        : "custom",
      selection,
    };
  }

  async evaluate(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ModelTeamEvaluationV1> {
    signal?.throwIfAborted();
    try {
      const run = (await this.dependencies.goals.loadReadOnly(
        runId,
        signal,
      )).state;
      const blueprint = await this.dependencies.blueprints.load(
        run.company.blueprintId,
        signal,
      );
      const parent = await this.dependencies.sessions.loadStateReadOnly(
        run.parentSessionId,
      );
      if (!isPinnedSessionState(parent)) {
        throw new TypeError("Company goal parent session is not pinned");
      }
      const teamIds = [...new Set(run.plan.assignments.flatMap((assignment) =>
        assignment.execution !== undefined &&
          "teamRunId" in assignment.execution
          ? [assignment.execution.teamRunId]
          : []
      ))];
      if (teamIds.length === 0) {
        throw new TypeError("Company goal has no team execution evidence");
      }
      const teamStates = await Promise.all(
        teamIds.map((id) => this.dependencies.teams.load(id)),
      );
      const reference = teamStates[0]!.descriptor.routes;
      if (teamStates.some((state) =>
        !isDeepStrictEqual(state.descriptor.routes, reference)
      )) {
        throw new TypeError("Company goal used inconsistent model-team routes");
      }
      const lineup = exactLineup(parent.backend.pin, reference);
      const existing = findRecordedModelTeamEvaluation(
        await this.dependencies.evaluations.list(signal),
        run.id,
        lineup,
      );
      if (existing !== null) return existing;
      const evaluatedAt = run.updatedAt;
      const report = evaluateCompanyGoalExecution({
        run,
        blueprint,
        mode: "configured",
        backend: {
          providerId: parent.backend.pin.providerId,
          modelId: parent.backend.pin.modelId,
        },
        startedAt: run.createdAt,
        completedAt: evaluatedAt,
      });
      const evaluation = parseModelTeamEvaluation({
        id: evaluationId(run.id, lineup),
        version: 1,
        taskClass: "general_coding",
        companyGoalRunId: run.id,
        evaluatedAt,
        lineup,
        report,
      });
      await this.dependencies.evaluations.create(evaluation, signal);
      return evaluation;
    } catch (error) {
      if (error instanceof ModelTeamServiceError) throw error;
      throw new ModelTeamServiceError(
        "run_unavailable",
        "The company goal could not be recorded as model-team evidence",
        { cause: error },
      );
    }
  }

  async select(signal?: AbortSignal): Promise<ModelTeamSelectionV1> {
    signal?.throwIfAborted();
    const proposed = selectEvaluatedModelTeam({
      evaluations: await this.dependencies.evaluations.list(signal),
      selectedAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
    });
    if (proposed === null) {
      throw new ModelTeamServiceError(
        "no_evidence",
        "Models Auto needs a completed company goal whose decomposition, evidence, and synthesis evaluation passed",
      );
    }
    const previous = await this.dependencies.selections.latest(signal);
    const selection = previous !== null &&
        previous.taskClass === proposed.taskClass &&
        isDeepStrictEqual(previous.lineup, proposed.lineup) &&
        isDeepStrictEqual(previous.evidenceIds, proposed.evidenceIds)
      ? previous
      : proposed;
    const current = await this.dependencies.registry.read(
      signal === undefined ? {} : { signal },
    );
    const routes = routeMap(selection);
    if (selection.lineup.some((route) => {
      const connection = current.connections.find((candidate) =>
        candidate.id === route.connectionId
      );
      return connection === undefined || !connectionMatches(connection, route);
    })) {
      throw new ModelTeamServiceError(
        "connection_changed",
        "An evaluated model connection changed; record fresh evidence before using Auto",
      );
    }
    if (selection === proposed) {
      await this.dependencies.selections.create(selection, signal);
    }
    try {
      await this.dependencies.registry.commit(
        current.revision,
        (draft) => {
          draft.primaryConnectionId = routes.parent.connectionId;
          draft.agentRoutes = Object.fromEntries(
            (["implement", "review", "repair"] as const).map((role) => [
              role,
              routes[role].connectionId === routes.parent.connectionId
                ? null
                : routes[role].connectionId,
            ]),
          ) as typeof draft.agentRoutes;
        },
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      throw new ModelTeamServiceError(
        "connection_changed",
        "Model connections changed while Auto was being selected",
        { cause: error },
      );
    }
    return selection;
  }
}
