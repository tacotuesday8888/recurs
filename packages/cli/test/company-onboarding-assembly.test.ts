import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileConnectionRegistry,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import type { AgentRuntime } from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import { CODEX_APP_SERVER_PROFILE_REVISION } from "@recurs/runtimes";

import { createStandaloneCompanyOnboarding } from "../src/assembly.js";

describe("standalone company onboarding assembly", () => {
  it("binds the durable coordinator to the selected direct backend", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-company-assembly-")),
    );
    const provider = new ScriptedProvider([[
      {
        type: "text_delta",
        text: JSON.stringify({
          kind: "question",
          id: "outcome",
          question: "What outcome should the company own?",
        }),
      },
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "done", stopReason: "complete" },
    ]]);
    try {
      const options = {
        cwd: root,
        dataDirectory: path.join(root, "data"),
        skillHomeDirectory: root,
        provider,
      };
      const service = await createStandaloneCompanyOnboarding({
        permissionMode: "full_access",
        operatingModeId: "balanced_v6",
      }, options);
      const repeated = await createStandaloneCompanyOnboarding({
        permissionMode: "full_access",
        operatingModeId: "balanced_v6",
        repositoryConsent: true,
      }, options);
      expect(repeated.backendFingerprint).toBe(service.backendFingerprint);
      expect(service.proposalEditor).toBeDefined();
      expect(service.capabilityCatalogs).toBeUndefined();
      expect(repeated.capabilityCatalogs).toMatchObject({
        skills: { skills: [] },
        mcp: { projectTrust: "absent", servers: [] },
      });

      const started = await service.coordinator.start({
        projectRoot: service.projectRoot,
        depth: "quick",
        designMode: "stable_core_specialists",
        permissionMode: "full_access",
        operatingModeId: "balanced_v6",
        backendFingerprint: service.backendFingerprint,
        repositoryConsent: false,
      });
      const advanced = await service.coordinator.advance(started.state.id);

      expect(advanced).toMatchObject({
        kind: "question",
        question: { id: "outcome" },
      });
      expect(provider.requests[0]!.tools).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs Codex formation through the same restricted Plan-mode host tools", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-codex-company-assembly-")),
    );
    const dataDirectory = path.join(root, "data");
    const connection: DelegatedConnectionRecord = {
      kind: "delegated_agent",
      id: "codex-sol",
      providerId: "openai-codex-chatgpt",
      adapterId: "codex-app-server",
      label: "Sol · ChatGPT",
      accountLabel: "ChatGPT subscription",
      organizationLabel: null,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      runtimeCapabilityProfileRevision: CODEX_APP_SERVER_PROFILE_REVISION,
      accountSubjectFingerprint:
        "sha256:51ad6241d1bfb3fbf43e889bf15530e6ca0c985d6a816d3358c3d356b0a768fa",
      policyRevision: "openai-codex-chatgpt-2026-07-11",
      billingPolicy: {
        revision: "billing:openai-codex-chatgpt:2026-07-11",
        disclosureRevision:
          "billing-disclosure:openai-codex-chatgpt:2026-07-11",
        primarySource: "included_subscription",
        possibleAdditionalSources: ["prepaid_credits"],
        providerFallback: "automatic",
        availableSelections: ["allow_declared_additional"],
      },
      billingSelection: {
        mode: "allow_declared_additional",
        policyRevision: "billing:openai-codex-chatgpt:2026-07-11",
        disclosureRevision:
          "billing-disclosure:openai-codex-chatgpt:2026-07-11",
        allowedSources: ["included_subscription", "prepaid_credits"],
        acknowledgedAt: "2026-07-23T00:00:00.000Z",
      },
      verifiedAt: "2026-07-23T00:00:00.000Z",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    const exposedTools: string[][] = [];
    const runtime: AgentRuntime = {
      adapterId: connection.adapterId,
      connectionId: connection.id,
      capabilityProfileRevision: CODEX_APP_SERVER_PROFILE_REVISION,
      capabilities: {
        resume: false,
        cancellation: "protocol",
        fileEvents: false,
        usageEvents: true,
        supportedPermissionModes: [
          "ask_always",
          "approved_for_me",
          "full_access",
        ],
        approvalControl: "host",
        planMode: "enforced",
        toolExecution: "host_tools",
        checkpointing: "host_tools",
      },
      async *run(_request, host) {
        exposedTools.push(host.tools?.map((tool) => tool.name) ?? []);
        yield {
          type: "usage",
          usage: { inputTokens: 12, outputTokens: 7 },
        };
        yield {
          type: "done",
          finalText: JSON.stringify({
            kind: "question",
            id: "outcome",
            question: "What outcome should the company own?",
          }),
          stopReason: "complete",
        };
      },
      async reconcile() { return "gone"; },
    };
    try {
      const registry = new FileConnectionRegistry(dataDirectory);
      await registry.commit(0, (draft) => {
        draft.connections.push(connection);
        draft.primaryConnectionId = connection.id;
      });
      const service = await createStandaloneCompanyOnboarding({
        permissionMode: "approved_for_me",
        operatingModeId: "balanced_v6",
      }, {
        cwd: root,
        dataDirectory,
        delegatedRuntimeFactory: () => runtime,
      });
      const started = await service.coordinator.start({
        projectRoot: service.projectRoot,
        depth: "guided",
        designMode: "stable_core_specialists",
        permissionMode: "approved_for_me",
        operatingModeId: "balanced_v6",
        backendFingerprint: service.backendFingerprint,
        repositoryConsent: true,
      });
      const advanced = await service.coordinator.advance(started.state.id);

      expect(advanced).toMatchObject({
        kind: "question",
        question: { id: "outcome" },
        run: { state: { usage: { modelRequests: 1 } } },
      });
      expect(exposedTools).toEqual([[]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
