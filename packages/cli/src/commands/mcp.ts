import { deriveTrustedRunContext } from "@recurs/contracts";

import type { McpServerCatalog } from "../mcp-client.js";
import { message, type Command } from "./types.js";

function canManageProjectTrust(command: Parameters<Command["execute"]>[1]): boolean {
  try {
    const invocation = deriveTrustedRunContext(command.invocation);
    return invocation.presence === "present" && invocation.location === "local" &&
      invocation.automation === "manual" &&
      (invocation.embedding === "cli" || invocation.embedding === "desktop");
  } catch {
    return false;
  }
}

function renderCatalog(catalog: McpServerCatalog): string {
  const snapshot = catalog.snapshot();
  if (snapshot.servers.length === 0) {
    return [
      "No MCP servers configured.",
      `User config: ${snapshot.configPath}`,
      ...(snapshot.projectConfigPath === undefined
        ? ["Project config: .recurs/mcp-servers.json (not found)"]
        : [
            `Project config: ${snapshot.projectConfigPath}${snapshot.projectTrust === "absent" ? " (not found)" : ""}`,
            `Project trust: ${snapshot.projectTrust}`,
          ]),
      "Remote transports and OAuth are not enabled.",
      ...(snapshot.warnings.length === 0
        ? []
        : ["Warnings:", ...snapshot.warnings.map((warning) => `- ${warning}`)]),
    ].join("\n");
  }
  return [
    "MCP servers (persistent stdio):",
    ...snapshot.servers.map((server) =>
      [
        `${server.enabled ? "enabled " : "disabled"}  ${server.id}  ${server.description}  source:${server.source}  ${server.state}  network:${server.network}`,
        `  command:${server.command}  args:${server.args.length}`,
        ...(server.enabled && server.state === "connected"
          ? [`  ${server.serverName}@${server.serverVersion} · MCP ${server.protocolVersion}`]
          : []),
      ].join("\n")
    ),
    `User config: ${snapshot.configPath}`,
    ...(snapshot.projectConfigPath === undefined
      ? ["Project config: .recurs/mcp-servers.json (not found)"]
      : [
          `Project config: ${snapshot.projectConfigPath}${snapshot.projectTrust === "absent" ? " (not found)" : ""}`,
          `Project trust: ${snapshot.projectTrust}`,
        ]),
    ...(snapshot.projectTrust === "untrusted" || snapshot.projectTrust === "stale"
      ? ["Run /mcp trust-project from the local interactive CLI to trust this exact project configuration."]
      : []),
    "Servers start only after normal shell/network permission checks, stay scoped to this Recurs runtime, and close with it.",
    "A reused session must answer MCP ping before another operation. Failed health checks restart before, never during, a tool call.",
    ...(snapshot.warnings.length === 0
      ? []
      : ["Warnings:", ...snapshot.warnings.map((warning) => `- ${warning}`)]),
  ].join("\n");
}

export function createMcpCommand(catalog: McpServerCatalog): Command {
  return {
    name: "mcp",
    description: "Inspect MCP servers or manage exact project-config trust",
    usage: "/mcp [list|trust-project|untrust-project]",
    async execute(args, context) {
      const action = args.trim().toLowerCase();
      if (action.length === 0 || action === "list") {
        return message(renderCatalog(catalog));
      }
      if (action !== "trust-project" && action !== "untrust-project") {
        return message(
          "Usage: /mcp [list|trust-project|untrust-project]",
          "error",
        );
      }
      if (!canManageProjectTrust(context)) {
        return message(
          "Project MCP trust can only be changed from a local, user-present interactive CLI or desktop session",
          "error",
        );
      }
      if (action === "untrust-project") {
        try {
          await catalog.untrustProject();
        } catch {
          return message("Project MCP trust could not be removed safely", "error");
        }
        return message(`Project MCP configuration is untrusted\n${renderCatalog(catalog)}`);
      }
      const snapshot = catalog.snapshot();
      if (snapshot.projectTrust === "invalid") {
        return message("Project MCP configuration is not trustable; inspect /mcp warnings", "error");
      }
      if (!catalog.hasProjectServers) {
        return message("No project MCP servers were found", "warning");
      }
      if (!(await context.confirm(
        "Trust this workspace's exact project MCP configuration? Its servers can execute commands only after normal shell/network approval, and any config change invalidates persistent trust.",
      ))) {
        return message("Project MCP configuration remains untrusted", "warning");
      }
      try {
        await catalog.trustProject();
      } catch {
        return message("Project MCP trust could not be stored safely", "error");
      }
      return message(`Project MCP configuration trusted\n${renderCatalog(catalog)}`);
    },
  };
}
