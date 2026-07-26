import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import {
  FileConnectionRegistry,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import { CODEX_APP_SERVER_PROFILE_REVISION } from "@recurs/runtimes";
import { createCompanyBenchmarkSummary } from "@recurs/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createConfiguredCompanyBenchmarkCampaign,
  parseCompanyBenchmarkCommand,
  renderCompanyBenchmarkScenarios,
} from "../src/company-benchmark-command.js";
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
  it("requires explicit configured network authority and freezes resume inputs", () => {
    expect(parseCompanyBenchmarkCommand([
      "company", "--configured", "--allow-network", "--repetitions", "2",
    ])).toEqual({
      action: "run",
      connectionId: null,
      repetitions: 2,
      json: false,
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
    expect(renderCompanyBenchmarkScenarios(false)).toContain(
      "alias_registry v1",
    );
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
      connectionId: null,
      repetitions: 2,
      campaignId: "company-proof-test",
      createdAt: AT,
    });

    expect(campaign.armOrder.map((slot) => slot.armId)).toEqual([
      "single-strong",
      "company-auto",
      "company-auto",
      "single-strong",
    ]);
    expect(campaign.baseline.configuredRoutes).toEqual([
      expect.objectContaining({
        role: "parent",
        connectionId: parent.id,
        modelId: parent.modelId,
      }),
    ]);
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
      connectionId: null,
      repetitions: 1,
      campaignId: "company-proof-public-command",
      createdAt: AT,
    });
    const report = {
      version: 1 as const,
      campaign,
      summary: createCompanyBenchmarkSummary(campaign, []),
      trials: [],
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
          repetitions: 1,
          connectionId: null,
        });
        return report;
      },
    });

    expect(code).toBe(1);
    expect(requested).toBe(true);
    expect(JSON.parse(stdout.value)).toMatchObject({
      version: 1,
      campaign: { id: campaign.id },
      trials: [],
    });
    expect(stderr.value).toBe("");
  });
});
