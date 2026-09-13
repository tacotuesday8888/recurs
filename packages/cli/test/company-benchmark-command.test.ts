import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import {
  FileConnectionRegistry,
  type ConnectionRegistryDocument,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import { CODEX_APP_SERVER_PROFILE_REVISION } from "@recurs/runtimes";
import { deriveCompanyBenchmarkFailureAttribution } from "@recurs/contracts";
import {
  createCompanyBenchmarkBlueprint,
  createCompanyBenchmarkSummary,
  getCompanyBenchmarkScenario,
} from "@recurs/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createConfiguredCompanyBenchmarkCampaign,
  parseCompanyBenchmarkCommand,
  renderCompanyBenchmarkReport,
  renderCompanyBenchmarkScenarios,
} from "../src/company-benchmark-command.js";
import { companyBenchmarkBlueprintDigest } from "../src/company-benchmark-execution.js";
import { runCli } from "../src/process-host.js";

const AT = "2026-07-24T00:00:00.000Z";
const roots: string[] = [];

class TextOutput extends Writable {
  value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function connection(
  id: string,
  modelId: string,
  reasoningEffort: "medium" | "high",
): DelegatedConnectionRecord {
  return {
    kind: "delegated_agent",
    id,
    providerId: "openai-codex-chatgpt",
    adapterId: "codex-app-server",
    label: id,
    accountLabel: "Codex test account",
    organizationLabel: null,
    modelId,
    reasoningEffort,
    accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
    policyRevision: "openai-codex-chatgpt-2026-07-11",
    billingPolicy: {
      revision: "billing:openai-codex-chatgpt:2026-07-11",
      disclosureRevision:
        "billing-disclosure:openai-codex-chatgpt:2026-07-11",
      primarySource: "included_subscription",
      possibleAdditionalSources: ["prepaid_credits"],
      providerFallback: "automatic",
      availableSelections: ["allow_declared_additional"],
    },
    billingSelection: {
      mode: "allow_declared_additional",
      policyRevision: "billing:openai-codex-chatgpt:2026-07-11",
      disclosureRevision:
        "billing-disclosure:openai-codex-chatgpt:2026-07-11",
      allowedSources: ["included_subscription", "prepaid_credits"],
      acknowledgedAt: AT,
    },
    runtimeCapabilityProfileRevision: CODEX_APP_SERVER_PROFILE_REVISION,
    verifiedAt: AT,
    createdAt: AT,
    updatedAt: AT,
  };
}

describe("company benchmark command", () => {
  it("freezes the native Codex control and matched subscription parent", () => {
    const options = parseCompanyBenchmarkCommand(["company", "--configured", "--allow-network", "--control", "codex"]);
    expect(options).toMatchObject({ control: "codex" });
    for (const args of [["company", "--list", "--control", "codex"], ["company", "--configured", "--allow-network", "--control", "fake"], ["company", "--resume", "id", "--allow-network", "--control", "codex"]]) {
      expect(() => parseCompanyBenchmarkCommand(args)).toThrow();
    }
    const parent = connection("luna", "gpt-5.6-luna", "medium"), worker = connection("terra", "gpt-5.6-terra", "medium");
    const document: ConnectionRegistryDocument = { schemaVersion: 2, revision: 1, primaryConnectionId: parent.id, connections: [parent, worker], agentRoutes: { implement: worker.id, review: parent.id, repair: worker.id } };
    const input = { document, scenarioId: "shipment_quote", connectionId: parent.id, repetitions: 2 as const, compareAllStrong: false, campaignId: "native", createdAt: AT, control: "codex" as const };
    const campaign = createConfiguredCompanyBenchmarkCampaign(input);
    expect(campaign.comparisonDesign).toBe("official_codex_control_v1");
    expect(campaign.launchProtocolRevision).toBe("company-benchmark-codex-control-300s-v1");
    expect(campaign.armOrder.map(slot => slot.armId)).toEqual(["codex-cli", "company-auto", "company-auto", "codex-cli"]);
    expect(campaign.baseline.configuredRoutes[0]).toMatchObject({ adapterId: "codex-cli-exec", connectionId: parent.id, modelId: parent.modelId });
    expect(campaign.companyArms[0]!.configuredRoutes[0]).toMatchObject({ adapterId: "codex-app-server", connectionId: parent.id, modelId: parent.modelId });
    expect(() => createConfiguredCompanyBenchmarkCampaign({ ...input, roleConnectionIds: { parent: worker.id } })).toThrow("same subscription parent");
  });

  it("creates a contract-valid campaign for every latest scenario advertised by --list", () => {
    const parent = connection("luna-parent", "gpt-5.6-luna", "medium");
    const worker = connection("terra-worker", "gpt-5.6-terra", "medium");
    const document: ConnectionRegistryDocument = {
      schemaVersion: 2, revision: 1, primaryConnectionId: parent.id,
      connections: [parent, worker],
      agentRoutes: { implement: worker.id, review: parent.id, repair: worker.id },
    };
    const listed = JSON.parse(renderCompanyBenchmarkScenarios(true)) as {
      scenarios: { id: string; version: number; verifierId: string }[];
    };
    expect(listed.scenarios.map(({ id, version }) => `${id}:v${version}`)).toEqual([
      "alias_registry:v1", "layered_config:v1", "retry_after:v1",
      "options_precedence:v1", "queue_cancellation:v2", "workspace_maintenance:v2",
      "shipment_quote:v1", "incremental_build_repair:v1", "release_window_regressions:v1",
    ]);
    for (const scenario of listed.scenarios) {
      const campaign = createConfiguredCompanyBenchmarkCampaign({
        document, scenarioId: scenario.id, connectionId: parent.id,
        repetitions: 2, compareAllStrong: false,
        campaignId: `campaign-${scenario.id}`, createdAt: AT,
      });
      expect(campaign.scenario).toMatchObject(scenario);
      expect(campaign.scenario.fixtureSha256)
        .toBe(getCompanyBenchmarkScenario(scenario.id).fixtureSha256);
      expect(campaign.armOrder.map(({ armId }) => armId))
        .toEqual(["single-strong", "company-auto", "company-auto", "single-strong"]);
    }
  });

  it("accepts explicit artifact directories without treating them as connection ids", () => {
    expect(parseCompanyBenchmarkCommand(["company", "--configured", "--allow-network", "--scenario", "queue_cancellation", "--artifacts", "/tmp/recurs trial artifacts"]))
      .toMatchObject({ artifactsDirectory: "/tmp/recurs trial artifacts", scenarioId: "queue_cancellation" });
    expect(() => parseCompanyBenchmarkCommand(["company", "--list", "--artifacts", "/tmp/artifacts"])).toThrow();
  });

  it("requires explicit configured network authority and freezes resume inputs", () => {
    expect(parseCompanyBenchmarkCommand([
      "company", "--configured", "--allow-network", "--repetitions", "2",
    ])).toEqual({
      action: "run",
      scenarioId: "alias_registry",
      connectionId: null,
      roleConnectionIds: {},
      repetitions: 2,
      compareAllStrong: false,
      json: false,
    });
    expect(parseCompanyBenchmarkCommand([
      "company", "--configured", "--allow-network", "--compare-all-strong",
    ])).toMatchObject({
      action: "run",
      compareAllStrong: true,
    });
    expect(parseCompanyBenchmarkCommand([
      "company", "--resume", "company-proof-1", "--allow-network", "--json",
    ])).toEqual({
      action: "resume",
      campaignId: "company-proof-1",
      json: true,
    });
    expect(() => parseCompanyBenchmarkCommand([
      "company", "--configured",
    ])).toThrow("--allow-network");
    expect(() => parseCompanyBenchmarkCommand([
      "company", "--resume", "company-proof-1", "--allow-network",
      "--connection", "changed",
    ])).toThrow("frozen campaign");
    expect(() => parseCompanyBenchmarkCommand([
      "company", "--resume", "company-proof-1", "--allow-network",
      "--compare-all-strong",
    ])).toThrow("frozen campaign");
    expect(() => parseCompanyBenchmarkCommand([
      "company", "--list", "--compare-all-strong",
    ])).toThrow("--list can be combined only with --json");
    expect(renderCompanyBenchmarkScenarios(false)).toContain(
      "alias_registry v1",
    );
    expect(parseCompanyBenchmarkCommand([
      "company", "--configured", "--allow-network",
      "--scenario", "layered_config",
    ])).toMatchObject({
      action: "run",
      scenarioId: "layered_config",
    });
    expect(() => parseCompanyBenchmarkCommand([
      "company", "--configured", "--allow-network",
      "--scenario", "missing",
    ])).toThrow("Unknown company benchmark scenario");
  });

  it("keeps the strong baseline fixed while selecting each company role independently", () => {
    expect(parseCompanyBenchmarkCommand([
      "company",
      "--configured",
      "--allow-network",
      "--connection",
      "sol-high",
      "--parent-connection",
      "terra-high",
      "--implement-connection",
      "terra-medium",
      "--review-connection",
      "luna-high",
      "--repair-connection",
      "sol-medium",
    ])).toEqual({
      action: "run",
      scenarioId: "alias_registry",
      connectionId: "sol-high",
      roleConnectionIds: {
        parent: "terra-high",
        implement: "terra-medium",
        review: "luna-high",
        repair: "sol-medium",
      },
      repetitions: 3,
      compareAllStrong: false,
      json: false,
    });
  });

  it("builds a canonical alternating campaign from exact saved role routes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-benchmark-command-"));
    roots.push(root);
    const parent = connection("sol-parent", "gpt-5.6-sol", "high");
    const worker = connection("terra-workers", "gpt-5.6-terra", "medium");
    const registry = new FileConnectionRegistry(root);
    await registry.commit(0, (draft) => {
      draft.connections.push(parent, worker);
      draft.primaryConnectionId = parent.id;
      draft.agentRoutes = {
        implement: worker.id,
        review: worker.id,
        repair: worker.id,
      };
    });

    const campaign = createConfiguredCompanyBenchmarkCampaign({
      document: await registry.inspect(),
      scenarioId: "layered_config",
      connectionId: null,
      repetitions: 2,
      compareAllStrong: false,
      campaignId: "company-proof-test",
      createdAt: AT,
    });

    expect(campaign.armOrder.map((slot) => slot.armId)).toEqual([
      "single-strong",
      "company-auto",
      "company-auto",
      "single-strong",
    ]);
    expect(campaign.scenario.id).toBe("layered_config");
    expect(campaign.blueprint.sha256).toBe(companyBenchmarkBlueprintDigest(
      createCompanyBenchmarkBlueprint(
        getCompanyBenchmarkScenario("layered_config", 1),
      ),
    ));
    expect(campaign.baseline.configuredRoutes).toEqual([
      expect.objectContaining({
        role: "parent",
        connectionId: parent.id,
        modelId: parent.modelId,
      }),
    ]);
    expect(campaign.companyArms.map((arm) => arm.id)).toEqual(["company-auto"]);
    expect(Object.hasOwn(campaign, "comparisonDesign")).toBe(false);
    expect(campaign.companyArms[0]?.configuredRoutes.map((route) => [
      route.role,
      route.connectionId,
    ])).toEqual([
      ["parent", parent.id],
      ["implement", worker.id],
      ["review", worker.id],
      ["repair", worker.id],
    ]);
    expect(campaign.ceilings).toEqual({
      maxTrialSlots: 4,
      maxRequests: 384,
      maxReportedCostUsd: 12,
    });

    const expanded = createConfiguredCompanyBenchmarkCampaign({
      document: await registry.inspect(),
      scenarioId: "layered_config",
      connectionId: null,
      repetitions: 2,
      compareAllStrong: true,
      campaignId: "company-proof-test-expanded",
      createdAt: AT,
    });
    expect(expanded.companyArms.map((arm) => arm.id)).toEqual([
      "company-auto",
      "company-strong",
    ]);
    expect(expanded.armOrder.map((slot) => slot.armId)).toEqual([
      "single-strong",
      "company-auto",
      "company-strong",
      "company-strong",
      "company-auto",
      "single-strong",
    ]);
    expect(expanded.ceilings).toEqual({
      maxTrialSlots: 6,
      maxRequests: 576,
      maxReportedCostUsd: 18,
    });
  });

  it("freezes an independently selected company parent without changing the baseline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-benchmark-command-"));
    roots.push(root);
    const baseline = connection("sol-high", "gpt-5.6-sol", "high");
    const companyParent = connection("terra-high", "gpt-5.6-terra", "high");
    const worker = connection("luna-medium", "gpt-5.6-luna", "medium");
    const registry = new FileConnectionRegistry(root);
    await registry.commit(0, (draft) => {
      draft.connections.push(baseline, companyParent, worker);
      draft.primaryConnectionId = baseline.id;
    });

    const campaign = createConfiguredCompanyBenchmarkCampaign({
      document: await registry.inspect(),
      scenarioId: "layered_config",
      connectionId: baseline.id,
      roleConnectionIds: {
        parent: companyParent.id,
        implement: worker.id,
        review: worker.id,
        repair: companyParent.id,
      },
      repetitions: 3,
      compareAllStrong: false,
      campaignId: "company-proof-independent-parent",
      createdAt: AT,
    });

    expect(campaign.baseline.configuredRoutes[0]).toMatchObject({
      connectionId: baseline.id,
      modelId: baseline.modelId,
    });
    expect(campaign.comparisonDesign).toBe(
      "independent_company_parent_v1",
    );
    expect(campaign.companyArms[0]?.configuredRoutes.map((item) => [
      item.role,
      item.connectionId,
    ])).toEqual([
      ["parent", companyParent.id],
      ["implement", worker.id],
      ["review", worker.id],
      ["repair", companyParent.id],
    ]);
  });

  it("routes the public JSON command without creating an ordinary runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-benchmark-command-"));
    roots.push(root);
    const parent = connection("sol-parent", "gpt-5.6-sol", "high");
    const registry = new FileConnectionRegistry(root);
    await registry.commit(0, (draft) => {
      draft.connections.push(parent);
      draft.primaryConnectionId = parent.id;
    });
    const campaign = createConfiguredCompanyBenchmarkCampaign({
      document: await registry.inspect(),
      scenarioId: "alias_registry",
      connectionId: null,
      repetitions: 1,
      compareAllStrong: false,
      campaignId: "company-proof-public-command",
      createdAt: AT,
    });
    const report = {
      version: 2 as const,
      campaign,
      summary: createCompanyBenchmarkSummary(campaign, []),
      trials: [],
      attribution: deriveCompanyBenchmarkFailureAttribution(campaign, []),
    };
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let requested = false;

    const code = await runCli([
      "benchmark",
      "company",
      "--configured",
      "--allow-network",
      "--repetitions",
      "1",
      "--json",
    ], {
      stdout,
      stderr,
      async createRuntime() {
        throw new Error("ordinary runtime must not start");
      },
      async benchmarkCompany(input) {
        requested = true;
        expect(input).toMatchObject({
          action: "run",
          compareAllStrong: false,
          scenarioId: "alias_registry",
          repetitions: 1,
          connectionId: null,
        });
        return report;
      },
    });

    expect(code).toBe(1);
    expect(requested).toBe(true);
    expect(JSON.parse(stdout.value)).toMatchObject({
      version: 2,
      campaign: { id: campaign.id },
      attribution: {
        version: 1,
        trialCounts: {
          reliability: 0,
          rosterInformative: 0,
          sharedParentBoundaryFailure: 0,
        },
      },
      trials: [],
    });
    expect(renderCompanyBenchmarkReport(report)).toContain(
      "Attribution: 0 reliability · 0 roster-informative · 0 shared-parent-boundary-failure trial(s)",
    );
    expect(stderr.value).toBe("");
  });
});
