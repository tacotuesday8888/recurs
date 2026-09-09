# Release-readiness ecosystem decisions — September 2026

Research date: 2026-09-09 UTC. This is a source-backed decision record, not a
performance benchmark or a claim that upstream applications were executed.
Official release pages, source, tests, and specifications were inspected.
Repository HTTP access from the restricted shell failed DNS resolution; the
web reader supplied primary sources. Development-branch observations below
may postdate the listed release and are not claims about that release's binary.

## Version and license checkpoint

| Project | Latest stable release observed | License evidence |
| --- | --- | --- |
| Codex | [0.153.4](https://github.com/openai/codex/releases/tag/rust-v0.153.4) | [Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE) |
| OpenCode | [1.18.29](https://github.com/anomalyco/opencode/releases/tag/v1.18.29) | [MIT](https://github.com/anomalyco/opencode/blob/dev/LICENSE) |
| Pi | [0.85.1](https://github.com/earendil-works/pi/releases/tag/v0.85.1) | [MIT](https://github.com/earendil-works/pi/blob/main/LICENSE) |
| Gemini CLI | [0.58.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.58.0) | [Apache-2.0](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE) |
| Aider | [0.86.0](https://github.com/Aider-AI/aider/releases/tag/v0.86.0) | [Apache-2.0](https://github.com/Aider-AI/aider/blob/main/LICENSE.txt) |
| Goose | [1.49.0](https://github.com/aaif-goose/goose/releases/tag/v1.49.0) | [Apache-2.0](https://github.com/aaif-goose/goose/blob/main/LICENSE) |
| OpenTUI | [0.5.10](https://github.com/anomalyco/opentui/releases/tag/v0.5.10) | [MIT](https://github.com/anomalyco/opentui/blob/main/LICENSE) |
| Ink | [7.1.1](https://github.com/vadimdemedes/ink/releases/tag/v7.1.1) | [MIT](https://github.com/vadimdemedes/ink/blob/master/license) |

Pi's current canonical repository is `earendil-works/pi`; Goose's former
`block/goose` release endpoint redirects to `aaif-goose/goose`. Recurs currently
pins pi-tui 0.83.0 and Codex 0.145.0: a newer upstream version is evidence to
review compatibility, not permission to silently widen Recurs's exact pins.

The official MCP TypeScript SDK is now split into V2 packages. Its
[client manifest](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/package.json)
identifies `@modelcontextprotocol/client` 2.0.0, Node >=20, and a MIT package
field. However, the [repository license](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)
explicitly describes Apache-2.0 new contributions and retained MIT contributions;
the manifest alone is insufficient notice evidence. Inspect the selected packed
artifact's license before shipping. [V1 remains on the legacy v1.x branch](https://github.com/modelcontextprotocol/typescript-sdk#v1-legacy-documentation-and-fixes).
The repository's latest release can name a different package (Fastify), so it
must not be used as the client version. No package was installed by this research.

## Decisions grounded in implementation

**Retain the TypeScript core and pi-tui; replace the company-floor presentation.**
Recurs already separates provider contracts, orchestration, persistence, host
tools, and terminal projection. Its useful value lies in governed execution,
not a language rewrite. Pi's [renderer interface and components](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md)
provide main-screen scrollback, alternate-screen layout, overlays, completion,
and bracketed paste. Its [editor tests](https://github.com/earendil-works/pi/blob/main/packages/tui/test/editor.test.ts)
exercise undo restoring paste contents, marker navigation, literal expansion,
and markers wider than the viewport. These are concrete acceptance cases to
reuse conceptually in Recurs's own integration tests. Upstream's 0.85.1 release
also fixes autocomplete selection drift and accidental publication of internal
SDK dependencies: both argue for testing the exact installed package.

OpenTUI is a credible alternative with TypeScript bindings and native Zig
rendering, [documented native tests and benchmarks](https://github.com/anomalyco/opentui/blob/main/README.md).
It would introduce a different native/build and layout surface. Ink is another
maintained option, but neither has demonstrated a benefit for Recurs in this
investigation. Keep framework replacement conditional on measured defects that
cannot reasonably be fixed through the current renderer. Do not claim startup,
memory, or input-latency improvements without measurements.

**Represent executions independently of roles.** Recurs's initial terminal
projection presents activated company assignments while ordinary children and
batches also exist in the core. An execution registry should carry immutable
execution ID, parent execution ID, session ID, role ID, model, task, timestamps,
state, and available control capabilities. A role may have zero or several
executions. Display the registry through a conventional tree/list and load each
selected execution's actual transcript. Reconstruct this registry from durable
records; never infer the parent from screen geometry.

This is consistent with Pi's [session manager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts),
which stores entry IDs and parent IDs and separates model-context messages from
extension metadata, and Gemini's [recording service](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts),
which stores subagent logs under complete parent session IDs and distinguishes
resumable content from abandoned startup records. These support explicit
identity and reconstruction; they do not justify replacing Recurs's existing
versioned journals and mutation leases.

Codex's [current app-server notes](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
make cancellation semantics precise: acknowledgment can precede completion,
late results require handling, and an owner controls internal-worker shutdown.
Recurs should likewise show requested versus completed cancellation and expose
only controls the selected backend implements. Archiving a row is not process
cancellation. A broad agent tree is useful only if these controls are real.

**Replace handwritten MCP protocol mechanics with the maintained SDK, while
retaining Recurs's authority boundary.** Initial `mcp-client.ts` implements
custom stdio JSON-RPC, tool discovery, and result bounds but no remote HTTP,
OAuth, prompts, or resources. OpenCode's [MCP implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/mcp/index.ts)
uses SDK Client/StreamableHTTP transports, explicit pending authentication,
OAuth state validation, and cleanup. Gemini's [MCP client](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-client.ts)
also separates transport/discovery and rejects stdio startup in untrusted
folders. Reuse the SDK transport and negotiation layer; retain Recurs's bounded
results, permission preflight, project trust digest, filtered environment, and
contained subprocess ownership. The SDK's default spawn path must not bypass
Recurs's subprocess containment. Do not copy either application's full manager.

Remote access needs explicit server identity, HTTPS policy, scope, capability
inventory, and authentication status. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
requires PKCE and support verification, metadata discovery and protected
resource handling; implementing a pasted bearer token alone is not OAuth.
Verify authentication in an isolated fixture, including refresh, rejected state,
expired credentials, and cancellation. Tokens belong in private credential
storage, never project JSON or transcripts.

Goose's [extension manager and colocated tests](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/agents/extension_manager.rs)
cover resource/prompt operations, cancellation tokens, request-scoped
notifications, ambiguous tool names, and refusal to dispatch unadvertised tools.
Adopt those cases as acceptance requirements: permission checks must apply to
actual dispatch, not only the visible catalog. Neither tool annotations nor a
server's read-only claim grants authority. Recurs's company capability bundle
must filter resources/prompts and tool calls consistently.

**Finish skills as a managed, bounded content feature.** The
[Agent Skills specification](https://agentskills.io/specification) defines
required name/description, optional compatibility/metadata/license, progressive
loading of instructions and resources, and experimental `allowed-tools`.
Recurs already parses these fields and enforces safe resource reads; its
initial command only lists skills and toggles project trust. Add local copying,
explicit-source installation, inspection, per-skill enable/disable, removal,
and actionable dependency information. Preserve the distinction between enabling
a skill and trusting a project's content. Document collisions and precedence,
and keep tool hints informational: skill text cannot increase agent authority.
Do not require Python, a marketplace, or arbitrary in-process plugins to load
plain Markdown. Installation must not run scripts from the selected source.

**Make independent verification part of coding outcomes.** Aider's
[coding loop](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py)
runs configured tests after edits and can feed failures into bounded repair;
it records test outcomes separately from model output. Recurs already has
review/repair/apply boundaries and hidden-verifier evidence documenting false
model approvals. Preserve those boundaries and show model review and executable
verification separately. The useful comparison is the same repository change,
model where compatible, permission boundary, and independent verifier—not a
comparison of model brands or screenshots. No comparative timing/quality result
was produced here.

## Release priorities and acceptance evidence

1. **Execution integrity:** ordinary child, parallel batch, worktree team, and
   company-goal records appear once each; counts match; parent links survive
   reopening; selection opens real work; cancellation and steering reach the
   named live execution. Test delayed completion and a failed child.
2. **Extension completeness:** add/list/inspect/enable/disable/remove in user
   and project scopes; deny untrusted execution; exercise SDK stdio and HTTP,
   tools/resources/prompts, paginated discovery, OAuth and reauthentication,
   timeout/disconnect/cancel, and revoked capability access.
3. **First-run continuity:** a fresh installed CLI connects and completes a
   small task without requiring deep team design. Guided/Deep remain available;
   interrupted setup resumes; effective limits and model routes are visible
   before approval and match the resulting execution.
4. **Terminal behavior:** test real PTYs plus virtual rendering at narrow and
   resized dimensions, long streams, pasted drafts, pending approvals, selected
   agent switches, no-color, and restart. Reuse the existing renderer tests as
   regression foundations, not as substitutes for packaged interactive use.
5. **Public presentation:** lead with one install command, one verified ordinary
   task, and one real hierarchical workflow. Keep a short current compatibility
   table and contributor gate. Remove stale V19/floor-map claims and show actual
   captures. Preserve honest unknown cost and unsupported-platform boundaries.

The product thesis is **configurable, inspectable agent execution with bounded
authority and recoverable work**. Configured team size or an impressive diagram
is insufficient proof. Recurs's durable policy snapshots, explicit model routes,
worktree isolation, and independent review/repair are assets to retain; the
release work is making their execution visible, controllable, and easy to use.

Local evidence inspected: `ARCHITECTURE.md`, `package.json`,
`THIRD_PARTY_NOTICES.md`, `docs/FEATURE_STATUS.md`, `packages/cli/src/terminal-ui.ts`,
`packages/cli/src/mcp-client.ts`, `packages/cli/src/agent-skills.ts`,
`packages/cli/src/commands/skills.ts`, and `packages/cli/test/agent-skills.test.ts`.
Statements about initial gaps describe the pre-implementation research snapshot;
use the current capability documentation and acceptance reports for final status.
