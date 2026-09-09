# MCP release acceptance — 2026-09-08

## Decision and implementation

Retained Recurs's owned process sessions, isolated environment, project trust,
role access checks, and tool permission boundary. Replaced the custom MCP
JSON-RPC implementation with the official `@modelcontextprotocol/client` 2.0.0
SDK behind a Recurs-owned stdio adapter. This preserves descendant cleanup and
prevents the SDK from creating an unsandboxed sibling process during protocol
negotiation.

The SDK's current stable v2 line implements the 2026-07-28 protocol and supports
legacy negotiation. Its package metadata declares MIT while its shipped license
records an Apache-2.0 transition with retained MIT contributions; notices state
both, and the package remains an external runtime dependency. Versions were
verified through npm and the installed package, not inferred from a monorepo
release name. Sources: [official SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[current HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

Added live/persistent server lifecycle management, Streamable HTTP,
capability-aware tools/resources/resource templates/prompts, and browser OAuth.
Existing version-1 stdio configurations continue to load. Explicit user/project
scope and collision behavior remain visible. Management works through slash
commands and the parent integration's `recurs mcp` entry point.

## Executed evidence

| Check | Result |
| --- | --- |
| `npx tsc -b --pretty false` | Passed |
| Focused ESLint for the five MCP source modules, command, and new integration tests | Passed |
| Existing `mcp-client.test.ts` | 19 tests passed, including real parent-loop execution, project trust, permissions, cancellation, health checks, and descendant cleanup |
| New `mcp-extensions.test.ts` | 11 tests passed: lifecycle persistence, exact project trust invalidation, modern/legacy HTTP, resources-only servers, role/network denial, SSRF prevention, cancellation/no ambiguous replay, OAuth PKCE/state/persistence/refresh/logout, project revocation, and delayed token/refresh cancellation |
| Live DeepWiki HTTPS discovery | Passed; negotiated MCP `2025-11-25`, listed `ask_question`, `read_wiki_contents`, and `read_wiki_structure` |

The native subprocess tests and local HTTP fixtures were run outside the agent's
outer execution sandbox. The outer sandbox otherwise blocks macOS sandbox
nesting and loopback listeners; tests were not weakened or skipped to bypass
those restrictions. All fixture configuration and credentials were under
fresh temporary directories and removed afterward. One original parent-loop
test read the real home skill catalog despite a temporary data directory; it
now passes an explicit empty `skillHomeDirectory`.

The DeepWiki check used its documented free, no-auth Streamable HTTP endpoint
`https://mcp.deepwiki.com/mcp` and a fresh temporary catalog. It listed tools
only: no model-powered question, private repository, account changes, or
personal configuration. Endpoint source:
[DeepWiki documentation](https://docs.devin.ai/work-with-devin/deepwiki-mcp).

OAuth was verified against an independently implemented local issuer, including
SHA-256 PKCE verification and resource-indicator inspection at the token
endpoint, an invalid-state callback, CLI restart with saved tokens, and an
expired-token refresh. This proves protocol behavior with deterministic
fixtures; it does not claim a successful login to every commercial service.

## Final safety review and closures

The review covered actual file paths and invocation paths, not only command
output. Confirmed issues and their fixes:

- **Credential discovery:** OAuth state uses
  `<data>/auth/mcp/<connection-hash>/credentials`; the protected basename applies
  to direct read/search/path handling. Atomic staging also uses the exact
  `credentials` basename inside a private per-write directory, avoiding a
  temporary unprotected filename.
- **Subprocess reads:** the execution review added dynamic denied-read roots to
  the workspace sandbox. The real `<data>/auth` directory is prepared before
  tool processes can start; MCP's own stdio/diagnostic path adds the same root
  to inherited masks. Custom data-directory locations are covered. Guarded
  host mode remains explicitly uncontained, as documented.
- **OAuth metadata SSRF:** a public MCP endpoint cannot grant access to loopback
  or private networks through discovery, registration, token, or browser
  authorization URLs. The transport reuses Recurs's public-address validation
  and pins verified DNS answers to socket lookup. Explicit loopback servers
  can use only their own local origin; other destinations must be public HTTPS.
- **Late token persistence:** login cancellation, project trust revocation,
  connection closure, and logout abort OAuth HTTP operations. Credential
  persistence checks the connection/flow signal before atomic rename. Tests
  delay both authorization-code exchange and refresh, then cancel/logout and
  verify that credentials do not reappear.
- **Collision trust escalation:** previously, `untrustProject()` could turn an
  invalid project/user ID collision into a trustable state. Invalid state is
  now retained, `trustProject()` checks collisions independently, and project
  revocation cannot act on the colliding user server. A regression exercises
  untrust followed by trust.
- **Metadata compatibility:** legitimate multiline tool descriptions and
  resource-only servers now work through SDK schemas; the previous custom
  client rejected them.
- **Authorization ceilings:** enabled state, project digest, and approved role
  server IDs are rechecked at exposure, permission checks, and execution.
  Callback startup also rechecks authority before returning a login URL.
  Server results do not grant authority, and authentication material is absent
  from catalog output. Inspection reports argument counts instead of echoing
  potentially sensitive process arguments.

## Supported boundaries and remaining limits

- Streamable HTTP supports JSON and request SSE responses, including the current
  protocol and legacy initialization. Legacy standalone HTTP+SSE is not exposed.
- Server-side sampling, elicitation, roots, subscription UI, and arbitrary
  extension-specific methods are not advertised. Unsupported capabilities fail
  explicitly. Discovery reads refresh the catalog instead of relying on stale
  results.
- Authentication supports public native OAuth clients, supported dynamic client
  registration, optional pre-registered client IDs, PKCE, issuer validation,
  resource indicators, token refresh, and explicit reauthentication. Client-ID
  metadata document hosting, client secrets, arbitrary custom headers, and
  generic stdio credential forwarding are not implemented.
- Remote URLs require public HTTPS or explicit loopback HTTP; credential-bearing
  URLs, query strings, fragments, redirects, compressed responses, and private
  network destinations are excluded. These are documented compatibility limits.
- Resources and prompts are returned as MCP protocol data. Binary content is
  not a promise of native rendering for every MIME type.
- Operations have a 30-second budget, discovery is capped at 128 items/eight
  pages, results at 256 KiB, messages at 512 KiB, and stdio lifetime output at
  8 MiB. Lost or cancelled tool calls are not replayed automatically.
- The focused extension checks do not replace the parent's final installed
  artifact smoke, full CI, merge verification, or package publication approval.
