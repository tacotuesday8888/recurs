import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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

  it("holds a private owner lock for the full lease and blocks live recovery", async () => {
    const { repository, leases } = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("owned-live"),
      processRunner: fastGitRunner,
    });
    const lease = await manager.create(repository, new AbortController().signal);
    const lock = path.join(leases, ".owners", `${lease.id}.lock`);
    const owner = path.join(lock, "owner.json");

    await expect(manager.assertActive(lease)).resolves.toBeUndefined();
    expect((await lstat(leases)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(leases, ".owners"))).mode & 0o777).toBe(0o700);
    expect((await lstat(lock)).mode & 0o777).toBe(0o700);
    expect((await lstat(owner)).mode & 0o777).toBe(0o600);

    const restarted = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      processRunner: fastGitRunner,
    });
    await expect(restarted.assertActive(lease))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(restarted.recoverStale({ repositoryRoot: repository }))
      .resolves.toEqual({ removedLeaseIds: [], busyLeaseIds: [lease.id] });
    expect(await readFile(path.join(lease.worktreeRoot, "tracked.txt"), "utf8"))
      .toBe("committed\n");

    await manager.release(lease);
    await expect(access(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an exactly registered worktree after its owner dies", async () => {
    const { repository, leases } = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("dead-owner"),
      processRunner: fastGitRunner,
    });
    const lease = await manager.create(repository, new AbortController().signal);
    const owner = path.join(
      leases,
      ".owners",
      `${lease.id}.lock`,
      "owner.json",
    );
    const record = JSON.parse(await readFile(owner, "utf8")) as Record<string, unknown>;
    await writeFile(owner, `${JSON.stringify({
      ...record,
      pid: 2_147_483_647,
    })}\n`, { mode: 0o600 });

    const restarted = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      processRunner: fastGitRunner,
    });
    await expect(restarted.recoverStale({ repositoryRoot: repository }))
      .resolves.toEqual({ removedLeaseIds: [lease.id], busyLeaseIds: [] });
    await expect(access(lease.worktreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(restarted.recoverStale({ repositoryRoot: repository }))
      .resolves.toEqual({ removedLeaseIds: [], busyLeaseIds: [] });
  });

  it("allows only one concurrent recovery to claim a dead owner", async () => {
    const { repository, leases } = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("contended-dead-owner"),
      processRunner: fastGitRunner,
    });
    const lease = await manager.create(repository, new AbortController().signal);
    const owner = path.join(
      leases,
      ".owners",
      `${lease.id}.lock`,
      "owner.json",
    );
    const record = JSON.parse(await readFile(owner, "utf8")) as Record<string, unknown>;
    await writeFile(owner, `${JSON.stringify({
      ...record,
      pid: 2_147_483_647,
    })}\n`, { mode: 0o600 });
    const first = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      processRunner: fastGitRunner,
    });
    const second = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      processRunner: fastGitRunner,
    });

    const outcomes = await Promise.all([
      first.recoverStale({ repositoryRoot: repository }),
      second.recoverStale({ repositoryRoot: repository }),
    ]);

    expect(outcomes.flatMap((outcome) => outcome.removedLeaseIds))
      .toEqual([lease.id]);
    await expect(access(lease.worktreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(leases, ".owners", `${lease.id}.lock`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves registered worktrees without a matching Recurs owner binding", async () => {
    const missing = await fixture();
    const prepare = new GitWorktreeLeaseManager({
      rootDirectory: missing.leases,
      createId: ids("prepare-owner-root"),
      processRunner: fastGitRunner,
    });
    const prepared = await prepare.create(
      missing.repository,
      new AbortController().signal,
    );
    await prepare.release(prepared);
    const manual = path.join(missing.leases, "manual-worktree");
    await git(missing.repository, [
      "worktree", "add", "--detach", manual, missing.revision,
    ]);

    await expect(prepare.recoverStale({ repositoryRoot: missing.repository }))
      .resolves.toEqual({ removedLeaseIds: [], busyLeaseIds: [] });
    expect(await readFile(path.join(manual, "tracked.txt"), "utf8"))
      .toBe("committed\n");

    const mismatch = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: mismatch.leases,
      createId: ids("mismatched-owner"),
      processRunner: fastGitRunner,
    });
    const lease = await manager.create(
      mismatch.repository,
      new AbortController().signal,
    );
    const owner = path.join(
      mismatch.leases,
      ".owners",
      `${lease.id}.lock`,
      "owner.json",
    );
    const record = JSON.parse(await readFile(owner, "utf8")) as Record<string, unknown>;
    await writeFile(owner, `${JSON.stringify({
      ...record,
      repositoryRoot: path.join(mismatch.base, "different-repository"),
      revision: "b".repeat(40),
      pid: 2_147_483_647,
    })}\n`, { mode: 0o600 });
    const restarted = new GitWorktreeLeaseManager({
      rootDirectory: mismatch.leases,
      processRunner: fastGitRunner,
    });

    await expect(restarted.recoverStale({ repositoryRoot: mismatch.repository }))
      .resolves.toEqual({ removedLeaseIds: [], busyLeaseIds: [] });
    expect(await readFile(path.join(lease.worktreeRoot, "tracked.txt"), "utf8"))
      .toBe("committed\n");
  });

  it("fails closed when owner storage becomes permissive or symlinked", async () => {
    const permissive = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: permissive.leases,
      createId: ids("unsafe-owner-root"),
      processRunner: fastGitRunner,
    });
    const lease = await manager.create(
      permissive.repository,
      new AbortController().signal,
    );
    await chmod(path.join(permissive.leases, ".owners"), 0o755);
    await expect(manager.assertActive(lease))
      .rejects.toMatchObject({ code: "permission_denied" });

    const linked = await fixture();
    const linkedManager = new GitWorktreeLeaseManager({
      rootDirectory: linked.leases,
      createId: ids("unsafe-owner-file"),
      processRunner: fastGitRunner,
    });
    const linkedLease = await linkedManager.create(
      linked.repository,
      new AbortController().signal,
    );
    const canary = path.join(linked.base, "owner-canary.json");
    await writeFile(canary, "do not touch\n", "utf8");
    const owner = path.join(
      linked.leases,
      ".owners",
      `${linkedLease.id}.lock`,
      "owner.json",
    );
    await rm(owner);
    await symlink(canary, owner);
    await expect(linkedManager.assertActive(linkedLease))
      .rejects.toMatchObject({ code: "permission_denied" });
    expect(await readFile(canary, "utf8")).toBe("do not touch\n");
  });

  it("rejects drifted, unregistered, and symlink-swapped active targets", async () => {
    const drifted = await fixture();
    const driftManager = new GitWorktreeLeaseManager({
      rootDirectory: drifted.leases,
      createId: ids("drifted-head"),
      processRunner: fastGitRunner,
    });
    const driftLease = await driftManager.create(
      drifted.repository,
      new AbortController().signal,
    );
    await git(driftLease.worktreeRoot, [
      "-c", "user.name=Recurs Tests",
      "-c", "user.email=tests@recurs.invalid",
      "commit", "--allow-empty", "--quiet", "-m", "drift",
    ]);
    await expect(driftManager.assertActive(driftLease))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(driftManager.release(driftLease)).resolves.toBeUndefined();
    await expect(access(driftLease.worktreeRoot))
      .rejects.toMatchObject({ code: "ENOENT" });

    const unregistered = await fixture();
    const unregisteredManager = new GitWorktreeLeaseManager({
      rootDirectory: unregistered.leases,
      createId: ids("unregistered"),
      processRunner: fastGitRunner,
    });
    const unregisteredLease = await unregisteredManager.create(
      unregistered.repository,
      new AbortController().signal,
    );
    await git(unregistered.repository, [
      "worktree", "remove", "--force", unregisteredLease.worktreeRoot,
    ]);
    await expect(unregisteredManager.assertActive(unregisteredLease))
      .rejects.toMatchObject({ code: "permission_denied" });

    const swapped = await fixture();
    const swappedManager = new GitWorktreeLeaseManager({
      rootDirectory: swapped.leases,
      createId: ids("swapped-target"),
      processRunner: fastGitRunner,
    });
    const swappedLease = await swappedManager.create(
      swapped.repository,
      new AbortController().signal,
    );
    await git(swapped.repository, [
      "worktree", "remove", "--force", swappedLease.worktreeRoot,
    ]);
    const outside = path.join(swapped.base, "outside-target");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(path.join(outside, "canary"), "untouched\n", "utf8");
    await symlink(outside, swappedLease.worktreeRoot);
    await expect(swappedManager.assertActive(swappedLease))
      .rejects.toMatchObject({ code: "permission_denied" });
    expect(await readFile(path.join(outside, "canary"), "utf8"))
      .toBe("untouched\n");
  }, 30_000);

  it("leaves unregistered direct children untouched during stale recovery", async () => {
    const { repository, leases } = await fixture();
    const manager = new GitWorktreeLeaseManager({
      rootDirectory: leases,
      createId: ids("prepare-recovery-root"),
      processRunner: fastGitRunner,
    });
    const lease = await manager.create(repository, new AbortController().signal);
    await manager.release(lease);
    const unregistered = path.join(leases, "unregistered-child");
    await mkdir(unregistered, { mode: 0o700 });
    await writeFile(path.join(unregistered, "canary"), "untouched\n", "utf8");

    await expect(manager.recoverStale({ repositoryRoot: repository }))
      .resolves.toEqual({ removedLeaseIds: [], busyLeaseIds: [] });
    expect(await readFile(path.join(unregistered, "canary"), "utf8"))
      .toBe("untouched\n");
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

  it("rejects roots that contain the repository or are permissive or symlinked", async () => {
    const containing = await fixture();
    const containsRepository = new GitWorktreeLeaseManager({
      rootDirectory: containing.base,
      createId: ids("contains-repository"),
      processRunner: fastGitRunner,
    });
    await expect(containsRepository.create(
      containing.repository,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "permission_denied" });

    const permissive = await fixture();
    await mkdir(permissive.leases, { mode: 0o755 });
    await chmod(permissive.leases, 0o755);
    const permissiveManager = new GitWorktreeLeaseManager({
      rootDirectory: permissive.leases,
      createId: ids("permissive"),
      processRunner: fastGitRunner,
    });
    await expect(permissiveManager.create(
      permissive.repository,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "permission_denied" });

    const linked = await fixture();
    const outside = path.join(linked.base, "outside-leases");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, linked.leases);
    const linkedManager = new GitWorktreeLeaseManager({
      rootDirectory: linked.leases,
      createId: ids("linked"),
      processRunner: fastGitRunner,
    });
    await expect(linkedManager.create(
      linked.repository,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "permission_denied" });
    expect(await readdir(outside)).toEqual([]);
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
    expect(await readdir(leases)).toEqual([".owners"]);
    expect(await readdir(path.join(leases, ".owners"))).toEqual([]);
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
    await expect(manager.assertActive(lease)).resolves.toBeUndefined();
    await expect(access(path.join(
      leases,
      ".owners",
      `${lease.id}.lock`,
    ))).resolves.toBeUndefined();
    expect(await readFile(path.join(lease.worktreeRoot, "tracked.txt"), "utf8"))
      .toBe("committed\n");
    failRemove = false;
    await expect(manager.release(lease)).resolves.toBeUndefined();
  });

  it("reconciles remove-then-error for release and stale recovery", async () => {
    const released = await fixture();
    let releaseThrow = true;
    const releaseRunner: typeof runProcess = async (...args) => {
      const result = await fastGitRunner(...args);
      if (releaseThrow && args[0] === "git" &&
        hasGitCommand(args[1], "worktree", "remove")) {
        releaseThrow = false;
        throw new ToolError("process_failed", "injected post-remove failure");
      }
      return result;
    };
    const releaseManager = new GitWorktreeLeaseManager({
      rootDirectory: released.leases,
      createId: ids("ambiguous-release"),
      processRunner: releaseRunner,
    });
    const releaseLease = await releaseManager.create(
      released.repository,
      new AbortController().signal,
    );
    await expect(releaseManager.release(releaseLease)).resolves.toBeUndefined();
    await expect(access(path.join(
      released.leases,
      ".owners",
      `${releaseLease.id}.lock`,
    ))).rejects.toMatchObject({ code: "ENOENT" });

    const recovered = await fixture();
    const creator = new GitWorktreeLeaseManager({
      rootDirectory: recovered.leases,
      createId: ids("ambiguous-recovery"),
      processRunner: fastGitRunner,
    });
    const stale = await creator.create(
      recovered.repository,
      new AbortController().signal,
    );
    const owner = path.join(
      recovered.leases,
      ".owners",
      `${stale.id}.lock`,
      "owner.json",
    );
    const record = JSON.parse(await readFile(owner, "utf8")) as Record<string, unknown>;
    await writeFile(owner, `${JSON.stringify({
      ...record,
      pid: 2_147_483_647,
    })}\n`, { mode: 0o600 });
    let recoveryThrow = true;
    const recoveryRunner: typeof runProcess = async (...args) => {
      const result = await fastGitRunner(...args);
      if (recoveryThrow && args[0] === "git" &&
        hasGitCommand(args[1], "worktree", "remove")) {
        recoveryThrow = false;
        throw new ToolError("process_failed", "injected post-remove failure");
      }
      return result;
    };
    const recoveryManager = new GitWorktreeLeaseManager({
      rootDirectory: recovered.leases,
      processRunner: recoveryRunner,
    });
    await expect(recoveryManager.recoverStale({
      repositoryRoot: recovered.repository,
    })).resolves.toEqual({
      removedLeaseIds: [stale.id],
      busyLeaseIds: [],
    });
  }, 30_000);
});
