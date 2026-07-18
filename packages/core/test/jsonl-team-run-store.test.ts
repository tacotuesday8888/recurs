import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  getOperatingModePolicy,
  type SessionBackendPin,
  type TeamRunDescriptor,
  type TeamRunPolicySnapshot,
} from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlTeamRunStore,
} from "../src/index.js";
import { acquireSessionLock } from "../src/session-mutation-lease.js";

const directories: string[] = [];
const baseAt = "2026-07-18T00:00:00.000Z";
const baseRevision = "a".repeat(40);

function pin(): SessionBackendPin {
  return {
    kind: "model_provider",
    providerId: "test-provider",
    adapterId: "test-adapter",
    connectionId: "test-connection",
    modelId: "test-model",
    modelIdentityKind: "versioned",
    providerResolvedModelRevisionAtCreation: "model-r1",
    catalogRevision: "catalog-r1",
    policyRevisionAtCreation: "policy-r1",
    billingPolicyRevisionAtCreation: "billing-r1",
    primaryBillingSourceAtCreation: "local_compute",
    billingSelectionAtCreation: {
      mode: "strict_primary_only",
      policyRevision: "policy-r1",
      disclosureRevision: "disclosure-r1",
      allowedSources: ["local_compute"],
      acknowledgedAt: baseAt,
    },
    accountSubjectFingerprint: "account-canary-do-not-list",
  };
}

function descriptor(id = "team-run-1"): TeamRunDescriptor {
  const backend = pin();
  return {
    id,
    version: 1,
    parentSessionId: "parent-session",
    parentAgentId: "parent-agent",
    execution: "background",
    parentExecutionMode: "act",
    parentPermissionMode: "full_access",
    invocation: {
      invocation: "repl",
      presence: "present",
      location: "local",
      automation: "manual",
      embedding: "cli",
    },
    operatingModeId: "balanced_v4",
    operatingModeVersion: 4,
    policy: structuredClone(
      getOperatingModePolicy("balanced_v4"),
    ) as TeamRunPolicySnapshot,
    allocation: {
      maxChildren: 7,
      maxRequests: 56,
      requestAllowance: 8,
      maxReportedCostUsd: 3,
    },
    routes: [
      ["implement", "implement_v2"],
      ["review", "review_v2"],
      ["repair", "repair_v1"],
    ].map(([role, profileId]) => ({
      role,
      profileId,
      executionMode: "act",
      permissionMode: "full_access",
      strategy: "inherit_parent",
      candidateId: "parent",
      reason: "parent_fallback",
      pin: backend,
    })) as TeamRunDescriptor["routes"],
    backend,
    repositoryRoot: path.resolve("/workspace"),
    baseRevision,
    request: {
      description: "description-canary-do-not-list",
      tasks: [{
        description: "Implementation 1",
        prompt: "prompt-canary-do-not-list",
      }],
      review: { instructions: "review-canary-do-not-list" },
    },
  };
}

async function fixture(): Promise<{
  root: string;
  directory: string;
  store: JsonlTeamRunStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-team-runs-"));
  directories.push(root);
  const directory = path.join(root, "team-runs");
  return { root, directory, store: new JsonlTeamRunStore(directory) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("JsonlTeamRunStore", () => {
  it("creates, appends, reloads, and lists a safe private run", async () => {
    const { directory, store } = await fixture();
    const created = await store.create(descriptor(), baseAt);
    const claimed = await store.append("team-run-1", 0, {
      type: "run_claimed",
      ownerId: "owner-1",
      claimEpoch: 1,
      at: "2026-07-18T00:00:01.000Z",
    });

    expect(created.status).toBe("created");
    expect(claimed).toMatchObject({
      lastSequence: 1,
      claim: { ownerId: "owner-1", claimEpoch: 1 },
    });
    expect(await store.load("team-run-1")).toEqual(claimed);
    const listed = await store.list("parent-session");
    expect(listed).toEqual([expect.objectContaining({
      id: "team-run-1",
      parentSessionId: "parent-session",
      status: "created",
      lastSequence: 1,
    })]);
    const rendered = JSON.stringify(listed);
    for (const secret of [
      "prompt-canary-do-not-list",
      "description-canary-do-not-list",
      "review-canary-do-not-list",
      "account-canary-do-not-list",
      "/workspace",
    ]) {
      expect(rendered).not.toContain(secret);
    }

    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(directory, "team-run-1.jsonl"))).mode & 0o777)
      .toBe(0o600);
  });

  it("fences stale and concurrent sequence writers", async () => {
    const { store } = await fixture();
    await store.create(descriptor(), baseAt);
    await expect(store.append("team-run-1", 7, {
      type: "run_claimed",
      ownerId: "owner-1",
      claimEpoch: 1,
      at: "2026-07-18T00:00:01.000Z",
    })).rejects.toMatchObject({ code: "session_conflict" });

    const writes = await Promise.allSettled([
      store.append("team-run-1", 0, {
        type: "run_claimed",
        ownerId: "owner-1",
        claimEpoch: 1,
        at: "2026-07-18T00:00:01.000Z",
      }),
      store.append("team-run-1", 0, {
        type: "run_claimed",
        ownerId: "owner-2",
        claimEpoch: 1,
        at: "2026-07-18T00:00:01.000Z",
      }),
    ]);
    expect(writes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await store.load("team-run-1")).lastSequence).toBe(1);
  });

  it("repairs only a torn final fragment while holding the writer lock", async () => {
    const { directory, store } = await fixture();
    await store.create(descriptor(), baseAt);
    const file = path.join(directory, "team-run-1.jsonl");
    await appendFile(file, "{\"version\":1,\"runId\":\"team-run-1\"", "utf8");

    const lock = await acquireSessionLock(directory, "team-run-1");
    await expect(store.load("team-run-1")).rejects.toMatchObject({
      code: "session_busy",
    });
    await lock.release();

    const loaded = await store.load("team-run-1");
    expect(loaded.lastSequence).toBe(0);
    expect(await readFile(file, "utf8")).toMatch(/\n$/u);
    expect(await readFile(file, "utf8")).not.toContain("runId\":\"team-run-1\"\n{");
  });

  it("repairs a torn tail that ends midway through a UTF-8 code point", async () => {
    const { directory, store } = await fixture();
    await store.create(descriptor(), baseAt);
    const file = path.join(directory, "team-run-1.jsonl");
    await appendFile(file, Buffer.from([0xe2, 0x82]));

    expect((await store.load("team-run-1")).lastSequence).toBe(0);
    const repaired = await readFile(file);
    expect(repaired.at(-1)).toBe(0x0a);
    expect(repaired.includes(0xe2)).toBe(false);
  });

  it("truncates a complete-looking final record without a durability newline", async () => {
    const { directory, store } = await fixture();
    await store.create(descriptor(), baseAt);
    const file = path.join(directory, "team-run-1.jsonl");
    await appendFile(file, JSON.stringify({
      version: 1,
      runId: "team-run-1",
      sequence: 1,
      type: "run_claimed",
      ownerId: "uncommitted-owner",
      claimEpoch: 1,
      at: "2026-07-18T00:00:01.000Z",
    }), "utf8");

    expect((await store.load("team-run-1")).lastSequence).toBe(0);
    expect(await readFile(file, "utf8")).not.toContain("uncommitted-owner");
  });

  it("fails closed on middle, newline-terminated, sequence, and transition corruption", async () => {
    const cases = [
      "not-json\n",
      `${JSON.stringify({
        version: 1,
        runId: "team-run-1",
        sequence: 7,
        type: "run_claimed",
        ownerId: "owner-1",
        claimEpoch: 1,
        at: "2026-07-18T00:00:01.000Z",
      })}\n`,
      `${JSON.stringify({
        version: 1,
        runId: "team-run-1",
        sequence: 1,
        type: "phase_started",
        phase: "review",
        round: 0,
        at: "2026-07-18T00:00:01.000Z",
      })}\n`,
    ];
    for (const [index, tail] of cases.entries()) {
      const { directory, store } = await fixture();
      await store.create(descriptor(`team-run-${index}`), baseAt);
      const file = path.join(directory, `team-run-${index}.jsonl`);
      const normalized = tail.replaceAll("team-run-1", `team-run-${index}`);
      await appendFile(file, normalized, "utf8");
      await expect(store.load(`team-run-${index}`)).rejects.toMatchObject({
        code: expect.stringMatching(/invalid_record|corrupt_log/u),
      });
    }
  });

  it("fails closed on invalid UTF-8 instead of repairing it", async () => {
    const { directory, store } = await fixture();
    await store.create(descriptor(), baseAt);
    await appendFile(
      path.join(directory, "team-run-1.jsonl"),
      Buffer.from([0xc3, 0x28, 0x0a]),
    );
    await expect(store.load("team-run-1")).rejects.toMatchObject({
      code: "corrupt_log",
    });
  });

  it("keeps missing read-only roots absent", async () => {
    const { directory, store } = await fixture();
    expect(await store.list()).toEqual([]);
    await expect(store.load("missing-run")).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe IDs, permissive roots, directory symlinks, and log symlinks", async () => {
    const unsafe = await fixture();
    await expect(unsafe.store.create(descriptor("../escape"), baseAt))
      .rejects.toMatchObject({ code: "invalid_session_id" });

    const permissive = await fixture();
    await mkdir(permissive.directory, { mode: 0o755 });
    await chmod(permissive.directory, 0o755);
    await expect(permissive.store.create(descriptor(), baseAt))
      .rejects.toThrow(/private|permission/u);

    const linked = await fixture();
    const target = path.join(linked.root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked.directory);
    await expect(linked.store.create(descriptor(), baseAt))
      .rejects.toThrow(/symbolic|directory/u);

    const logLink = await fixture();
    await logLink.store.create(descriptor(), baseAt);
    const outside = path.join(logLink.root, "outside.jsonl");
    await writeFile(outside, "outside", { mode: 0o600 });
    const file = path.join(logLink.directory, "team-run-1.jsonl");
    await rm(file);
    await symlink(outside, file);
    await expect(logLink.store.load("team-run-1"))
      .rejects.toThrow(/symbolic|regular file/u);
  });

  it("rejects lock and fence symlinks before the lock primitive can touch them", async () => {
    for (const helper of [".locks", ".fences"]) {
      const linked = await fixture();
      await mkdir(linked.directory, { mode: 0o700 });
      const target = path.join(linked.root, `${helper.slice(1)}-target`);
      await mkdir(target, { mode: 0o700 });
      await symlink(target, path.join(linked.directory, helper));

      await expect(linked.store.create(descriptor(), baseAt))
        .rejects.toThrow(/symbolic|directory/u);
      expect(await readdir(target)).toEqual([]);
    }
  });

  it("does not create or duplicate an existing run", async () => {
    const { store } = await fixture();
    await store.create(descriptor(), baseAt);
    await expect(store.create(descriptor(), baseAt)).rejects.toMatchObject({
      code: "session_conflict",
    });
    await expect(store.load("missing-run")).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(store.create(descriptor("a".repeat(129)), baseAt))
      .rejects.toMatchObject({ code: "invalid_session_id" });
  });
});
