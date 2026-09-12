# Third-Party Notices

The Recurs npm artifact contains Recurs's bundled JavaScript and declares the
following exact runtime, optional, or compatibility packages. Their code is
not copied into `dist/cli/main.js`. Codex remains a development dependency and
optional compatibility peer. The GitHub Copilot SDK is an exact optional peer
installed only through explicit user opt-in. A normal Recurs installation does
not install or bundle either package.

| Package | Version | License | Source |
| --- | ---: | --- | --- |
| `@agentclientprotocol/codex-acp` | 1.1.7 | Apache-2.0 | <https://github.com/agentclientprotocol/codex-acp> |
| `@agentclientprotocol/sdk` | 1.4.0 | Apache-2.0 | <https://github.com/agentclientprotocol/typescript-sdk> |
| `@earendil-works/pi-tui` | 0.83.0 | MIT | <https://github.com/earendil-works/pi/tree/main/packages/tui> |
| `@github/copilot-sdk` | 1.0.8 | MIT | <https://github.com/github/copilot-sdk> |
| `@modelcontextprotocol/client` | 2.0.0 | Apache-2.0 and MIT | <https://github.com/modelcontextprotocol/typescript-sdk> |
| `@lydell/node-pty` | 1.1.0 | MIT | <https://github.com/lydell/node-pty> |
| `@openai/codex` | 0.145.0 | Apache-2.0 | <https://github.com/openai/codex> |
| `typescript` | 6.0.3 | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| `ws` | 8.21.3 | MIT | <https://github.com/websockets/ws> |
| `yaml` | 2.9.1 | ISC | <https://github.com/eemeli/yaml> |
| `zod` | 4.6.2 | MIT | <https://github.com/colinhacks/zod> |

Each dependency remains subject to its own license. Its installed npm package
and source repository are authoritative for the complete license text and any
dependency-specific notices. Transitive dependencies are likewise installed
as separate npm packages and retain their own package metadata and license
files.

The optional `@github/copilot-sdk` package is MIT-licensed. Its separately
installed `@github/copilot` CLI and platform payload are GitHub vendor software
governed by GitHub's applicable terms. Recurs does not bundle or distribute
that CLI or its native platform payload in the Recurs npm artifact.

Rolldown is used only as a build tool. The package verifier rejects unexpected
external imports and preserves legal comments in the generated Recurs bundle.

The official MCP TypeScript SDK 2.0.0 package metadata still declares MIT,
while its shipped `LICENSE` documents a transition: new contributions and
relicensed contributions use Apache-2.0; original contributions without
relicensing consent retain MIT. The SDK client and its `@modelcontextprotocol/core`
2.0.0 dependency are installed separately, with their full license files. Recurs
uses the SDK through its public interface and does not copy its implementation.
The client's other separately installed runtime dependencies include
`cross-spawn` (MIT), `eventsource` (MIT), `eventsource-parser` (MIT), `jose` (MIT),
`pkce-challenge` (MIT), and `zod` (MIT). Their packaged license files remain
authoritative.
