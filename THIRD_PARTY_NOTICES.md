# Third-Party Notices

The Recurs npm artifact contains Recurs's bundled JavaScript and declares the
following exact runtime packages as external npm dependencies. Their code is
installed as separate packages; it is not copied into `dist/cli/main.js`.

| Package | Version | License | Source |
| --- | ---: | --- | --- |
| `@agentclientprotocol/codex-acp` | 1.1.2 | Apache-2.0 | <https://github.com/agentclientprotocol/codex-acp> |
| `@agentclientprotocol/sdk` | 1.2.1 | Apache-2.0 | <https://github.com/agentclientprotocol/typescript-sdk> |
| `@lydell/node-pty` | 1.1.0 | MIT | <https://github.com/lydell/node-pty> |
| `@openai/codex` | 0.144.0 | Apache-2.0 | <https://github.com/openai/codex> |
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
