# Provider Authentication Matrix Design

**Date:** 2026-07-11
**Status:** Implemented foundation; direct credential-bearing activations and additional delegated adapters remain deferred
**Scope:** Broad provider metadata and onboarding foundation, shared protocol seams, and the first official delegated subscription runtime

## Outcome

Recurs exposes a broad provider catalog without building a separate engine for every vendor. Provider entries are manifests over a small set of protocol and authentication families. The first production subscription path is Codex through the pinned official `@agentclientprotocol/codex-acp` 1.1.2 adapter, which delegates authentication to Codex instead of importing its credential files.

This phase implements 25 discoverable paths. Exactly three are runnable: literal-loopback Ollama, literal-loopback LM Studio, and Codex with an existing ChatGPT account. Direct API, coding-plan, OAuth, and cloud-identity entries are validated activation recipes but remain unavailable for credential entry until the native credential broker, tool-containment boundary, and required adapter exist. A provider is never labeled ready merely because its endpoint is OpenAI-compatible.

## Decision and alternatives

The selected approach is a manifest registry over shared protocol families.

1. **Selected: manifests plus shared protocols.** A manifest declares provider identity, endpoint, access/auth kind, billing behavior, support status, policy, and protocol. OpenAI-compatible, Anthropic-compatible, cloud-identity, local, and ACP implementations are reused across manifests.
2. **Rejected: one adapter per vendor.** This duplicates streaming, tool-call, retry, and error logic and makes regional/coding-plan differences easy to hide accidentally.
3. **Rejected: one universal gateway.** A gateway is useful as one provider, but cannot represent existing subscriptions, cloud identities, local models, regional restrictions, or provider-specific billing accurately.

## Deliverable boundaries

### Provider registry

`@recurs/contracts` defines strict manifest, policy, model-catalog, and runtime-capability types. `@recurs/providers` owns validation and a bundled immutable registry.

The initial registry covers distinct paths for:

- OpenAI API and Codex with ChatGPT;
- Anthropic API and Claude subscription;
- GitHub Copilot;
- OpenRouter, OpenCode Zen/Go, Kilo Gateway, and Nous Portal;
- Alibaba Model Studio API and Coding Plan;
- Kimi API and Kimi Code;
- MiniMax API and Token Plan;
- Z.ai API and GLM Coding Plan;
- DeepSeek API;
- AWS Bedrock, Google Vertex/Gemini, and Azure OpenAI;
- local Ollama and LM Studio.

Entries may be `supported`, `conditional`, `blocked_pending_written_approval`, or `blocked`. The normal onboarding list shows runnable entries first, then activatable entries, and hides blocked entries unless the user asks for all details.

### Shared protocol readiness

Protocol identifiers are data, not claims of activation. Existing local OpenAI-compatible streaming remains the live direct transport. The registry identifies which future direct adapter family each entry uses, allowing API/coding-plan connections to be activated through one broker-backed implementation per family rather than copied vendor code.

### Connection registry and onboarding

A schema-versioned non-secret connection registry replaces the single local-connection file. It uses atomic revisioned writes, preserves the existing local configuration through a one-time migration, and stores no API key, OAuth token, browser cookie, vendor auth path, or credential reference that a model can dereference.

The CLI exposes:

```text
recurs setup local --url <loopback-url> --model <model-id>
recurs setup codex
recurs provider list [--all] [--json]
recurs account list [--json]
```

Local setup verifies an exact loopback model. Codex setup presents the automatic prepaid-credit disclosure, delegates any currently advertised `chat-gpt` login flow to the official adapter, rechecks structured account status, probes the selected model and `read-only` mode, and commits non-secret linkage. Direct key-based entries are listable as native-broker-required and do not request a key. This is a truthful blocked state, not a placeholder connection.

### Delegated runtime foundation

`@recurs/runtimes` uses the official `@agentclientprotocol/sdk` and spawns the pinned `@agentclientprotocol/codex-acp` package directly rather than invoking `npx` or parsing ad-hoc CLI output. It never reads `~/.codex/auth.json` or accepts copied tokens.

The ACP client:

- negotiates the exact stable protocol version;
- records agent implementation and capability metadata;
- handles ACP authentication methods through the official runtime;
- creates or resumes a session scoped to the canonical workspace;
- maps prompt updates, tool activity, file changes, reasoning, usage, and terminal outcomes into bounded normalized runtime events;
- bridges permission requests to Recurs decisions;
- propagates cancellation and requires terminal settlement;
- bounds message sizes, queued updates, stderr, startup, prompt, and shutdown time;
- rejects unknown, malformed, duplicate-terminal, or post-terminal traffic;
- spawns with an explicit environment allowlist and no Recurs/provider secrets.

Codex ACP currently wraps the official Codex App Server and ships a compatible Codex dependency. ChatGPT authentication is owned by that adapter and Codex. Setup may open the official login flow, but Recurs persists only non-secret runtime linkage and verified account labels returned by the adapter.

Standalone Codex execution is limited to a local, manual, user-present CLI REPL and the enforced Codex `read-only`/Plan profile. Every run rereads the connection and current policy, then binds structured ChatGPT authentication and account identity on the exact ACP child before session work and again immediately before prompting. Core rejects all non-read runtime approvals in Plan mode. Act, one-shot, unattended, recognized-CI, implicit-SDK, remote, and scripted contexts fail closed. Included subscription usage may automatically consume available prepaid credits after limits, so setup requires explicit acknowledgement of both declared sources.

### Core delegated execution

Core includes a real `DelegatedAgentExecutor`. It validates that the resolved lane, adapter, connection, model, authorization, and runtime capability profile match the immutable session pin. It maps runtime output into durable version-2 results, changed-file/evidence metadata, usage, failure/cancellation, and continuation state without pretending unavailable data is zero.

Vendor session IDs remain behind process-scoped continuation capabilities rather than in JSONL. A staged uncertain continuation is committed only with its matching durable terminal. While the process-scoped payload remains available, a later attempt must reconcile an uncertain tip before any new work. Core supports runtime-proven committed or gone outcomes; the current ACP path conservatively leaves an existing resumable session uncertain and advances only when it is proven gone. Still-uncertain state—and process loss that makes the payload unavailable—fails closed; remote work is never repeated automatically.

Delegated `/compact` is rejected explicitly in this phase because the runtime owns its transcript. A runtime that cannot enforce the requested permission or plan mode is rejected before the prompt is persisted.

## Security and policy

- Browser cookies, copied tokens, private vendor auth files, desktop credential extraction, and shared subscription credentials are never accepted.
- API/coding-plan credentials remain disabled until a separately reviewed native broker captures and stores them outside the TypeScript harness and tools are denied access to broker authority.
- Codex runs only through the official adapter and retains ownership of its authentication.
- The implemented Codex subscription access is restricted to local, user-present, manual CLI context. Desktop and unattended contexts are not implemented.
- Coding-plan manifests retain dedicated endpoints, credential kinds, billing disclosures, regions, and usage restrictions even when the wire protocol matches another provider.
- Alibaba Coding Plan is foreground-interactive only. Z.ai GLM Coding Plan remains hidden pending written approval. MiniMax Token Plan requires explicit additional-spend disclosure. Unknown fallback billing is blocked.
- Unsupported or stale policy never degrades into a warning-and-continue path.

## Testing

The implementation uses test-first slices:

- manifest-schema and complete-registry invariants;
- blocked/conditional/runnable onboarding filtering and billing text;
- local-config migration and concurrent registry revision checks;
- hostile fake ACP processes for malformed frames, oversized output, permission requests, cancellation, timeout, early exit, duplicate terminal, and process cleanup;
- fake runtime contract tests for durable delegated results, failures, usage, changed files, evidence, and exact pin validation;
- CLI setup/account/provider rendering in text and JSON;
- focused fake-process Codex ACP setup/run coverage; no live credential is required in CI;
- the existing full `npm run check` gate.

## Explicitly deferred

This phase does not collect or persist API/coding-plan keys, implement cloud workload identity, reuse Claude/Copilot private auth state, or automatically route orchestrator/subagent models. Those become separate verified activations over the registry and runtime seams built here. The heavy company/subagent architecture follows after provider selection and capabilities are explicit.
