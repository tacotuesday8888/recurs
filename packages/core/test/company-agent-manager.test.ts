import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  type CoordinatedRunInput,
  type RunCoordinator,
} from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveCompanyBlueprint,
  ChildAgentManager,
  CompanyAgentManager,
  compileCompanyBlueprint,
  createDelegationBudget,
  createRootAgentDescriptor,
  FileCompanyBlueprintStore,
  JsonlSessionStore,
  type RecursEvent,
} from "../src/index.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];
const trusted = deriveTrustedRunContext(createHostInvocation({
  invocation: "repl",
  userPresent: true,
  remote: false,
  scripted: false,
  embedding: "cli",
}));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-agent-")),
  );
  directories.push(root);
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  const blueprints = new FileCompanyBlueprintStore(path.join(root, "blueprints"));
  const blueprint = approveCompanyBlueprint(compileCompanyBlueprint({
    id: "company-1",
    createdAt: testAt,
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Deliver a reliable company-aware handoff",
      constraints: ["Keep the child bounded"],
      repository: { inspected: true, markers: [".git", "package.json"] },
    },
    developmentStyle: "layered_company",
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v5",
  }), "2026-07-17T00:01:00.000Z");
  await blueprints.create(blueprint);
  const pin = testBackendPin();
  const binding = {
    blueprintId: blueprint.id,
    blueprintVersion: 1 as const,
    roleId: "orchestrator_v1" as const,
    roleVersion: 1 as const,
  };
  const parent = await sessions.createPinnedSession({
    id: "parent-session",
    cwd: root,
    backend: pin,
    agent: createRootAgentDescriptor(
      "parent-session",
      pin,
      blueprint.authority.operatingModeId,
      blueprint.authority.permissionMode,
      "act",
      binding,
    ),
    at: testAt,
  });
  return { root, sessions, blueprints, blueprint, parent };
}

function context(parent: Awaited<ReturnType<typeof fixture>>["parent"]) {
  return {
    sessionId: parent.id,
    cwd: parent.cwd,
    executionMode: parent.executionMode,
    signal: new AbortController().signal,
    readRevisions: new Map<string, string>(),
    runContext: trusted,
    delegationBudget: createDelegationBudget(parent.agent),
  };
}

describe("CompanyAgentManager", () => {
  it("runs a real approved role through the existing child engine", async () => {
    const setup = await fixture();
    const starts: CoordinatedRunInput[] = [];
    const events: RecursEvent[] = [];
    const coordinator: RunCoordinator = {
      async start(input) {
        starts.push(input);
        const result = {
          finalText: "bounded change completed",
          usage: { inputTokens: 12, outputTokens: 5, costUsd: 0.03 },
          usageSource: "provider" as const,
          steps: 2,
          changedFiles: ["src/company.ts"],
          changedFilesSource: "host_tools" as const,
          evidence: ["focused company test passed"],
          evidenceSource: "host_tools" as const,
        };
        await setup.sessions.withSessionMutation(
          input.sessionId,
          input.expectedSessionRecordSequence,
          async (lease) => {
            await lease.append({
              type: "turn_started",
              turnId: "company-child-turn",
              prompt: input.prompt,
              at: testAt,
            });
            await lease.append({
              type: "model_completed",
              turnId: "company-child-turn",
              message: {
                id: "company-child-message",
                role: "assistant",
                content: result.finalText,
                toolCalls: [],
              },
              usage: result.usage,
              stopReason: "complete",
              at: testAt,
            });
            await lease.append({
              type: "turn_completed",
              turnId: "company-child-turn",
              result,
              at: testAt,
            });
          },
        );
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({
            ok: true,
            result,
          }),
        };
      },
    };
    const children = new ChildAgentManager({
      sessions: setup.sessions,
      getCoordinator: () => coordinator,
      async emit(event) { events.push(event); },
      createId: (() => {
        const ids = ["child-session", "child-agent", "child-task"];
        return () => ids.shift()!;
      })(),
      now: () => testAt,
    });
    const companies = new CompanyAgentManager({
      sessions: setup.sessions,
      blueprints: setup.blueprints,
      children,
    });
    const tool = companies.createTool();

    const result = await tool.execute(tool.parse({
      role: "scoped_builder_v1",
      description: "Implement the company handoff",
      prompt: "Implement the bounded company handoff and verify it",
    }), context(setup.parent));

    expect(result.output).toBe("bounded change completed");
    expect(result.metadata).toMatchObject({
      profileId: "implement_v1",
      company: {
        blueprintId: "company-1",
        roleId: "scoped_builder_v1",
      },
      changedFiles: ["src/company.ts"],
      evidence: ["focused company test passed"],
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.prompt).toContain("Scoped Builder");
    expect(starts[0]?.prompt).toContain("Keep the child bounded");
    const child = await setup.sessions.loadState("child-session");
    expect(child).toMatchObject({
      agent: {
        parentSessionId: setup.parent.id,
        profile: { id: "implement_v1", version: 1 },
        company: {
          blueprintId: "company-1",
          blueprintVersion: 1,
          roleId: "scoped_builder_v1",
          roleVersion: 1,
        },
      },
      agentResult: {
        finalText: "bounded change completed",
        evidence: ["focused company test passed"],
      },
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent_started",
        company: expect.objectContaining({ roleId: "scoped_builder_v1" }),
      }),
      expect.objectContaining({
        type: "agent_completed",
        company: expect.objectContaining({ roleId: "scoped_builder_v1" }),
      }),
    ]));
  });

  it("rejects a non-executable company role", async () => {
    const setup = await fixture();
    const companies = new CompanyAgentManager({
      sessions: setup.sessions,
      blueprints: setup.blueprints,
      children: { delegate: async () => { throw new Error("must not run"); } },
    });

    await expect(companies.createTool().execute({
      role: "orchestrator_v1",
      description: "Delegate the parent",
      prompt: "This role must remain the parent",
    }, context(setup.parent))).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("propagates company-child cancellation truthfully", async () => {
    const setup = await fixture();
    const events: RecursEvent[] = [];
    const children = new ChildAgentManager({
      sessions: setup.sessions,
      getCoordinator: () => ({
        async start() {
          return {
            events: { async *[Symbol.asyncIterator]() {} },
            outcome: Promise.resolve({
              ok: false,
              failure: {
                domain: "runtime",
                phase: "started",
                code: "cancelled",
                safeMessage: "Parent cancelled the company handoff",
                diagnosticId: "company-cancelled",
                retryable: false,
              },
            }),
          };
        },
      }),
      async emit(event) { events.push(event); },
      createId: (() => {
        const ids = ["cancelled-session", "cancelled-agent", "cancelled-task"];
        return () => ids.shift()!;
      })(),
      now: () => testAt,
    });
    const companies = new CompanyAgentManager({
      sessions: setup.sessions,
      blueprints: setup.blueprints,
      children,
    });

    await expect(companies.createTool().execute({
      role: "qa_reviewer_v1",
      description: "Review the bounded change",
      prompt: "Review and return evidence",
    }, context(setup.parent))).rejects.toMatchObject({ code: "cancelled" });
    await expect(setup.sessions.loadState("cancelled-session")).resolves.toMatchObject({
      agent: { company: { roleId: "qa_reviewer_v1" } },
      agentLifecycle: {
        status: "cancelled",
        reason: "Parent cancelled the company handoff",
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_cancelled",
      company: { roleId: "qa_reviewer_v1" },
      reason: "Parent cancelled the company handoff",
    });
  });
});
