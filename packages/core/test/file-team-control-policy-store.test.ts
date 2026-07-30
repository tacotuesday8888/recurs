import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  recommendedTeamControlPolicy,
  type TeamControlPolicyV1,
} from "@recurs/contracts";
import * as core from "../src/index.js";

interface TeamControlPolicyStore {
  publish(
    workspaceIdentity: string,
    policy: TeamControlPolicyV1,
    expectedRevision: number | null,
    signal?: AbortSignal,
  ): Promise<void>;
  load(
    workspaceIdentity: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<TeamControlPolicyV1>;
  latest(
    workspaceIdentity: string,
    signal?: AbortSignal,
  ): Promise<TeamControlPolicyV1 | null>;
}

type TeamControlPolicyStoreConstructor = new (
  directory: string,
) => TeamControlPolicyStore;

const Store = (core as unknown as {
  readonly FileTeamControlPolicyStore: TeamControlPolicyStoreConstructor;
}).FileTeamControlPolicyStore;

const roots: string[] = [];
const workspace = "/tmp/recurs-team-control-project";

async function directory(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-team-controls-")),
  );
  roots.push(root);
  return path.join(root, "team-controls");
}

function policy(
  revision: number,
  overrides: Partial<TeamControlPolicyV1> = {},
): TeamControlPolicyV1 {
  return {
    ...recommendedTeamControlPolicy("balanced_v6", revision),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("FileTeamControlPolicyStore", () => {
  it("publishes private revisions and reloads them through a new instance", async () => {
    const location = await directory();
    const first = new Store(location);

    await expect(first.latest(workspace)).resolves.toBeNull();
    await first.publish(workspace, policy(1), null);
    await first.publish(workspace, policy(2, {
      topology: "hierarchical",
      maxActiveAgents: 6,
      maxRequests: 64,
    }), 1);

    const second = new Store(location);
    await expect(second.load(workspace, 1)).resolves.toEqual(policy(1));
    await expect(second.latest(workspace)).resolves.toEqual(policy(2, {
      topology: "hierarchical",
      maxActiveAgents: 6,
      maxRequests: 64,
    }));

    expect((await stat(location)).mode & 0o777).toBe(0o700);
    const records = (await readdir(location)).filter((name) =>
      name.endsWith(".json")
    );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect((await stat(path.join(location, record))).mode & 0o777).toBe(0o600);
    }
  });

  it("treats exact replay as idempotent and rejects stale or conflicting publication", async () => {
    const store = new Store(await directory());
    const first = policy(1);
    await store.publish(workspace, first, null);
    await expect(store.publish(workspace, first, null)).resolves.toBeUndefined();

    await expect(store.publish(workspace, policy(2), null)).rejects.toMatchObject({
      code: "sequence_conflict",
    });
    await expect(store.publish(workspace, policy(3), 1)).rejects.toMatchObject({
      code: "sequence_conflict",
    });
    await expect(store.publish(workspace, {
      ...first,
      topology: "parallel",
    }, null)).rejects.toMatchObject({ code: "conflict" });
  });

  it("serializes same-instance and cross-instance publication races", async () => {
    const location = await directory();
    const first = new Store(location);
    const second = new Store(location);
    const value = policy(1);

    await expect(Promise.all([
      first.publish(workspace, value, null),
      first.publish(workspace, value, null),
      second.publish(workspace, value, null),
    ])).resolves.toEqual([undefined, undefined, undefined]);
    await expect(first.latest(workspace)).resolves.toEqual(value);
  });

  it("keeps independent workspace identities separate", async () => {
    const store = new Store(await directory());
    await store.publish(workspace, policy(1), null);
    await store.publish(`${workspace}-other`, policy(1, {
      topology: "focused",
      maxActiveAgents: 3,
      maxConcurrentAgents: 1,
      maxDelegationDepth: 1,
      maxRequests: 24,
    }), null);

    await expect(store.latest(workspace)).resolves.toMatchObject({
      topology: "recommended",
    });
    await expect(store.latest(`${workspace}-other`)).resolves.toMatchObject({
      topology: "focused",
    });
  });

  it("rejects corrupt, oversized, public, and symlinked state", async () => {
    const location = await directory();
    const store = new Store(location);
    await store.publish(workspace, policy(1), null);
    const record = (await readdir(location)).find((name) =>
      name.endsWith(".json")
    )!;
    const recordPath = path.join(location, record);
    const original = await readFile(recordPath, "utf8");

    await writeFile(recordPath, `${original.trimEnd()}x\n`, "utf8");
    await expect(store.latest(workspace)).rejects.toMatchObject({
      code: "corrupt",
    });

    await writeFile(recordPath, "x".repeat(70_000), {
      encoding: "utf8",
      mode: 0o600,
    });
    await expect(store.latest(workspace)).rejects.toMatchObject({
      code: "corrupt",
    });

    await writeFile(recordPath, original, { encoding: "utf8", mode: 0o600 });
    await chmod(recordPath, 0o644);
    await expect(store.latest(workspace)).rejects.toMatchObject({
      code: "corrupt",
    });

    const aliasRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-team-control-alias-")),
    );
    roots.push(aliasRoot);
    const alias = path.join(aliasRoot, "team-controls");
    await symlink(location, alias);
    await expect(new Store(alias).latest(workspace)).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});
