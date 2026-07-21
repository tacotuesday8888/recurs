# Recurs CLI

Recurs Core v0 is a provider-neutral coding-agent harness. The CLI, direct agent loop, delegated-runtime executor, owned single-child and bounded parallel analysis/review paths, durable implementation/review/repair teams, tools, permissions, Plan mode, sessions, goals, checkpoints, structured output, credential-free local transport, bounded stdio MCP client, and first official Codex ACP path are implemented.

When no provider is available, an interactive launch offers one guided setup and otherwise remains in a sessionless workspace shell. Coding prompts require a configured literal-loopback local server, a saved or ephemeral reviewed BYOK connection, an eligible interactive Codex connection, or an injected test/embedding `ModelProvider`; no fake `unconfigured` session is written.

## Install from source

Requirements:

- Node.js 22.22 or newer. Node.js 24 LTS is supported.
- Git 2.45 or newer. Protected Git operations fail with a typed error on older
  versions because their lazy-fetch suppression is unavailable.
- ripgrep (`rg`) for file listing and text search.

Build and inspect the CLI:

```bash
npm install
npm run check
npm run build
npm link
recurs --version
recurs --help
recurs run --help
recurs setup
node packages/cli/dist/main.js --help
```

You can expose the root package's bundled `recurs` binary locally with `npm link` after building. `--version`, `-V`, `-v`, and `version` print the exact root-package version embedded into the bundled artifact; unbundled workspace modules identify themselves as `development` so they cannot accidentally impersonate a release. `help <command>` and `<command> --help` provide scoped help for `run`, `setup`, `provider`, `account`, `doctor`, and `acp`; help and version never initialize a provider, runtime, or requested working root. The same build version is advertised by Recurs's ACP server and outbound MCP/Codex ACP client identities rather than a separate hard-coded value. The release candidate can be checked without publishing:

```bash
npm run package:check
npm run package:smoke-install
```

The first command verifies one executable bundle, its exact external dependencies, size, mode, absence of private workspace imports and build-machine paths, and the five-file tarball allowlist including `THIRD_PARTY_NOTICES.md`. It also runs the release-policy tests and proves publication remains blocked for the exact deliberate license/version/package gates. After a build, the second packs the artifact, installs it into an empty temporary prefix, verifies its exact version and scoped help, runs the fresh-state commands, configures a deterministic loopback model, and drives the installed agent through user Agent Skill activation, a private stdio MCP call, sandboxed command execution, denied outside-workspace writing, and a guarded read. The same smoke negotiates ACP v1 with the artifact version over the installed binary, creates a session, verifies streamed model output, closes the session, and requires clean process shutdown. CI runs both boundaries.

No package or installer is published today. The source repository is public, while the package remains `private`, version `0.0.0`, and `UNLICENSED` until the owner selects a license and preview version. Direct-runtime dependency notices are complete for the current exact package set. `.github/workflows/publish-npm.yml` is a manual protected-environment OIDC workflow: it requires a public source repository and exact `vVERSION` tag reachable from `main`, reruns the full Linux/package gates, rejects tokens and mismatched release metadata, and builds one exact npm tarball. It then renders a checksum-bound user-local installer and Homebrew formula, creates a draft GitHub release, attests the assets, publishes or verifies the same tarball through npm trusted publishing, and publishes the GitHub release only after those steps succeed. A failed npm step leaves a draft rather than advertising a broken release. The npm package/environment trust relationship still has to be configured by the owner before the first release.

After that first authorized release, users can install an exact version with npm, download the versioned `install.sh` asset for a SHA-256-verified install into `~/.local` (or `RECURS_INSTALL_PREFIX`), or download the generated `recurs.rb` formula. The formula follows Homebrew's documented Node-module layout and isolates npm content under `libexec`. No tap exists yet, so Recurs does not claim a short `brew install` command. Bun may later install the npm package, but Node remains the supported runtime and Bun runtime compatibility has not been implemented. Windows packaging remains later work.

Source/npm execution supports credential-free local, environment-BYOK, and vendor-owned Codex paths. It cannot persist a Recurs-owned credential: the native authority requires a correctly bundled, production-signed macOS 14.4+ launcher and broker, and source, unsigned, or ad-hoc builds fail closed without a plaintext fallback.

The repository does not yet contain a license. Although it is intended to become open source, it remains source-available rather than legally open source until the owner selects and adds a license.

## Guided first run

Run `recurs setup`, or launch `recurs` with no configured connection. The same local, user-present guide:

1. shows saved connections, safely detected Ollama/LM Studio runtimes, the official Codex path, reviewed environment-BYOK providers, and installed-native paths that the current build can attempt;
2. after the environment-variable name is chosen, selects an exact credential-visible model from the reviewed Anthropic, OpenRouter, DeepSeek, or MiniMax endpoint; other reviewed BYOK paths use bounded `models.dev` metadata or ask for an exact model ID when authoritative discovery is unavailable;
3. executes the existing provider-specific credential and billing disclosure—generic onboarding never asks for a key value;
4. selects Ask Always, Approved for Me, or Full Access;
5. selects a current versioned Economy, Standard, Balanced, Performance, or Max operating mode; Balanced is recommended; and
6. when another eligible saved Act + Plan connection exists, optionally assigns Implement, Review, and Repair specialist candidates; and
7. reports existing project instructions or offers to create a concise user-confirmed `AGENTS.md` brief without overwriting any existing instruction file, then creates a fresh durable session and enters the ordinary REPL.

Approved for Me is the recommended interactive preset. Full Access still requires a separate warning and confirmation. Cancelling that confirmation safely falls back to Ask Always. The selected permission and operating mode are stored in the new session rather than mutable global preferences; existing sessions keep their recorded boundaries. Role customization never changes the parent connection, excludes Plan-only delegated runtimes and billing classes ineligible for the chosen mode, and uses the existing confirmation-gated `account route` command for every changed role. Keeping current routing is the default. With no eligible secondary connection, every role honestly inherits the parent. Skipping connection setup leaves the sessionless `/provider` workspace available.

If the first parent-model connection cannot be completed, the guide stays in setup and offers to retry the same path, return to the provider/runtime list, or stop. Before authenticated BYOK discovery, it checks only whether the named environment variable is present in the current Recurs process; the guide never receives, renders, or persists the credential value. Provider, authentication, and transport failures are rendered through the same redacted CLI error boundary before recovery is offered.

After setup, `/model` lists every saved connection with its exact ID, provider/model, execution capability, billing source, active/primary state, and any explicit reasoning effort. `/model <exact-connection-id>` is local, manual, user-present, and confirmation-gated. It resolves the current connection policy and credential/runtime boundary, then creates a fresh pinned session while preserving the active operating mode, permission preset, Plan state where supported, and workspace. It does not mutate conversation history or silently change the registry primary; the prior session remains available through `/resume`. A Plan-only delegated connection starts in Plan mode. Injected test providers and process-only environment overrides remain intentionally unswitchable because they are not saved registry choices.

At the start of each direct-model turn, Recurs discovers one `AGENTS.override.md` or `AGENTS.md` per directory from the nearest `.git` project root through the session cwd, preferring the override at each level. Without a project marker it reads only the cwd. The root-to-cwd contents are snapshotted once for the complete turn and supplied to parent and child agents; a later turn sees confirmed edits or a newly created `/init` file. The aggregate is limited to 32 KiB. Symlinks, non-regular files, invalid UTF-8, mid-read changes, and over-limit instruction sets fail closed rather than becoming partial model policy. These files never grant tools, permissions, credentials, or higher delegation limits.

For a catalog with many models, the guide asks for a search first and then shows at most 30 exact matches. Public catalog metadata helps selection but does not activate an unreviewed provider, supply credentials, or override Recurs's manifest and billing policy. OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, and MiniMax instead use the named environment credential against their exact reviewed model-list endpoint and do not silently fall back to public metadata when authentication or transport fails.

The interaction follows current official patterns reviewed on 2026-07-19: [Kimi Code](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers) uses a known-provider → credential → default-model path backed by `models.dev`; [OpenCode](https://opencode.ai/docs/providers) separates `/connect` authentication from exact model selection; [Goose](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md) combines searchable provider configuration with keychain-backed secrets; and [Codex](https://openai.com/codex/get-started/) moves directly from sign-in and project choice into the first task. Recurs keeps that short flow while retaining its stricter reviewed-provider, credential-owner, billing, and immutable-session boundaries.

## Provider boundary

Recurs exposes a validated catalog of 25 provider/authentication paths. Source installs can run credential-free literal-loopback Ollama/LM Studio, an existing ChatGPT account through the pinned official Codex ACP adapter, or saved/ephemeral BYOK for fixed-origin OpenAI Responses and supported reviewed OpenAI Chat-compatible or Anthropic Messages providers. The private production-signed macOS path also implements persistent OpenAI API, Anthropic API, and Kimi Code onboarding plus broker-owned generation; it is not distributed yet. Catalog entries outside those implemented protocol paths remain discovery metadata rather than live transports.

The strongest persistent path keeps keys outside TypeScript: `recurs setup openai`, `recurs setup anthropic --model <exact-id>`, and `recurs setup kimi --model <exact-id>` delegate foreground capture to the signed native authority. Cross-platform source installs may save a provider/model binding while keeping the key in a named environment variable. Setup authenticates model discovery again before saving; when that exact model reports input/output limits, Recurs stores the limits as non-secret setup-time metadata and pins them into future sessions. Missing limits stay unknown:

```bash
export OPENROUTER_API_KEY=<key>
recurs setup byok \
  --provider openrouter-api \
  --model <provider/model> \
  --key-env OPENROUTER_API_KEY

export OPENAI_API_KEY=<key>
recurs setup byok \
  --provider openai-api \
  --model <reported-compatible-model> \
  --key-env OPENAI_API_KEY \
  --reasoning-effort max

export ANTHROPIC_API_KEY=<key>
recurs setup byok \
  --provider anthropic-api \
  --model <exact-model-id> \
  --key-env ANTHROPIC_API_KEY

export GEMINI_API_KEY=<key>
recurs setup byok \
  --provider google-gemini-api \
  --model <exact-model-id> \
  --key-env GEMINI_API_KEY
```

Setup is local, interactive, and manual. It validates the current reviewed manifest and billing selection, shows the fixed-origin and billing disclosure, and saves only non-secret metadata: provider, model, adapter/policy/billing revisions, the environment-variable name, and a provider-bound SHA-256 credential fingerprint. OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, and MiniMax setup first authenticate to their fixed model-list endpoint and refuse a model not visible to that credential. The key value is neither written to the registry nor copied into a session. The first account becomes primary; later accounts require `account set-primary`. `--billing strict` is the default. Use `--billing allow-additional` only when the provider policy declares another source and the user accepts it; OpenCode Go is the current such profile.

For the exact reviewed GPT-5.6 models on the OpenAI Responses path, guided setup offers provider default plus `none|low|medium|high|xhigh|max`; the same choice is available as `--reasoning-effort` for explicit setup. A selected value is stored as non-secret policy and frozen into future sessions. `/status` reports it, and every request in that session carries it. Provider default leaves the field absent so OpenAI applies its default. Re-running setup changes only future sessions; use `/model <connection-id>` to start one. The option is rejected for other providers, adapters, unreviewed models, and unsupported values. Codex presents Ultra as an effort level in its own model catalog; Recurs does not send the literal value `ultra` to the Responses API because `max` is the documented highest API effort for this reviewed model family.

The current reviewed saved-BYOK set is OpenAI API, Anthropic API, Google Gemini API, OpenRouter API, OpenCode Go, Kilo Gateway, Alibaba Model Studio API, Kimi Platform API, Kimi Code, MiniMax API, Z.ai API, and DeepSeek API. `provider list` is authoritative because support and policy review can change. Blocked or conditional coding-plan paths do not become runnable merely because they use a compatible protocol.

For a one-process override without a saved record:

```bash
RECURS_PROVIDER=openrouter-api \
RECURS_MODEL=<provider/model> \
RECURS_API_KEY=<key> \
recurs
```

All three variables are required together. The provider must have a supported reviewed fixed HTTPS origin and an implemented `openai_responses`, `openai_chat`, `anthropic_messages`, or `gemini_generate_content` environment adapter. This explicit triple overrides saved selection for that process. In both forms, the key remains in a private provider field, is not written to the session log, and is stripped from tool subprocesses. This does not turn cloud-identity, blocked coding-plan, or arbitrary custom endpoints into runnable paths. OpenAI Responses uses `store: false`, requests encrypted reasoning output, bounds the same typed event protocol over WebSocket and SSE, and replays validated private output items only from bounded process memory. One authenticated WebSocket is reused across the sequential model/tool rounds in a run. If its handshake fails before any request is sent, Recurs visibly falls back to the equivalent fixed-origin SSE endpoint for the rest of that run; after request delivery, a socket interruption fails non-retryably instead of risking duplicate output or spend. The socket is closed when the run succeeds, fails, or is cancelled. If Recurs exits during a tool turn, that turn must be retried; a completed conversation resumes from its last visible answer without claiming hidden-reasoning durability. Anthropic sends the key only in `x-api-key`, requires API version `2023-06-01`, translates native tool blocks, and bounds named-SSE parsing. Gemini sends the key only in `x-goog-api-key`, translates native function calls and images, bounds SSE parsing, and preserves exact opaque thought signatures in process-scoped continuation memory. All public adapters reject redirects and fail closed if credential bytes appear across response chunks.

Inspect the catalog and configured accounts without revealing account labels, account fingerprints, local endpoints, or credential material:

```bash
recurs provider list
recurs provider list --all
recurs provider list --json
recurs provider catalog
recurs provider catalog kimi
recurs provider catalog "coding plan" --json
recurs provider detect
recurs provider models --provider anthropic-api --key-env ANTHROPIC_API_KEY
recurs provider models --provider anthropic-api --key-env ANTHROPIC_API_KEY --json
recurs account list
recurs account list --json
recurs account verify <connection-id>
recurs account set-primary <connection-id>
recurs account route <implement|review|repair> <connection-id|parent>
recurs account disconnect <connection-id>
recurs doctor native
recurs doctor native --json
```

The normal provider list hides blocked paths; `--all` includes them. Both text and JSON distinguish runnable, environment-BYOK, native-broker-required, and blocked paths and report structured billing and restrictions. Account output marks the primary connection and omits local endpoints, delegated account labels, fingerprints, and credentials.

These commands intentionally separate four sources that other harnesses can make look like one operation:

- `provider list` is Recurs's reviewed support and policy catalog;
- `provider catalog` fetches public provider/model discovery metadata from `https://models.dev/api.json` and does not activate or authenticate anything;
- `provider detect` probes only the fixed literal-loopback Ollama and LM Studio ports. It does not search the filesystem, inspect another tool's credential store, scan the LAN, or import tokens.
- `provider models` authenticates the named environment credential to a reviewed fixed OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, or MiniMax endpoint, returns bounded exact model metadata including reported limits when available, denies redirects, and never places the key in arguments, output, or the URL.

Inside the interactive CLI, `/provider [search]` combines connected accounts, safe local detection, the public catalog, and Recurs's truthful setup status in one view. `/connect` remains an alias. The first-run guide composes this same discovery and setup system; if the guide is skipped, `/provider` remains the first sessionless workspace view. A public catalog match is never presented as runnable until Recurs has the complete reviewed authentication, billing, transport, and execution path.

Account mutations require one full exact ID; prefixes, labels, indexes, extra flags, and control characters are rejected. `verify` is read-only and runs only from a local, user-present, non-automation terminal because Codex is one supported path. It rechecks the exact local model or official Codex account/model/read-only profile. For saved BYOK it proves only that the named environment variable is present and matches the setup fingerprint. OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, and MiniMax setup have already authenticated and verified model visibility, while other BYOK providers authenticate on their first model request; `account verify` deliberately does not repeat either network check. Verification does not sign in, repair billing acknowledgement, make a network request for BYOK, or mutate the registry.

`set-primary` changes only the default for a future new session. Every existing session continues through its immutable connection/model/account/policy/billing pin. `account route` explicitly assigns one saved direct-model connection as the candidate for a durable team's Implement, Review, or Repair role; `parent` clears the assignment. It is local, interactive, manual, and confirmation-gated because a selected secondary account may incur its own provider charges. Delegated runtimes such as Codex cannot be assigned. The active mode and live connection policy still decide eligibility, and the parent remains the fallback. `disconnect` requires interactive confirmation and removes only Recurs metadata; it also clears role assignments to that exact connection but does not sign out, revoke, or delete vendor-owned authentication. Removing the primary leaves no primary instead of selecting another billing source implicitly.

### Native authority diagnostics

`recurs doctor native [--json]` reports the bounded native-authority status available to the CLI; it never starts the agent runtime, prompts for a key, opens Keychain itself, or reveals native paths, descriptors, signing identities, account values, endpoints, headers, or secrets. Text output is intended for a person. JSON is a stable versioned envelope:

```json
{"version":1,"nativeAuthority":{"state":"unavailable","reason":"launcher_unavailable"}}
```

Current ordinary macOS npm/source execution reports `launcher_unavailable` and exits successfully because an unavailable diagnostic is a valid result; non-macOS source execution reports `unsupported_platform`. The public entrypoint deletes `RECURS_NATIVE_FD` before loading the application, never reads or writes an injected descriptor, and never treats a descriptor number as provenance.

The private launcher path now exists in code but is not shipped as a signed/notarized installed artifact. After production-signing validation, it resolves only nonsymlinked `Contents/Resources/runtime/bin/node` and `Contents/Resources/engine/main.js`, creates one anonymous socketpair, maps the engine endpoint to descriptor 3, and directly spawns the child with descriptors `0`–`3` only. `PATH`, cwd, environment variables, and user arguments cannot select either file. Source, unsigned, and ad-hoc launchers fail this engine path with exit `78` and empty stdout/stderr. The child stays in the foreground process group; cancellation receives a bounded grace period before exact-PID shutdown/reap, and the launcher mirrors its final exit or signal.

The launcher/private-engine bridge carries bounded health, cancellation, and OpenAI onboarding frames. Production broker startup recovers its credential authority before listener activation and exposes a private launcher-only lifecycle surface with `persistentCredentials: true`. A directly injected peer that claims readiness reports `peer_identity_unverified`, because its own attestation cannot authenticate provenance; there is no JavaScript or environment override. Source/npm and ad-hoc builds cannot pass the broker's production gates. Invalid CLI subcommands or duplicate/unknown flags exit `2`; `SIGINT` cancels native diagnostics and onboarding with exit `130` and a fixed message.

Native component `0.2.0` authenticates an exact profile binding in every schema-v2 broker journal record and accepts the same identity only through bounded non-secret metadata. Route authority reserves the exact Keychain generation and debits scope, cancellation, expiry, and checked budgets only after final revalidation. OpenAI setup now connects foreground TTY capture, provider-verified catalog staging, native commit/reconciliation, and redacted registry persistence. Real controlling-PTY tests prove restoration with no input echo across interrupt, termination, hangup, and suspend/resume. Unreleased schema-v1 journals have no migration and must be reset by development users. Broker-owned generation and OpenAI continuation are implemented and tested, but remain unavailable in source/npm and undistributed pending a signed/notarized installed artifact and production credential-canary smoke.

Diagnostics alone are not provider activation. Every broker-owned catalog path still requires its native request codec and endpoint profile, current policy, compatible platform, onboarding/connection lifecycle, provider adapter, and signed installed-artifact tests. Missing any requirement keeps execution unavailable. OpenAI onboarding and transport trust macOS system proxy and root configuration rather than repository proxy/CA environment variables.

### OpenAI API setup

```bash
recurs setup openai
recurs setup openai --model <exact-reviewed-model-id>
recurs setup openai --recover
```

Setup is local, interactive, and manual only. The CLI discloses that API billing is separate from ChatGPT and that the system proxy and certificate roots are trusted. The native authority captures and stores the key; JavaScript receives only redacted status, exact model metadata, and a non-authorizing identity fingerprint used for reconciliation. Setup verifies the provider catalog, intersects it with Recurs's reviewed capability profile, and commits native and non-secret registry state through a recoverable transaction. In a production-signed native session, the saved connection can immediately use the broker-owned generation stream; source/npm and ad-hoc execution cannot activate it.

### Local setup

The CLI can verify and save a credential-free OpenAI-compatible server bound to literal `127.0.0.1` or `[::1]`. It refuses DNS names, LAN/remote addresses, HTTPS, URL credentials, queries, fragments, and redirects.

For Ollama, start the server, ensure the model is installed, then run:

```bash
recurs setup local --url http://127.0.0.1:11434/v1 --model qwen2.5-coder:7b
```

For LM Studio, enable its local server and use its displayed model identifier:

```bash
recurs setup local --url http://127.0.0.1:1234/v1 --model <model-id>
```

Setup reads `/models`, requires an exact model match, and writes only non-secret endpoint/model metadata under `RECURS_HOME`. A normalized loopback origin identifies one record, so changing that origin creates another connection instead of redirecting an existing pin. Only the first record in an empty registry becomes primary; later records remain secondary until `account set-primary` is explicit.

### Codex with ChatGPT

Run Codex setup from a local interactive terminal:

```bash
recurs setup codex
```

Before starting, the CLI requires explicit acknowledgement that eligible ChatGPT plans include Codex usage but the provider may automatically consume available prepaid credits after included limits. The pinned official adapter reports authentication status; Recurs accepts only a structured `chat-gpt` account, uses only a currently advertised `chat-gpt` login method when sign-in is needed, rechecks status after login, and verifies a temporary session exposes the selected model and Codex `read-only` mode. Adapter 1.1.2 does not report plan tier, organization, or remaining allowance, so Recurs claims only ChatGPT authentication and session usability. The non-secret registry retains the verified account label and a canonical one-way fingerprint so later runs can detect an account change. Public account output omits both; session pins retain only the non-authorizing fingerprint, not the account label. Recurs never imports or stores the token, auth-file contents, or browser cookie. Vendor session IDs are kept only as bounded process-scoped continuation payloads and never enter the registry, JSONL session log, or public account output.

Adding another ChatGPT account leaves the existing primary unchanged. Re-running setup for the same verified account updates that exact record without changing whether it is primary or secondary.

Every Codex run rereads the registry and current billing/usage policy. The active account is then verified against the saved fingerprint on the exact initialized ACP child, after continuation loading when resuming, and again after configuration immediately before continuation staging and prompting. Codex runs only in a local manual CLI REPL with the user present. It is Plan-only/read-only: Act mode, remote or scripted use, recognized CI even with a TTY, implicit programmatic submission, `recurs run`, unattended/background work, and automatic continuation while account or policy state is uncertain all fail closed. Core also rejects every non-read opaque runtime approval in Plan mode regardless of Ask Always, Approved for Me, or Full Access.

This Codex path remains implemented for the public npm/source executable. The sealed private engine intentionally replaces the delegated-runtime module with a fixed `adapter_unavailable` implementation; it does not search `node_modules` or invoke an ambient Codex binary. Codex remains unavailable through the native launcher until its adapter and binary have a reviewed fixed signed-bundle layout.

A host injects a provider that implements:

```ts
interface ModelProvider {
  readonly id: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}
```

The normalized request contains the model name, immutable message snapshot, visible tool definitions, and an abort signal. The stream returns text/reasoning deltas, normalized tool calls, usage, and one terminal event. The shared reducer rejects blank successful completions, a tool-call stop without a tool call, and tool calls paired with an inconsistent stop reason; Recurs does not silently accept a blank answer or spend more tokens on an implicit semantic retry. Usage preserves provider-reported cached-input, cache-write, and reasoning-token breakdowns across JavaScript and native-broker transports. `inputTokens` remains the provider-normalized total input count; the optional fields are breakdowns, not extra tokens to add again. Missing fields remain absent, and Recurs does not infer dollar cost from a static price table. `ScriptedProvider` supplies deterministic responses for tests and embedded development.

Retryable direct-provider failures may run at most twice, and only before text, reasoning, a tool call, reported usage, or committed provider state has been observed. Recurs uses 200 ms then 400 ms by default. Reviewed HTTP adapters honor numeric seconds, HTTP dates, and `retry-after-ms` hints, but cap every wait at 30 seconds and expose the selected delay through a normalized retry event. Cancellation interrupts the wait immediately. A failure after any replay-unsafe boundary is terminal because replay could duplicate visible work, provider state, or spend.

Every normalized provider stream, including compaction, has a five-minute idle deadline between events. The deadline also covers waiting for the first event, aborts the provider request when it expires, and becomes a retryable transport failure. The normal replay rule still applies: the agent loop may retry a silent pre-output stream, but never one that crossed a visible-output, tool, usage, or committed-state boundary. User cancellation wins immediately. This is a liveness boundary, not a total turn-duration limit; active streams can run longer than five minutes.

Native-tool providers use the provider-neutral `native_tool_use_v2` profile. They may emit up to four independent built-in read calls together; Recurs starts and settles that bounded group concurrently but persists tool events and returns results in provider call order. Only `read_file`, `list_files`, `search_text`, `code_outline`, `git_status`, `git_diff`, `git_history`, and `git_show` opt in. A call that is mutating, dynamically mutating, approval-requiring, malformed, policy-disallowed, unknown, or not explicitly marked safe becomes a serial barrier. The `compatible_tool_use_v1` profile remains one call at a time for conservative OpenAI Chat-compatible models.

The root model can use `request_user_input` for one necessary clarification during a turn. A request contains one question of at most 2 KiB and optionally two to four unique 128-byte choices. It is available only to a local, manual, user-present CLI REPL; scripted, one-shot, remote, ACP, SDK, CI, child, and team contexts fail closed. The CLI temporarily preempts its pending live-steering prompt, displays the bounded question, accepts a choice number or at most 4 KiB of free text, and then restores normal prompt routing. A blank answer becomes an explicit declined result. Cancellation aborts the tool. The question and answer become ordinary durable tool-call/result context, so this tool must never request passwords, API keys, tokens, or other secrets. Facts discoverable from the workspace should still be explored instead of asking the user.

### Repository structure

`read_file` opens the resolved regular file without following a final symlink, compares its device, inode, size, modification time, and change time before and after the complete read, and records a patch-authorizing SHA-256 only after that evidence is stable. Source files are capped at 8 MiB before allocation; selected output remains capped at 256 KiB. NUL data and malformed UTF-8 fail closed instead of becoming lossy model context. A line range narrows returned context but does not bypass the full-source integrity and size boundary.

`list_files` accepts a workspace directory, a result limit, and an optional ripgrep glob. It collects NUL-delimited path bytes from the canonical resolved directory, omits non-UTF-8 or credential-classified records, normalizes paths against the canonical workspace, sorts by UTF-8 bytes rather than host locale, and returns one JSON-escaped `{path}` record per line. Raw collection and rendered output have independent byte limits; metadata reports accepted, omitted, and conservatively truncated results. The glob is passed as a literal process argument, remains bounded to 1 KiB, respects repository ignore rules, and is applied before Recurs's deny-last credential exclusions. This keeps one discovery tool available to existing parent and child profiles instead of adding a redundant `glob` tool or changing immutable historical policies.

`search_text` keeps literal fixed-text matching as its default and accepts an explicit `regex` mode for ripgrep's linear-time regular expressions. Queries are capped at 16 KiB, globs at 1 KiB, and returned matches at 100 by default or 1,000 when requested. Each returned line is a JSON object with a normalized path, one-based line number, and JSON-escaped text; raw process evidence and rendered output have independent byte limits. Metadata distinguishes returned matches, observed matching lines and occurrences, omitted unsafe records, and conservative truncation. Arguments remain literal, repository ignore rules apply, and credential exclusions are appended after any model-supplied include glob.

`code_outline` gives parent and child agents an on-demand structural view without automatically placing an entire repository map into every prompt. It accepts a file or directory plus optional fixed-text query, file limit, symbol limit, and `source` or `references` ranking. The default `source` mode preserves the concise path-ranked outline: query mode finds source files containing the text or matching it in their path, then returns matching declarations; a path match returns that file's complete bounded outline. TypeScript, JavaScript, and their JSX/module variants use the official TypeScript compiler syntax tree, so multiline declarations, class/interface methods, namespaces, and callable variables are recognized without treating comments or strings as code. Other supported languages retain conservative lexical extraction.

The opt-in `references` mode scans the bounded candidate set, counts exact declaration identifiers, builds a weighted file-reference graph, and ranks declarations by distributed graph importance. Repeated mentions grow sublinearly, identifiers defined in many files and short generic names are downweighted, and long compound identifiers receive a specificity boost. A query focuses that ranking without hiding all surrounding symbols. Directory discovery respects ripgrep ignore rules and Recurs's credential exclusions. Reference ranking remains lexical even for parser-backed declarations: counts can include comments or unrelated identifiers with the same spelling. Neither mode resolves types, imports, definitions, or project configuration, and neither claims language-server diagnostics.

`typescript_diagnostics` runs Recurs's pinned TypeScript compiler against one workspace config, defaulting to `tsconfig.json`. It is a fixed, shell-free, network-denied process with no arbitrary compiler arguments: Recurs forces plain output, `--noEmit`, a bounded timeout/output limit, and redirects incremental metadata away from the workspace. Ordinary type and configuration failures return as model-visible diagnostic evidence instead of becoming opaque tool failures; cancellation, timeout, output overflow, compiler startup failure, and an external or credential config path still fail closed. Because the tool is non-mutating, the root agent can use it in Plan as well as Act mode. Existing versioned child profiles remain unchanged; a future child policy must opt in under a new stable version. The sealed private native engine does not expose this tool until the compiler is included in its reviewed fixed bundle. This is TypeScript project checking, not a general LSP, semantic navigation service, watch mode, build mode, or multi-language diagnostics claim.

`git_status` gives the model machine-readable workspace state in Plan or Act mode. It accepts no options and reads Git's stable porcelain-v2, NUL-delimited format with branch headers, ahead/behind counts, complete untracked discovery, rename detection, and fixed credential exclusions. Recurs validates every structural field before returning one JSON object per line: a branch record followed by path-sorted change records for ordinary edits, renames/copies, conflicts, and untracked files. Newlines and other unusual UTF-8 characters therefore remain inside JSON strings instead of corrupting record framing. Non-UTF-8 and credential paths are omitted and reported conservatively; raw and rendered evidence have separate byte bounds.

`git_diff` returns a bounded raw patch for the working tree or index in Plan or Act mode. An optional path is resolved inside the canonical workspace and passed to Git as a top-level literal pathspec, so pathspec syntax in a filename cannot widen the request. Recurs fixes patch prefixes, disables renames, external diff drivers, text conversion, color, submodule dirtiness, hooks, filters, fsmonitor commands, and lazy fetching, then appends deny-last credential exclusions. The result is intentionally patch text for review and synthesis; structured workspace classification belongs to `git_status`.

`git_history` gives the root agent recent repository context in Plan or Act mode without opening a generic shell. It accepts only an optional workspace path and a limit from 1 to 100, reads from the current `HEAD`, and returns bounded JSON-lines metadata for each commit: full object ID, authored timestamp, author name, and subject. It never accepts revision expressions, branches, formatting directives, commit bodies, patches, notes, signatures, replacement objects, or credential paths. Fixed Git policy still disables hooks, filters, fsmonitor commands, and lazy fetching. Existing versioned child profiles remain unchanged; this root capability does not silently expand team authority.

`git_show` lets the root agent inspect the change behind one `git_history` result in Plan or Act mode. It accepts exactly one full lowercase object ID, requires that commit to be reachable from the current `HEAD`, and optionally filters through one literal workspace path. It returns bounded JSON-escaped metadata followed by a bounded first-parent patch. Abbreviations, revision expressions, branches, unreachable objects, commit bodies, renames, external diff drivers, text conversion, notes, signatures, replacement objects, and credential paths are unavailable. A commit with no accessible patch returns no commit prose. Existing versioned child profiles remain unchanged.

Result metadata reports `typescript_compiler_v1`, `lexical_v1`, or their mixed form plus the file count handled by each engine. The source/npm CLI installs the pinned compiler dependency. The sealed private native engine deliberately falls back to lexical TypeScript/JavaScript extraction until a reviewed compiler is included in its fixed signed bundle; it reports that fallback truthfully in the same metadata. Recurs also recognizes conservative declaration forms in Python, Rust, Go, Swift, Java, Kotlin, C#, Ruby, PHP, C/C++, and shell files. Each file, aggregate scan, indexed declaration count, returned symbol count, discovery output, and final output is bounded; binary, oversized, generated, credential, sensitive, and mid-read-changing files are omitted and reported. An outline is never recorded as a complete-file read revision, so it cannot authorize a later patch.

### Public web evidence

`web_fetch` gives the parent agent a narrow way to read a known public HTTP(S) URL. It is a network permission at elevated risk, so Ask Always prompts for every URL and Approved for Me can retain an exact session grant. Plan mode may use it because it does not mutate the workspace, but it remains a serial approval barrier rather than a parallel-safe read.

The transport accepts no URL credentials, cookies, authorization, referrer, inherited proxy, or compressed response. It resolves every request and redirect hop itself, rejects local/reserved names and any private or mixed public/private DNS answer, then pins the verified address set into the actual socket lookup. Redirects are limited to three on the same host and port, with HTTPS downgrade denied; another origin requires a separate model call and permission decision. The complete operation has a 30-second hard maximum, a 1 MiB response limit, a 256 KiB output limit, and a 16 KiB response-header limit. Only textual MIME types are accepted. HTML conversion is deliberately best effort, not browser rendering or sanitization, and returned content is JSON-quoted and explicitly marked as untrusted external data.

This is not web search, a browser, authenticated HTTP, arbitrary downloading, or a source-verification claim. Existing child and team profiles do not include `web_fetch` and permit no network category, so this addition does not expand child authority. A future network-enabled profile must make that authority explicit rather than inheriting it accidentally.

`createStandaloneRuntime(eventSink, { provider, model })` remains the test/embedding assembly point for an injected provider. Normal standalone assembly also resolves saved local, environment-BYOK, brokered-native, and Codex records into immutable version-2 backend pins. A saved BYOK record runs only when the exact named credential matches its stored fingerprint; missing or changed credentials fail before provider work with the required variable named safely. Launching the compiled CLI without a connection keeps workspace commands available, but `recurs run <prompt>` exits with configuration code `2` before persisting the prompt. JSONL mode emits one `configuration_error` object without prose on standard output.

## Start and run

Interactive mode:

```bash
node packages/cli/dist/main.js
```

During a live direct-provider turn, the interactive prompt remains available.
Plain text entered there is queued as same-turn steering rather than starting a
second turn. Recurs applies it at the next safe model boundary, persists a
`turn_steered` record and normalized event, and includes it in the following
provider request. The terminal completion boundary closes the queue atomically,
so input is either accepted for that exact turn or rejected as already
finishing. The queue permits at most four pending inputs, 16 KiB each and 32 KiB
in total. `/cancel`, `/status`, `/help`, and `/queue <prompt>` remain available
while the turn runs.

Steering does not abort a provider request already in flight; it takes effect
after that response and any requested tool calls settle. Opaque delegated
runtimes do not expose this direct-loop boundary, so Recurs rejects live input
for them instead of claiming it was applied.

Use `/queue <prompt>` when the input should be a distinct turn rather than
same-turn steering. Recurs admits at most four pending turns, waits until each
accepted prompt is durably appended, then runs locally admitted turns in FIFO
order after the current turn succeeds. A failure or cancellation never silently
replays pending work. Queued turns survive restart, but recovery is explicit:
`/queue` or `/queue list` inspects IDs without rendering prompt contents,
`/queue resume` continues from the exact FIFO head, and `/queue clear` requires
confirmation. While durable work is pending, unrelated new prompts are rejected
instead of bypassing it. This first queue is available only for direct-provider
parent sessions; it is not a background daemon or recursive scheduler.

One non-interactive run:

```bash
node packages/cli/dist/main.js run "inspect the repository" --format text
node packages/cli/dist/main.js run "inspect the repository" --format json
node packages/cli/dist/main.js run "inspect the repository" -C /path/to/project --format jsonl
node packages/cli/dist/main.js run "inspect the repository" --format jsonl
node packages/cli/dist/main.js run "run the checks" --permissions full --format jsonl
node packages/cli/dist/main.js run "inspect efficiently" --mode economy --format jsonl
node packages/cli/dist/main.js run "inspect without editing" --plan --format json
node packages/cli/dist/main.js run "review with the saved work account" --connection <connection-id> --format jsonl
node packages/cli/dist/main.js review -C /path/to/project --format json
node packages/cli/dist/main.js run "continue the review" --resume <session-id> --format jsonl
node packages/cli/dist/main.js run "explain this interface" --image ./screenshot.png --format jsonl
cat prompt.md | node packages/cli/dist/main.js run - --format jsonl
cat logs.txt | node packages/cli/dist/main.js run "Summarize these logs" --stdin
```

The no-argument interactive CLI requires a user-present local terminal and rejects recognized automation even when it allocates a TTY. The one-shot prompt examples require a configured local provider or an injected provider. A plain `recurs run` always creates a fresh durable session, so automation never inherits whichever compatible conversation happens to be newest. `--permissions ask|approved|full` pins that preset into the fresh session; Full still preserves credential denials, sensitive and external-path prompts, integrity controls, and the macOS/Linux workspace sandbox. Windows subprocess tools remain unsupported.

`--format json` suppresses live events and writes exactly one versioned terminal object after all owned runtime resources settle. Success produces `run_result` with the exact session ID and an `agent` or `command` result; the agent result retains final text, usage, step count, changed files, and evidence. User-actionable preflight failures produce `configuration_error` and exit `2`. Started or preflight cancellation, unexpected pre-coordinator failure, and cleanup failure produce `run_error` with a nullable session ID, normalized safe `IntegrationFailure`, and exit `1` or `130`; unsafe cleanup always exits `1`. Provider authentication, rate-limit, transport, context, and invalid-response failures retain provider-domain codes and recovery hints; raw causes never enter the document. Cleanup failure overrides a would-be success because the runtime did not settle safely. Use `--format jsonl` when a caller needs normalized events as work progresses. Aggregate JSON is built from the already bounded run result rather than buffering the event stream.

`-C <directory>` and `--cd <directory>` select one existing directory as the canonical working root for ordinary interactive, setup, provider, account, and headless CLI work. Relative paths are resolved from the caller's directory, then canonicalized before runtime creation. Recurs does not call `process.chdir`: sessions, project instructions, tools, MCP trust, and the OS sandbox all receive the same exact root. An unavailable path fails before a session is created. Resuming from a different root still fails the existing workspace check. ACP rejects this flag because the ACP client supplies and validates its session root.

`--mode economy|standard|balanced|performance|max` pins the current version of one existing operating policy into a fresh headless session. An exact historical policy ID such as `balanced_v4` is also accepted for deterministic replay. The mode changes real model eligibility, child/request limits, concurrency, review depth, and reported-cost ceilings; it is not a display-only quality label. Like permissions, mode cannot be overridden while using `--resume`, because a resumed session retains its immutable stored policy.

`--connection <connection-id>` selects one exact saved provider/model binding for a fresh headless session without changing the registry's primary connection or role routes. Use `recurs account list --json` to obtain the stable ID. Missing connections and simultaneous process-scoped provider overrides fail closed. A resumed session rejects the flag because its original connection is already immutable.

`recurs run <prompt> --plan` creates the fresh durable session with Plan authority in its sequence-zero root-agent descriptor. Mutating tools are therefore unavailable for the entire one-shot run; this is not a prompt hint or a mutable process default. It composes with `--connection`, `--mode`, `--permissions`, `-C`, structured output, stdin, and images. It cannot accompany `--resume`, because resume retains the exact stored Act/Plan state.

`recurs review` is the non-interactive form of the existing `/review` workflow. It creates one fresh Plan session, reads bounded staged and unstaged diffs through the hardened Git tool, and submits the standard correctness, regression, security, and missing-test review prompt. It supports the shared working-root, connection, operating-mode, permission, and output-format flags. Positional prompts, stdin, images, resume, and a redundant `--plan` are rejected instead of producing ambiguous review scope.

`--resume <session-id>` instead continues one exact durable parent session in the current canonical workspace without creating a throwaway session. It revalidates the session's immutable backend pin against the current saved connection or process-scoped provider before any prompt is persisted. A missing/changed credential, disconnected provider, mismatched backend, child session, or simultaneous connection, permission, or mode override fails closed. The resumed session retains its stored permission, operating mode, Plan/Act state, usage, and visible conversation. Codex still rejects this unattended path because its subscription policy requires a local user-present manual CLI. In JSONL mode every normalized event includes the exact `sessionId`; wrappers should read it from `turn_started` and supply it explicitly on the next invocation. JSONL uses the same runtime and events as the interactive CLI.

`recurs run -` reads the complete prompt from an explicit non-interactive stdin pipe. `recurs run <prompt> --stdin` appends the piped input inside a labeled `<stdin>` block after the positional instructions. Both forms require nonempty valid UTF-8, stop at 1 MiB, honor host cancellation before session creation, and work with `--resume`. Recurs never opportunistically waits on stdin when neither form is requested, and it rejects these flags on a TTY rather than turning the terminal into a hidden second prompt.

`recurs run <prompt> --image <path>` adds one explicit local PNG, JPEG, or WebP image; repeat the flag for at most four images and 5 MiB of decoded image data in total. Paths are resolved from the canonical working root. Recurs rejects symlinks, non-regular files, mismatched file signatures, and files that change while being read. It persists only validated media type and base64 bytes inside the private session journal, never the local path, so the same input remains available across tool rounds and exact resume. Direct OpenAI Responses, reviewed Chat-compatible, Anthropic Messages, and private native-broker adapters encode images in their native wire formats. The adapter boundary is verified locally; a selected model that lacks vision support can still reject the provider request. Opaque delegated runtimes do not expose a Recurs-controlled image contract yet and fail before starting instead of silently dropping the image.

The local interactive REPL uses the same boundary. `/image <path>` validates and stages one image for the next ordinary prompt, including a terminal-dropped path escaped with spaces or wrapped in quotes. `/image` reports the staged count and decoded-byte budget without retaining source paths, and `/image clear` discards the in-memory attachments. Up to four images may be staged. Slash commands do not consume them, and adding an image during an active agent turn is rejected rather than ambiguously treating it as live steering. The next idle ordinary prompt takes the complete staged set exactly once before starting, so a later prompt cannot accidentally resend it.

### Long-running command sessions

The direct-model runtime owns up to four active command sessions across the parent and its children. `run_command` waits up to 10 seconds by default, or an explicit 250–30,000 ms yield interval. A command that is still running returns a random session identifier. The model can then use `process_session` to poll recent output, write at most 64 KiB to stdin, close stdin, or stop the process. Output is incremental and remains subject to the existing 1 MiB command limit and 10-minute maximum runtime.

The interactive user can run `/process` (or `/processes`) to list only the command sessions owned by the current conversation without draining their output. `/process <id>` collects currently buffered output; `wait [ms]` waits up to 30 seconds for new activity; `write <text>` sends visible literal text; `enter [text]` appends a newline; `close` closes piped stdin; `resize <columns>x<rows>` changes an owned PTY; and `stop` performs bounded cleanup. The same limits are enforced again by the owner manager, not only by the slash-command parser. Directly rendered control bytes are escaped so process output cannot issue terminal control sequences. These commands do not expose another conversation's processes or provide hidden-secret input.

`/process <id> attach` is available only in the local, manual, user-present CLI for a running PTY owned by the current conversation. Recurs pauses line editing, switches its input terminal to raw mode, relays exact bounded input bytes, forwards bounded window sizes, and renders the PTY stream directly until the child exits or `Ctrl-]` detaches. Detaching leaves the command running and restores the prior terminal mode even on failure. Because attached output is intentionally a terminal stream, the child can emit cursor and other control sequences. Attachment is not available through ACP, one-shot/SDK/remote hosts, or piped sessions, and it is not a protected credential-entry channel: input crosses the TypeScript process and terminal output may echo or retain it.

`run_command` can explicitly set `tty: true` when a command needs terminal semantics. Supported macOS and Linux npm/source installations allocate a real `xterm-256color` pseudo-terminal at 120 columns by 30 rows; `process_session` can resize it within bounded dimensions before sending more input. PTY output is returned as the terminal emitted it, including control sequences and CRLF. A PTY has one combined output stream and cannot honestly half-close stdin, so `closeStdin` is rejected for terminal sessions; send the program's normal terminal input or stop the session instead. If the optional platform PTY package did not install, Recurs fails that request with `tool_unavailable` while ordinary piped commands continue to work.

Only the agent session that started a process can control it. Its original permission decision, network policy, workspace sandbox, isolated environment, output bound, timeout, and process group remain fixed. One workspace checkpoint spans the complete process lifetime and is finalized on exit, timeout, cancellation, explicit stop, startup failure, or runtime shutdown. Closing Recurs terminates all remaining owned processes and fails visibly if cleanup or checkpoint completion cannot be confirmed.

Piped sessions remain the default for dev servers, watchers, long verification, and simple line-oriented input. PTY attachment is a bounded raw relay, not a separate full-screen terminal emulator. Recurs does not claim scrollback management, arbitrary terminal-signal controls, or safe hidden input for authentication and passphrase prompts. The sealed native engine does not package the optional Node PTY dependency and therefore reports PTY requests as unavailable; Windows subprocess tools remain unsupported.

### ACP stdio agent

`recurs acp` serves Recurs as an Agent Client Protocol v1 agent over standard input and output. It is a thin host over the same standalone runtime: every ACP `session/new` creates a distinct pinned Recurs session, and `session/prompt` uses the ordinary coordinator, provider, permissions, tools, sessions, and child/team engine. Model text and reasoning, tool lifecycles, and Recurs child, batch, and team activity are projected into typed ACP session updates. A client permission prompt can grant or reject one operation; Recurs does not advertise an always-allow choice through this boundary.

The endpoint deliberately classifies prompts as local, unattended, scripted SDK work. Direct local, environment-BYOK, and supported brokered-model providers can run only when their existing policy admits that context. The ChatGPT Codex subscription adapter remains local, manual, user-present CLI-only and therefore fails closed through ACP. An editor connection is not treated as proof that a user is present.

The v0 handshake advertises baseline text, bounded image, and resource-link prompts plus session cancellation and close. ACP images use the same PNG/JPEG/WebP, four-image, and 5 MiB aggregate validation as the CLI before entering the durable provider-neutral message contract. Audio and embedded-resource prompts are rejected. Additional workspace roots and client-supplied MCP servers are rejected, and no MCP capability is advertised. Recurs uses its own bounded host tools rather than delegating filesystem or terminal authority to the ACP client. On connection loss, active Recurs runtimes are cancelled.

### Agent Skills

Recurs supports the open [Agent Skills `SKILL.md` specification](https://agentskills.io/specification) for bounded, progressive instruction loading. At startup it scans direct child directories in `~/.agents/skills` and `$RECURS_HOME/skills`, with the Recurs directory taking precedence. It also detects `.agents/skills` and `.recurs/skills` in the active workspace, with `.recurs` taking precedence, but repository-provided skills are disabled by default. `/skills enable-project` requires a local, user-present, manual CLI or desktop invocation plus explicit confirmation; trust lasts only for that Recurs process. `/skills disable-project` removes them immediately from subsequent model context.

Discovery validates the skill name against its directory, requires bounded YAML frontmatter and UTF-8 Markdown instructions, skips symlinks, hard-linked files, and credential-classified resources, limits each scope to 64 skills, and reports malformed or colliding entries through `/skills`. Enabled name/description metadata is added to the parent direct-provider system context under a 16 KiB catalog budget; `/skills` still lists the complete discovered catalog. The read-only `activate_skill` tool loads one skill's instructions and lists at most 64 bundled resource files; an exact listed UTF-8 resource can then be loaded through the same tool. Paths are confined to the skill directory and tool invocation remains subject to the ordinary parent read policy.

This is not a plugin installer. Recurs does not download skills, automatically execute bundled scripts, interpret `allowed-tools` as authority, persist project trust, expose skills through historical bounded child profiles, or inject them into an opaque delegated runtime's private prompt. Executable MCP servers use the separate authority boundary below; a skill cannot enable one.

### MCP stdio tools

The parent direct-provider loop can use configured stdio MCP servers. User configuration lives at `$RECURS_HOME/config/mcp-servers.json` (normally `~/.recurs/config/mcp-servers.json`) and must be owned by the current user, mode `0600` or stricter, a regular single-link file, valid bounded JSON, and no larger than 64 KiB. Recurs also discovers `.recurs/mcp-servers.json` below the canonical workspace. A project file must be an owned, single-link regular file with no group/other writes, but its servers remain disabled by default. `/mcp` lists both sources without starting a server.

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

Configuration supports at most 32 stable server IDs, absolute commands, at most 32 bounded literal arguments, and `network: "allow"` or `"deny"`. It cannot define environment variables or a shell string. The first approved `list_tools` or `call_tool` operation starts a process, negotiates a supported MCP protocol version, and creates one session for the exact server/workspace/sandbox identity. Calls for that identity are serialized. Before reusing the process, Recurs requires a successful MCP `ping`; a failed ping closes the process and permits one fresh initialization before the requested operation. A tool call that fails after it is sent is never retried because its external effect may be ambiguous. Pagination, per-operation time, protocol lines, lifetime output, and result size are bounded. The process gets Recurs's private home/config/cache/temp environment and never inherits API keys, tokens, proxy settings, or provider authority.

`/mcp trust-project` is accepted only from a local, manual, user-present CLI or desktop invocation and requires explicit confirmation. Recurs stores versioned trust below the workspace's private project-data directory with the canonical workspace path and exact SHA-256 of the loaded config; it never stores credentials or server output there. Trust survives restart only while those exact bytes remain unchanged. A changed, replaced, unsafe, malformed, or colliding project config is disabled before process execution and requires a fresh review. Project server IDs cannot collide with user server IDs. `/mcp untrust-project` removes the trust record, aborts active project MCP operations, closes their processes, and disables the servers immediately.

`/mcp` reports `idle`, `connected`, or `failed` plus negotiated server identity for a connected session. It does not start a server. Cancellation sends the MCP cancellation notification, then invalidates and closes the complete process group; timeout and protocol failure do the same. Interactive exit, one-shot completion/failure, ACP session close/disconnect, and explicit runtime close all dispose their owned sessions. Persistence is limited to one live Recurs runtime and is not a daemon or cross-process cache.

The model-facing `mcp` tool is classified as mutating because server initialization and tool annotations cannot prove read-only behavior. It is unavailable in Plan mode, always declares an elevated shell intent, adds an elevated network intent only for `network: "allow"`, and uses normal Ask Always/Approved for Me/Full Access decisions. On macOS and Linux it receives the same workspace sandbox as other arbitrary processes. Existing child/team profiles do not receive MCP.

Server metadata, JSON Schemas, annotations, instructions, and results are untrusted data. They cannot widen Recurs permissions or change policy. Automatic installation, cross-runtime daemons, Streamable HTTP/OAuth, prompts, resources, sampling, elicitation, and ACP-client-supplied MCP servers remain intentionally absent. Project trust applies only to the parent direct-provider stdio catalog; it does not grant historical child/team or delegated-runtime access.

Example editor agent command configuration:

```json
{
  "command": "recurs",
  "args": ["acp"]
}
```

Build and `npm link` the source checkout first. No ACP package or release artifact is published yet.

Exit codes:

- `0`: success.
- `1`: terminal agent or provider failure.
- `2`: usage or provider-configuration failure.
- `130`: cancellation.

## Permissions

Every tool reports normalized intent before execution. `/permissions` selects one of three session presets:

| Mode | Behavior |
| --- | --- |
| Ask Always | Project reads run normally. Every write and shell command asks. Sensitive files, network, external paths, deployment, and destructive actions also ask. Classified credential paths are denied. This is the default. |
| Approved for Me | Normal guarded project reads/writes run automatically. Shell commands still ask. On macOS and Linux an approved command also runs in the workspace sandbox; Windows subprocess tools are unsupported. Network, external, sensitive, deployment, and destructive actions also ask. Classified credential paths are denied. |
| Full Access | Routine workspace, command, network, deployment, and destructive prompts are skipped after explicit confirmation. Sensitive and external paths still ask, and classified credential paths are denied. Integrity controls remain enabled. On macOS and Linux command subprocesses remain sandboxed; Windows subprocess tools are unsupported. |

An explicit outside path can run only after its external-path intent is approved, including in Full Access. A hidden symlink escape remains blocked because the model did not request that outside path explicitly.

For headless execution, `recurs run <prompt> --permissions ask|approved|full` selects the same policies without an interactive confirmation. Supplying the flag is the explicit authorization and always starts a fresh pinned session. In particular, `full` is an auto-approval policy inside the active execution boundary; it never disables the OS sandbox or credential/path guards.

Credential classification is shared across direct and aggregate built-in operations. It covers `.env` and `.env.*`, common private-key and credential filenames, certificate/key suffixes, and auth directories such as `.ssh`, `.aws`, `.azure`, `.docker`, `.gnupg`, `.kube`, and `.config/gcloud`, case-insensitively. Slash and literal-backslash path variants use the same exclusions. Direct or canonical classified targets are denied. List, search, Git status/diff, and checkpoint enumeration exclude them. Patch accepts exact slash-separated declarations without surrounding whitespace or backslashes, rejects rename/copy operations, denies canonical credential aliases before checkpoint capture, and requires Git's complete parsed path set to equal the declared revision-checked files before mutation. Configured `sensitivePatterns` remain a separate approvable policy.

This protects the built-in interfaces only. A permitted shell script can spell, discover, or open any host path available to the current user, regardless of the path classifier.

## Tool security profiles

The embedding assembly option `toolSecurityProfile` has three values:

| Profile | Behavior |
| --- | --- |
| `workspace_sandboxed` | Standalone default on macOS and Linux. Applies the normal guards and runs shell/verification children under Apple Seatbelt or a fixed system-Bubblewrap policy with workspace-only host writes, hidden host credential/runtime state, and intent-gated network. Linux adds user/PID/IPC/UTS/mount namespaces but no Recurs seccomp filter. Fails closed when unavailable. |
| `local_guarded` | Standalone default on Windows and an explicit embedding option elsewhere. Advertises the registered tools and applies Plan mode, permission evaluation, path checks, process bounds, and checkpoints. On supported process platforms arbitrary commands retain host authority; Windows subprocess execution is rejected as unsupported. |
| `tools_disabled` | Advertises no model tools and rejects every direct model-tool invocation before parsing, permissions, or checkpoint capture. This is fail-closed but is not a useful coding profile. |

Every fixed or arbitrary child process receives a fresh private home, config, cache, and temporary directory plus only a filtered absolute `PATH` and selected locale/terminal variables. It does not inherit the real home, parent `SHELL`, cloud/provider variables, proxies, sockets, Git config variables, or workspace-contained `PATH` entries. `/bin/sh -c` is used for `run_command` on macOS and Linux; it is not a login shell. Recurs terminates the process group on completion, cancellation, timeout, or output overflow, bounds output-pipe draining, destroys its pipe handles, and then performs synthetic-tree cleanup. A descendant can escape this application-level process group only under `local_guarded`; the default macOS/Linux profiles add platform containment. Subprocess tools fail with a typed unsupported-platform error on Windows.

Fixed Git operations first require Git 2.45 or newer, then pin the requested worktree and disable optional index writes, lazy object fetching, repository hooks, fsmonitor commands, external diff/text conversion, configured clean/smudge/process filters, and expanded dirty-submodule diffs. Recurs enumerates filter key names only and replaces their commands with empty command-line overrides before status, diff, patch, or checkpoint Git work; configured command values are never returned to the harness. This preflight is not protection against a hostile same-user process racing repository configuration.

Environment cleanup prevents direct inheritance on every platform. The macOS and Linux workspace profiles add OS boundaries for shell and verification children. Linux requires a trusted non-setuid `/usr/bin/bwrap` and enabled unprivileged user namespaces; it fails closed without them, refuses a workspace that contains the host home or sits inside a host credential directory, and does not yet install a Recurs seccomp filter. Windows has no equivalent containment. No sandbox profile authorizes a persistent provider credential to enter TypeScript. The Codex adapter remains vendor-authenticated and Recurs neither imports nor stores its credential.

## Plan and Act modes

Act mode is normal coding. Plan mode is enforced read-only at the tool registry:

- Available: file reads/listing/search and Git status/diff.
- Hidden and denied: patching and shell commands.

`/plan [prompt]` enters Plan mode and can immediately submit a planning prompt. `/plan exit` restores the permission preset that was active before planning. `/review` uses a temporary read-only override without changing the stored Act/Plan mode. For automation, `recurs run --plan` pins a fresh Plan session and `recurs review` runs the same bounded review workflow in a fresh Plan session.

Codex sessions are permanently constrained by their runtime profile to Plan mode and Codex `read-only` mode. Exiting Plan may update the local session mode, but the next delegated run is rejected before provider work; it cannot turn Codex into an Act-capable connection.

## Goals

`/goal` is the durable long-running-work primitive:

```text
/goal <objective>
/goal
/goal pause
/goal resume
/goal complete
/goal clear
```

Replacing or clearing an unfinished goal requires confirmation. Each successful agent turn records its final progress summary and its own verification evidence into the active goal. Completion is rejected until that goal—not an older conversation—contains both.

## Owned child agents and operating modes

`delegate_task` is Recurs's single-child orchestration primitive. A parent model supplies exactly `{ profile, description, prompt }`, where `profile` is `explore`, `implement`, `review`, or the corresponding stable ID. Recurs creates a separate pinned version-2 child session and records its parent, task, profile, policy, permission envelope, lifecycle, usage, evidence, files, and terminal result. The child runs through the same coordinator as an ordinary turn; its final handoff becomes a parent tool result, and the parent model performs synthesis.

`delegate_tasks` is the bounded independent-analysis primitive. Its exact input is `{ tasks: [{ profile, description, prompt }, ...] }` with two to eight tasks and no extra fields. Only Explore and Review are accepted. The active operating mode can impose a lower task and concurrency limit. Settled results always return in input order even when children finish in a different order, and successful sibling output and evidence remain available when another child fails.

The version-1 profiles used by single-child and analysis-batch delegation are host policies, not prompt-only roles:

| Profile | Execution and workspace effect | Exact host-controlled tools |
| --- | --- | --- |
| Explore (`explore_v1`) | Plan; read-only | `read_file`, `list_files`, `search_text`, `code_outline`, `git_status`, `git_diff` |
| Implement (`implement_v1`) | Act parent required; scoped edits and verification | Explore tools plus `apply_patch`, `run_command`, `process_session`, `run_verification` |
| Review (`review_v1`) | Act parent required; read-only inspection | Explore tools |

Where Recurs owns tool execution, the registry enforces both the exact tool names and each profile's permission-category/risk ceiling before approval. `run_verification`, available to `implement_v1`, parses one allowlisted npm, pnpm, yarn, Bun, Cargo, Go, Pytest, or Swift test/check command and executes it directly without a shell; pipes, redirection, substitution, arbitrary programs, install/deploy commands, and mutating test flags are rejected. It is still workspace-effectful because builds and tests can write artifacts, so Implement delegation receives parent-level checkpoints. The invoked project task and its arguments retain ordinary host-process authority; an allowlisted task name is not containment or proof that the task is side-effect free. Implement's separate `run_command` tool remains an approval-gated arbitrary shell with host authority: command classification and checkpoints are application defenses, not containment, and embedded scripts can evade semantic classification.

Version-4-or-newer durable teams use stricter profiles with no arbitrary-command or verification tools. Only hardened Git inspection may spawn a process, and candidate project scripts cannot be executed before Recurs has an enforceable OS boundary:

| Profile | Purpose | Exact host-controlled tools |
| --- | --- | --- |
| Implement (`implement_v2`) | Isolated staged edits | `read_file`, `list_files`, `search_text`, `code_outline`, `apply_patch`, `git_status`, `git_diff` |
| Review (`review_v2`) | Read-only staged review with strict JSON findings | `read_file`, `list_files`, `search_text`, `code_outline`, `git_status`, `git_diff` |
| Repair (`repair_v1`) | Finding-scoped edits to the staged candidate | Implement v2 tools |

Every child receives a backend route and a permission preset that cannot exceed the parent. Ordinary `delegate_task` and `delegate_tasks` children inherit the immutable parent pin. Version-5 durable teams can use an explicitly assigned saved direct-model connection for Implement, Review, or Repair when the connection is still runnable and its billing class is eligible; otherwise they inherit the parent. Explore narrows execution to Plan. Implement, Review, and Repair require Act. Child profiles exclude every delegation tool, so depth remains one. Retries are zero, and parent/run cancellation is linked to active children. A started failed or cancelled attempt consumes its child slot and request reservation; validation, preflight, or worktree setup that fails before child allocation does not. Child failures, cancellation, profile-correlated lifecycle, results, usage, and evidence remain visible as normalized events and durable session state.

Single-child `delegate_task` retains the parent-workspace behavior. Implement can edit and run approved verification there through the existing approval and checkpoint seams; Review remains read-only.

`delegate_tasks` runs independent Explore/Review children in detached Git worktrees rather than the parent workspace. The session must be at the canonical repository root, the repository must have no staged, unstaged, untracked, or submodule changes, and `HEAD` must identify a commit. Ignored local files are not present in the child. Recurs creates each lease outside the repository under `<project-data>/agent-worktrees`, records its exact revision in the child session/result, and cleans it after success, failure, or cancellation. Cleanup failure is visible and fatal. Batch worktree changes are never merged back.

`delegate_team` is the durable editing-team path. Its exact input is a description, one to four concrete Implement tasks, review instructions, and optional `execution: "foreground" | "background"`; the selected version-4-or-newer mode may impose a lower task limit. Every Implement child runs at the same exact revision in its own worktree. All workers must succeed and return a nonempty patch before Recurs stages any result. Patch artifacts are hash-addressed and limited to 1 MiB and 256 unambiguous text paths; binaries, credential paths, symlinks, submodules, mode changes, renames/copies, foreign handles, and base drift are rejected. Recurs applies worker artifacts in input order to a dedicated private staging worktree and captures one cumulative durable candidate. It never commits.

The mode's `review_v2` panel inspects the staged candidate and must return exact bounded JSON. Unanimous valid approval is `approved`; any valid change request is `changes_requested`; malformed or failed reviews without a valid change request are `unverified`. Only valid structured findings can start a `repair_v1` child. Repair runs in the same staging workspace, receives only those findings, and is followed by another Review round. Repair is a fresh depth-one sibling rather than a retry or recursive child, and the frozen policy caps it at zero, one, or two rounds.

Foreground is the default. An approved foreground candidate is applied to the parent through a durable two-phase checkpoint transaction before the tool returns. A failed checkpoint-preparation attempt leaves the reviewed candidate at `ready_to_apply` instead of discarding it. Non-approved runs do not mutate the parent. Historical version-3 policies retain their original foreground behavior when selected by exact ID.

`execution: "background"` returns after the run has a durable owner and continues only while that Recurs process remains alive. It never mutates the parent: approval stops at `ready_to_apply`, and `/agents apply <id>` or `apply_team` performs the explicit parent transaction later. Recurs releases the staging worktree before publishing ready and best-effort discards intermediate artifacts; bounded wait and direct apply confirm the cross-process owner handoff before treating ready as actionable. Starting or resuming background work requires Full Access, a local/manual/user-present Act invocation, and a backend eligible for background host-tool control. Apply requires Full Access or one explicit elevated write approval. This is useful process-lifetime concurrency, not a daemon.

One unresolved durable team may belong to a parent at a time. A separate private JSONL journal freezes its policy, parent/backend/base, role routes, tasks, review contract, allocation, child reservations/results, artifacts, rounds, cancellation, usage/cost coverage, and outcome. Cross-process owner leases admit one live parent/run writer and fence stale owners. List and detail output deliberately omit prompts, patch bodies, private worktree paths, credentials, and provider/account configuration.

Startup recovery runs before provider-policy and conversational-session activation. It reclaims only dead owners, validates a completed child's exact task/workspace/assignment binding, settles accounting, and removes stale worktrees only below Recurs's private project-data root. Recovery attempts every run, sanitizes failures, and blocks startup with one safe error when any run cannot be reconciled. Active compute cannot survive process exit: a running ownerless team becomes `interrupted`. `/agents resume <id>` or `resume_team` may restart a safely interrupted background run under fresh authorization and fresh depth-one child attempts; it never reuses a terminal child session. A stable reviewed candidate survives restart.

Parent apply records a durable checkpoint and `apply_prepared` before mutation, applies the cumulative artifact, validates the complete dirty path set, completes the checkpoint, and records `apply_committed`. If startup finds an interrupted apply, an unchanged clean base returns to `ready_to_apply`, an exact candidate diff completes idempotently, and any other workspace state remains `interrupted` with manual attention required. Recurs never silently resets or overwrites an ambiguous parent.

For an opaque delegated runtime, Recurs cannot advertise or filter vendor-internal tools. Explore is accepted only when the pinned runtime guarantees enforced Plan mode. Implement, Review, and Repair require host-controlled tools and checkpointing and therefore fail preflight on the current opaque Codex ACP runtime. Recurs does not claim visibility into vendor-internal model calls, tool catalogs, or spend.

`/agents` shows the exact policy version, concurrency, workflow child/request budget, per-child reservation, team width/review/repair policy, batch eligibility, and reported-cost ceiling. `/agents profiles` shows the profile enforcement boundaries. `/agents activity` lists durable children owned by the current parent, and `/agents activity <exact-child-or-session-id>` shows one child's safe status, usage, files, evidence, failure, and isolation revision without exposing its prompt, worktree path, account fingerprint, or provider configuration. `/agents mode economy|standard|balanced|performance|max` selects the current version-5 policy; an exact historical ID remains selectable for deterministic replay. Names are display labels, while logs and sessions store IDs such as `balanced_v5`.

| Current mode | Children | Concurrency | Requests | Reserved/child | Implement max | Review initial/max | Repair rounds | Eligible assigned billing | Quality | Cost ceiling |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| Economy (`economy_v5`) | 2 | 1 | 8 | 4 | 1 | 1/1 | 0 | local compute | essential | $0.25 |
| Standard (`standard_v5`) | 6 | 2 | 36 | 6 | 1 | 1/2 | 1 | local or included subscription | standard | $1 |
| Balanced (`balanced_v5`) | 7 | 3 | 56 | 8 | 2 | 1/2 | 1 | local, included subscription, or metered API | balanced | $3 |
| Performance (`performance_v5`) | 10 | 4 | 100 | 10 | 3 | 2/3 | 1 | local, included subscription, or metered API | thorough | $10 |
| Max (`max_v5`) | 18 | 6 | 216 | 12 | 4 | 2/4 | 2 | local, included subscription, or metered API | maximum | $25 |

Immutable version-1 through version-4 IDs remain valid for old sessions and explicit selection. Version 1 keeps concurrency one and its original total workflow budgets; version 2 keeps its original bounded Explore/Review fan-out; version 3 keeps the original foreground team semantics without durable repair/background controls; version 4 keeps durable teams with parent-only routing. Historical policies never silently acquire newer behavior. Display-name selection chooses version 5.

Version-5 team routing is explicit and conservative. Registry assignments are candidates, not unconditional redirects: preflight rereads the exact record, resolves its immutable pin, applies the mode's billing-class eligibility, checks the role/permission/background contract, and retains the parent fallback. The frozen decision is journaled before any child starts; resume fails closed if the fresh route no longer matches. Background routing additionally permits only direct local-compute or metered-API pins, never included-subscription pins. Recurs does not rank models, estimate prices, spread work across unassigned accounts, or route ordinary single/batch children yet. At child start, Recurs atomically claims one child slot and reserves that child's request allowance from the shared run budget. Starting or resuming detached work reserves the complete live parent-turn delegation budget; resume separately reconstructs the frozen run's remaining accounting, so ordinary delegation cannot share that turn. Direct runs report observed steps; an opaque runtime consumes the full reservation because its internal calls are not observable. Reported USD cost becomes known only after provider/runtime telemetry arrives, so already-active siblings can complete past the ceiling; the overrun is reported and no later child starts. Missing USD telemetry remains explicitly unavailable rather than estimated.

Economy and every version-1 mode provide a sequential batch fallback. Standard through Max version 5 cap concurrent children at two, three, four, or six. Batch results include completed, failed, and cancelled entries; ordinary partial failure is returned for synthesis, while linked cancellation or worktree-cleanup failure fails the tool. Durable teams emit normalized sequence/phase/round, routing, repair, ready, apply, interruption, recovery, failure, cancellation, and team-correlated child lifecycle activity. `/agents` projections and `agent_team_activity` omit prompts, patch bodies, private worktree paths, credentials, and account data. The private team journal and child session logs persist assigned prompts and tool calls; the general JSONL transcript can include prompts and tool arguments and is not a redacted audit feed.

Existing `explore_v1` session records remain valid. Because Recurs is still unreleased `0.0.0`, the earlier two-field `delegate_task` draft is not retained: embeddings must now provide an exact `profile` rather than receiving an implicit Explore child.

A daemon that outlives the CLI, recursive depth, automatic task decomposition, terminal-child retries, dirty-workspace snapshots, arbitrary worktree continuation, automatic model intelligence, dynamic role libraries, auto-commit/push/deploy, schedules, and the company interface remain later milestones. Current teams are explicit depth-one workflows over a clean committed parent; only bounded valid Review findings trigger Repair. Worktree isolation and owner leases are not OS containment. See the [primary-source harness comparison](research/SUBAGENT_HARNESS_COMPARISON.md).

## Slash commands

| Command | Purpose |
| --- | --- |
| `/help` | Show concise command help. |
| `/goal ...` | Create, inspect, pause, resume, complete, or clear the durable goal. |
| `/plan [prompt\|exit]` | Enter enforced read-only planning or return to Act. |
| `/permissions [ask\|approved\|full]` | Inspect or change the permission preset. |
| `/agents [profiles\|activity [exact-id]\|teams\|team <id>\|wait <id>\|cancel <id>\|resume <id>\|apply <id>\|mode ...]` | Inspect profiles, child/team activity, control an owned durable team, or change the bounded policy. |
| `/skills [enable-project\|disable-project]` | List Agent Skills or change process-lifetime trust for repository skills. |
| `/mcp [list\|trust-project\|untrust-project]` | List stdio MCP servers and live state, or manage exact digest-bound project trust. |
| `/status` | Show session, workspace, model identifier, modes, goal, total usage, any provider-reported cache/reasoning breakdowns, verified setup-time context limits (or `unknown`), and pending tools. |
| `/model [connection-id]` | List exact saved model connections or confirm starting a fresh pinned session with one. The current session and registry primary remain unchanged. |
| `/init` | Confirm and create a starter `AGENTS.md`; never overwrite existing `AGENTS.md` or `AGENTS.override.md`. The next turn loads it. |
| `/new` | Start a new durable session in the same workspace. |
| `/fork` | Copy the current completed direct-provider conversation into a new durable session. The backend, operating mode, permissions, Plan state, summary, and visible messages are preserved; usage, goals, evidence, checkpoints, workspace history, session approvals, live tools, and opaque runtime continuations are not. |
| `/resume [id]` | List sessions newest-first or resume one exact ID. Prefix matching is not used. |
| `/compact` | Durably start a direct-provider compaction, ask for a continuation summary from a byte-bounded projection of earlier context, and retain roughly the latest six messages without splitting tool-call/result groups. Provider-reported usage and typed failures are journaled. A parent session also compacts before a new turn when its immutable saved-BYOK pin has authenticated limits, its previous response reported real usage, and the conservative projected input reaches the reserved threshold. If a direct parent instead receives a clean pre-output context-overflow error with reducible history, Recurs records one turn-scoped compaction and retries that same model step once. Unknown limits and missing usage keep proactive compaction off; delegated children and delegated Codex sessions use neither automatic path. |
| `/diff [--staged] [path]` | Show a bounded Git diff without repository hooks, filters, external diff/text conversion, or expanded dirty-submodule content. |
| `/review` | Submit staged/unstaged changes for a temporary read-only review. |
| `/undo` | Restore the latest checkpoint that actually changed files. |
| `/queue [prompt\|list\|resume\|clear]` | Admit a bounded durable FIFO follow-up turn, inspect pending IDs, explicitly recover after restart, or confirm clearing the queue. |
| `/process [id [action]]` | List, poll, wait for, write visible input to, close, resize, attach to, or stop a command session owned by the current conversation. |
| `/cancel` | Abort the current provider/tool run. |
| `/quit`, `/exit`, `/q` | Exit the interactive CLI. |

Without an explicit primary, the workspace shell exposes only `/help`, `/connect`, `/model`, `/permissions`, `/agents`, `/skills`, `/mcp`, `/status`, `/resume`, `/init`, `/diff`, and exit commands. `/agents` explains the default but cannot persist a policy until a model connection creates a session. `/skills` can inspect discovery and establish process-lifetime project trust before a model is connected; `/mcp` can inspect configuration and establish or revoke persistent exact-config project trust without executing a server. Secondary records are never selected by file order. `/model` may explicitly activate one exact saved secondary connection as a fresh session while leaving the registry primary unset. `/resume <exact-id>` may load a historical pinned session for inspection and, when its exact connection still exists and matches, continued work. A changed or disconnected record fails preflight before provider/runtime work. `/connect` gives both `recurs setup codex` and the credential-free local setup command.

## Sessions and recovery

By default, project data lives under:

```text
~/.recurs/projects/<workspace-hash>/
```

Set `RECURS_HOME` to move the Recurs data root. New session logs use strict version-2 append-only JSONL. Sequence zero pins the provider lane, connection, adapter, account fingerprint, model identity, billing choice, catalog, and policy revisions; local pins also bind a digest of the normalized loopback origin. Each run rereads the registry and reconstructs that complete pin. A primary switch cannot redirect history, while a changed or missing record fails closed. Every mutation holds a cross-process lock and exact sequence; stale or concurrent writers fail. Version-1 logs remain readable and listable but cannot be changed.

Completed messages and tool/permission/turn boundaries are flushed to disk. A partial final JSONL record is quarantined during recovery; committed corruption in the middle fails loudly. Before the next turn, pending tools receive durable failure results and the prior open turn is closed as interrupted. Compaction holds the session mutation lease from its durable start through its terminal record, so it cannot hide an interleaved turn. A durable queued prompt survives compaction unchanged. Retained messages have opaque direct-provider continuation handles removed so the remote pre-compaction transcript cannot silently override the new summary. An orphaned idle compaction is closed locally with unknown usage and never retried automatically; an orphaned context-overflow compaction also closes its exact open turn as interrupted.

Delegated turns persist normalized results, usage, changed files, evidence, failures/cancellation, and opaque continuation handles. Vendor session IDs stay in a bounded process-scoped continuation store rather than JSONL. A new continuation is recorded as uncertain before terminal settlement and committed only alongside the matching durable terminal. While its process-scoped payload remains available, a later prompt first probes the uncertain tip with separate authorization. Core can record a runtime-proven committed or gone result, but the current ACP path treats an existing resumable vendor session as still uncertain and proceeds only when the session is proven gone; it never repeats remote work automatically. After process loss the payload cannot be resumed, so the durable uncertain record blocks unsafe replay. This is durable lifecycle accounting and fail-closed recovery, not persistent vendor-session storage.

Durable teams use a separate private `team-runs` JSONL store so background progress never contends with the parent conversation lease. Each append is strictly validated, sequence-checked, flushed, and fsynced. Separate parent/run owner directories provide cross-process admission and stale-writer fencing. At startup, ownerless active runs are reconciled conservatively: exact bound child terminals may settle, stable candidates remain ready, stale owned worktrees are removed, and unsafe in-flight work becomes `interrupted`. Resume is explicit and creates fresh attempts. An interrupted apply is never guessed from timestamps or a partial checkpoint; Recurs compares the canonical parent workspace with the frozen base and candidate and requires manual attention for any third state.

Compaction is also append-only: the log keeps the audit history, while replay replaces active context with the summary plus retained recent messages. Proactive compaction is intentionally limited to parent sessions created from saved environment-BYOK connections whose authenticated catalog reported a limit. Reactive recovery is also parent-only and requires a normalized `context_overflow` before any text, reasoning, tool call, usage, or provider-state event; partial output is never replayed. The public OpenAI Responses adapter recognizes the exact `context_length_exceeded` machine code in a bounded JSON error or strict streamed failure, rejects credential echo, and discards provider prose. Recovery runs at most once per turn and only when more than six messages exist, so a single oversized prompt fails truthfully instead of triggering a futile token-burning loop. Local loopback, ephemeral BYOK, native broker, delegated-runtime, and child-session pins currently keep proactive compaction off unless a later reviewed path can supply the same durable evidence.

## Checkpoints and undo

Every potentially mutating tool is wrapped with before/after workspace snapshots. Checkpoint data is content-addressed and kept outside the project and outside `.git`. Git is used only to enumerate tracked and non-ignored untracked project files; raw Git names plus canonical parent and regular-file targets are classified before Recurs reads workspace content or writes a blob. Recurs never creates commits, resets, cleans, or checks out the user's repository for checkpointing.

Fresh checkpoint stores contain a private `.format.json` marker for format version 2 with credential exclusion enabled. A nonempty unversioned store, invalid or symlinked marker, or unknown marker version is rejected without scanning, rewriting, deleting, or blessing its contents. Recurs creates the marker before the first version-2 capture, but the marker is an unauthenticated upgrade assertion rather than proof about the store's contents. Do not copy or create a marker in a legacy store.

For this unreleased `0.0.0` format, recovery is an explicit manual reset:

1. Exit every Recurs process using the project.
2. From the exact workspace root, derive and verify its checkpoint directory with the command below.
3. Move its `checkpoints` directory to a private backup outside any repository. Do not attach, publish, or inspect it with model tools; legacy data may contain secrets.
4. Restart Recurs. The next mutating tool creates a fresh marked store.

The CLI derives the project ID from the SHA-256 digest of the canonical workspace path. This command reproduces that calculation and honors `RECURS_HOME`:

```bash
CHECKPOINT_DIR="$(
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { realpathSync } from "node:fs";
    import { homedir } from "node:os";
    import path from "node:path";

    const workspace = realpathSync(process.cwd());
    const projectId = createHash("sha256")
      .update(workspace)
      .digest("hex")
      .slice(0, 24);
    const root = process.env.RECURS_HOME ?? path.join(homedir(), ".recurs");
    process.stdout.write(path.join(root, "projects", projectId, "checkpoints"));
  '
)"
printf 'Checkpoint directory for this workspace:\n%s\n' "$CHECKPOINT_DIR"
```

Inspect the printed path before moving anything. If an embedding application supplies `dataDirectory` programmatically, substitute that directory for the data root because the shell command cannot discover it. Choose a backup root outside every repository; the default below is independent of `RECURS_HOME`. Then create a private directory and collision-resistant backup name before moving the rejected store:

```bash
umask 077
BACKUP_ROOT="${RECURS_CHECKPOINT_BACKUP_ROOT:-$HOME/.recurs-legacy-backups}"
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
BACKUP="$BACKUP_ROOT/checkpoints-legacy-$(node --input-type=module -e '
  import { randomUUID } from "node:crypto";
  process.stdout.write(randomUUID());
')"
mv "$CHECKPOINT_DIR" "$BACKUP"
printf 'Moved legacy checkpoints to:\n%s\n' "$BACKUP"
```

Recurs does not perform this move automatically. The marker is an upgrade-safety invariant, not hardened secret storage.

`/undo` skips newer no-op checkpoints and selects the latest checkpoint that changed files. Before writing anything, it verifies that every affected path still matches the agent-produced after-state. If the user changed one path, replaced a parent with an outside-pointing symlink, or made a canonical parent/target credential-classified, the entire undo is refused before restoration begins. Missing credential targets are conflicts rather than being mistaken for the expected absent state.

## Current safety limits

- The macOS and Linux workspace sandboxes cover shell, verification, and configured stdio MCP subprocesses, not the whole Recurs process. Linux uses namespaces and mount policy without a Recurs seccomp filter; Windows lacks an equivalent OS sandbox or container.
- `local_guarded` arbitrary commands have host filesystem, network, IPC, and process authority. Shell classification is conservative but cannot prove scripts safe.
- Permanent credential-path denial covers every built-in tool. On macOS and Linux, the workspace sandbox additionally hides common host credential locations from shell children. No profile makes the TypeScript process an appropriate persistent credential authority.
- The macOS component foundation supplies the fixed launcher-created engine bridge, production-gated recovered broker lifecycle, authenticated journal-v2 profile binding, bounded OpenAI/Anthropic/Kimi onboarding, exact model-catalog verification, broker-owned Responses/Messages/Chat Completions streaming, encrypted OpenAI continuation storage, and route authority. There is no signed/notarized installed artifact or successful production smoke.
- The npm builder keeps third-party libraries as exact dependencies, preserves legal comments in Recurs' bundle, and enforces a four-file tarball allowlist. Publication still requires a selected project license, complete third-party notices, and a non-placeholder version.
- Checkpoints enumerate Git tracked and non-ignored untracked files; ignored files are not restored by checkpoint undo.
- Output, read, patch, command-time, and agent-step limits are bounded, but very large repositories can still make full snapshots expensive.
- Persistent Keychain setup and broker-owned generation for OpenAI API, Anthropic API, and Kimi Code exist only through the private native authority and have not shipped as an installed artifact. Source/npm builds separately support environment-BYOK generation for fixed-origin OpenAI Responses, Anthropic Messages, Gemini GenerateContent, and reviewed Chat-compatible providers, with fixed-origin authenticated model discovery for OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, and MiniMax. Saved connections can be selected through `/model`; explicit reasoning effort is currently limited to the reviewed saved OpenAI Responses profile and cannot be mutated inside an existing session. Bounded image input is implemented for direct reviewed adapters and ACP, but opaque delegated runtimes remain text-only. There is still no arbitrary public-endpoint/cloud-identity onboarding, live unsaved catalog activation, plugin system, MCP marketplace/installation/remote OAuth, persistent background daemon, recursive company coordinator, desktop app, cloud worker, scheduler, or endless `/loop` in v0. Agent Skills are bounded text/resource context, not executable plugins. The ACP endpoint exposes the real current Recurs runtime; it does not add those absent capabilities. Team `background` means process-lifetime work with durable interruption and explicit resume/apply controls.
