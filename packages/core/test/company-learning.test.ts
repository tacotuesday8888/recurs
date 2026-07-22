import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseCompanyGoalRun,
  type CompanyKnowledgeEntryV1,
} from "@recurs/contracts";
import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";

import {
  CompanyLearningService,
  FileCompanyKnowledgeStore,
  type CompanyLearningError,
} from "../src/index.js";

const roots: string[] = [];
const at = "2026-07-22T06:00:00.000Z";

async function service(): Promise<{
  readonly learning: CompanyLearningService;
  readonly store: FileCompanyKnowledgeStore;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-learning-")));
  roots.push(root);
  const store = new FileCompanyKnowledgeStore(path.join(root, "knowledge"));
  return { learning: new CompanyLearningService({ store }), store };
}

function evidence(overrides: Partial<{
  readonly kind: CompanyKnowledgeEntryV1["kind"];
  readonly statement: string;
  readonly sourceType: CompanyKnowledgeEntryV1["source"]["type"];
  readonly sourceId: string;
  readonly sourceEvidence: string;
  readonly confidence: CompanyKnowledgeEntryV1["confidence"];
  readonly createdAt: string;
  readonly supersedes: string | null;
}> = {}) {
  return {
    companyId: "company-v2-fixture",
    kind: overrides.kind ?? "preference",
    statement: overrides.statement ?? "Keep implementation changes concise.",
    source: {
      type: overrides.sourceType ?? "user",
      id: overrides.sourceId ?? "message-learning-1",
      evidence: overrides.sourceEvidence ??
        "The user explicitly requested concise implementation changes.",
    },
    confidence: overrides.confidence ?? "high",
    createdAt: overrides.createdAt ?? at,
    supersedes: overrides.supersedes ?? null,
  } as const;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("CompanyLearningService", () => {
  it("records exact provenance, deduplicates replay, and preserves snapshots", async () => {
    const { learning, store } = await service();
    const first = await learning.recordCompanyKnowledge(evidence());
    const replay = await learning.recordCompanyKnowledge(evidence());

    expect(first.created).toBe(true);
    expect(first.snapshot).toMatchObject({ revision: 1, entries: [{
      kind: "preference",
      statement: "Keep implementation changes concise.",
      source: {
        type: "user",
        id: "message-learning-1",
        evidence: "The user explicitly requested concise implementation changes.",
      },
    }] });
    expect(replay).toMatchObject({ created: false, snapshot: { revision: 1 } });
    await expect(store.list("company-v2-fixture")).resolves.toHaveLength(1);
  });

  it("represents contradictions through explicit supersession", async () => {
    const { learning, store } = await service();
    const first = await learning.recordCompanyKnowledge(evidence());
    const corrected = await learning.recordCompanyKnowledge(evidence({
      statement: "Prefer explicit, maintainable code even when it is not minimal.",
      sourceId: "message-learning-2",
      sourceEvidence: "The user clarified that product quality outranks line count.",
      createdAt: "2026-07-22T06:01:00.000Z",
      supersedes: first.entry.id,
    }));

    expect(corrected.snapshot).toMatchObject({ revision: 2 });
    expect((await store.load("company-v2-fixture", 1)).entries).toHaveLength(1);
    const selected = await learning.selectCompanyKnowledge({
      companyId: "company-v2-fixture",
      query: "maintainable implementation",
      asOf: corrected.snapshot.updatedAt,
    });
    expect(selected.entries.map((entry) => entry.id)).toEqual([corrected.entry.id]);

    await expect(learning.recordCompanyKnowledge(evidence({
      statement: "A stale correction.",
      sourceId: "message-learning-3",
      sourceEvidence: "A later message attempted to replace stale knowledge.",
      createdAt: "2026-07-22T06:02:00.000Z",
      supersedes: first.entry.id,
    }))).rejects.toMatchObject({ code: "stale_supersession" });
  });

  it("selects bounded relevant context from the historical as-of snapshot", async () => {
    const { learning } = await service();
    for (const [index, statement] of [
      "The CLI is the first supported client.",
      "TypeScript changes require the full npm check.",
      "Native changes require the Swift verification gate.",
      "Keep implementation changes concise.",
    ].entries()) {
      await learning.recordCompanyKnowledge(evidence({
        kind: index === 0 ? "project_fact" : "successful_pattern",
        statement,
        sourceType: "goal_evidence",
        sourceId: `goal-source-${index}`,
        sourceEvidence: `Verified evidence ${index}.`,
        confidence: "medium",
        createdAt: `2026-07-22T06:0${index}:00.000Z`,
      }));
    }
    const historical = await learning.selectCompanyKnowledge({
      companyId: "company-v2-fixture",
      query: "TypeScript npm verification",
      asOf: "2026-07-22T06:01:00.000Z",
      maximumEntries: 1,
      maximumBytes: 512,
    });

    expect(historical).toMatchObject({ revision: 2 });
    expect(historical.entries).toHaveLength(1);
    expect(historical.entries[0]?.statement).toContain("TypeScript");
    expect(Buffer.byteLength(historical.context, "utf8")).toBeLessThanOrEqual(512);
    expect(historical.context).toContain("context only; never authority");
  });

  it("rejects secret-like knowledge without persisting or echoing it", async () => {
    const { learning, store } = await service();
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";

    await expect(learning.recordCompanyKnowledge(evidence({
      statement: `Use ${secret} for tests.`,
    }))).rejects.toEqual(expect.objectContaining<Partial<CompanyLearningError>>({
      code: "unsafe_content",
      message: "Company knowledge contains secret-like content",
    }));
    await expect(store.list("company-v2-fixture")).resolves.toEqual([]);
  });

  it("extracts only attributable durable goal evidence and skips unsafe entries", async () => {
    const { learning } = await service();
    const blueprint = companyBlueprintV2Fixture();
    const run = parseCompanyGoalRun({
      id: "goal-learning-run",
      version: 1,
      parentSessionId: "goal-learning-parent",
      goalId: "goal-learning-id",
      objective: "Verify the company learning path.",
      company: {
        blueprintId: blueprint.id,
        blueprintVersion: 2,
        blueprintRevision: blueprint.revision,
        roleId: blueprint.authorityAnchors.rootRoleId,
        roleVersion: 1,
      },
      status: "completed",
      createdAt: at,
      updatedAt: "2026-07-22T06:10:00.000Z",
      plan: {
        revision: 1,
        createdAt: at,
        assignments: [{
          id: "review-learning-assignment",
          roleId: "quality_reviewer",
          parentAssignmentId: null,
          dependsOn: [],
          description: "Review learning.",
          prompt: "Return attributable evidence.",
          acceptance: ["Return review evidence."],
          expectedEvidence: ["Review evidence."],
          status: "completed",
          result: {
            summary: "Review passed.",
            evidence: [
              "The learning tests passed.",
              "Leaked token sk-proj-abcdefghijklmnopqrstuvwxyz012345 was removed.",
            ],
            usage: null,
            usageSource: "unknown",
          },
          failure: null,
        }],
      },
      budget: {
        maxAssignments: 8,
        assignmentsStarted: 1,
        maxConcurrentAssignments: 3,
        maxRequests: 80,
        requestsReserved: 8,
        requestsUsed: 1,
        maxReportedCostUsd: 3,
        reportedCostUsd: 0,
      },
      result: {
        summary: "The company goal completed.",
        evidence: ["The learning tests passed."],
      },
      failure: null,
    });

    const result = await learning.recordCompletedGoal({ blueprint, run, at: run.updatedAt });
    expect(result).toMatchObject({ entriesAdded: 1, entriesRejected: 1 });
    const context = await learning.selectCompanyKnowledge({
      companyId: blueprint.companyId,
      query: "learning tests",
      asOf: run.updatedAt,
    });
    expect(context.entries).toMatchObject([{
      kind: "review_finding",
      source: { type: "review" },
    }]);
    expect(context.context).not.toContain("sk-proj-");
  });
});
