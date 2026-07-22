import {
  appendFile,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CompanyAmendmentV1,
  CompanyGoalRunV1,
  CompanyKnowledgeV1,
  CompanyOnboardingRunV1,
} from "@recurs/contracts";
import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";

import {
  FileCompanyAmendmentStore,
  FileCompanyKnowledgeStore,
  FileCompanyOnboardingStore,
  JsonlCompanyGoalStore,
} from "../src/index.js";

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(directory);
  return directory;
}

function onboardingRun(): CompanyOnboardingRunV1 {
  return {
    id: "onboarding-store-run",
    version: 1,
    projectRoot: "/workspace/project",
    status: "interviewing",
    createdAt: "2026-07-22T03:00:00.000Z",
    updatedAt: "2026-07-22T03:00:00.000Z",
    depth: "guided",
    designMode: "guardrailed_dynamic",
    authority: {
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v6",
      operatingModeVersion: 6,
    },
    repositoryAccess: {
      scope: "project_read",
      grantedAt: "2026-07-22T03:00:00.000Z",
    },
    interview: { complete: false, answers: [] },
    research: [],
    usage: { modelRequests: 0, reportedCostUsd: 0 },
    proposal: null,
    approvedBlueprintId: null,
    terminalReason: null,
  };
}

function goalRun(): CompanyGoalRunV1 {
  return {
    id: "goal-store-run",
    version: 1,
    parentSessionId: "parent-session",
    goalId: "goal-1",
    objective: "Deliver one reviewed slice.",
    company: {
      blueprintId: "company-v2-fixture",
      blueprintVersion: 2,
      blueprintRevision: 1,
      roleId: "root_orchestrator",
      roleVersion: 1,
    },
    status: "created",
    createdAt: "2026-07-22T03:00:00.000Z",
    updatedAt: "2026-07-22T03:00:00.000Z",
    plan: {
      revision: 1,
      createdAt: "2026-07-22T03:00:00.000Z",
      assignments: [{
        id: "review-assignment",
        roleId: "quality_reviewer",
        parentAssignmentId: null,
        dependsOn: [],
        description: "Review the result.",
        prompt: "Return evidence-backed findings.",
        acceptance: ["Return findings or approval."],
        expectedEvidence: ["Citations."],
        status: "pending",
        result: null,
        failure: null,
      }],
    },
    budget: {
      maxAssignments: 8,
      assignmentsStarted: 0,
      maxConcurrentAssignments: 3,
      maxRequests: 80,
      requestsReserved: 0,
      requestsUsed: 0,
      maxReportedCostUsd: 3,
      reportedCostUsd: 0,
    },
    result: null,
    failure: null,
  };
}

function knowledge(): CompanyKnowledgeV1 {
  return {
    companyId: "company-v2-fixture",
    version: 1,
    revision: 1,
    updatedAt: "2026-07-22T03:00:00.000Z",
    entries: [{
      id: "knowledge-1",
      kind: "preference",
      statement: "Keep the implementation concise.",
      source: {
        type: "user",
        id: "message-1",
        evidence: "The user explicitly requested concise code.",
      },
      confidence: "high",
      createdAt: "2026-07-22T03:00:00.000Z",
      supersedes: null,
    }],
  };
}

function amendment(): CompanyAmendmentV1 {
  return {
    id: "amendment-store-1",
    version: 1,
    companyId: "company-v2-fixture",
    baseBlueprintId: "company-v2-fixture",
    baseBlueprintRevision: 1,
    state: "proposed",
    createdAt: "2026-07-22T03:00:00.000Z",
    decidedAt: null,
    reason: "Add a specialist only after evidence supports it.",
    proposedBlueprint: companyBlueprintV2Fixture({
      id: "company-v2-revision-2",
      revision: 2,
      previousBlueprintId: "company-v2-fixture",
      state: "proposed",
    }),
    resultingBlueprintId: null,
    decisionReason: null,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("durable company state stores", () => {
  it("creates, appends, and reloads private onboarding state", async () => {
    const directory = path.join(await root("recurs-onboarding-store-"), "runs");
    const store = new FileCompanyOnboardingStore(directory);
    await expect(store.create(onboardingRun())).resolves.toMatchObject({ sequence: 0 });
    const next = {
      ...onboardingRun(),
      updatedAt: "2026-07-22T03:01:00.000Z",
      usage: { modelRequests: 1, reportedCostUsd: 0 },
      interview: {
        complete: false,
        answers: [{
          id: "answer-1",
          question: "What should the company own?",
          answer: "A dependable CLI foundation.",
          at: "2026-07-22T03:01:00.000Z",
        }],
      },
    } satisfies CompanyOnboardingRunV1;
    await expect(store.append(next.id, 0, next)).resolves.toMatchObject({
      sequence: 1,
      state: next,
    });
    await expect(new FileCompanyOnboardingStore(directory).load(next.id))
      .resolves.toMatchObject({ sequence: 1, state: next });
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(directory, `${next.id}.jsonl`))).mode & 0o777)
      .toBe(0o600);
  });

  it("serializes concurrent appends and rejects stale sequence reuse", async () => {
    const directory = path.join(await root("recurs-onboarding-race-"), "runs");
    const first = new FileCompanyOnboardingStore(directory);
    const second = new FileCompanyOnboardingStore(directory);
    await first.create(onboardingRun());
    const next = {
      ...onboardingRun(),
      updatedAt: "2026-07-22T03:01:00.000Z",
      usage: { modelRequests: 1, reportedCostUsd: 0 },
    } satisfies CompanyOnboardingRunV1;
    const results = await Promise.allSettled([
      first.append(next.id, 0, next),
      second.append(next.id, 0, next),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0])
      .toMatchObject({ reason: { code: "sequence_conflict" } });
  });

  it("repairs only an incomplete final JSONL tail", async () => {
    const directory = path.join(await root("recurs-onboarding-repair-"), "runs");
    const store = new FileCompanyOnboardingStore(directory);
    await store.create(onboardingRun());
    const file = path.join(directory, `${onboardingRun().id}.jsonl`);
    await appendFile(file, "{\"partial\":", "utf8");
    await expect(store.load(onboardingRun().id)).resolves.toMatchObject({ sequence: 0 });
    expect((await readFile(file)).at(-1)).toBe(0x0a);
  });

  it("fails closed instead of repairing malformed durable history", async () => {
    const directory = path.join(await root("recurs-onboarding-corrupt-"), "runs");
    const store = new FileCompanyOnboardingStore(directory);
    await store.create(onboardingRun());
    const file = path.join(directory, `${onboardingRun().id}.jsonl`);
    await writeFile(file, "{\"durable\":false}\n", { mode: 0o600 });
    await expect(store.load(onboardingRun().id))
      .rejects.toMatchObject({ code: "corrupt" });
  });

  it("persists goal transitions and rejects terminal rewrites", async () => {
    const directory = path.join(await root("recurs-goal-store-"), "runs");
    const store = new JsonlCompanyGoalStore(directory);
    await store.create(goalRun());
    const running = {
      ...goalRun(),
      status: "running",
      updatedAt: "2026-07-22T03:01:00.000Z",
    } satisfies CompanyGoalRunV1;
    await store.append(running.id, 0, running);
    const cancelled = {
      ...running,
      status: "cancelled",
      updatedAt: "2026-07-22T03:02:00.000Z",
      failure: "Cancelled by the parent.",
    } satisfies CompanyGoalRunV1;
    await store.append(cancelled.id, 1, cancelled);
    await expect(store.append(cancelled.id, 2, cancelled))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("publishes immutable knowledge and amendments idempotently", async () => {
    const base = await root("recurs-company-records-");
    const knowledgeStore = new FileCompanyKnowledgeStore(path.join(base, "knowledge"));
    const amendmentStore = new FileCompanyAmendmentStore(path.join(base, "amendments"));
    await Promise.all([
      knowledgeStore.create(knowledge()),
      new FileCompanyKnowledgeStore(path.join(base, "knowledge")).create(knowledge()),
    ]);
    await amendmentStore.create(amendment());
    await expect(knowledgeStore.latest(knowledge().companyId))
      .resolves.toEqual(knowledge());
    await expect(amendmentStore.list(amendment().companyId))
      .resolves.toEqual([amendment()]);
    await expect(knowledgeStore.create({
      ...knowledge(),
      entries: [{ ...knowledge().entries[0]!, statement: "Different content." }],
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails closed for non-private directories and symbolic links", async () => {
    const base = await root("recurs-company-unsafe-");
    const directory = path.join(base, "runs");
    const store = new FileCompanyOnboardingStore(directory);
    await store.create(onboardingRun());
    await chmod(directory, 0o755);
    await expect(store.load(onboardingRun().id))
      .rejects.toMatchObject({ code: "corrupt" });

    const linkedBase = await root("recurs-company-linked-");
    const linked = path.join(linkedBase, "runs");
    await symlink(directory, linked);
    await expect(new FileCompanyOnboardingStore(linked).list())
      .rejects.toMatchObject({ code: "corrupt" });
  });
});
