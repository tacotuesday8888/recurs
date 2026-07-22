import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlSessionStore,
} from "@recurs/core";
import {
  parseCompanyOnboardingRun,
  type CompanyOnboardingRunV1,
} from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import { PermissionEngine } from "@recurs/tools";
import { testBackendPin } from "../../../tests/support/backend.js";

import {
  CompanyOnboardingAgentRuntime,
  companyOnboardingBackendFingerprint,
  createCompanyOnboardingToolRegistry,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function fixture(provider: ScriptedProvider) {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-onboarding-runtime-"));
  roots.push(root);
  const backend = testBackendPin();
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  return {
    root,
    backend,
    sessions,
    runtime: new CompanyOnboardingAgentRuntime({
      backend,
      sessions,
      cwd: root,
      createProvider: () => provider,
    }),
  };
}

function run(backendFingerprint: string): CompanyOnboardingRunV1 {
  return parseCompanyOnboardingRun({
    id: "onboarding-runtime",
    companyId: "company-runtime",
    version: 1,
    projectRoot: "/workspace/project",
    status: "interviewing",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    depth: "guided",
    designMode: "stable_core_specialists",
    authority: {
      permissionMode: "full_access",
      operatingModeId: "balanced_v6",
      operatingModeVersion: 6,
    },
    backend: { fingerprint: backendFingerprint },
    repositoryAccess: {
      scope: "project_read",
      grantedAt: "2026-07-22T00:00:00.000Z",
    },
    interview: { complete: false, pendingQuestion: null, answers: [] },
    research: [],
    usage: { modelRequests: 0, reportedCostUsd: 0 },
    proposal: null,
    approvedBlueprintId: null,
    terminalReason: null,
  });
}

const toolNames = [
  "read_file",
  "list_files",
  "search_text",
  "code_outline",
  "git_status",
  "git_history",
  "git_show",
  "git_diff",
];

describe("company onboarding runtime", () => {
  it("exposes only the dedicated read-only registry even under Full Access", async () => {
    const registry = createCompanyOnboardingToolRegistry();
    expect(registry.definitions("plan").map((tool) => tool.name)).toEqual(toolNames);
    expect(registry.definitions("act").map((tool) => tool.name)).toEqual(toolNames);

    const root = await mkdtemp(path.join(tmpdir(), "recurs-onboarding-tools-"));
    roots.push(root);
    const context = {
      sessionId: "onboarding",
      cwd: root,
      signal: new AbortController().signal,
      executionMode: "plan" as const,
      readRevisions: new Map<string, string>(),
    };
    for (const name of [
      "apply_patch", "run_command", "process_session", "web_fetch",
      "use_mcp", "use_skill", "delegate_task",
    ]) {
      await expect(registry.invoke(
        { id: name, name, arguments: {} },
        context,
        new PermissionEngine("full_access"),
        { async request() { throw new Error("must not ask"); } },
      )).rejects.toMatchObject({ code: "unknown_tool" });
    }
  });

  it("runs the adaptive interview through AgentLoop and rejects a hostile write call", async () => {
    const decision = JSON.stringify({
      kind: "question",
      id: "desired_outcome",
      question: "What outcome matters most?",
    });
    const provider = new ScriptedProvider([
      [{
        type: "tool_call",
        call: {
          id: "hostile-write",
          name: "apply_patch",
          arguments: { patch: "*** Begin Patch\n*** End Patch" },
        },
      }, { type: "done", stopReason: "tool_calls" }],
      [
        { type: "text_delta", text: decision },
        { type: "usage", inputTokens: 20, outputTokens: 8, costUsd: 0.01 },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const setup = await fixture(provider);
    const marker = path.join(setup.root, "marker.txt");
    await writeFile(marker, "unchanged\n", "utf8");

    const result = await setup.runtime.decide({
      run: run(companyOnboardingBackendFingerprint(setup.backend)),
      allowedTools: toolNames as never,
      maxRequests: 2,
    }, new AbortController().signal);

    expect(result).toEqual({
      decision: JSON.parse(decision),
      requestsUsed: 2,
      reportedCostUsd: 0.01,
    });
    expect(await readFile(marker, "utf8")).toBe("unchanged\n");
    expect(provider.requests.every((request) =>
      request.tools.map((tool) => tool.name).join(",") === toolNames.join(",")
    )).toBe(true);
    const state = await setup.sessions.loadState("onboarding-model-onboarding-runtime");
    expect(state.toolOutcomes["hostile-write"]).toMatchObject({
      type: "failed",
      error: { code: "tool_failed" },
    });
  });

  it("runs research as an Explore child with attributable evidence", async () => {
    const provider = new ScriptedProvider([
      [{
        type: "tool_call",
        call: { id: "read-package", name: "read_file", arguments: { path: "package.json" } },
      }, { type: "done", stopReason: "tool_calls" }],
      [
        { type: "text_delta", text: "The project has a package manifest." },
        { type: "usage", inputTokens: 15, outputTokens: 6 },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const setup = await fixture(provider);
    await writeFile(path.join(setup.root, "package.json"), "{\"name\":\"fixture\"}\n");
    const onboarding = run(companyOnboardingBackendFingerprint(setup.backend));
    const assignment = {
      id: "research-package",
      description: "Inspect the package manifest.",
      prompt: "Read package.json and identify the project shape.",
      status: "running" as const,
      evidence: [],
      failure: null,
    };

    const result = await setup.runtime.run({
      run: onboarding,
      assignment,
      profile: "explore_v1",
      allowedTools: toolNames as never,
      maxRequests: 2,
    }, new AbortController().signal);

    expect(result.requestsUsed).toBe(2);
    expect(result.evidence).toEqual([
      expect.stringMatching(/^read package\.json:1-1 \(sha256 [0-9a-f]{64}\)$/u),
    ]);
    expect(provider.requests[0]!.tools.map((tool) => tool.name)).toEqual(toolNames);
    const state = await setup.sessions.loadState(
      "onboarding-research-research-package",
    );
    expect(state).toMatchObject({
      executionMode: "plan",
      agent: {
        role: "child",
        profile: { id: "explore_v1", version: 1 },
      },
    });
  });

  it("refuses to run against a different durable backend fingerprint", async () => {
    const setup = await fixture(new ScriptedProvider([]));
    await expect(setup.runtime.decide({
      run: run("different-backend"),
      allowedTools: toolNames as never,
      maxRequests: 1,
    }, new AbortController().signal)).rejects.toThrow(
      "backend does not match durable state",
    );
  });
});
