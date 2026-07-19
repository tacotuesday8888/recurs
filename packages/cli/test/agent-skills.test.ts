import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createHostInvocation } from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentSkillCatalog,
  createStandaloneRuntime,
} from "../src/index.js";

const directories: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body: string,
  resources: Readonly<Record<string, string>> = {},
): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
  for (const [relative, content] of Object.entries(resources)) {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AgentSkillCatalog", () => {
  it("discovers bounded user skills and requires explicit project trust", async () => {
    const root = await temporaryRoot("recurs-skills-");
    const home = path.join(root, "home");
    const data = path.join(home, ".recurs");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeSkill(
      path.join(home, ".agents", "skills"),
      "release-check",
      "Verify a release candidate",
      "Run the release checklist.",
      { "references/checklist.md": "Check tests and artifacts.\n" },
    );
    await writeSkill(
      path.join(workspace, ".recurs", "skills"),
      "release-check",
      "Verify this repository's release",
      "Use the repository release policy.",
    );

    const catalog = await AgentSkillCatalog.discover({
      cwd: workspace,
      dataDirectory: data,
      homeDirectory: home,
    });
    expect(catalog.snapshot()).toMatchObject({
      projectSkillsEnabled: false,
      skills: [{
        name: "release-check",
        description: "Verify a release candidate",
        source: "user",
        enabled: true,
      }, {
        name: "release-check",
        description: "Verify this repository's release",
        source: "project",
        enabled: false,
      }],
    });
    expect(catalog.contextInstructions().join("\n"))
      .toContain("Verify a release candidate");
    expect(catalog.contextInstructions().join("\n"))
      .not.toContain("repository's release");

    const tool = catalog.createTool();
    expect(JSON.stringify(tool.definition)).not.toContain("release-check");
    const user = await tool.execute(
      tool.parse({ name: "release-check", resource: "references/checklist.md" }),
      {
        sessionId: "session",
        cwd: workspace,
        signal: new AbortController().signal,
        executionMode: "act",
        readRevisions: new Map(),
      },
    );
    expect(JSON.parse(user.output)).toMatchObject({
      instructions: "Run the release checklist.",
      resource: {
        path: "references/checklist.md",
        content: "Check tests and artifacts.\n",
      },
    });

    catalog.setProjectEnabled(true);
    expect(catalog.snapshot()).toMatchObject({
      projectSkillsEnabled: true,
      skills: [{
        name: "release-check",
        description: "Verify a release candidate",
        source: "user",
        enabled: false,
      }, {
        name: "release-check",
        description: "Verify this repository's release",
        source: "project",
        enabled: true,
      }],
    });
    const project = await tool.execute(
      tool.parse({ name: "release-check" }),
      {
        sessionId: "session",
        cwd: workspace,
        signal: new AbortController().signal,
        executionMode: "act",
        readRevisions: new Map(),
      },
    );
    expect(JSON.parse(project.output)).toMatchObject({
      instructions: "Use the repository release policy.",
      source: "project",
    });
  });

  it("ignores malformed skills and rejects unlisted resource paths", async () => {
    const root = await temporaryRoot("recurs-skills-invalid-");
    const home = path.join(root, "home");
    const data = path.join(home, ".recurs");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeSkill(
      path.join(data, "skills"),
      "valid-skill",
      "A valid skill",
      "Follow the valid instructions.",
      { ".env": "SECRET=canary\n", "guide.md": "Safe guide.\n" },
    );
    const invalid = path.join(data, "skills", "Wrong_Name");
    await mkdir(invalid, { recursive: true });
    await writeFile(
      path.join(invalid, "SKILL.md"),
      "---\nname: other-name\ndescription: Invalid\n---\nNope\n",
    );

    const catalog = await AgentSkillCatalog.discover({
      cwd: workspace,
      dataDirectory: data,
      homeDirectory: home,
    });
    expect(catalog.snapshot().skills.map((skill) => skill.name))
      .toEqual(["valid-skill"]);
    expect(catalog.snapshot().warnings.join("\n")).toContain("Wrong_Name");
    const tool = catalog.createTool();
    const activated = await tool.execute(
      tool.parse({ name: "valid-skill" }),
      {
        sessionId: "session",
        cwd: workspace,
        signal: new AbortController().signal,
        executionMode: "act",
        readRevisions: new Map(),
      },
    );
    expect(JSON.parse(activated.output).resources).toEqual(["guide.md"]);
    expect(activated.output).not.toContain("canary");
    await expect(tool.execute(
      tool.parse({ name: "valid-skill", resource: "../outside.txt" }),
      {
        sessionId: "session",
        cwd: workspace,
        signal: new AbortController().signal,
        executionMode: "act",
        readRevisions: new Map(),
      },
    )).rejects.toThrow("not listed");
  });
});

describe("Agent Skills assembly", () => {
  it("gates project trust and exposes enabled skills to the real agent loop", async () => {
    const root = await temporaryRoot("recurs-skills-assembly-");
    const workspace = path.join(root, "workspace");
    const data = path.join(root, "data");
    await mkdir(workspace, { recursive: true });
    await writeSkill(
      path.join(workspace, ".agents", "skills"),
      "project-style",
      "Apply this project's style guide",
      "Prefer narrow, test-backed changes.",
    );
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "skill-call",
            name: "activate_skill",
            arguments: { name: "project-style" },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "Applied the project skill." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory: data, provider },
    );

    await expect(runtime.submit("/skills enable-project")).resolves.toMatchObject({
      type: "message",
      level: "error",
    });
    await expect(runtime.submit("/skills enable-project", {
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    } as never)).resolves.toMatchObject({
      type: "message",
      level: "error",
    });
    runtime.setConfirmHandler(async () => true);
    const localUser = createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    });
    await expect(runtime.submit("/skills enable-project", localUser)).resolves
      .toMatchObject({ type: "message", level: "info" });
    await expect(runtime.submit("Use the project style skill", localUser)).resolves
      .toMatchObject({ finalText: "Applied the project skill." });

    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .toContain("activate_skill");
    expect(provider.requests[0]?.messages[0]?.content)
      .toContain("Apply this project's style guide");
    expect(JSON.stringify(provider.requests[1]?.messages))
      .toContain("Prefer narrow, test-backed changes.");
  });
});
