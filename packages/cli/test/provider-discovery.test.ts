import { describe, expect, it } from "vitest";

import {
  providerDiscoveryOverview,
  providerOverviewText,
} from "../src/index.js";

describe("provider discovery presentation", () => {
  it("keeps local and connected discovery useful when the public catalog is offline", async () => {
    const overview = await providerDiscoveryOverview(
      "/tmp/unused",
      "kimi",
      undefined,
      {
        async listAccounts() {
          return [{
            id: "account-1",
            label: "Primary model",
            providerId: "local-openai-compatible",
            adapterId: "openai-chat-completions",
            kind: "local_openai_compatible",
            modelId: "coder",
            primary: true,
            account: "local endpoint",
            execution: "Act or Plan",
            billingSources: ["local_compute"],
          }];
        },
        async detectLocal() {
          return [{
            id: "ollama",
            name: "Ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            detected: true,
          }];
        },
        async fetchCatalog() {
          throw new Error("private network details");
        },
      },
    );
    const text = providerOverviewText(overview, "kimi");

    expect(text).toContain("* Primary model · coder");
    expect(text).toContain("Ollama · http://127.0.0.1:11434/v1");
    expect(text).toContain("public provider catalog is temporarily unavailable");
    expect(text).not.toContain("private network details");
  });

  it("labels remote catalog entries as discovery metadata, not activation", async () => {
    const overview = await providerDiscoveryOverview(
      "/tmp/unused",
      "coding",
      undefined,
      {
        async listAccounts() { return []; },
        async detectLocal() { return []; },
        async fetchCatalog() {
          return {
            source: "https://models.dev/api.json",
            providers: [{
              id: "example-coding-plan",
              name: "Example Coding Plan",
              wire: "openai-compatible",
              modelCount: 4,
              modelIds: ["coder-a", "coder-b", "coder-c", "coder-d"],
            }],
          };
        },
      },
    );
    const text = providerOverviewText(overview, "coding");

    expect(text).toContain("example-coding-plan — Example Coding Plan · 4 models");
    expect(text).toContain("not a claim that every provider is runnable");
  });
});
