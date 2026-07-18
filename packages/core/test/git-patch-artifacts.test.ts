import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  FileCheckpointStore,
  ToolError,
  type runProcess,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileGitPatchArtifactStore,
  GitPatchArtifactManager,
  GitWorktreeLeaseManager,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

const fastGitRunner: typeof runProcess = async (command, args, options) => {
  if (options.signal?.aborted === true) {
    throw new ToolError("cancelled", `${command} was cancelled`);
  }
  try {
    const processOptions = {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      encoding: "utf8" as const,
    };
    const result = options.stdin === undefined
      ? await execFileAsync(command, [...args], processOptions)
      : await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const child = execFile(
            command,
            [...args],
            processOptions,
            (error, stdout, stderr) => {
              if (error !== null) {
                reject(Object.assign(error, { stdout, stderr }));
              } else {
                resolve({ stdout, stderr });
              }
            },
          );
          child.stdin?.end(options.stdin);
        });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new ToolError("cancelled", `${command} was cancelled`, { cause: error });
    }
    const exitCode = typeof error === "object" && error !== null &&
      "code" in error && typeof error.code === "number"
      ? error.code
      : -1;
    const acceptable = options.acceptableExitCodes ?? [0];
    if (acceptable.includes(exitCode)) {
      const stdout = typeof error === "object" && error !== null &&
        "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error === "object" && error !== null &&
        "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      return { stdout, stderr, exitCode };
    }
    throw new ToolError("process_failed", `${command} exited with ${exitCode}`, {
      cause: error,
    });
  }
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", [...args], { cwd })).stdout.trim();
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-patch-artifact-")),
  );
  directories.push(root);
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await git(repository, ["init", "--quiet"]);
  await writeFile(path.join(repository, "edit.txt"), "before\n", "utf8");
  await writeFile(path.join(repository, "delete.txt"), "delete me\n", "utf8");
  await git(repository, ["add", "edit.txt", "delete.txt"]);
  await git(repository, [
    "-c", "user.name=Recurs Tests",
    "-c", "user.email=tests@recurs.invalid",
    "commit", "--quiet", "-m", "initial",
  ]);
  const revision = await git(repository, ["rev-parse", "HEAD"]);
  let leaseId = 0;
  let patchId = 0;
  const worktrees = new GitWorktreeLeaseManager({
    rootDirectory: path.join(root, "worktrees"),
    createId: () => `lease-${++leaseId}`,
    processRunner: fastGitRunner,
  });
  const lease = await worktrees.create(
    repository,
    new AbortController().signal,
  );
  const artifactDirectory = path.join(root, "artifacts");
  const artifactStore = new FileGitPatchArtifactStore(artifactDirectory);
  const artifacts = new GitPatchArtifactManager({
    createId: () => `patch-${++patchId}`,
    processRunner: fastGitRunner,
    store: artifactStore,
  });
  const checkpoints = new FileCheckpointStore(path.join(root, "checkpoints"));
  return {
    root,
    repository,
    revision,
    worktrees,
    lease,
    artifacts,
    artifactStore,
    artifactDirectory,
    checkpoints,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("GitPatchArtifactManager", () => {
  it("preflights an exact clean parent and captures deterministic text changes", async () => {
    const setup = await fixture();
    const signal = new AbortController().signal;
    await writeFile(path.join(setup.lease.worktreeRoot, "edit.txt"), "after\n", "utf8");
    await rm(path.join(setup.lease.worktreeRoot, "delete.txt"));
    await writeFile(path.join(setup.lease.worktreeRoot, "added.txt"), "added\n", "utf8");

    await expect(setup.artifacts.preflightParent(setup.repository, signal))
      .resolves.toEqual({
        repositoryRoot: setup.repository,
        revision: setup.revision,
      });
    const artifact = await setup.artifacts.capture(setup.lease, signal);

    expect(artifact).toEqual({
      id: "patch-1",
      leaseId: setup.lease.id,
      baseRevision: setup.revision,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      byteLength: expect.any(Number),
      paths: ["added.txt", "delete.txt", "edit.txt"],
    });
    expect(artifact?.byteLength).toBeGreaterThan(0);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact?.paths)).toBe(true);
    expect(artifact).not.toHaveProperty("patch");
    if (artifact === null) throw new Error("expected artifact");
    await expect(setup.artifactStore.load(artifact)).resolves.toMatchObject({
      repositoryRoot: setup.repository,
      after: [
        {
          path: "added.txt",
          kind: "file",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          byteLength: 6,
          mode: "100644",
        },
        { path: "delete.txt", kind: "deleted" },
        {
          path: "edit.txt",
          kind: "file",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          byteLength: 6,
          mode: "100644",
        },
      ],
    });
    expect(await readFile(path.join(setup.repository, "edit.txt"), "utf8"))
      .toBe("before\n");
    await setup.worktrees.release(setup.lease);
  });

  it("returns null for an unchanged owned worktree", async () => {
    const setup = await fixture();

    await expect(setup.artifacts.capture(
      setup.lease,
      new AbortController().signal,
    )).resolves.toBeNull();
    await setup.worktrees.release(setup.lease);
  });

  it("fails closed for dirty parents, revision drift, and cancellation", async () => {
    const setup = await fixture();
    await writeFile(path.join(setup.repository, "untracked.txt"), "dirty\n", "utf8");
    await expect(setup.artifacts.preflightParent(
      setup.repository,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: "Team implementation requires a clean Git working tree",
    });
    await rm(path.join(setup.repository, "untracked.txt"));
    await git(setup.repository, ["commit", "--allow-empty", "-m", "drift"]);
    await expect(setup.artifacts.capture(
      setup.lease,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: "The parent Git revision changed during team implementation",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(setup.artifacts.preflightParent(setup.repository, controller.signal))
      .rejects.toMatchObject({ code: "cancelled" });
    await setup.worktrees.release(setup.lease);
  });

  it.each([
    ["credential path", async (root: string) => {
      await writeFile(path.join(root, ".env"), "PLACEHOLDER=value\n", "utf8");
    }, "Credential paths"],
    ["ambiguous path", async (root: string) => {
      await writeFile(path.join(root, "ambiguous\nname.txt"), "text\n", "utf8");
    }, "unambiguous"],
    ["symbolic link", async (root: string) => {
      await symlink("edit.txt", path.join(root, "link.txt"));
    }, "symbolic links"],
    ["mode change", async (root: string) => {
      await chmod(path.join(root, "edit.txt"), 0o755);
    }, "file-mode changes"],
    ["binary content", async (root: string) => {
      await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    }, "Binary patches"],
    ["oversized patch", async (root: string) => {
      await writeFile(path.join(root, "large.txt"), "x".repeat(1_100_000), "utf8");
    }, "Patch exceeds"],
  ] as const)("rejects unsafe %s", async (_name, mutate, message) => {
    const setup = await fixture();
    await mutate(setup.lease.worktreeRoot);

    await expect(setup.artifacts.capture(
      setup.lease,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining(message),
    });
    await setup.worktrees.release(setup.lease);
  });

  it("rejects a Git submodule change", async () => {
    const setup = await fixture();
    const moduleSource = path.join(setup.root, "module-source");
    await mkdir(moduleSource);
    await git(moduleSource, ["init", "--quiet"]);
    await writeFile(path.join(moduleSource, "module.txt"), "module\n", "utf8");
    await git(moduleSource, ["add", "module.txt"]);
    await git(moduleSource, [
      "-c", "user.name=Recurs Tests",
      "-c", "user.email=tests@recurs.invalid",
      "commit", "--quiet", "-m", "module",
    ]);
    await git(setup.lease.worktreeRoot, [
      "-c", "protocol.file.allow=always",
      "submodule", "add", "--quiet", moduleSource, "module",
    ]);

    await expect(setup.artifacts.capture(
      setup.lease,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("submodules"),
    });
    await setup.worktrees.release(setup.lease);
  });

  it("integrates owned artifacts in input order and records one transaction checkpoint", async () => {
    const setup = await fixture();
    const signal = new AbortController().signal;
    const base = await setup.artifacts.preflightParent(setup.repository, signal);
    const secondLease = await setup.worktrees.create(setup.repository, signal);
    await writeFile(path.join(setup.lease.worktreeRoot, "edit.txt"), "first patch\n", "utf8");
    await writeFile(path.join(secondLease.worktreeRoot, "second.txt"), "second patch\n", "utf8");
    const first = await setup.artifacts.capture(setup.lease, signal);
    const second = await setup.artifacts.capture(secondLease, signal);
    if (first === null || second === null) throw new Error("expected artifacts");
    await setup.worktrees.release(setup.lease);
    await setup.worktrees.release(secondLease);

    const outcome = await setup.artifacts.integrate({
      base,
      artifacts: [first, second],
      sessionId: "parent-session",
      operationId: "team-integration-1",
      checkpoints: setup.checkpoints,
      signal,
    });

    expect(outcome).toEqual({
      ok: true,
      artifactIds: ["patch-1", "patch-2"],
      changedFiles: ["edit.txt", "second.txt"],
      checkpointId: expect.any(String),
    });
    expect(await readFile(path.join(setup.repository, "edit.txt"), "utf8"))
      .toBe("first patch\n");
    expect(await readFile(path.join(setup.repository, "second.txt"), "utf8"))
      .toBe("second patch\n");
  }, 30_000);

  it("loads and integrates a captured artifact after the manager restarts", async () => {
    const setup = await fixture();
    const signal = new AbortController().signal;
    const base = await setup.artifacts.preflightParent(setup.repository, signal);
    await writeFile(path.join(setup.lease.worktreeRoot, "edit.txt"), "durable\n", "utf8");
    const artifact = await setup.artifacts.capture(setup.lease, signal);
    if (artifact === null) throw new Error("expected artifact");
    await setup.worktrees.release(setup.lease);

    const restarted = new GitPatchArtifactManager({
      processRunner: fastGitRunner,
      store: new FileGitPatchArtifactStore(setup.artifactDirectory),
    });
    const outcome = await restarted.integrate({
      base,
      artifacts: [artifact],
      sessionId: "parent-session",
      operationId: "team-integration-restarted",
      checkpoints: setup.checkpoints,
      signal,
    });

    expect(outcome).toMatchObject({
      ok: true,
      artifactIds: [artifact.id],
      changedFiles: ["edit.txt"],
    });
    expect(await readFile(path.join(setup.repository, "edit.txt"), "utf8"))
      .toBe("durable\n");
  }, 30_000);

  it("rolls every integrated patch back when a later patch conflicts", async () => {
    const setup = await fixture();
    const signal = new AbortController().signal;
    const base = await setup.artifacts.preflightParent(setup.repository, signal);
    const secondLease = await setup.worktrees.create(setup.repository, signal);
    await writeFile(path.join(setup.lease.worktreeRoot, "edit.txt"), "first version\n", "utf8");
    await writeFile(path.join(secondLease.worktreeRoot, "edit.txt"), "conflicting version\n", "utf8");
    const first = await setup.artifacts.capture(setup.lease, signal);
    const second = await setup.artifacts.capture(secondLease, signal);
    if (first === null || second === null) throw new Error("expected artifacts");
    await setup.worktrees.release(setup.lease);
    await setup.worktrees.release(secondLease);

    const outcome = await setup.artifacts.integrate({
      base,
      artifacts: [first, second],
      sessionId: "parent-session",
      operationId: "team-integration-conflict",
      checkpoints: setup.checkpoints,
      signal,
    });

    expect(outcome).toEqual({
      ok: false,
      code: "patch_failed",
      message: "A child patch conflicted with earlier team changes",
      artifactId: "patch-2",
      integratedArtifactIds: ["patch-1"],
      rolledBack: true,
      restored: ["edit.txt"],
      deleted: [],
    });
    expect(await readFile(path.join(setup.repository, "edit.txt"), "utf8"))
      .toBe("before\n");
    expect((await git(setup.repository, ["status", "--porcelain"]))).toBe("");
    await expect(setup.artifacts.integrate({
      base,
      artifacts: [first, second],
      sessionId: "parent-session",
      operationId: "team-integration-reuse",
      checkpoints: setup.checkpoints,
      signal,
    })).rejects.toMatchObject({
      code: "permission_denied",
      message: "The patch artifact handle is not owned by this workflow",
    });
  }, 30_000);

  it("rejects parent drift, unexpected dirt, cancellation, and tampered handles", async () => {
    const cases = [
      async (setup: Awaited<ReturnType<typeof fixture>>, base: {
        repositoryRoot: string;
        revision: string;
      }, artifact: NonNullable<Awaited<ReturnType<GitPatchArtifactManager["capture"]>>>) => {
        await git(setup.repository, [
          "-c", "user.name=Recurs Tests",
          "-c", "user.email=tests@recurs.invalid",
          "commit", "--allow-empty", "--quiet", "-m", "drift",
        ]);
        await expect(setup.artifacts.integrate({
          base,
          artifacts: [artifact],
          sessionId: "parent-session",
          operationId: "drift",
          checkpoints: setup.checkpoints,
          signal: new AbortController().signal,
        })).rejects.toMatchObject({ code: "permission_denied" });
      },
      async (setup: Awaited<ReturnType<typeof fixture>>, base: {
        repositoryRoot: string;
        revision: string;
      }, artifact: NonNullable<Awaited<ReturnType<GitPatchArtifactManager["capture"]>>>) => {
        await writeFile(path.join(setup.repository, "foreign.txt"), "foreign\n", "utf8");
        await expect(setup.artifacts.integrate({
          base,
          artifacts: [artifact],
          sessionId: "parent-session",
          operationId: "dirty",
          checkpoints: setup.checkpoints,
          signal: new AbortController().signal,
        })).rejects.toMatchObject({
          code: "permission_denied",
          message: "The parent workspace changed before patch integration",
        });
      },
      async (setup: Awaited<ReturnType<typeof fixture>>, base: {
        repositoryRoot: string;
        revision: string;
      }, artifact: NonNullable<Awaited<ReturnType<GitPatchArtifactManager["capture"]>>>) => {
        const controller = new AbortController();
        controller.abort();
        await expect(setup.artifacts.integrate({
          base,
          artifacts: [artifact],
          sessionId: "parent-session",
          operationId: "cancelled",
          checkpoints: setup.checkpoints,
          signal: controller.signal,
        })).rejects.toMatchObject({ code: "cancelled" });
      },
      async (setup: Awaited<ReturnType<typeof fixture>>, base: {
        repositoryRoot: string;
        revision: string;
      }, artifact: NonNullable<Awaited<ReturnType<GitPatchArtifactManager["capture"]>>>) => {
        await expect(setup.artifacts.integrate({
          base,
          artifacts: [{ ...artifact, sha256: "0".repeat(64) }],
          sessionId: "parent-session",
          operationId: "tampered",
          checkpoints: setup.checkpoints,
          signal: new AbortController().signal,
        })).rejects.toMatchObject({
          code: "permission_denied",
          message: "The patch artifact handle is not owned by this workflow",
        });
      },
    ];
    for (const run of cases) {
      const setup = await fixture();
      const signal = new AbortController().signal;
      const base = await setup.artifacts.preflightParent(setup.repository, signal);
      await writeFile(path.join(setup.lease.worktreeRoot, "edit.txt"), "child\n", "utf8");
      const artifact = await setup.artifacts.capture(setup.lease, signal);
      if (artifact === null) throw new Error("expected artifact");
      await setup.worktrees.release(setup.lease);
      await run(setup, base, artifact);
    }
  }, 60_000);
});
