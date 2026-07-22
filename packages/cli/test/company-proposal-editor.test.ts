import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompanyOnboardingCoordinator,
  FileCompanyBlueprintV2Store,
  FileCompanyOnboardingStore,
  type CompanyProposalRevisionModelPort,
} from "@recurs/core";

import {
  CompanyProposalEditor,
  companyEditorEnvironment,
  parseCompanyEditorCommand,
} from "../src/company-proposal-editor.js";
import {
  renderCompanyBlueprintYaml,
} from "../src/company-blueprint-yaml.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function proposedRun(model: CompanyProposalRevisionModelPort) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-proposal-editor-")),
  );
  roots.push(root);
  const runs = new FileCompanyOnboardingStore(path.join(root, "runs"));
  const blueprints = new FileCompanyBlueprintV2Store(path.join(root, "blueprints"));
  let tick = 0;
  const coordinator = new CompanyOnboardingCoordinator({
    runs,
    blueprints,
    model: {
      async decide() {
        return {
          decision: {
            kind: "propose",
            project: {
              type: "existing_project",
              stage: "active",
              purpose: "Build a dependable coding-agent company.",
              users: ["Software teams"],
              successCriteria: ["Every accepted change has independent evidence."],
              constraints: ["Never widen child authority."],
              risks: [],
              architecturePreferences: ["Reuse existing runtime seams."],
              deploymentTargets: ["CLI"],
              repository: { inspected: false, markers: [], evidence: [] },
            },
            initialGoal: "Deliver the first independently reviewed change.",
            roadmap: ["Understand the project.", "Deliver a reviewed slice."],
          },
          requestsUsed: 1,
          reportedCostUsd: 0,
        };
      },
    },
    research: { async run() { throw new Error("research must not run"); } },
    newId(kind) { return `${kind}-editor`; },
    now() {
      tick += 1;
      return new Date(Date.UTC(2026, 6, 22, 0, 0, tick)).toISOString();
    },
  });
  const started = await coordinator.start({
    projectRoot: root,
    depth: "guided",
    designMode: "stable_core_specialists",
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    backendFingerprint: "backend-editor",
    repositoryConsent: false,
  });
  const advanced = await coordinator.advance(started.state.id);
  if (advanced.kind !== "proposal") throw new Error("expected proposal");
  return {
    root,
    coordinator,
    run: advanced.run,
    editor: new CompanyProposalEditor({ coordinator, model }),
  };
}

describe("company proposal editor", () => {
  it("parses editor commands without shell interpolation", () => {
    expect(parseCompanyEditorCommand("code --wait 'profile one'")).toEqual({
      executable: "code",
      arguments: ["--wait", "profile one"],
    });
    expect(parseCompanyEditorCommand('editor "file name"')).toEqual({
      executable: "editor",
      arguments: ["file name"],
    });
    expect(() => parseCompanyEditorCommand("editor 'unfinished"))
      .toThrow("unfinished quote");
    expect(() => parseCompanyEditorCommand("editor\ncommand"))
      .toThrow("single-line");
    expect(companyEditorEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/user",
      OPENAI_API_KEY: "credential-canary",
      GH_TOKEN: "token-canary",
    })).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
  });

  it("applies a bounded chat revision and reports a structural diff", async () => {
    const revise = vi.fn<CompanyProposalRevisionModelPort["revise"]>(
      async (input) => {
        const blueprint = structuredClone(input.blueprint);
        return {
          blueprint: {
            ...blueprint,
            project: {
              ...blueprint.project,
              purpose: "Build a concise, dependable coding-agent company.",
            },
          },
          requestsUsed: 1,
          reportedCostUsd: 0.02,
        };
      },
    );
    const setup = await proposedRun({ revise });

    const edited = await setup.editor.discuss({
      run: setup.run,
      instruction: "Make the project purpose emphasize concise design.",
    });

    expect(edited).toMatchObject({
      kind: "updated",
      changes: expect.arrayContaining(["Project purpose changed"]),
      run: {
        state: {
          usage: { modelRequests: 2, reportedCostUsd: 0.02 },
          proposal: { revision: 2, source: "chat" },
        },
      },
    });
    expect(revise).toHaveBeenCalledWith(expect.objectContaining({
      instruction: "Make the project purpose emphasize concise design.",
      maxRequests: 23,
      allowedTools: [
        "read_file", "list_files", "search_text", "code_outline",
        "git_status", "git_history", "git_show", "git_diff",
      ],
    }), expect.any(AbortSignal));
  });

  it("keeps an invalid chat revision out of the proposal while accounting usage", async () => {
    const setup = await proposedRun({
      async revise() {
        return {
          blueprint: { invalid: true },
          requestsUsed: 2,
          reportedCostUsd: 0.01,
        };
      },
    });
    const edited = await setup.editor.discuss({
      run: setup.run,
      instruction: "Replace the company with invalid output.",
    });

    expect(edited).toMatchObject({
      kind: "invalid",
      run: {
        state: {
          usage: { modelRequests: 3, reportedCostUsd: 0.01 },
          proposal: { revision: 1 },
        },
      },
    });
  });

  it("applies YAML edits, ignores unchanged YAML, and rejects authority escalation", async () => {
    const setup = await proposedRun({
      async revise() { throw new Error("chat must not run"); },
    });
    const previous = setup.run.state.proposal!.blueprint;
    const changed = {
      ...structuredClone(previous),
      roadmap: [...previous.roadmap, "Document the reviewed result."],
    };
    const edited = await setup.editor.applyYaml({
      run: setup.run,
      yaml: renderCompanyBlueprintYaml(changed),
    });
    expect(edited).toMatchObject({
      kind: "updated",
      changes: expect.arrayContaining(["Roadmap changed"]),
      run: { state: { proposal: { revision: 2, source: "yaml" } } },
    });

    await expect(setup.editor.applyYaml({
      run: edited.run,
      yaml: renderCompanyBlueprintYaml(edited.blueprint),
    })).resolves.toMatchObject({ kind: "unchanged" });

    const widened = {
      ...structuredClone(edited.blueprint),
      authority: {
        ...edited.blueprint.authority,
        permissionMode: "full_access" as const,
      },
    };
    await expect(setup.editor.applyYaml({
      run: edited.run,
      yaml: renderCompanyBlueprintYaml(widened),
    })).resolves.toMatchObject({ kind: "invalid" });
  });

  it("uses VISUAL before EDITOR, protects the file, and always removes it", async () => {
    const setup = await proposedRun({
      async revise() { throw new Error("chat must not run"); },
    });
    let temporaryPath = "";
    const launch = vi.fn(async (command, file: string) => {
      temporaryPath = path.dirname(file);
      expect(command).toEqual({ executable: "visual-editor", arguments: ["--wait"] });
      expect((await stat(temporaryPath)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const blueprint = structuredClone(setup.run.state.proposal!.blueprint);
      blueprint.project.purpose = "Edited through private YAML.";
      await writeFile(file, renderCompanyBlueprintYaml(blueprint), "utf8");
      return "completed" as const;
    });
    const editor = new CompanyProposalEditor({
      coordinator: setup.coordinator,
      model: { async revise() { throw new Error("chat must not run"); } },
      environment: { VISUAL: "visual-editor --wait", EDITOR: "ignored" },
      temporaryDirectory: setup.root,
      launchEditor: launch,
    });

    await expect(editor.editYaml({ run: setup.run }))
      .resolves.toMatchObject({ kind: "updated" });
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(launch).toHaveBeenCalledOnce();
  });

  it("reports missing, failed, and cancelled editors without changing the proposal", async () => {
    const setup = await proposedRun({
      async revise() { throw new Error("chat must not run"); },
    });
    const unavailable = new CompanyProposalEditor({
      coordinator: setup.coordinator,
      model: { async revise() { throw new Error("chat must not run"); } },
      environment: {},
    });
    await expect(unavailable.editYaml({ run: setup.run }))
      .resolves.toMatchObject({ kind: "unavailable" });

    for (const outcome of ["failed", "cancelled"] as const) {
      const editor = new CompanyProposalEditor({
        coordinator: setup.coordinator,
        model: { async revise() { throw new Error("chat must not run"); } },
        environment: { EDITOR: "fixture-editor" },
        temporaryDirectory: setup.root,
        async launchEditor() { return outcome; },
      });
      await expect(editor.editYaml({ run: setup.run }))
        .resolves.toMatchObject({ kind: outcome === "failed" ? "invalid" : outcome });
    }
    expect(await readFile(
      path.join(setup.root, "runs", `${setup.run.state.id}.jsonl`),
      "utf8",
    )).toContain('"status":"proposed"');
  });
});
