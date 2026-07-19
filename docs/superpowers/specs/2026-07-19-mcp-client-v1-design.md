# MCP client v1 design

## Outcome

Recurs will expose one real, bounded MCP tool boundary to the direct-provider
parent agent. A user may configure local stdio MCP servers under
`$RECURS_HOME/config/mcp-servers.json`, inspect them with `/mcp`, and let the
agent list or call their tools through the existing permission engine and
normalized tool events.

This slice proves protocol interoperability without making repository content
executable by default or claiming a plugin marketplace, remote OAuth, or
recursive MCP delegation.

## Decisions

- Support stdio servers only. Streamable HTTP, OAuth, server installation,
  prompts, resources, sampling, elicitation, and project MCP configuration are
  intentionally absent.
- Read only the user-owned Recurs configuration. The file is bounded, must be a
  regular private file, and is validated against symlink, hard-link, owner,
  mode, and replacement races.
- Server commands are absolute executable paths with bounded literal arguments.
  Configuration cannot inject environment variables or a shell command.
- Each operation gets a fresh server process and always closes its process
  group. It runs with Recurs' isolated environment and the existing workspace
  sandbox where available. Parent credentials are not inherited.
- `network: "allow"` adds an explicit network permission intent. The default is
  `deny`. Starting any configured server always requires shell authority and is
  unavailable in Plan mode because initialization itself executes untrusted
  code.
- MCP server metadata, annotations, instructions, and results are untrusted
  data. They never grant Recurs permissions or change agent policy.
- The model gets one static `mcp` host tool with `list_tools` and `call_tool`
  actions. This avoids mutable tool schemas while still providing progressive
  discovery. Historical child profiles are not widened in this version.
- Implement the small stdio JSON-RPC subset directly against the published MCP
  protocol instead of taking the production v1 SDK dependency. The official
  package currently includes HTTP, OAuth, and server dependencies that this
  boundary neither needs nor authorizes. The subset still performs the standard
  initialize/initialized handshake, capability check, paginated `tools/list`,
  `tools/call`, JSON-RPC error handling, cancellation, timeouts, and strict
  result bounds.

## Configuration

```json
{
  "version": 1,
  "servers": [
    {
      "id": "example",
      "description": "Example local tools",
      "command": "/absolute/path/to/server",
      "args": [],
      "network": "deny"
    }
  ]
}
```

Server IDs are stable lowercase identifiers. Duplicate IDs, unknown fields,
unsafe text, non-absolute commands, oversized arguments, and excessive server
counts fail closed. A missing file means MCP is simply unconfigured; an unsafe
or malformed present file is reported rather than ignored.

## Runtime path

1. Assembly loads and validates the catalog before registering tools.
2. `/mcp` reports configured servers and the exact v1 safety limits without
   starting them.
3. The `mcp` host tool declares shell and optional network intents from the
   selected server before execution.
4. A managed process session creates the sanitized environment, applies the
   existing workspace sandbox policy, starts a detached process group, and
   bounds protocol stdout plus diagnostic stderr.
5. The client negotiates a supported MCP version, verifies the tools
   capability, performs one list/call operation, returns bounded JSON, and
   closes the full process group in `finally`.
6. Existing `tool_started`, `tool_completed`, and `tool_failed` events make the
   activity visible without inventing a parallel event system.

## Verification

- Configuration safety and rendering tests.
- A deterministic fake stdio server covering handshake, pagination, calls,
  protocol errors, output bounds, cancellation, secret isolation, and cleanup.
- Real agent-loop assembly tests for permission gating and normalized events.
- Full TypeScript check and native sealed-bundle verification. If the sealed
  native build cannot contain this boundary without ambient resolution, it must
  disable MCP honestly rather than weaken the bundle invariant.

## Next safe slice

After this boundary is stable: persistent user-approved server sessions and
health status, then separately authenticated Streamable HTTP. Project MCP
configuration requires its own explicit process-lifetime trust flow. Child and
team access requires versioned profile changes and parent-ceiling inheritance;
none of those are implied by v1.
