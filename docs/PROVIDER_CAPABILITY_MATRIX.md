# Provider Capability Matrix

Snapshot: 2026-08-07T12:00:00.000Z, generated from the executable provider and CLI readiness projections. No live verification evidence was supplied for this snapshot.

This matrix deliberately keeps four questions separate:

- **Catalog support:** a reviewed manifest exists.
- **Implementation/activation capability:** authentication, a wired model-discovery/readiness probe, streaming, tools, usage/error handling, and onboarding backend are implemented.
- **Configured account readiness:** a saved connection has the expected credential/account binding. This is checked by the connection lifecycle and is not inspected by this matrix.
- **Live verification:** a safe, successful provider readiness check was recorded in the previous 24 hours for the exact provider. Implementation booleans and test runs never imply this.

Categories are closed: `cataloged`, `activatable`, `live-tested`, `conditional`, `blocked`, and `unsupported`. `activatable` means the implementation can begin approved setup; it does not mean an account is configured, authenticated, entitled, reachable, or live-verified. A conditional or blocked policy is not upgraded by implementation or live evidence.

| Provider | Category | Adapter | Implementation coverage | Live | Missing activation capability |
| --- | --- | --- | --- | --- | --- |
| Codex with ChatGPT | conditional | `codex-app-server` | complete | not run | — |
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
| GitHub Copilot Subscription | conditional | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| OpenCode Zen | cataloged | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| Nous Portal | conditional | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| Z.ai GLM Coding Plan | blocked | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| AWS Bedrock | cataloged | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| Google Vertex AI | cataloged | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |
| Azure OpenAI | cataloged | — | none | not run | authentication, model discovery/readiness probe, streaming, tools, usage, errors, onboarding backend |

The executable source is `listProviderCapabilities()` in `packages/cli/src/provider-account.ts`. Unknown requested IDs produce `unsupported` with no adapter or verification claim.

## Current primary-source findings

- GitHub documents an official TypeScript Copilot SDK, logged-in-user/device-flow authentication, streaming events, and custom tools. Recurs does not yet contain that adapter or onboarding backend, so the manifest remains conditional rather than activatable: [authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate), [SDK tutorial](https://docs.github.com/en/copilot/how-tos/copilot-sdk/getting-started).
- AWS documents `ConverseStream`, tool use, model identifiers, and a permission requirement, but Recurs has no SigV4/workload-identity adapter or regional discovery backend: [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html).
- Google documents bearer-token authentication, regional Vertex endpoints, function calling, and streaming function-call arguments, but Recurs has no ADC/workload-identity adapter or project/location discovery backend: [Vertex function calling](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling), [REST authentication](https://cloud.google.com/docs/authentication/rest).
- Microsoft documents Azure OpenAI v1 Responses endpoints, API-key or OAuth authentication, and function tools, but Recurs has no resource/deployment discovery or Azure identity backend: [Azure OpenAI Responses](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses).

## Evidence limits

“Complete implementation coverage” means every required activation facet has executable backend code. It does not assert that provider-specific compatibility tests ran, or prove account entitlement, regional availability, model access, remaining quota, provider uptime, or a successful paid request. Scripted verification evidence belongs in test and CI results; live checks must use credentials already present through an approved authentication path. Recurs never scrapes private credential stores or imports browser cookies.
