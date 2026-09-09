import { randomUUID } from "node:crypto";
import { deriveTrustedRunContext } from "@recurs/contracts";
import { PermissionEngine, ToolRegistry } from "@recurs/tools";
import type { McpServerCatalog } from "../mcp-client.js";
import { message, type Command } from "./types.js";

function canManage(command: Parameters<Command["execute"]>[1]): boolean {
  try {
    const invocation = deriveTrustedRunContext(command.invocation);
    return invocation.presence === "present" && invocation.location === "local" &&
      invocation.automation === "manual" &&
      (invocation.embedding === "cli" || invocation.embedding === "desktop");
  } catch { return false; }
}

const USAGE = `/mcp [list|inspect <id>|reload|trust-project|untrust-project]
/mcp add <user|project> <JSON server definition>
/mcp configure <user|project> <JSON server definition>
/mcp <enable|disable|remove> <user|project> <id>
/mcp <diagnose|auth|logout> <id>
Example: /mcp add user {"id":"docs","description":"Documentation","transport":"http","url":"https://example.com/mcp"}
Stdio: use "command":"/absolute/path/to/server" and optional "args":["arg"].`;

function renderCatalog(catalog: McpServerCatalog, id?: string): string {
  const snapshot = catalog.snapshot();
  const servers = snapshot.servers.filter((server) => id === undefined || server.id === id);
  if (id !== undefined && servers.length === 0) return `No MCP server named ${id}`;
  return [
    servers.length === 0 ? "No MCP servers configured." : "MCP servers:",
    ...servers.map((server) => [
      `${server.enabled ? "enabled " : "disabled"}  ${server.id}  ${server.description}  source:${server.source}  ${server.state}  network:${server.network}`,
      server.transport === "http" ? `  HTTP ${server.url}` : `  stdio ${server.command}  args:${server.args.length}`,
      ...(server.protocolVersion ? [`  MCP ${server.protocolVersion} · ${server.serverName ?? "identity not supplied"}${server.serverVersion ? `@${server.serverVersion}` : ""}`] : []),
      ...(server.capabilities ? [`  Capabilities: ${server.capabilities.join(", ") || "none"}`] : []),
      ...(server.authentication ? [`  Authentication: ${server.authentication}`] : []),
    ].join("\n")),
    `User config: ${snapshot.configPath}`,
    `Project config: ${snapshot.projectConfigPath ?? ".recurs/mcp-servers.json (not found)"}`,
    `Project trust: ${snapshot.projectTrust}`,
    ...(snapshot.projectTrust === "untrusted" || snapshot.projectTrust === "stale"
      ? ["Inspect the definitions, then /mcp trust-project to trust this exact configuration."] : []),
    "User IDs take precedence: a collision disables the project configuration until renamed.",
    "MCP calls use normal permissions. Stdio processes close with Recurs; tool calls are never blindly retried.",
    ...snapshot.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}

export function createMcpCommand(catalog: McpServerCatalog): Command {
  return {
    name: "mcp",
    description: "Manage MCP servers, trust, discovery, and authentication",
    usage: USAGE,
    async execute(args, context) {
      const [action = "", ...parts] = args.trim().split(/\s+/u);
      if (action === "" || action === "list") return message(renderCatalog(catalog));
      if (action === "help") return message(USAGE);
      if (action === "inspect" && parts.length === 1) return message(renderCatalog(catalog, parts[0]));
      if (!canManage(context)) return message("MCP management requires a local, user-present interactive CLI or desktop session", "error");
      try {
        if (action === "reload") { await catalog.reload(); return message(renderCatalog(catalog)); }
        if (action === "trust-project") {
          if (catalog.snapshot().projectTrust === "invalid") return message("Project MCP configuration is not trustable; inspect /mcp warnings", "error");
          if (!catalog.hasProjectServers) return message("No project MCP servers were found", "warning");
          if (!(await context.confirm(`Trust this exact project MCP configuration? Its commands and network connections still require normal permissions. Any config change invalidates trust.\n${renderCatalog(catalog)}`))) return message("Project MCP configuration remains untrusted", "warning");
          await catalog.trustProject();
          return message(`Project MCP configuration trusted\n${renderCatalog(catalog)}`);
        }
        if (action === "untrust-project") { await catalog.untrustProject(); return message(`Project MCP configuration is untrusted\n${renderCatalog(catalog)}`); }
        if (action === "add" || action === "configure") {
          const scope = parts.shift();
          if (scope !== "user" && scope !== "project") return message(USAGE, "error");
          const definition: unknown = JSON.parse(args.trim().replace(/^\S+\s+\S+\s+/u, ""));
          await catalog.configure(scope, definition, action === "configure");
          return message(renderCatalog(catalog));
        }
        if (["enable", "disable", "remove"].includes(action)) {
          const [scope, id] = parts;
          if ((scope !== "user" && scope !== "project") || !id || parts.length !== 2) return message(USAGE, "error");
          if (action === "remove") await catalog.remove(scope, id);
          else await catalog.setEnabled(scope, id, action === "enable");
          return message(renderCatalog(catalog));
        }
        const [id] = parts;
        if (!id || parts.length !== 1) return message(USAGE, "error");
        if (action === "auth") {
          if (context.session.executionMode === "plan") return message("Switch to Act mode before authenticating an MCP connection", "error");
          const result = await catalog.authenticate(id);
          return message(`Open this URL to authorize ${id}:\n${result.url}\nThe callback expires in five minutes. /mcp inspect ${id} shows the result. Credentials stay in private user storage.`);
        }
        if (action === "logout") { await catalog.logout(id); return message(`Removed local OAuth credentials for ${id}`); }
        if (action === "diagnose") {
          const registry = new ToolRegistry([], { securityProfile: "workspace_sandboxed" });
          registry.register(catalog.createTool());
          const toolContext = {
            sessionId: context.session.id, cwd: context.session.cwd,
            executionMode: context.session.executionMode, signal: AbortSignal.timeout(30_000),
            readRevisions: new Map<string, string>(), runContext: deriveTrustedRunContext(context.invocation),
          };
          // Probe advertised capability categories independently: resource-only servers are valid.
          const details: string[] = [];
          for (const operation of ["list_tools", "list_resources", "list_prompts"] as const) {
            try {
              const result = await registry.invoke({ id: randomUUID(), name: "mcp", arguments: { server: id, action: operation } }, toolContext,
                new PermissionEngine(context.session.permissionMode), {
                  async request(intent) { return await context.confirm(`Allow ${intent.category} access to diagnose MCP server ${id}?`) ? "allow_once" : "deny"; },
                });
              const decoded = JSON.parse(result.output) as Record<string, unknown>;
              const field = operation.slice(5);
              details.push(`${field}: ${Array.isArray(decoded[field]) ? decoded[field].length : "connected"}`);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "tool_unavailable") { details.push(`${operation.slice(5)}: not advertised`); continue; }
              throw error;
            }
          }
          return message(`${renderCatalog(catalog, id)}\n${details.join("\n")}`);
        }
        return message(USAGE, "error");
      } catch (error) {
        // SDK/auth errors may contain URLs or server-controlled text. Do not echo secrets.
        return message(error instanceof Error && error.message.startsWith("MCP ")
          ? error.message : "MCP operation failed. Inspect the definition, permissions, connection, and authentication; use /mcp help for syntax.", "error");
      }
    },
  };
}
