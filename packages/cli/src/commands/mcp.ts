import type { McpServerCatalog } from "../mcp-client.js";
import { message, type Command } from "./types.js";

function renderCatalog(catalog: McpServerCatalog): string {
  const snapshot = catalog.snapshot();
  if (snapshot.servers.length === 0) {
    return [
      "No MCP servers configured.",
      `Config: ${snapshot.configPath}`,
      "Recurs v1 accepts private user-owned stdio server configuration only; project config and remote OAuth are not enabled.",
    ].join("\n");
  }
  return [
    "MCP servers (stdio, user configured):",
    ...snapshot.servers.map((server) =>
      `${server.id}  ${server.description}  network:${server.network}`
    ),
    `Config: ${snapshot.configPath}`,
    "Servers start only after normal shell/network permission checks. Their environment excludes host credentials.",
  ].join("\n");
}

export function createMcpCommand(catalog: McpServerCatalog): Command {
  return {
    name: "mcp",
    description: "Inspect user-configured MCP servers",
    usage: "/mcp",
    async execute(args) {
      if (args.trim().length > 0 && args.trim().toLowerCase() !== "list") {
        return message("Usage: /mcp [list]", "error");
      }
      return message(renderCatalog(catalog));
    },
  };
}
