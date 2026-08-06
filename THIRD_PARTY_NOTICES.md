# Third-Party Notices

The Recurs npm artifact contains Recurs's bundled JavaScript and declares the
following exact runtime, optional, or compatibility packages. Their code is
not copied into `dist/cli/main.js`. The Codex packages are development
dependencies and optional compatibility peers; normal Recurs installation uses
an independently installed, reviewed Codex CLI when that provider is selected.

| Package | Version | License | Source |
| --- | ---: | --- | --- |
| `@agentclientprotocol/codex-acp` | 1.1.7 | Apache-2.0 | <https://github.com/agentclientprotocol/codex-acp> |
| `@agentclientprotocol/sdk` | 1.3.0 | Apache-2.0 | <https://github.com/agentclientprotocol/typescript-sdk> |
| `@earendil-works/pi-tui` | 0.83.0 | MIT | <https://github.com/earendil-works/pi/tree/main/packages/tui> |
| `@lydell/node-pty` | 1.1.0 | MIT | <https://github.com/lydell/node-pty> |
| `@openai/codex` | 0.145.0 | Apache-2.0 | <https://github.com/openai/codex> |
| `typescript` | 6.0.3 | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| `ws` | 8.21.1 | MIT | <https://github.com/websockets/ws> |
| `yaml` | 2.9.0 | ISC | <https://github.com/eemeli/yaml> |
| `zod` | 4.4.3 | MIT | <https://github.com/colinhacks/zod> |

Each dependency remains subject to its own license. Its installed npm package
and source repository are authoritative for the complete license text and any
dependency-specific notices. Transitive dependencies are likewise installed
as separate npm packages and retain their own package metadata and license
files.

Rolldown is used only as a build tool. The package verifier rejects unexpected
external imports and preserves legal comments in the generated Recurs bundle.
