import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PROJECT_INSTRUCTION_BYTES,
  ProjectInstructionsError,
  createProjectInstructions,
  discoverProjectInstructions,
  projectContextInstructions,
  renderProjectInstructions,
} from "../src/project-instructions.js";

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("project instructions", () => {
  it("loads root-to-cwd instructions and prefers a local override", async () => {
    const project = await root("recurs-project-instructions-");
    const nested = path.join(project, "packages", "app");
    await mkdir(path.join(project, ".git"));
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(project, "AGENTS.md"), "root policy\n");
    await writeFile(path.join(nested, "AGENTS.md"), "ignored local policy\n");
    await writeFile(
      path.join(nested, "AGENTS.override.md"),
      "override policy\n",
    );

    expect(await discoverProjectInstructions(nested)).toEqual([
      { source: "AGENTS.md", contents: "root policy\n" },
      {
        source: path.join("packages", "app", "AGENTS.override.md"),
        contents: "override policy\n",
      },
    ]);
    expect((await projectContextInstructions(nested)).join("\n"))
      .toContain("override policy");
  });

  it("does not traverse parents when no project marker exists", async () => {
    const parent = await root("recurs-unmarked-instructions-");
    const cwd = path.join(parent, "workspace");
    await mkdir(cwd);
    await writeFile(path.join(parent, "AGENTS.md"), "outside\n");

    expect(await discoverProjectInstructions(cwd)).toEqual([]);
  });

  it("rejects symlinks, invalid UTF-8, and an aggregate over the byte limit", async () => {
    const project = await root("recurs-invalid-instructions-");
    await mkdir(path.join(project, ".git"));
    const target = path.join(project, "target.md");
    await writeFile(target, "target\n");
    await symlink(target, path.join(project, "AGENTS.md"));
    await expect(discoverProjectInstructions(project)).rejects.toMatchObject({
      code: "invalid",
    });

    await rm(path.join(project, "AGENTS.md"));
    await writeFile(path.join(project, "AGENTS.md"), Buffer.from([0xff]));
    await expect(discoverProjectInstructions(project)).rejects.toBeInstanceOf(
      ProjectInstructionsError,
    );

    await writeFile(
      path.join(project, "AGENTS.md"),
      "x".repeat(MAX_PROJECT_INSTRUCTION_BYTES + 1),
    );
    await expect(discoverProjectInstructions(project)).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("creates a bounded project brief once and never overwrites it", async () => {
    const project = await root("recurs-create-instructions-");
    expect(await createProjectInstructions(project, {
      purpose: "Build a reliable coding harness.",
      notes: "Run npm test before shipping.",
    })).toBe("created");
    const first = await readFile(path.join(project, "AGENTS.md"), "utf8");
    expect(first).toContain("Build a reliable coding harness.");
    expect(first).toContain("Run npm test before shipping.");

    expect(await createProjectInstructions(project, {
      purpose: "overwrite",
    })).toBe("exists");
    expect(await readFile(path.join(project, "AGENTS.md"), "utf8"))
      .toBe(first);
    expect(() => renderProjectInstructions({ purpose: "\0" }))
      .toThrowError(ProjectInstructionsError);

    const invalid = await root("recurs-invalid-brief-");
    await expect(createProjectInstructions(invalid, { purpose: "\0" }))
      .rejects.toBeInstanceOf(ProjectInstructionsError);
    await expect(readFile(path.join(invalid, "AGENTS.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
