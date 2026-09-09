import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import type { fetchPublicWeb } from "@recurs/tools";
import { createHostInvocation } from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import { createStandaloneRuntime } from "../src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { AgentSkillCatalog } from "../src/agent-skills.js";
import { downloadGithubSkill } from "../src/skill-source.js";
import { runCli } from "../src/process-host.js";

const roots: string[] = [];
async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-skill-lifecycle-")));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const dataDirectory = path.join(root, "home", ".recurs");
  const homeDirectory = path.join(root, "home");
  await mkdir(cwd);
  const input = { cwd, dataDirectory, homeDirectory };
  return { root, input, catalog: await AgentSkillCatalog.discover(input) };
}
async function skill(directory: string, instructions = "Check the release.") {
  await mkdir(path.join(directory, "references"), { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: release-check\ndescription: Verify the release\ncompatibility: Requires git and a Node.js project\nallowed-tools: Read Bash\n---\n${instructions}\n`);
  await writeFile(path.join(directory, "references", "check.md"), "Run the package verification.\n");
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("skill lifecycle", () => {
  it("preserves apostrophes in top-level skill source arguments", async () => {
    const { root, input } = await setup();
    const source = path.join(root, "Bob's-skills", "release-check");
    await skill(source);
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    const code = await runCli(["skills", "add", source], {
      stdout: stream, stderr: stream, interactive: true, automation: false,
      createRuntime: (events) => createStandaloneRuntime(events, { ...input, provider: new ScriptedProvider([]) }),
    });
    expect(code, output).toBe(0);
    expect(output).toContain("Added release-check");
    expect((await AgentSkillCatalog.discover(input)).snapshot().skills).toContainEqual(expect.objectContaining({ name: "release-check" }));
  });

  it("reports a missing model for top-level skill use instead of silently succeeding", async () => {
    const { root, input, catalog } = await setup();
    const source = path.join(root, "source", "release-check");
    await skill(source);
    await catalog.add(source);
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    const code = await runCli(["skills", "use", "release-check"], {
      stdout: stream, stderr: stream, interactive: true, automation: false,
      createRuntime: (events) => createStandaloneRuntime(events, { ...input, environment: {} }),
    });
    expect(code, output).toBe(1);
    expect(output).toContain("Connect a model before invoking an Agent Skill");
  });

  it("invokes a connected model for top-level skill use", async () => {
    const { root, input, catalog } = await setup();
    const source = path.join(root, "source", "release-check");
    await skill(source);
    await catalog.add(source);
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "Skill task handled." }, { type: "done", stopReason: "complete" }]]);
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    const code = await runCli(["skills", "use", "release-check", "Check this release"], {
      stdout: stream, stderr: stream, interactive: true, automation: false,
      createRuntime: (events) => createStandaloneRuntime(events, { ...input, provider }),
    });
    expect(code, output).toBe(0);
    expect(output).toContain("Skill task handled.");
    expect(provider.requests[0]?.messages).toContainEqual(expect.objectContaining({ role: "user", content: expect.stringContaining("Check this release") }));
  });

  it("copies a bundle, preserves resources, persists disable, and archives removal", async () => {
    const { root, input, catalog } = await setup();
    const source = path.join(root, "source", "release-check");
    await skill(source);
    await catalog.add(source);
    expect(await catalog.inspect("release-check")).toMatchObject({ enabled: true, resources: ["references/check.md"], compatibility: "Requires git and a Node.js project" });
    await catalog.setEnabled("release-check", false);
    const reopened = await AgentSkillCatalog.discover(input);
    expect((await reopened.inspect("release-check")).enabled).toBe(false);
    await reopened.setEnabled("release-check", true);
    const tool = reopened.createTool();
    const result = await tool.execute(tool.parse({ name: "release-check", resource: "references/check.md" }), {
      sessionId: "test", cwd: input.cwd, executionMode: "act", readRevisions: new Map(), signal: new AbortController().signal,
    });
    expect(JSON.parse(result.output).resource.content).toBe("Run the package verification.\n");
    const archive = await reopened.remove("release-check");
    expect(reopened.hasSkills).toBe(false);
    expect(await readFile(path.join(archive, "SKILL.md"), "utf8")).toContain("Check the release.");
    expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toContain("Check the release.");
  });

  it("keeps project installation untrusted and applies explicit per-scope preferences", async () => {
    const { root, catalog } = await setup();
    const source = path.join(root, "source", "release-check");
    await skill(source);
    await catalog.add(source, "user");
    await catalog.add(source, "project");
    expect((await catalog.inspect("release-check", "project")).enabled).toBe(false);
    catalog.setProjectEnabled(true);
    expect((await catalog.inspect("release-check", "project")).enabled).toBe(true);
    await catalog.setEnabled("release-check", false, "project");
    expect((await catalog.inspect("release-check", "user")).enabled).toBe(true);
    await catalog.refresh();
    expect(catalog.snapshot().projectSkillsEnabled).toBe(false);
  });

  it("rejects conflicts, symlink resources, and symlink installation roots", async () => {
    const { root, input, catalog } = await setup();
    const source = path.join(root, "source", "release-check");
    await skill(source);
    await catalog.add(source);
    await expect(catalog.add(source)).rejects.toThrow("already exists");
    await catalog.remove("release-check");
    await symlink(path.join(source, "SKILL.md"), path.join(source, "linked.md"));
    await expect(catalog.add(source)).rejects.toThrow("symlink");
    await rm(path.join(source, "linked.md"));
    await rm(path.join(input.dataDirectory, "skills"), { recursive: true });
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(input.dataDirectory, "skills"));
    await expect(catalog.add(source)).rejects.toThrow("canonical");
  });

  it("adds the first skill in a running CLI and routes explicit use through the model tool", async () => {
    const { root, input } = await setup();
    const source = path.join(root, 'source with "quotes" and \\ backslash', "release-check");
    await skill(source);
    const provider = new ScriptedProvider([
      [{ type: "tool_call", call: { id: "load", name: "activate_skill", arguments: { name: "release-check" } } }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", text: "Release checked." }, { type: "done", stopReason: "complete" }],
    ]);
    const runtime = await createStandaloneRuntime({ async emit() {} }, { cwd: input.cwd, dataDirectory: input.dataDirectory, provider });
    const invocation = createHostInvocation({ invocation: "repl", userPresent: true, remote: false, scripted: false, embedding: "cli" });
    runtime.setConfirmHandler(async () => true);
    await expect(runtime.submit(`/skills add ${JSON.stringify(source)}`, invocation)).resolves.toMatchObject({ type: "message", level: "info" });
    await expect(runtime.submit("/skills use release-check Check this release", invocation)).resolves.toMatchObject({ finalText: "Release checked." });
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain("activate_skill");
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("Check the release.");
  });

  it("reports declared missing executables without running or installing them", async () => {
    const { root, catalog } = await setup();
    const source = path.join(root, "source", "release-check");
    await skill(source);
    await writeFile(path.join(source, "SKILL.md"), "---\nname: release-check\ndescription: Check release\nmetadata:\n  recurs-required-binaries: recurs-missing-fixture-tool-9271\n---\nCheck it.\n");
    await catalog.add(source);
    expect((await catalog.inspect("release-check")).diagnostics.join("\n")).toContain("Missing executable: recurs-missing-fixture-tool-9271");
  });

  it("never deletes a discovered skill managed by another application", async () => {
    const { input } = await setup();
    await skill(path.join(input.homeDirectory, ".agents", "skills", "release-check"));
    const catalog = await AgentSkillCatalog.discover(input);
    await expect(catalog.remove("release-check")).rejects.toThrow("managed outside Recurs");
  });

  it("installs bounded HTTPS content and rejects credential-bearing sources", async () => {
    const { catalog } = await setup();
    const content = "---\nname: release-check\ndescription: Check a release\n---\nDo the checks.\n";
    const fetch: typeof fetchPublicWeb = async (url, options) => {
      expect(options.maxRedirects).toBe(0);
      return { requestedUrl: url, finalUrl: url, status: 200, headers: {}, body: Buffer.from(content), redirects: 0 };
    };
    await expect(catalog.install("https://skills.example.com/release-check/SKILL.md", "user", fetch)).resolves.toContain("SHA-256");
    await expect(catalog.install("https://secret@example.com/SKILL.md", "user", fetch)).rejects.toThrow("without credentials");
  });
});

function githubFixture(mode = "100644") {
  const document = Buffer.from("---\nname: release-check\ndescription: Verify a release\n---\nRead references/check.md.\n");
  const reference = Buffer.from("Run the external verifier.\n");
  const blobId = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const commit = "a".repeat(40), root = "b".repeat(40), selected = "c".repeat(40), refs = "d".repeat(40);
  const objects: Record<string, unknown> = {
    "commits/main": { sha: commit, commit: { tree: { sha: root } } },
    [`git/trees/${root}`]: { sha: root, tree: [{ path: "release-check", mode: "040000", type: "tree", sha: selected }] },
    [`git/trees/${selected}`]: { sha: selected, tree: [
      { path: "SKILL.md", mode, type: "blob", sha: blobId(document) },
      { path: "references", mode: "040000", type: "tree", sha: refs },
    ] },
    [`git/trees/${refs}`]: { sha: refs, tree: [{ path: "check.md", mode: "100644", type: "blob", sha: blobId(reference) }] },
    ...Object.fromEntries([document, reference].map((bytes) => [`git/blobs/${blobId(bytes)}`, { sha: blobId(bytes), size: bytes.length, encoding: "base64", content: bytes.toString("base64") }])),
  };
  const fetch: typeof fetchPublicWeb = async (url) => {
    const value = objects[url.replace("https://api.github.com/repos/example/skills/", "")];
    if (!value) throw new Error(`Unexpected fixture request: ${url}`);
    return { requestedUrl: url, finalUrl: url, status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)), redirects: 0 };
  };
  return { fetch, commit };
}

describe("explicit GitHub source", () => {
  it("resolves a ref to a commit, installs verified resources, and records provenance", async () => {
    const { catalog, input } = await setup();
    const { fetch, commit } = githubFixture();
    await expect(catalog.install("github:example/skills@main:release-check", "user", fetch)).resolves.toContain(commit);
    expect((await catalog.inspect("release-check")).resources).toEqual(["references/check.md"]);
    const provenance = JSON.parse(await readFile(path.join(input.dataDirectory, "skills", ".sources", "release-check.json"), "utf8"));
    expect(provenance).toMatchObject({ repository: "example/skills", commit, requestedRef: "main" });
    await catalog.remove("release-check");
    await expect(catalog.install("github:example/skills@main:release-check", "user", fetch)).resolves.toContain(commit);
  });
  it("rejects Git symlinks and path traversal before extraction", async () => {
    await expect(downloadGithubSkill("github:example/skills@main:release-check", githubFixture("120000").fetch)).rejects.toThrow("symlink");
    await expect(downloadGithubSkill("github:example/skills@main:../release-check", githubFixture().fetch)).rejects.toThrow("invalid");
  });
});
