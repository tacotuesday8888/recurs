import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileConnectionRegistry,
  type LocalConnectionRecord,
} from "@recurs/app";
import {
  COMPANY_EVALUATION_DIMENSIONS,
  parseModelTeamEvaluationV2,
  parseModelTeamSelection,
  type ModelTeamRole,
} from "@recurs/contracts";
import {
  FileCompanyBlueprintV2Store,
  FileModelTeamEvaluationStore,
  FileModelTeamSelectionStore,
  JsonlCompanyGoalStore,
  JsonlSessionStore,
  JsonlTeamRunStore,
} from "@recurs/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  findRecordedModelTeamEvaluation,
  ModelTeamService,
} from "../src/model-team-service.js";
import type { ModelTeamServiceError } from "../src/model-team-service.js";

const directories: string[] = [];
const at = "2026-07-23T00:00:00.000Z";
const roles: readonly ModelTeamRole[] = [
  "parent",
  "implement",
  "review",
  "repair",
];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function local(role: ModelTeamRole): LocalConnectionRecord {
  return {
    kind: "local_openai_compatible",
    id: `connection-${role}`,
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    label: `${role} model`,
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: `model-${role}`,
    createdAt: at,
    updatedAt: at,
  };
}

function evaluation(index = 1) {
  return parseModelTeamEvaluationV2({
    id: `evaluation-balanced-${index}`,
    version: 2,
    taskClass: "general_coding",
    companyGoalRunId: `company-goal-${index}`,
    evaluatedAt: "2026-07-23T00:00:02.000Z",
    lineup: roles.map((role) => ({
      role,
      providerId: "local-openai-compatible",
      adapterId: "openai-chat-completions",
      connectionId: `connection-${role}`,
      modelId: `model-${role}`,
      reasoningEffort: null,
    })),
    activatedRoles: ["parent", "implement", "review"],
    report: {
      id: `report-balanced-${index}`,
      version: 1,
      scenarioId: "company_goal_execution_v1",
      scenarioVersion: 1,
      mode: "configured",
      status: "passed",
      startedAt: at,
      completedAt: "2026-07-23T00:00:01.000Z",
      latencyMs: 1_000,
      backend: {
        providerId: "local-openai-compatible",
        modelId: "model-parent",
        fingerprint: "backend-balanced",
      },
      usage: { requestsUsed: 8, reportedCostUsd: 0, source: "provider" },
      rubric: COMPANY_EVALUATION_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "passed",
        evidence: [`${dimension} passed.`],
      })),
      failures: [],
    },
  });
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-model-teams-")),
  );
  directories.push(root);
  const registry = new FileConnectionRegistry(path.join(root, "registry"));
  await registry.commit(0, (draft) => {
    draft.connections.push(...roles.map(local));
  });
  const evaluations = new FileModelTeamEvaluationStore(
    path.join(root, "evaluations"),
  );
  const selections = new FileModelTeamSelectionStore(
    path.join(root, "selections"),
  );
  const service = new ModelTeamService({
    registry,
    sessions: new JsonlSessionStore(path.join(root, "sessions")),
    goals: new JsonlCompanyGoalStore(path.join(root, "goals")),
    teams: new JsonlTeamRunStore(path.join(root, "teams")),
    blueprints: new FileCompanyBlueprintV2Store(path.join(root, "blueprints")),
    evaluations,
    selections,
    now: () => "2026-07-23T00:00:03.000Z",
  });
  return { service, registry, evaluations, selections };
}

describe("ModelTeamService", () => {
  it("reuses immutable evidence for the same run and exact route snapshot", () => {
    const recorded = evaluation();
    expect(findRecordedModelTeamEvaluation(
      [recorded],
      recorded.companyGoalRunId,
      recorded.lineup,
    )).toBe(recorded);
    expect(() => findRecordedModelTeamEvaluation(
      [recorded],
      recorded.companyGoalRunId,
      recorded.lineup.map((route) =>
        route.role === "review"
          ? { ...route, modelId: "changed-review-model" }
          : route
      ),
    )).toThrow("different route snapshot");
  });

  it("applies Auto only after three observed eligible runs", async () => {
    const { service, registry, evaluations } = await fixture();
    expect(await service.status()).toEqual({ mode: "custom", selection: null });
    await evaluations.create(evaluation(1));
    await evaluations.create(evaluation(2));
    await evaluations.create(evaluation(3));

    const selected = await service.select();
    expect(selected.evidenceIds).toEqual([
      "evaluation-balanced-1",
      "evaluation-balanced-2",
      "evaluation-balanced-3",
    ]);
    expect(selected.rationale).toBe(
      "3 eligible recorded configured company-goal evaluations support this configured lineup; Parent, Implement, and Review were observed. Repair remains a fallback unless separately observed.",
    );
    await expect(service.status()).resolves.toMatchObject({
      mode: "auto",
      selection: { id: selected.id },
    });
    await expect(registry.read()).resolves.toMatchObject({
      primaryConnectionId: "connection-parent",
      agentRoutes: {
        implement: "connection-implement",
        review: "connection-review",
        repair: "connection-repair",
      },
    });
  });

  it("shows Custom after a manual route change and refuses missing evidence", async () => {
    const { service, registry, evaluations } = await fixture();
    await expect(service.select()).rejects.toMatchObject<
      Partial<ModelTeamServiceError>
    >({ code: "no_evidence" });
    await evaluations.create(evaluation(1));
    await evaluations.create(evaluation(2));
    await evaluations.create(evaluation(3));
    await service.select();
    const current = await registry.read();
    await registry.commit(current.revision, (draft) => {
      draft.agentRoutes = { ...draft.agentRoutes, review: null };
    });

    await expect(service.status()).resolves.toMatchObject({ mode: "custom" });
    await expect(service.select()).resolves.toMatchObject({
      id: expect.stringContaining("model-team-selection-"),
    });
    await expect(service.status()).resolves.toMatchObject({ mode: "auto" });
  });

  it("keeps a legacy Auto selection readable but inactive", async () => {
    const { service, selections } = await fixture();
    await selections.create(parseModelTeamSelection({
      id: "legacy-selection",
      version: 1,
      taskClass: "general_coding",
      selectedAt: "2026-07-23T00:00:03.000Z",
      lineup: roles.map((role) => ({
        role,
        providerId: "local-openai-compatible",
        adapterId: "openai-chat-completions",
        connectionId: `connection-${role}`,
        modelId: `model-${role}`,
        reasoningEffort: null,
      })),
      evidenceIds: ["legacy-evaluation"],
      rationale: "Legacy configured route evidence.",
    }));

    await expect(service.status()).resolves.toMatchObject({
      mode: "custom",
      selection: { id: "legacy-selection", version: 1 },
    });
  });
});
