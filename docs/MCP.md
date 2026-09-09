# MCP servers

Recurs connects to local stdio servers and remote Streamable HTTP servers using
the official MCP TypeScript client SDK. Servers can expose tools, resources,
resource templates, and prompts. Their definitions and results remain untrusted
content; they do not change the user's instructions or agent permissions.

Manage extensions before connecting a model with `recurs mcp ...`, or use the
same commands inside the terminal as `/mcp ...`.

## Add and inspect

Add an HTTP server with an explicit definition:

```sh
recurs mcp add user '{"id":"docs","description":"Documentation server","transport":"http","url":"https://example.com/mcp"}'
recurs mcp inspect docs
recurs mcp diagnose docs
```

Replace the example URL with your server's documented MCP endpoint. `diagnose`
connects and lists advertised capabilities after normal permission checks; it
does not call a server tool. A server exposing only resources or prompts is
valid.

A local server needs an absolute executable path and an argument array:

```sh
recurs mcp add user '{"id":"local-docs","description":"Local documentation","command":"/absolute/path/to/node","args":["/absolute/path/to/server.mjs"],"network":"deny"}'
```

The executable is launched directly, without shell expansion. Stdio runs with
Recurs's isolated process environment and applicable workspace sandbox. Host
credentials and the owner's normal home directory are not inherited. Servers
that need their own credentials must provide a supported explicit authentication
mechanism; arbitrary environment forwarding and inline secret fields are not
supported. Prefer the server's HTTP OAuth interface when available.

## Scope and trust

| Scope | Configuration | Activation |
| --- | --- | --- |
| User | `$RECURS_HOME/config/mcp-servers.json` | Enabled definitions are available to that user |
| Project | `<workspace>/.recurs/mcp-servers.json` | Disabled until the local user trusts the exact file |

The user config is a private, owned `0600` file. Project config can be committed
and uses `0644`. Recurs rejects unsafe symlinks, hard links, ownership, file
modes, and oversized or invalid documents. An ID collision preserves the user
server and disables the entire project configuration until the conflict is
renamed. The catalog reports this explicitly.

```sh
recurs mcp add project '{"id":"project-docs","description":"Project documentation","transport":"http","url":"https://example.com/mcp"}'
recurs mcp list
recurs mcp trust-project
recurs mcp untrust-project
```

Trust is bound to the canonical workspace and the exact configuration bytes.
Any file change, including one made by `configure`, `enable`, or `disable`,
requires renewed project trust. Revoking trust aborts active project operations
and closes their connections. Trust does not bypass shell or network approval.

The configuration document remains version 1. Existing stdio definitions remain
valid; omitted `transport` means `stdio`, omitted `enabled` means `true`, and
stdio `network` defaults to `deny`. HTTP connections require network access.

```json
{
  "version": 1,
  "servers": [
    {
      "id": "docs",
      "description": "Documentation server",
      "transport": "http",
      "url": "https://example.com/mcp",
      "network": "allow",
      "enabled": true
    }
  ]
}
```

## Configure, disable, and remove

`configure` replaces one existing definition in the named scope; include its
complete definition. These commands update the live catalog and persist changes.

```sh
recurs mcp configure user '{"id":"docs","description":"Updated documentation","transport":"http","url":"https://example.com/new-mcp"}'
recurs mcp disable user docs
recurs mcp enable user docs
recurs mcp remove user docs
recurs mcp reload
```

`remove` removes the selected configuration and clears its local OAuth
credentials. `logout` only clears local OAuth credentials; it does not revoke
grants at the authorization service. Use that service's account controls if
you also want to revoke an existing grant.

## OAuth authentication

```sh
recurs mcp auth docs
recurs mcp inspect docs
recurs mcp logout docs
```

`auth` prints the authorization URL. Open it in your browser, complete the
server's consent flow, and return to Recurs. A temporary callback listens only
on `127.0.0.1`, checks a random state value, and expires after five minutes.
The official SDK handles discovery, PKCE, authorization-server issuer checks,
resource indicators, token exchange, and refresh. Recurs keeps tokens in private
`$RECURS_HOME/auth/mcp/<connection-hash>/credentials` files, outside project
configuration. Credentials are not shown by the catalog. The guarded host
profile is not an OS sandbox; use workspace isolation for enforced subprocess
credential separation.

Public native clients can supply an `oauthClientId` in an HTTP definition when
the server requires pre-registration. The registered client must permit native
loopback callbacks with an ephemeral port. Otherwise Recurs uses the SDK's
supported dynamic client registration flow. Recurs does not publish a client
metadata document or silently register accounts with an unrelated service.

The CLI waits for the callback. In an interactive terminal, `/mcp auth docs`
returns the URL while the callback remains active; `/mcp inspect docs` reports
the outcome. Interrupting the CLI or closing Recurs cancels pending login.
Expired credentials are refreshed when possible. If renewed browser consent
is needed, run `auth` again. A failed or ambiguous server tool call is never
blindly replayed.

## Agent access and runtime behavior

The model receives the enabled server catalog and uses `mcp` with a server ID
and an action:

| Action | Additional inputs |
| --- | --- |
| `list_tools` | None |
| `call_tool` | `tool`, optional object `arguments` |
| `list_resources` | None |
| `list_resource_templates` | None |
| `read_resource` | `uri` |
| `list_prompts` | None |
| `get_prompt` | `prompt`, optional string-valued `arguments` |

Company capability bundles can bind an enabled server ID to an approved role.
Access checks apply when the tool is exposed, permission-checked, and executed.
Normal agent tool policies and inherited permission ceilings still apply.
MCP operations require Act mode; server connection or discovery may itself
launch a process or contact a network service.

Connections are reused within the runtime and checked before subsequent
operations. A failed health check can reconnect before an operation starts.
Cancellation closes the affected connection; stdio descendant processes remain
owned by Recurs and are cleaned up. Catalog edits and shutdown close live
connections. Discovery is bounded to 128 items and eight pages; individual
results are capped at 256 KiB and transport messages at 512 KiB. Operations
have a 30-second budget. Stdio sessions also have an 8 MiB lifetime output cap.

## Compatibility and troubleshooting

The SDK negotiates the 2026-07-28 protocol and falls back to supported legacy
initialization. Both JSON and SSE responses on Streamable HTTP are accepted.
Legacy standalone HTTP+SSE endpoints are not supported. Server-initiated
sampling, elicitation, and roots are not advertised; prompts and resources
remain explicit model actions. Binary content is returned as protocol data;
Recurs does not promise a renderer for every third-party content type.

HTTP endpoints require HTTPS with public DNS addresses, or explicit loopback
HTTP. DNS answers are verified and pinned to the connection. Server-provided
OAuth metadata cannot grant access to private networks or a different local
service. URLs cannot contain credentials, query strings, or fragments. Redirects
and compressed HTTP responses are rejected; configure the final MCP endpoint.
These boundaries currently exclude private-network HTTP services beyond an
explicit loopback endpoint and some deployments requiring custom headers.

If a server is unavailable:

1. Run `inspect` and check its scope, enabled state, URL or executable, and project trust.
2. Run `reload` after editing configuration by hand, then renew project trust if needed.
3. Run `diagnose` in Act mode and allow the required shell/network access.
4. For protected HTTP, run `auth` and complete the browser callback.
5. Check the server's transport, protocol, and response-size requirements.

Compatibility evidence includes isolated stdio fixtures for trust, permissions,
pagination, reuse, cancellation, and descendant cleanup; loopback legacy and
2026 HTTP fixtures for tools/resources/prompts; and a local OAuth issuer for
PKCE, state rejection, private persistence, restart, token refresh, and logout.
This is standards-based extensibility, not a claim that every third-party MCP
server has been tested.
