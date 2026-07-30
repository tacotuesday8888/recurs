import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  recommendedTeamControlPolicy,
  type TeamControlPolicyV1,
} from "@recurs/contracts";
import { FileTeamControlPolicyStore } from "@recurs/core";
import { afterEach, describe, expect, it } from "vitest";

import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";
import { TeamControlService } from "../src/team-control-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-team-controls-")),
  );
  directories.push(root);
  return {
    root,
    service: new TeamControlService(
      new FileTeamControlPolicyStore(path.join(root, "controls")),
    ),
    blueprint: companyBlueprintV2Fixture(),
  };
}

describe("TeamControlService", () => {
  it("distinguishes recommended defaults, hard ceilings, and effective values", async () => {
    const setup = await fixture();

    await expect(setup.service.inspect({
      workspace: setup.root,
      operatingModeId: "balanced_v6",
      blueprint: setup.blueprint,
    })).resolves.toMatchObject({
      source: "recommended",
      compatible: true,
      selected: recommendedTeamControlPolicy("balanced_v6"),
      hardCeiling: recommendedTeamControlPolicy("balanced_v6"),
      effective: {
        blueprintId: setup.blueprint.id,
        maxDelegationDepth: 1,
      },
    });
  });

  it("publishes recommended defaults once without overwriting an existing choice", async () => {
    const setup = await fixture();
    const initial = await setup.service.ensureRecommended(
      setup.root,
      "balanced_v6",
    );
    const configured = await setup.service.configure({
      workspace: setup.root,
      operatingModeId: "balanced_v6",
      changes: { topology: "focused" },
    });
    const preserved = await setup.service.ensureRecommended(
      setup.root,
      "balanced_v6",
    );

    expect(initial).toEqual(recommendedTeamControlPolicy("balanced_v6"));
    expect(configured.topology).toBe("focused");
    expect(preserved).toEqual(configured);
  });

  it("publishes bounded revisions and leaves state unchanged after invalid widening", async () => {
    const setup = await fixture();
    const saved = await setup.service.configure({
      workspace: setup.root,
      operatingModeId: "balanced_v6",
      changes: {
        topology: "parallel",
        maxConcurrentAgents: 2,
        maxRequests: 40,
      },
    });

    expect(saved).toMatchObject({
      revision: 1,
      topology: "parallel",
      maxConcurrentAgents: 2,
      maxRequests: 40,
    });
    await expect(setup.service.configure({
      workspace: setup.root,
      operatingModeId: "balanced_v6",
      changes: { maxConcurrentAgents: 4 },
    })).rejects.toThrow(/ceiling/iu);
    expect((await setup.service.inspect({
      workspace: setup.root,
      operatingModeId: "balanced_v6",
      blueprint: setup.blueprint,
    })).selected).toEqual(saved);
  });

  it("reports a mode change as incompatible until an explicit reset", async () => {
    const setup = await fixture();
    await setup.service.configure({
      workspace: setup.root,
      operatingModeId: "balanced_v6",
      changes: { topology: "review_heavy" },
    });

    await expect(setup.service.inspect({
      workspace: setup.root,
      operatingModeId: "economy_v6",
      blueprint: null,
    })).resolves.toMatchObject({
      source: "saved",
      compatible: false,
      effective: null,
      selected: {
        operatingModeId: "balanced_v6",
        topology: "review_heavy",
      },
      hardCeiling: recommendedTeamControlPolicy("economy_v6"),
    });

    const reset = await setup.service.reset(setup.root, "economy_v6");
    expect(reset).toEqual({
      ...recommendedTeamControlPolicy("economy_v6"),
      revision: 2,
    } satisfies TeamControlPolicyV1);
  });
});
