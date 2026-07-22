import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CompanyBlueprintBindingV2, CompanyBlueprintV2 } from "@recurs/contracts";
import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";

import {
  CompanyAmendmentService,
  FileCompanyAmendmentStore,
  FileCompanyBlueprintV2Store,
  type CompanyAmendmentError,
} from "../src/index.js";

const roots: string[] = [];
const createdAt = "2026-07-22T06:30:00.000Z";

async function setup(): Promise<{
  readonly service: CompanyAmendmentService;
  readonly blueprints: FileCompanyBlueprintV2Store;
  readonly amendments: FileCompanyAmendmentStore;
  readonly base: CompanyBlueprintV2;
  readonly binding: CompanyBlueprintBindingV2;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-amendments-")));
  roots.push(root);
  const blueprints = new FileCompanyBlueprintV2Store(path.join(root, "blueprints"));
  const amendments = new FileCompanyAmendmentStore(path.join(root, "amendments"));
  const base = companyBlueprintV2Fixture();
  const binding = {
    blueprintId: base.id,
    blueprintVersion: 2,
    blueprintRevision: base.revision,
    roleId: base.authorityAnchors.rootRoleId,
    roleVersion: 1,
  } as const;
  await blueprints.create(base);
  return {
    service: new CompanyAmendmentService({ blueprints, amendments }),
    blueprints,
    amendments,
    base,
    binding,
  };
}

function proposal(base: CompanyBlueprintV2, id: string, purpose: string) {
  return {
    ...companyBlueprintV2Fixture({
      id,
      revision: base.revision + 1,
      previousBlueprintId: base.id,
      state: "proposed",
    }),
    project: { ...base.project, purpose },
  } satisfies CompanyBlueprintV2;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("CompanyAmendmentService", () => {
  it("approves a reviewed proposal as a new immutable future revision", async () => {
    const fixture = await setup();
    const originalBinding = structuredClone(fixture.binding);
    const proposed = await fixture.service.propose({
      amendmentId: "amendment-quality-r2",
      company: fixture.binding,
      proposedBlueprint: proposal(
        fixture.base,
        "company-v2-quality-r2",
        "Operate a dependable company with stronger review.",
      ),
      reason: "Repeated review evidence supports a stronger quality charter.",
      at: createdAt,
    });

    expect(proposed.state).toBe("proposed");
    const approved = await fixture.service.approve({
      amendmentId: proposed.id,
      company: fixture.binding,
      at: "2026-07-22T06:31:00.000Z",
      decisionReason: "Approved after inspecting the exact proposal.",
    });

    expect(approved).toMatchObject({
      amendment: {
        state: "approved",
        resultingBlueprintId: "company-v2-quality-r2",
      },
      blueprint: { state: "approved", revision: 2 },
    });
    await expect(fixture.amendments.load(proposed.id)).resolves.toMatchObject({
      state: "approved",
    });
    await expect(fixture.blueprints.load(fixture.base.id)).resolves.toEqual(fixture.base);
    expect(fixture.binding).toEqual(originalBinding);
    await expect(fixture.service.latest({ company: fixture.binding })).resolves
      .toEqual(approved.blueprint);
    await expect(fixture.service.approve({
      amendmentId: proposed.id,
      company: fixture.binding,
      at: "2026-07-22T06:32:00.000Z",
      decisionReason: "Idempotent replay.",
    })).resolves.toEqual(approved);
  });

  it("rejects a proposal without creating or changing a blueprint", async () => {
    const fixture = await setup();
    const proposedBlueprint = proposal(
      fixture.base,
      "company-v2-rejected-r2",
      "A rejected organization.",
    );
    await fixture.service.propose({
      amendmentId: "amendment-rejected-r2",
      company: fixture.binding,
      proposedBlueprint,
      reason: "Consider a different organization.",
      at: createdAt,
    });
    const rejected = await fixture.service.reject({
      amendmentId: "amendment-rejected-r2",
      company: fixture.binding,
      at: "2026-07-22T06:31:00.000Z",
      decisionReason: "The proposed organization is unnecessary.",
    });

    expect(rejected.amendment).toMatchObject({
      state: "rejected",
      resultingBlueprintId: null,
    });
    await expect(fixture.blueprints.load(proposedBlueprint.id))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(fixture.service.reject({
      amendmentId: "amendment-rejected-r2",
      company: fixture.binding,
      at: "2026-07-22T06:32:00.000Z",
      decisionReason: "Idempotent replay.",
    })).resolves.toEqual(rejected);
  });

  it("allows only one concurrent next revision and fails the other stale", async () => {
    const fixture = await setup();
    for (const suffix of ["a", "b"] as const) {
      await fixture.service.propose({
        amendmentId: `amendment-race-${suffix}`,
        company: fixture.binding,
        proposedBlueprint: proposal(
          fixture.base,
          `company-v2-race-${suffix}`,
          `Concurrent organization ${suffix}.`,
        ),
        reason: `Review concurrent proposal ${suffix}.`,
        at: createdAt,
      });
    }

    const results = await Promise.allSettled(["a", "b"].map((suffix) =>
      new CompanyAmendmentService({
        blueprints: fixture.blueprints,
        amendments: fixture.amendments,
      }).approve({
        amendmentId: `amendment-race-${suffix}`,
        company: fixture.binding,
        at: "2026-07-22T06:31:00.000Z",
        decisionReason: `Approve proposal ${suffix}.`,
      })
    ));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0])
      .toMatchObject({ reason: { code: "stale_base" } });
    expect((await fixture.blueprints.list()).filter((item) =>
      item.companyId === fixture.base.companyId && item.state === "approved"
    )).toHaveLength(2);
  });

  it("does not authorize two amendments for one identical blueprint revision", async () => {
    const fixture = await setup();
    const shared = proposal(
      fixture.base,
      "company-v2-shared-r2",
      "One exact next organization.",
    );
    for (const suffix of ["a", "b"] as const) {
      await fixture.service.propose({
        amendmentId: `amendment-shared-${suffix}`,
        company: fixture.binding,
        proposedBlueprint: shared,
        reason: `Review duplicate proposal ${suffix}.`,
        at: createdAt,
      });
    }

    const results = await Promise.allSettled(["a", "b"].map((suffix) =>
      fixture.service.approve({
        amendmentId: `amendment-shared-${suffix}`,
        company: fixture.binding,
        at: "2026-07-22T06:31:00.000Z",
        decisionReason: `Approve proposal ${suffix}.`,
      })
    ));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0])
      .toMatchObject({ reason: { code: "stale_base" } });
    await expect(fixture.service.latest({ company: fixture.binding }))
      .resolves.toMatchObject({ id: shared.id, revision: 2 });
  });

  it("recovers approval after blueprint publication but before decision publication", async () => {
    const fixture = await setup();
    const proposedBlueprint = proposal(
      fixture.base,
      "company-v2-recovery-r2",
      "Recover an interrupted amendment approval.",
    );
    await fixture.service.propose({
      amendmentId: "amendment-recovery-r2",
      company: fixture.binding,
      proposedBlueprint,
      reason: "Exercise deterministic approval recovery.",
      at: createdAt,
    });
    await fixture.blueprints.create({
      ...proposedBlueprint,
      state: "approved",
      approvedAt: "2026-07-22T06:30:30.000Z",
    });
    await expect(fixture.service.latest({ company: fixture.binding })).resolves
      .toEqual(fixture.base);

    const recovered = await fixture.service.approve({
      amendmentId: "amendment-recovery-r2",
      company: fixture.binding,
      at: "2026-07-22T06:31:00.000Z",
      decisionReason: "Complete the interrupted approval.",
    });
    expect(recovered).toMatchObject({
      amendment: { state: "approved" },
      blueprint: { id: proposedBlueprint.id, approvedAt: "2026-07-22T06:30:30.000Z" },
    });
    await expect(fixture.service.latest({ company: fixture.binding })).resolves
      .toEqual(recovered.blueprint);
  });

  it("fails closed for stale authority, mismatched roots, and secret-like proposals", async () => {
    const fixture = await setup();
    const changed = proposal(
      fixture.base,
      "company-v2-invalid-r2",
      "Do not store sk-proj-abcdefghijklmnopqrstuvwxyz012345 in a blueprint.",
    );
    await expect(fixture.service.propose({
      amendmentId: "amendment-secret-r2",
      company: fixture.binding,
      proposedBlueprint: changed,
      reason: "This proposal contains unsafe content.",
      at: createdAt,
    })).rejects.toEqual(expect.objectContaining<Partial<CompanyAmendmentError>>({
      code: "unsafe_content",
    }));

    await expect(fixture.service.propose({
      amendmentId: "amendment-wrong-root-r2",
      company: { ...fixture.binding, roleId: "quality_reviewer" },
      proposedBlueprint: proposal(
        fixture.base,
        "company-v2-wrong-root-r2",
        "Use exact root authority.",
      ),
      reason: "A reviewer cannot amend the company.",
      at: createdAt,
    })).rejects.toMatchObject({ code: "authority_mismatch" });

    await fixture.service.propose({
      amendmentId: "amendment-current-r2",
      company: fixture.binding,
      proposedBlueprint: proposal(
        fixture.base,
        "company-v2-current-r2",
        "Advance the company revision.",
      ),
      reason: "Advance once.",
      at: createdAt,
    });
    await fixture.service.approve({
      amendmentId: "amendment-current-r2",
      company: fixture.binding,
      at: "2026-07-22T06:31:00.000Z",
      decisionReason: "Advance the company.",
    });
    await expect(fixture.service.propose({
      amendmentId: "amendment-stale-r2",
      company: fixture.binding,
      proposedBlueprint: proposal(
        fixture.base,
        "company-v2-stale-r2",
        "This base is stale.",
      ),
      reason: "This should be rejected.",
      at: "2026-07-22T06:32:00.000Z",
    })).rejects.toMatchObject({ code: "stale_base" });
  });

  it("fails closed instead of selecting a broken approved lineage", async () => {
    const fixture = await setup();
    await fixture.blueprints.create(companyBlueprintV2Fixture({
      id: "company-v2-broken-r3",
      revision: 3,
      previousBlueprintId: "missing-r2",
    }));

    await expect(fixture.service.latest({ company: fixture.binding }))
      .rejects.toMatchObject({ code: "corrupt_state" });
  });
});
