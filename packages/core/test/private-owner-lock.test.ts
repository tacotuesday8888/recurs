import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import type * as FileSystemPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  acquirePrivateOwnerLock,
  type PrivateOwnerBinding,
  type PrivateOwnerReclaimResult,
  reclaimPrivateOwnerLock,
} from "../src/private-owner-lock.js";

type PublicationKind = "claim" | "replacement";

const publicationControl = vi.hoisted(() => ({
  beforePublication: undefined as
    | ((kind: PublicationKind) => Promise<void>)
    | undefined,
  afterPublication: undefined as
    | ((kind: PublicationKind, path: string) => Promise<void>)
    | undefined,
  failDirectorySyncFor: undefined as string | undefined,
  failCandidateRemoval: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      if (String(args[0]) === publicationControl.failDirectorySyncFor) {
        const sync = handle.sync.bind(handle);
        Object.defineProperty(handle, "sync", {
          configurable: true,
          async value() {
            if (String(args[0]) === publicationControl.failDirectorySyncFor) {
              publicationControl.failDirectorySyncFor = undefined;
              throw Object.assign(new Error("injected directory sync failure"), {
                code: "EIO",
              });
            }
            return sync();
          },
        });
      }
      return handle;
    },
    async link(
      existingPath: Parameters<typeof actual.link>[0],
      newPath: Parameters<typeof actual.link>[1],
    ) {
      if (String(newPath).endsWith(`${path.sep}claim.json`)) {
        await publicationControl.beforePublication?.("claim");
      }
      await actual.link(existingPath, newPath);
      if (String(newPath).endsWith("claim.json")) {
        await publicationControl.afterPublication?.("claim", String(newPath));
      }
    },
    async rename(
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) {
      if (String(oldPath).endsWith(".owner.tmp") &&
        String(newPath).endsWith(`${path.sep}owner.json`)) {
        await publicationControl.beforePublication?.("replacement");
      }
      return actual.rename(oldPath, newPath);
    },
    async rm(...args: Parameters<typeof actual.rm>) {
      const target = String(args[0]);
      if (publicationControl.failCandidateRemoval &&
        path.basename(target).startsWith(".candidate.") &&
        target.endsWith(".json")) {
        publicationControl.failCandidateRemoval = false;
        throw Object.assign(new Error("injected candidate removal failure"), {
          code: "EIO",
        });
      }
      return actual.rm(...args);
    },
  };
});

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const directories: string[] = [];

interface OwnerFixture {
  readonly root: string;
  readonly binding: PrivateOwnerBinding;
  readonly ownerPath: string;
  readonly ownerRecord: Record<string, unknown>;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function publicationBarrier(): {
  readonly arrived: readonly [Deferred, Deferred];
  readonly proceed: readonly [Deferred, Deferred];
} {
  const arrived = [deferred(), deferred()] as const;
  const proceed = [deferred(), deferred()] as const;
  let selected: PublicationKind | null = null;
  let index = 0;
  publicationControl.beforePublication = async (kind) => {
    selected ??= kind;
    if (kind !== selected || index >= arrived.length) return;
    const slot = index;
    index += 1;
    arrived[slot].resolve();
    await proceed[slot].promise;
  };
  return { arrived, proceed };
}

async function ownerFixture(leaseId: string): Promise<OwnerFixture> {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-private-owner-lock-")),
  );
  directories.push(base);
  const root = path.join(base, "leases");
  await mkdir(root, { mode: 0o700 });
  const binding: PrivateOwnerBinding = {
    leaseId,
    repositoryRoot: path.join(base, "repository"),
    worktreeRoot: path.join(root, leaseId),
    revision: "a".repeat(40),
  };
  const original = await acquirePrivateOwnerLock(root, binding);
  expect(original).not.toBeNull();
  const ownerPath = path.join(
    root,
    ".owners",
    `${binding.leaseId}.lock`,
    "owner.json",
  );
  const ownerRecord = JSON.parse(
    await readFile(ownerPath, "utf8"),
  ) as Record<string, unknown>;
  await writeFile(ownerPath, `${JSON.stringify({
    ...ownerRecord,
    pid: 2_147_483_647,
  })}\n`, { mode: 0o600 });
  return { root, binding, ownerPath, ownerRecord };
}

afterEach(async () => {
  publicationControl.beforePublication = undefined;
  publicationControl.afterPublication = undefined;
  publicationControl.failDirectorySyncFor = undefined;
  publicationControl.failCandidateRemoval = false;
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function seedDeadClaimChain(
  fixture: OwnerFixture,
  count: number,
): Promise<readonly Record<string, unknown>[]> {
  const claimRoot = path.join(
    path.dirname(fixture.ownerPath),
    ".claims",
    String(fixture.ownerRecord.nonce),
  );
  await mkdir(claimRoot, { recursive: true, mode: 0o700 });
  const records: Record<string, unknown>[] = [];
  let file = "claim.json";
  for (let index = 0; index < count; index += 1) {
    const record = {
      version: 1,
      ...fixture.binding,
      ownerNonce: fixture.ownerRecord.nonce,
      nonce: randomUUID(),
      pid: 2_147_483_647,
      released: true,
    };
    await writeFile(
      path.join(claimRoot, file),
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );
    records.push(record);
    file = `${record.nonce}.claim.json`;
  }
  return records;
}

it("fences contenders that observed the same dead owner before publication", async () => {
  const { root, binding } = await ownerFixture("contended-dead-owner");

  const barrier = publicationBarrier();
  let first: PrivateOwnerReclaimResult | undefined;
  let second: PrivateOwnerReclaimResult | undefined;
  try {
    const firstAttempt = reclaimPrivateOwnerLock(root, binding);
    await barrier.arrived[0].promise;
    const secondAttempt = reclaimPrivateOwnerLock(root, binding);
    await barrier.arrived[1].promise;

    barrier.proceed[0].resolve();
    first = await firstAttempt;
    expect(first.status).toBe("acquired");

    barrier.proceed[1].resolve();
    second = await secondAttempt;
    expect([first.status, second.status].sort()).toEqual(["acquired", "busy"]);
  } finally {
    barrier.proceed[0].resolve();
    barrier.proceed[1].resolve();
    publicationControl.beforePublication = undefined;
    if (first?.status === "acquired") await first.lock.release().catch(() => undefined);
    if (second?.status === "acquired") await second.lock.release().catch(() => undefined);
  }
});

it("reclaims a dead contender claim without reusing its publication slot", async () => {
  const { root, binding, ownerRecord } = await ownerFixture("dead-claimant");
  const claimPublished = deferred();
  const resumeClaimant = deferred();
  let claimPath: string | null = null;
  publicationControl.afterPublication = async (kind, publishedPath) => {
    if (kind !== "claim" || claimPath !== null) return;
    claimPath = publishedPath;
    claimPublished.resolve();
    await resumeClaimant.promise;
  };

  let first: PrivateOwnerReclaimResult | undefined;
  let second: PrivateOwnerReclaimResult | undefined;
  try {
    const firstAttempt = reclaimPrivateOwnerLock(root, binding);
    await claimPublished.promise;
    if (claimPath === null) throw new Error("Claim publication was not observed");
    expect((await lstat(claimPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(claimPath))).mode & 0o777).toBe(0o700);
    const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(claimPath, `${JSON.stringify({
      ...claim,
      pid: 2_147_483_647,
    })}\n`, { mode: 0o600 });

    second = await reclaimPrivateOwnerLock(root, binding);
    expect(second.status).toBe("acquired");
    const owner = JSON.parse(
      await readFile(path.join(
        root,
        ".owners",
        `${binding.leaseId}.lock`,
        "owner.json",
      ), "utf8"),
    ) as Record<string, unknown>;
    expect(owner.nonce).not.toBe(ownerRecord.nonce);

    resumeClaimant.resolve();
    first = await firstAttempt;
    expect(first.status).toBe("busy");
  } finally {
    resumeClaimant.resolve();
    publicationControl.afterPublication = undefined;
    if (first?.status === "acquired") await first.lock.release().catch(() => undefined);
    if (second?.status === "acquired") await second.lock.release().catch(() => undefined);
  }
});

it("uses the last releasable claim slot and can abandon the reclaimed owner", async () => {
  const fixture = await ownerFixture("last-releasable-claim");
  const claims = await seedDeadClaimChain(fixture, 31);

  const reclaimed = await reclaimPrivateOwnerLock(fixture.root, fixture.binding);
  expect(reclaimed.status).toBe("acquired");
  if (reclaimed.status !== "acquired") return;

  await reclaimed.lock.abandon();

  const restored = JSON.parse(await readFile(fixture.ownerPath, "utf8")) as Record<
    string,
    unknown
  >;
  expect(restored.nonce).toBe(fixture.ownerRecord.nonce);
  const lastClaim = claims.at(-1);
  expect(lastClaim).toBeDefined();
  const active = JSON.parse(await readFile(path.join(
    path.dirname(fixture.ownerPath),
    ".claims",
    String(fixture.ownerRecord.nonce),
    `${String(lastClaim?.nonce)}.claim.json`,
  ), "utf8")) as Record<string, unknown>;
  const released = JSON.parse(await readFile(path.join(
    path.dirname(fixture.ownerPath),
    ".claims",
    String(fixture.ownerRecord.nonce),
    `${String(active.nonce)}.claim.json`,
  ), "utf8")) as Record<string, unknown>;
  expect(active.released).toBe(false);
  expect(released.released).toBe(true);
});

it("fails closed before publishing an active claim without a release slot", async () => {
  const fixture = await ownerFixture("exhausted-claim-chain");
  const claims = await seedDeadClaimChain(fixture, 32);
  const lastClaim = claims.at(-1);
  expect(lastClaim).toBeDefined();
  const unreachable = path.join(
    path.dirname(fixture.ownerPath),
    ".claims",
    String(fixture.ownerRecord.nonce),
    `${String(lastClaim?.nonce)}.claim.json`,
  );

  await expect(
    reclaimPrivateOwnerLock(fixture.root, fixture.binding),
  ).rejects.toMatchObject({ code: "permission_denied" });

  await expect(lstat(unreachable)).rejects.toMatchObject({ code: "ENOENT" });
  const owner = JSON.parse(await readFile(fixture.ownerPath, "utf8")) as Record<
    string,
    unknown
  >;
  expect(owner.nonce).toBe(fixture.ownerRecord.nonce);
  expect(owner.pid).toBe(2_147_483_647);
});

it("reconciles a published claim after its directory sync fails", async () => {
  const fixture = await ownerFixture("claim-sync-failure");
  publicationControl.afterPublication = async (kind, publishedPath) => {
    if (kind === "claim") {
      publicationControl.failDirectorySyncFor = path.dirname(publishedPath);
      publicationControl.afterPublication = undefined;
    }
  };

  const reclaimed = await reclaimPrivateOwnerLock(fixture.root, fixture.binding);

  expect(reclaimed.status).toBe("acquired");
  if (reclaimed.status === "acquired") await reclaimed.lock.release();
});

it("reconciles a published claim when candidate cleanup fails", async () => {
  const fixture = await ownerFixture("claim-cleanup-failure");
  publicationControl.failCandidateRemoval = true;

  const reclaimed = await reclaimPrivateOwnerLock(fixture.root, fixture.binding);

  expect(reclaimed.status).toBe("acquired");
  if (reclaimed.status === "acquired") await reclaimed.lock.release();
});
