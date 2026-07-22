import { appendFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CompanyOnboardingDecisionV1,
  CompanyOnboardingModelPort,
  CompanyOnboardingResearchPort,
} from "../src/company-onboarding-coordinator.js";
import {
  CompanyOnboardingCoordinator,
  CompanyOnboardingCoordinatorError,
  FileCompanyBlueprintV2Store,
  FileCompanyOnboardingStore,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function stores() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-onboarding-coordinator-")),
  );
  roots.push(root);
  return {
    root,
    runs: new FileCompanyOnboardingStore(path.join(root, "runs")),
    blueprints: new FileCompanyBlueprintV2Store(path.join(root, "blueprints")),
  };
}

function proposal(): CompanyOnboardingDecisionV1 {
  return {
    kind: "propose",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Ship a dependable company-directed coding harness.",
      users: ["Software teams"],
      successCriteria: ["Every accepted change has independent evidence."],
      constraints: ["Children never exceed parent authority."],
      risks: ["Unbounded delegation"],
      architecturePreferences: ["Reuse existing runtime seams."],
      deploymentTargets: ["CLI"],
      repository: {
        inspected: true,
        markers: [".git", "package.json"],
        evidence: [{
          path: "package.json",
          finding: "The project is a TypeScript workspace.",
        }],
      },
    },
    initialGoal: "Deliver the first independently reviewed company goal.",
    roadmap: ["Understand the project.", "Deliver a reviewed slice."],
  };
}

function scriptedModel(
  decisions: readonly CompanyOnboardingDecisionV1[],
): CompanyOnboardingModelPort & { readonly calls: unknown[] } {
  const queue = [...decisions];
  const calls: unknown[] = [];
  return {
    calls,
    async decide(input) {
      calls.push(input);
      const decision = queue.shift();
      if (decision === undefined) throw new Error("script exhausted");
      return { decision, requestsUsed: 1, reportedCostUsd: 0 };
    },
  };
}

function noResearch(): CompanyOnboardingResearchPort {
  return {
    async run() {
      throw new Error("research must not run");
    },
  };
}

async function coordinator(
  model: CompanyOnboardingModelPort,
  research: CompanyOnboardingResearchPort = noResearch(),
) {
  const setup = await stores();
  let id = 0;
  let tick = 0;
  return {
    ...setup,
    coordinator: new CompanyOnboardingCoordinator({
      runs: setup.runs,
      blueprints: setup.blueprints,
      model,
      research,
      newId(kind) { id += 1; return `${kind}-${id}`; },
      now() {
        tick += 1;
        return new Date(Date.UTC(2026, 6, 22, 0, 0, tick)).toISOString();
      },
    }),
  };
}

const startInput = {
  projectRoot: "/workspace/project",
  depth: "guided" as const,
  designMode: "stable_core_specialists" as const,
  permissionMode: "approved_for_me" as const,
  operatingModeId: "balanced_v6" as const,
  backendFingerprint: "backend-fixture",
  repositoryConsent: true,
};

describe("CompanyOnboardingCoordinator", () => {
  it("supports a durable adaptive question, answer, proposal, and approval", async () => {
    const model = scriptedModel([{
      kind: "question",
      id: "outcome",
      question: "What outcome should the company own?",
    }, proposal()]);
    const setup = await coordinator(model);
    const started = await setup.coordinator.start(startInput);

    const question = await setup.coordinator.advance(started.state.id);
    expect(question).toMatchObject({
      kind: "question",
      question: { id: "outcome" },
      run: { sequence: 2 },
    });
    const reloaded = await new FileCompanyOnboardingStore(setup.runs.directory)
      .load(started.state.id);
    expect(reloaded.state.interview.pendingQuestion).toEqual({
      id: "outcome",
      question: "What outcome should the company own?",
    });

    const restarted = new CompanyOnboardingCoordinator(
      setup.coordinator.dependencies,
    );
    await expect(restarted.resume(startInput)).resolves.toEqual(reloaded);
    await expect(restarted.advance(started.state.id)).resolves.toMatchObject({
      kind: "question",
      run: { sequence: reloaded.sequence },
    });
    expect(model.calls).toHaveLength(1);

    const answered = await restarted.answer(
      started.state.id,
      reloaded.sequence,
      "A trustworthy open-source coding-agent company.",
    );
    expect(answered.state.interview.answers).toHaveLength(1);
    expect(answered.state.interview.pendingQuestion).toBeNull();

    const proposed = await restarted.advance(started.state.id);
    expect(proposed).toMatchObject({
      kind: "proposal",
      run: { state: { status: "proposed", interview: { complete: true } } },
    });
    const approved = await restarted.approve(
      started.state.id,
      proposed.run.sequence,
    );
    expect(approved.state).toMatchObject({
      status: "approved",
      approvedBlueprintId: proposed.blueprint.id,
    });
    await expect(setup.blueprints.load(proposed.blueprint.id))
      .resolves.toMatchObject({ state: "approved" });
  });

  it.each([
    ["quick", 0],
    ["guided", 3],
    ["deep", 8],
  ] as const)("enforces %s research capacity of %s", async (depth, maximum) => {
    const assignments = Array.from({ length: maximum }, (_, index) => ({
      key: `research_${index + 1}`,
      description: `Inspect area ${index + 1}.`,
      prompt: `Read area ${index + 1} and return evidence.`,
    }));
    const decisions: CompanyOnboardingDecisionV1[] = maximum === 0
      ? [proposal()]
      : [{ kind: "research", assignments }, proposal()];
    let active = 0;
    let peak = 0;
    const research: CompanyOnboardingResearchPort = {
      async run(input) {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return {
          evidence: [`${input.assignment.description} evidence`],
          requestsUsed: 1,
          reportedCostUsd: 0,
        };
      },
    };
    const setup = await coordinator(scriptedModel(decisions), research);
    const started = await setup.coordinator.start({
      ...startInput,
      depth,
      operatingModeId: depth === "deep" ? "max_v6" : "balanced_v6",
    });

    if (maximum > 0) {
      const researched = await setup.coordinator.advance(started.state.id);
      expect(researched).toMatchObject({ kind: "researched" });
      expect(researched.run.state.research).toHaveLength(maximum);
      expect(researched.run.state.research.every((item) =>
        item.status === "completed"
      )).toBe(true);
      const concurrency = depth === "deep" ? 4 : 2;
      expect(peak).toBeLessThanOrEqual(concurrency);
    }
    const proposed = await setup.coordinator.advance(started.state.id);
    expect(proposed.kind).toBe("proposal");
  });

  it("fails closed on research without consent or above the depth limit", async () => {
    const researchDecision: CompanyOnboardingDecisionV1 = {
      kind: "research",
      assignments: [{
        key: "repository",
        description: "Inspect the repository.",
        prompt: "Read the repository.",
      }],
    };
    const denied = await coordinator(scriptedModel([researchDecision]));
    const deniedRun = await denied.coordinator.start({
      ...startInput,
      repositoryConsent: false,
    });
    await expect(denied.coordinator.advance(deniedRun.state.id))
      .rejects.toMatchObject({ code: "policy_violation" });
    await expect(denied.runs.load(deniedRun.state.id))
      .resolves.toMatchObject({ state: { status: "failed" } });

    const excessive = await coordinator(scriptedModel([{
      kind: "research",
      assignments: Array.from({ length: 4 }, (_, index) => ({
        key: `area_${index}`,
        description: `Inspect area ${index}.`,
        prompt: `Read area ${index}.`,
      })),
    }]));
    const excessiveRun = await excessive.coordinator.start(startInput);
    await expect(excessive.coordinator.advance(excessiveRun.state.id))
      .rejects.toMatchObject({ code: "policy_violation" });
  });

  it("resumes only the newest compatible unfinished run without deleting history", async () => {
    const setup = await coordinator(scriptedModel([proposal()]));
    const first = await setup.coordinator.start(startInput);

    await expect(setup.coordinator.resume(startInput)).resolves.toEqual(first);
    await expect(setup.coordinator.resume({
      ...startInput,
      backendFingerprint: "different-backend",
    })).rejects.toMatchObject({ code: "resume_mismatch" });
    await expect(setup.coordinator.resume({
      ...startInput,
      permissionMode: "ask_always",
    })).rejects.toMatchObject({ code: "resume_mismatch" });
    await expect(setup.coordinator.resume({
      ...startInput,
      projectRoot: "/workspace/other",
    })).resolves.toBeNull();
    expect(await setup.runs.list()).toHaveLength(1);
  });

  it("preserves save/exit and records explicit cancellation truthfully", async () => {
    const setup = await coordinator(scriptedModel([proposal()]));
    const started = await setup.coordinator.start(startInput);

    await expect(setup.coordinator.save(started.state.id)).resolves.toEqual(started);
    const cancelled = await setup.coordinator.cancel(
      started.state.id,
      started.sequence,
      "Interrupted by the user.",
    );
    expect(cancelled.state).toMatchObject({
      status: "cancelled",
      terminalReason: "Interrupted by the user.",
    });
    await expect(setup.coordinator.advance(started.state.id))
      .rejects.toBeInstanceOf(CompanyOnboardingCoordinatorError);
  });

  it("persists validated chat and YAML proposal revisions without widening identity", async () => {
    const setup = await coordinator(scriptedModel([proposal()]));
    const started = await setup.coordinator.start(startInput);
    const proposed = await setup.coordinator.advance(started.state.id);
    if (proposed.kind !== "proposal") throw new Error("expected proposal");
    const chatBlueprint = structuredClone(proposed.blueprint);
    chatBlueprint.project.purpose = "Ship a concise, dependable agent company.";

    const chat = await setup.coordinator.reviseProposal(
      started.state.id,
      proposed.run.sequence,
      {
        source: "chat",
        blueprint: chatBlueprint,
        requestsUsed: 2,
        reportedCostUsd: 0.03,
      },
    );
    expect(chat).toMatchObject({
      changed: true,
      run: {
        state: {
          status: "proposed",
          usage: { modelRequests: 3, reportedCostUsd: 0.03 },
          proposal: { revision: 2, source: "chat" },
        },
      },
    });

    const yaml = await setup.coordinator.reviseProposal(
      started.state.id,
      chat.run.sequence,
      {
        source: "yaml",
        blueprint: chat.run.state.proposal!.blueprint,
        requestsUsed: 0,
        reportedCostUsd: 0,
      },
    );
    expect(yaml.changed).toBe(false);
    expect(yaml.run.sequence).toBe(chat.run.sequence);
  });

  it("accounts invalid chat output but rejects authority and stable-id changes", async () => {
    const setup = await coordinator(scriptedModel([proposal()]));
    const started = await setup.coordinator.start(startInput);
    const proposed = await setup.coordinator.advance(started.state.id);
    if (proposed.kind !== "proposal") throw new Error("expected proposal");

    await expect(setup.coordinator.reviseProposal(
      started.state.id,
      proposed.run.sequence,
      {
        source: "chat",
        blueprint: { invalid: true },
        requestsUsed: 1,
        reportedCostUsd: 0.01,
      },
    )).rejects.toMatchObject({ code: "invalid_model_output" });
    const accounted = await setup.coordinator.save(started.state.id);
    expect(accounted.state).toMatchObject({
      status: "proposed",
      usage: { modelRequests: 2, reportedCostUsd: 0.01 },
      proposal: { revision: 1 },
    });

    const widened = structuredClone(accounted.state.proposal!.blueprint);
    widened.authority.permissionMode = "full_access";
    await expect(setup.coordinator.reviseProposal(
      started.state.id,
      accounted.sequence,
      {
        source: "yaml",
        blueprint: widened,
        requestsUsed: 0,
        reportedCostUsd: 0,
      },
    )).rejects.toMatchObject({ code: "invalid_model_output" });

    const replacedRole = structuredClone(accounted.state.proposal!.blueprint);
    replacedRole.roles[0]!.id = "replacement_role";
    await expect(setup.coordinator.reviseProposal(
      started.state.id,
      accounted.sequence,
      {
        source: "yaml",
        blueprint: replacedRole,
        requestsUsed: 0,
        reportedCostUsd: 0,
      },
    )).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("persists SIGINT cancellation and fails closed on corrupt resume state", async () => {
    const setup = await coordinator(scriptedModel([proposal()]));
    const interrupted = await setup.coordinator.start(startInput);
    const controller = new AbortController();
    controller.abort(new Error("SIGINT"));

    await expect(setup.coordinator.advance(
      interrupted.state.id,
      controller.signal,
    )).rejects.toMatchObject({ code: "cancelled" });
    await expect(setup.runs.load(interrupted.state.id)).resolves.toMatchObject({
      state: { status: "cancelled", terminalReason: "SIGINT" },
    });

    const corrupt = await setup.coordinator.start(startInput);
    await appendFile(
      path.join(setup.runs.directory, `${corrupt.state.id}.jsonl`),
      "{\"durable\":false}\n",
    );
    await expect(setup.coordinator.resume(startInput))
      .rejects.toMatchObject({ code: "corrupt" });
  });
});
