import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  ToolError,
  type runProcess,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  GitWorktreeLeaseManager,
  type GitWorktreeLease,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", [...args], { cwd })).stdout.trim();
}

const fastGitRunner: typeof runProcess = async (command, args, options) => {
  if (options.signal?.aborted === true) {
    throw new ToolError("cancelled", `${command} was cancelled`);
  }
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      encoding: "utf8",
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

async function fixture(): Promise<{
  base: string;
  repository: string;
  leases: string;
  revision: string;
}> {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-worktree-leases-")),
  );
  directories.push(base);
  const repository = path.join(base, "repository");
  await mkdir(repository);
  await git(repository, ["init", "--quiet"]);
  await writeFile(path.join(repository, "tracked.txt"), "committed\n", "utf8");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, [
    "-c", "user.name=Recurs Tests",
    "-c", "user.email=tests@recurs.invalid",
    "commit", "--quiet", "-m", "initial",
  ]);
  return {
    base,
    repository,
    leases: path.join(base, "leases"),
    revision: await git(repository, ["rev-parse", "HEAD"]),
  };
}

function ids(...values: string[]): () => string {
  return () => {
    const next = values.shift();
    if (next === undefined) throw new Error("Test lease IDs exhausted");
    return next;
  };
}

function hasGitCommand(args: readonly string[], ...command: string[]): boolean {
  const start = args.findIndex((value) => value === command[0]);
  return start >= 0 && command.every((value, index) => args[start + index] === value);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("GitWorktreeLeaseManager", () => {
  it("leases the exact committed revision and removes a dirty lease idempotently", async () => {
    const { repository, leases, revision } = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("lease-a"),
      processRunner: fastGitRunner,
    });

    const lease = await manager.create(
      repository,
      new AbortController().signal,
    );

    expect(lease).toEqual({
      id: "lease-a",
      repositoryRoot: repository,
      worktreeRoot: path.join(leases, "lease-a"),
      revision,
    });
    expect(await readFile(path.join(lease.worktreeRoot, "tracked.txt"), "utf8"))
      .toBe("committed\n");
    expect(await git(lease.worktreeRoot, ["rev-parse", "HEAD"])).toBe(revision);
    await writeFile(path.join(lease.worktreeRoot, "artifact.txt"), "generated\n", "utf8");

    await manager.release(lease);
    await expect(access(lease.worktreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repository, ["worktree", "list", "--porcelain"]))
      .not.toContain(lease.worktreeRoot);
    await expect(manager.release(lease)).resolves.toBeUndefined();
  });

  it("rejects staged, modified, and untracked parent state before creating a lease", async () => {
    const cases = [
      async (repository: string) => {
        await writeFile(path.join(repository, "staged.txt"), "staged\n", "utf8");
        await git(repository, ["add", "staged.txt"]);
      },
      async (repository: string) => {
        await writeFile(path.join(repository, "tracked.txt"), "modified\n", "utf8");
      },
      async (repository: string) => {
        await writeFile(path.join(repository, "untracked.txt"), "untracked\n", "utf8");
      },
    ];
    for (const [index, mutate] of cases.entries()) {
      const { repository, leases } = await fixture();
      await mutate(repository);
      const manager = new GitWorktreeLeaseManager({
        rootDirectory: leases,
        createId: ids(`dirty-${index}`),
        processRunner: fastGitRunner,
      });

      await expect(manager.create(repository, new AbortController().signal))
        .rejects.toMatchObject({
          code: "permission_denied",
          message: "Parallel delegation requires a clean Git working tree",
        });
      await expect(access(path.join(leases, `dirty-${index}`)))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("does not copy ignored machine-local state into an otherwise clean lease", async () => {
    const { repository, leases } = await fixture();
    await writeFile(path.join(repository, ".gitignore"), "ignored.local\n", "utf8");
    await git(repository, ["add", ".gitignore"]);
    await git(repository, [
      "-c", "user.name=Recurs Tests",
      "-c", "user.email=tests@recurs.invalid",
      "commit", "--quiet", "-m", "ignore local state",
    ]);
    await writeFile(path.join(repository, "ignored.local"), "machine-only\n", "utf8");
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("ignored-state"),
      processRunner: fastGitRunner,
    });

    const lease = await manager.create(repository, new AbortController().signal);
    await expect(access(path.join(lease.worktreeRoot, "ignored.local")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await manager.release(lease);
  });

  it("creates distinct leases concurrently", async () => {
    const { repository, leases, revision } = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("parallel-a", "parallel-b"),
      processRunner: fastGitRunner,
    });

    const created = await Promise.all([
      manager.create(repository, new AbortController().signal),
      manager.create(repository, new AbortController().signal),
    ]);

    expect(created.map((lease) => lease.id).sort()).toEqual([
      "parallel-a",
      "parallel-b",
    ]);
    expect(created.every((lease) => lease.revision === revision)).toBe(true);
    await Promise.all(created.map((lease) => manager.release(lease)));
  });

  it("reserves lease IDs before asynchronous creation begins", async () => {
    const { repository, leases } = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("same-id", "same-id"),
      processRunner: fastGitRunner,
    });

    const settled = await Promise.allSettled([
      manager.create(repository, new AbortController().signal),
      manager.create(repository, new AbortController().signal),
    ]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<GitWorktreeLease> =>
        result.status === "fulfilled",
    );
    const rejected = settled.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await readFile(
      path.join(fulfilled[0]!.value.worktreeRoot, "tracked.txt"),
      "utf8",
    )).toBe("committed\n");
    await manager.release(fulfilled[0]!.value);
  });

  it("rejects hostile IDs, roots inside the repository, and forged releases", async () => {
    const { base, repository, leases } = await fixture();
    const hostile = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("../escape"),
      processRunner: fastGitRunner,
    });
    await expect(hostile.create(repository, new AbortController().signal))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(access(path.join(base, "escape"))).rejects.toMatchObject({ code: "ENOENT" });

    const nestedRoot = path.join(repository, ".recurs-worktrees");
    const nested = new GitWorktreeLeaseManager({
      rootDirectory: nestedRoot,
      createId: ids("nested"),
      processRunner: fastGitRunner,
    });
    await expect(nested.create(repository, new AbortController().signal))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(access(nestedRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("owned"),
      processRunner: fastGitRunner,
    });
    const lease = await manager.create(repository, new AbortController().signal);
    const forged: GitWorktreeLease = {
      ...lease,
      worktreeRoot: path.join(leases, "different"),
    };
    await expect(manager.release(forged)).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(manager.release({
      ...lease,
      repositoryRoot: undefined as never,
    })).rejects.toMatchObject({ code: "permission_denied" });
    expect(await readFile(path.join(lease.worktreeRoot, "tracked.txt"), "utf8"))
      .toBe("committed\n");
    await manager.release(lease);
  });

  it("honors pre-cancellation without leaving a target", async () => {
    const { repository, leases } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("pre-cancelled"),
      processRunner: fastGitRunner,
    });

    await expect(manager.create(repository, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(access(path.join(leases, "pre-cancelled")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a worktree created immediately before cancellation", async () => {
    const { repository, leases } = await fixture();
    let cancelAfterAdd = true;
    const processRunner: typeof runProcess = async (...args) => {
      const result = await fastGitRunner(...args);
      if (cancelAfterAdd && args[0] === "git" && hasGitCommand(args[1], "worktree", "add")) {
        cancelAfterAdd = false;
        throw new ToolError("cancelled", "git was cancelled");
      }
      return result;
    };
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("cancelled-after-add"),
      processRunner,
    });

    await expect(manager.create(repository, new AbortController().signal))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(await readdir(leases)).toEqual([]);
    expect(await git(repository, ["worktree", "list", "--porcelain"]))
      .not.toContain("cancelled-after-add");
  });

  it("surfaces cleanup failure and permits an exact retry", async () => {
    const { repository, leases } = await fixture();
    let failRemove = true;
    const processRunner: typeof runProcess = async (...args) => {
      if (failRemove && args[0] === "git" &&
        hasGitCommand(args[1], "worktree", "remove")) {
        throw new ToolError("process_failed", "injected cleanup failure");
      }
      return fastGitRunner(...args);
    };
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("retry-cleanup"),
      processRunner,
    });
    const lease = await manager.create(repository, new AbortController().signal);

    await expect(manager.release(lease)).rejects.toMatchObject({
      code: "process_failed",
      message: "Git worktree cleanup failed",
    });
    expect(await readFile(path.join(lease.worktreeRoot, "tracked.txt"), "utf8"))
      .toBe("committed\n");
    failRemove = false;
    await expect(manager.release(lease)).resolves.toBeUndefined();
  });
});
