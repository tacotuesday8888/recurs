import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileConnectionRegistry,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import { afterEach, describe, expect, it } from "vitest";

import {
  listAccountSummaries,
  listProviderSummaries,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("provider and account projections", () => {
  it("lists the truthful runnable/broker catalog without making blocked paths ready", () => {
    const normal = listProviderSummaries(false);
    const all = listProviderSummaries(true);
    expect(normal.length).toBeLessThan(all.length);
    expect(normal.find((entry) => entry.id === "openai-codex-chatgpt"))
      .toMatchObject({
        status: "runnable",
        accessKind: "subscription",
        adapterKind: "agent_runtime",
        connectionOwner: "vendor_runtime",
        billing: {
          primarySource: "included_subscription",
          possibleAdditionalSources: ["prepaid_credits"],
          providerFallback: "automatic",
        },
      });
    expect(normal.find((entry) => entry.id === "openai-api"))
      .toMatchObject({
        status: "requires_native_broker",
        connectionOwner: "recurs_broker",
      });
    expect(all.some((entry) => entry.status === "blocked")).toBe(true);
  });

  it("returns useful account metadata while omitting account identifiers and endpoints", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-account-list-"));
    directories.push(directory);
    const email = "private-owner@example.com";
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const record: DelegatedConnectionRecord = {
      kind: "delegated_agent",
      id: "codex-1",
      providerId: "openai-codex-chatgpt",
      adapterId: "codex-acp",
      label: "Codex with ChatGPT",
      accountLabel: email,
      organizationLabel: null,
      modelId: "gpt-test",
      accountSubjectFingerprint: fingerprint,
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
        acknowledgedAt: "2026-07-11T00:00:00.000Z",
      },
      verifiedAt: "2026-07-11T00:00:00.000Z",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    };
    const registry = new FileConnectionRegistry(directory);
    await registry.commit(0, (draft) => {
      draft.connections.push(record);
      draft.primaryConnectionId = record.id;
    });

    const summaries = await listAccountSummaries(directory);
    expect(summaries).toEqual([{
      id: "codex-1",
      label: "Codex with ChatGPT",
      providerId: "openai-codex-chatgpt",
      adapterId: "codex-acp",
      kind: "delegated_agent",
      modelId: "gpt-test",
      primary: true,
      account: "verified (identifier redacted)",
      execution: "Plan-only",
      billingSources: ["included_subscription", "prepaid_credits"],
    }]);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(fingerprint);
    expect(serialized).not.toContain("accountLabel");
    expect(serialized).not.toContain("organizationLabel");
  });
});
