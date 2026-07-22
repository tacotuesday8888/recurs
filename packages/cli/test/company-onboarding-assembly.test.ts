import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ScriptedProvider } from "@recurs/providers";

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
      expect(provider.requests[0]!.tools.map((tool) => tool.name)).toEqual([
        "read_file",
        "list_files",
        "search_text",
        "code_outline",
        "git_status",
        "git_history",
        "git_show",
        "git_diff",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
