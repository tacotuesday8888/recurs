import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseCompanyGoalRun,
  parseEffectiveTeamControlPolicyV1,
  recommendedTeamControlPolicy,
  type CompanyGoalRun,
  type CompanyGoalRunV1,
  type CompanyGoalRunV2,
} from "@recurs/contracts";
import {
  CompanyStateStoreError,
  JsonlCompanyGoalStore,
} from "../src/index.js";

const roots: string[] = [];

async function directory(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-goal-v2-")),
  );
  roots.push(root);
  return path.join(root, "runs");
}

function common(id: string): Omit<CompanyGoalRunV1, "id" | "version"> {
  return {
    parentSessionId: "parent-session",
    goalId: `goal-${id}`,
    objective: "Complete one governed team task.",
    company: {
      blueprintId: "approved-blueprint",
      blueprintVersion: 2,
      blueprintRevision: 4,
      roleId: "root-orchestrator",
      roleVersion: 1,
    },
    status: "created",
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    plan: {
      revision: 1,
      createdAt: "2026-07-30T10:00:00.000Z",
      assignments: [{
        id: "implement-task",
        roleId: "scoped-builder",
        parentAssignmentId: null,
        dependsOn: [],
        description: "Implement the scoped task.",
        prompt: "Implement only the approved scope.",
        acceptance: ["Verification passes."],
        expectedEvidence: ["Changed paths and verification output."],
        status: "pending",
        result: null,
        failure: null,
      }],
    },
    budget: {
      maxAssignments: 3,
      assignmentsStarted: 0,
      maxConcurrentAssignments: 2,
      maxRequests: 48,
      requestsReserved: 0,
      requestsUsed: 0,
      maxReportedCostUsd: 2,
      reportedCostUsd: 0,
    },
    result: null,
    failure: null,
  };
}

function v1(id = "legacy-run"): CompanyGoalRunV1 {
  return parseCompanyGoalRun({ id, version: 1, ...common(id) });
}

function v2(id = "governed-run"): CompanyGoalRunV2 {
  const selected = {
    ...recommendedTeamControlPolicy("balanced_v6", 2),
    topology: "parallel" as const,
    maxActiveAgents: 5,
    maxConcurrentAgents: 2,
    maxRequests: 48,
    maxReportedCostUsd: 2,
  };
  return parseCompanyGoalRun({
    id,
    version: 2,
    ...common(id),
    teamControl: {
      selected,
      effective: parseEffectiveTeamControlPolicyV1({
        version: 1,
        sourceRevision: 2,
        operatingModeId: "balanced_v6",
        operatingModeVersion: 6,
        blueprintId: "approved-blueprint",
        blueprintRevision: 4,
        topology: "parallel",
        maxActiveAgents: 3,
        maxConcurrentAgents: 2,
        maxDelegationDepth: 1,
        escalation: "manager_only",
        independentReview: "required",
        maxRepairRounds: 1,
        maxRequests: 48,
        maxReportedCostUsd: 2,
      }),
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("JsonlCompanyGoalStore versioned authority", () => {
  it("stores historical V1 and governed V2 runs together", async () => {
    const store = new JsonlCompanyGoalStore<CompanyGoalRun>(await directory());

    await store.create(v1());
    await store.create(v2());

    await expect(store.load("legacy-run")).resolves.toMatchObject({
      state: { version: 1 },
    });
    await expect(store.load("governed-run")).resolves.toMatchObject({
      state: {
        version: 2,
        teamControl: {
          selected: { revision: 2 },
          effective: { sourceRevision: 2 },
        },
      },
    });
  });

  it("keeps V2 authority immutable across lifecycle transitions", async () => {
    const store = new JsonlCompanyGoalStore<CompanyGoalRun>(await directory());
    const created = await store.create(v2());
    const running = parseCompanyGoalRun({
      ...created.state,
      status: "running",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });

    await expect(store.append(
      running.id,
      created.sequence,
      running,
    )).resolves.toMatchObject({ sequence: 1, state: { status: "running" } });

    await expect(store.append(
      running.id,
      1,
      parseCompanyGoalRun({
        ...running,
        updatedAt: "2026-07-30T10:02:00.000Z",
        teamControl: {
          selected: {
            ...running.teamControl.selected,
            topology: "focused",
          },
          effective: {
            ...running.teamControl.effective,
            topology: "focused",
          },
        },
      }),
    )).rejects.toBeInstanceOf(CompanyStateStoreError);
    await expect(store.load(running.id)).resolves.toMatchObject({
      sequence: 1,
      state: {
        teamControl: {
          selected: { topology: "parallel" },
        },
      },
    });
  });
});
