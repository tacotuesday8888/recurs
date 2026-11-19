# Provider Capability Matrix

## November 2026 availability

**Published alpha.11.** Ollama and LM Studio can connect over literal loopback.
The hosted usage reviews in this package expired in October 2026.

**Alpha.12 source candidate.** The new policy window opens November 18, 2026
at 00:00 UTC and ends February 18, 2027 at 00:00 UTC. The review covers these
eleven routes. Model access, permissions and billing choices are checked for
each connection. The November review used public documentation and made no
authenticated model calls. [Review and official sources](research/provider-review-2026-11.md)

| Connection | Reviewed routes | Setup requirement |
| --- | --- | --- |
| Vendor login | Codex with ChatGPT, GitHub Copilot | Use the supported official runtime and its signed-in account. Observe the route’s usage and billing conditions. |
| API key | OpenAI API, Anthropic API, Google Gemini API, xAI API, Alibaba Model Studio API, Z.ai API | Supply the named environment variable and a model available to that key on the reviewed endpoint. |
| Coding plan | Alibaba Coding Plan | Use the plan-specific key and confirm an active plan for local, manual, user-present work. |
| Local model | Ollama, LM Studio | Start a literal-loopback server and supply a locally served model ID. |

Eight previously reviewed routes remain closed. DeepSeek API, Kimi Platform
API and MiniMax API need model-specific verification for the next request
after a tool call. MiniMax Token Plan also needs updated plan coverage. Kimi
Code, OpenCode Go, OpenRouter API and Kilo Gateway need routing, client or
billing changes documented in the review. Run `recurs provider list --all`
to inspect the policy status in your installed version.

## August 2026 implementation snapshot

The table below records the August 13 implementation and readiness
projections. The Codex live checks used three saved routes on August 10.
The November availability table above applies to the alpha.12 candidate.

This matrix deliberately keeps four questions separate:

- **Catalog support:** a reviewed manifest exists.
- **Implementation/activation capability:** authentication, a wired model-discovery/readiness probe, streaming, tools, usage/error handling, and onboarding backend are implemented.
- **Configured account readiness:** a saved connection has the expected credential/account binding. This is checked by the connection lifecycle and is not inspected by this matrix.
- **Live verification:** a safe, successful provider readiness check was recorded in the previous 24 hours for the exact provider. Implementation booleans and test runs never imply this.

Categories are closed: `cataloged`, `activatable`, `live-tested`, `conditional`, `blocked`, and `unsupported`. `activatable` means the implementation can begin approved setup; it does not mean an account is configured, authenticated, entitled, reachable, or live-verified. A conditional or blocked policy is not upgraded by implementation or live evidence.

| Provider | August category | Adapter | August implementation coverage | Live check in August | Missing activation capability in August |
| --- | --- | --- | --- | --- | --- |
| Codex with ChatGPT | conditional | `codex-app-server` | complete | passed 2026-08-10 | — |
| Ollama Local | activatable | `openai-chat-completions` | complete | not run | — |
| LM Studio Local | activatable | `openai-chat-completions` | complete | not run | — |
| OpenAI API | activatable | `openai-responses` | complete | not run | — |
| Anthropic API | activatable | `anthropic-messages` | complete | not run | — |
| OpenRouter API | activatable | `openai-chat-completions` | complete | not run | — |
| xAI API | activatable | `openai-chat-completions` | complete | not run | — |
| OpenCode Go | cataloged | `openai-chat-completions` | partial | not run | model discovery/readiness probe |
| Kilo Gateway | cataloged | `openai-chat-completions` | partial | not run | model discovery/readiness probe |
| Alibaba Model Studio API | cataloged | `openai-chat-completions` | partial | not run | model discovery/readiness probe |
| Alibaba Coding Plan | conditional | `openai-chat-completions` | partial | not run | model discovery/readiness probe |
| Kimi Platform API | cataloged | `openai-chat-completions` | partial | not run | model discovery/readiness probe |
| Kimi Code | cataloged | `openai-chat-completions` | partial | not run | model discovery/readiness probe |
| MiniMax API | activatable | `openai-chat-completions` | complete | not run | — |
| MiniMax Token Plan | conditional | `anthropic-messages` | complete | not run | — |
| Z.ai API | cataloged | `openai-chat-completions` | partial | not run | model discovery/readiness probe |
| DeepSeek API | activatable | `openai-chat-completions` | complete | not run | — |
| Google Gemini API | activatable | `gemini-generate-content` | complete | not run | — |
| Claude Subscription | blocked | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| GitHub Copilot Subscription | conditional | `github-copilot-sdk` | complete | not run | — |
| OpenCode Zen | cataloged | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| Nous Portal | conditional | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| Z.ai GLM Coding Plan | blocked | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| AWS Bedrock | cataloged | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| Google Vertex AI | cataloged | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| Azure OpenAI | cataloged | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |

The snapshot used `listProviderCapabilities()` in `packages/cli/src/provider-account.ts`. Unknown requested IDs produce `unsupported` with no adapter or verification claim.

A fixed-endpoint adapter can be executable without satisfying this matrix's
full activation definition. OpenCode Go, Kimi Code, Alibaba Coding Plan, and
other fixed-origin Chat-compatible paths accept an explicit model and
environment credential through their wired adapters, but remain
`cataloged`/`conditional` here until a provider-specific model discovery or
readiness probe exists. A saved account and a successful live turn are separate
facts again; neither changes a blocked provider policy.

The official GitHub Copilot path ships in alpha.8. Its implementation coverage
is complete, but no live Copilot model turn has been supplied; SDK presence,
saved-account readiness, and live evidence remain separate facts.

### Sources for the August snapshot

- GitHub documents an official TypeScript Copilot SDK, vendor-owned logged-in-user authentication, streaming events, and custom tools. Recurs provides an opt-in official SDK adapter for `github.com`; GitHub Enterprise hosts remain unsupported in this alpha. SDK installation, saved-account readiness, and live-turn evidence stay separate. The path remains policy-conditional because included allowance can continue through provider-configured Additional usage: [authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate), [SDK tutorial](https://docs.github.com/en/copilot/how-tos/copilot-sdk/getting-started), [usage limits](https://docs.github.com/en/copilot/concepts/usage-limits).
- AWS documents `ConverseStream`, tool use, model identifiers, and a permission requirement, but Recurs has no SigV4/workload-identity adapter or regional discovery backend: [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html).
- Google documents bearer-token authentication, regional Vertex endpoints, function calling, and streaming function-call arguments, but Recurs has no ADC/workload-identity adapter or project/location discovery backend: [Vertex function calling](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling), [REST authentication](https://cloud.google.com/docs/authentication/rest).
- Microsoft documents Azure OpenAI v1 Responses endpoints, API-key or OAuth authentication, and function tools, but Recurs has no resource/deployment discovery or Azure identity backend: [Azure OpenAI Responses](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses).

### Evidence limits

“Complete implementation coverage” means every required activation facet has executable backend code. It does not assert that provider-specific compatibility tests ran, or prove account entitlement, regional availability, model access, remaining quota, provider uptime, or a successful paid request. Scripted verification evidence belongs in test and CI results; live checks must use credentials already present through an approved authentication path. Recurs never scrapes private credential stores or imports browser cookies.
