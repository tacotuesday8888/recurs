import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PermissionRuleConfigurationError,
  inspectPermissionRules,
  loadWorkspacePermissionRules,
  renderPermissionRuleStatus,
} from "../src/permission-rules.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixture(): Promise<{
  data: string;
  workspace: string;
  otherWorkspace: string;
  config: string;
}> {
  const created = await mkdtemp(path.join(tmpdir(), "recurs-permission-rules-"));
  directories.push(created);
  const root = await realpath(created);
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  await Promise.all([
    mkdir(path.join(data, "config"), { recursive: true, mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
    mkdir(otherWorkspace, { mode: 0o700 }),
  ]);
  return {
    data,
    workspace,
    otherWorkspace,
    config: path.join(data, "config", "permissions.json"),
  };
}

async function writeConfig(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  await chmod(filename, 0o600);
}

describe("workspace permission rules", () => {
  it("selects only exact-workspace rules and redacts resources from status", async () => {
    const { data, workspace, otherWorkspace, config } = await fixture();
    await writeConfig(config, {
      version: 1,
      workspaces: [
        {
          workspace,
          rules: [
            {
              id: "tests",
              decision: "allow",
              category: "shell",
              resource: "npm test -- PRIVATE_ARGUMENT",
              risk: "normal",
            },
            {
              id: "no-deploy",
              decision: "deny",
              category: "deploy",
              resource: "production",
              risk: "elevated",
            },
          ],
        },
        { workspace: otherWorkspace, rules: [] },
      ],
    });

    await expect(loadWorkspacePermissionRules(data, workspace)).resolves.toEqual([
      {
        id: "tests",
        decision: "allow",
        intent: {
          category: "shell",
          resource: "npm test -- PRIVATE_ARGUMENT",
          risk: "normal",
        },
      },
      {
        id: "no-deploy",
        decision: "deny",
        intent: { category: "deploy", resource: "production", risk: "elevated" },
      },
    ]);
    const status = await inspectPermissionRules(data, workspace);
    const testResourceHash = createHash("sha256")
      .update("npm test -- PRIVATE_ARGUMENT")
      .digest("hex");
    const deployResourceHash = createHash("sha256")
      .update("production")
      .digest("hex");
    expect(status).toEqual({
      version: 1,
      type: "permission_rules",
      configured: true,
      configFile: "$RECURS_HOME/config/permissions.json",
      rules: [
        {
          id: "tests",
          decision: "allow",
          category: "shell",
          risk: "normal",
          resourceSha256: testResourceHash,
        },
        {
          id: "no-deploy",
          decision: "deny",
          category: "deploy",
          risk: "elevated",
          resourceSha256: deployResourceHash,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("PRIVATE_ARGUMENT");
    expect(JSON.stringify(status)).not.toContain(workspace);
    expect(renderPermissionRuleStatus(status)).toContain(
      "Matching: exact workspace + category + resource + risk",
    );
    expect(renderPermissionRuleStatus(status)).toContain(
      `sha256:${testResourceHash.slice(0, 12)}`,
    );
  });

  it("rejects credential rules, destructive allows, duplicate matches, and unknown fields", async () => {
    const { data, workspace, config } = await fixture();
    const cases = [
      [{ id: "credential", decision: "deny", category: "credential", resource: ".env", risk: "elevated" }],
      [{ id: "destroy", decision: "allow", category: "shell", resource: "rm -rf .", risk: "destructive" }],
      [
        { id: "first", decision: "allow", category: "shell", resource: "npm test", risk: "normal" },
        { id: "second", decision: "deny", category: "shell", resource: "npm test", risk: "normal" },
      ],
    ];
    for (const rules of cases) {
      await writeConfig(config, { version: 1, workspaces: [{ workspace, rules }] });
      await expect(loadWorkspacePermissionRules(data, workspace)).rejects
        .toBeInstanceOf(PermissionRuleConfigurationError);
    }
    await writeConfig(config, { version: 1, workspaces: [], extra: true });
    await expect(loadWorkspacePermissionRules(data, workspace)).rejects
      .toBeInstanceOf(PermissionRuleConfigurationError);
  });

  it("treats an absent configuration or unmatched workspace as no rules", async () => {
    const { data, workspace, otherWorkspace, config } = await fixture();
    await expect(loadWorkspacePermissionRules(data, workspace)).resolves.toEqual([]);
    await writeConfig(config, {
      version: 1,
      workspaces: [{ workspace: otherWorkspace, rules: [] }],
    });
    await expect(loadWorkspacePermissionRules(data, workspace)).resolves.toEqual([]);
    await expect(inspectPermissionRules(data, workspace)).resolves.toMatchObject({
      configured: false,
      rules: [],
    });
  });

  it("rejects a non-private configuration", async () => {
    const { data, workspace, config } = await fixture();
    await writeConfig(config, { version: 1, workspaces: [{ workspace, rules: [] }] });
    await chmod(config, 0o644);

    await expect(loadWorkspacePermissionRules(data, workspace)).rejects.toThrow(
      "private, owned, single-link regular file",
    );
  });
});
import { createHash } from "node:crypto";
