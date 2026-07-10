import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createHostInvocation,
  deriveTrustedRunContext,
} from "../src/index.js";

async function packageManifest(
  relativePath: string,
): Promise<{ dependencies?: Record<string, string> }> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
}

describe("provider-neutral contracts", () => {
  it("derives every trusted context dimension from a host-only invocation", () => {
    const invocation = createHostInvocation({
      invocation: "one_shot",
      userPresent: false,
      remote: true,
      scripted: true,
      embedding: "ci",
    });

    expect(deriveTrustedRunContext(invocation)).toEqual({
      invocation: "one_shot",
      presence: "unattended",
      location: "remote",
      automation: "scripted",
      embedding: "ci",
    });
  });

  it("rejects a structurally forged host invocation at runtime", () => {
    expect(() => deriveTrustedRunContext({
      invocation: "one_shot",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    } as never)).toThrow("trusted host");
  });

  it("keeps contracts as a dependency leaf", async () => {
    const contracts = await packageManifest("../package.json");
    const providers = await packageManifest("../../providers/package.json");
    const tools = await packageManifest("../../tools/package.json");

    expect(contracts.dependencies).toBeUndefined();
    expect(providers.dependencies).toEqual({ "@recurs/contracts": "0.0.0" });
    expect(tools.dependencies).toEqual({ "@recurs/contracts": "0.0.0" });
  });
});
