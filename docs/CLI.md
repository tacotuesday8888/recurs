# Recurs CLI

Recurs Core v0 is a provider-neutral coding-agent harness. The CLI, direct agent loop, delegated-runtime executor, owned single-child and bounded parallel analysis/review paths, durable implementation/review/repair teams, tools, permissions, Plan mode, sessions, goals, checkpoints, structured output, credential-free local transport, bounded stdio MCP client, and first official Codex ACP path are implemented.

The executable starts in a sessionless workspace shell when no provider is available. Coding prompts require a configured literal-loopback local server, a saved or ephemeral reviewed BYOK connection, an eligible interactive Codex connection, or an injected test/embedding `ModelProvider`; no fake `unconfigured` session is written.

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
node packages/cli/dist/main.js --help
```

You can expose the root package's bundled `recurs` binary locally with `npm link` after building. The release candidate can be checked without publishing:

```bash
npm run package:check
npm run package:smoke-install
```

The first command verifies one executable bundle, its exact external dependencies, size, mode, absence of private workspace imports and build-machine paths, and the four-file tarball allowlist. The second packs the artifact, installs it into an empty temporary prefix, and runs `recurs --help` plus a fresh account-list command. CI runs both boundaries.

No package or installer is published today. The package remains `private`, version `0.0.0`, and `UNLICENSED` until the owner selects a license, a preview version, and complete third-party notices. Bun may later install the npm package, but Node remains the supported runtime and Bun runtime compatibility has not been implemented. Homebrew and curl wait for versioned, signed artifacts; Windows packaging remains later work.

Source/npm execution supports credential-free local, environment-BYOK, and vendor-owned Codex paths. It cannot persist a Recurs-owned credential: the native authority requires a correctly bundled, production-signed macOS 14.4+ launcher and broker, and source, unsigned, or ad-hoc builds fail closed without a plaintext fallback.

The repository does not yet contain a license. Although it is intended to become open source, it remains source-available rather than legally open source until the owner selects and adds a license.

## Provider boundary

Recurs exposes a validated catalog of 25 provider/authentication paths. Source installs can run credential-free literal-loopback Ollama/LM Studio, an existing ChatGPT account through the pinned official Codex ACP adapter, or saved/ephemeral BYOK for a supported reviewed OpenAI Chat-compatible HTTPS provider. The private production-signed macOS path also implements persistent OpenAI API, Anthropic API, and Kimi Code onboarding plus broker-owned generation; it is not distributed yet. Catalog entries outside those implemented protocol paths remain discovery metadata rather than live transports.

The strongest persistent path keeps keys outside TypeScript: `recurs setup openai`, `recurs setup anthropic --model <exact-id>`, and `recurs setup kimi --model <exact-id>` delegate foreground capture to the signed native authority. Cross-platform source installs may save a provider/model binding while keeping the key in a named environment variable:

```bash
export OPENROUTER_API_KEY=<key>
recurs setup byok \
  --provider openrouter-api \
  --model <provider/model> \
  --key-env OPENROUTER_API_KEY
```

Setup is local, interactive, and manual. It validates the current reviewed manifest and billing selection, shows the fixed-origin and billing disclosure, and saves only non-secret metadata: provider, model, adapter/policy/billing revisions, the environment-variable name, and a provider-bound SHA-256 credential fingerprint. The key value is neither written to the registry nor copied into a session. The first account becomes primary; later accounts require `account set-primary`. `--billing strict` is the default. Use `--billing allow-additional` only when the provider policy declares another source and the user accepts it; OpenCode Go is the current such profile.

The current reviewed saved-BYOK set is OpenRouter API, OpenCode Go, Kilo Gateway, Alibaba Model Studio API, Kimi Platform API, Kimi Code, MiniMax API, Z.ai API, and DeepSeek API. `provider list` is authoritative because support and policy review can change. Blocked or conditional coding-plan paths do not become runnable merely because they use a compatible protocol.

For a one-process override without a saved record:

```bash
RECURS_PROVIDER=openrouter-api \
RECURS_MODEL=<provider/model> \
RECURS_API_KEY=<key> \
recurs
```

All three variables are required together. The provider must have a supported reviewed `openai_chat` manifest with a fixed HTTPS origin. This explicit triple overrides saved selection for that process. In both forms, the key remains in a private provider field, is not written to the session log, and is stripped from tool subprocesses. This does not turn Responses, Anthropic, Gemini, cloud-identity, blocked coding-plan, or arbitrary custom endpoints into runnable paths.

Inspect the catalog and configured accounts without revealing account labels, account fingerprints, local endpoints, or credential material:

```bash
recurs provider list
recurs provider list --all
recurs provider list --json
recurs provider catalog
recurs provider catalog kimi
recurs provider catalog "coding plan" --json
recurs provider detect
recurs account list
recurs account list --json
recurs account verify <connection-id>
recurs account set-primary <connection-id>
recurs account disconnect <connection-id>
recurs doctor native
recurs doctor native --json
```

The normal provider list hides blocked paths; `--all` includes them. Both text and JSON distinguish runnable, environment-BYOK, native-broker-required, and blocked paths and report structured billing and restrictions. Account output marks the primary connection and omits local endpoints, delegated account labels, fingerprints, and credentials.

These commands intentionally separate three sources that other harnesses can make look like one operation:

- `provider list` is Recurs's reviewed support and policy catalog;
- `provider catalog` fetches public provider/model discovery metadata from `https://models.dev/api.json` and does not activate or authenticate anything;
- `provider detect` probes only the fixed literal-loopback Ollama and LM Studio ports. It does not search the filesystem, inspect another tool's credential store, scan the LAN, or import tokens.

Inside the interactive CLI, `/provider [search]` combines connected accounts, safe local detection, the public catalog, and Recurs's truthful setup status in one view. `/connect` remains an alias. When Recurs starts without a configured model, this provider view is the first onboarding step; the same discovery service will support the broader project-and-team onboarding flow rather than becoming a separate settings system. A public catalog match is never presented as runnable until Recurs has the complete reviewed authentication, billing, transport, and execution path.

Account mutations require one full exact ID; prefixes, labels, indexes, extra flags, and control characters are rejected. `verify` is read-only and runs only from a local, user-present, non-automation terminal because Codex is one supported path. It rechecks the exact local model or official Codex account/model/read-only profile. For saved BYOK it proves only that the named environment variable is present and matches the setup fingerprint; the provider authenticates the key on the first model request. Verification does not sign in, repair billing acknowledgement, make a network request for BYOK, or mutate the registry.

`set-primary` changes only the default for a future new session. Every existing session continues through its immutable connection/model/account/policy/billing pin. `disconnect` requires interactive confirmation and removes only Recurs metadata; it does not sign out, revoke, or delete vendor-owned authentication. Removing the primary leaves no primary instead of selecting another billing source implicitly.

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

The normalized request contains the model name, immutable message snapshot, visible tool definitions, and an abort signal. The stream returns text/reasoning deltas, normalized tool calls, usage, and one terminal event. `ScriptedProvider` supplies deterministic responses for tests and embedded development.

`createStandaloneRuntime(eventSink, { provider, model })` remains the test/embedding assembly point for an injected provider. Normal standalone assembly also resolves saved local, environment-BYOK, brokered-native, and Codex records into immutable version-2 backend pins. A saved BYOK record runs only when the exact named credential matches its stored fingerprint; missing or changed credentials fail before provider work with the required variable named safely. Launching the compiled CLI without a connection keeps workspace commands available, but `recurs run <prompt>` exits with configuration code `2` before persisting the prompt. JSONL mode emits one `configuration_error` object without prose on standard output.

## Start and run

Interactive mode:

```bash
node packages/cli/dist/main.js
```

One non-interactive run:

```bash
node packages/cli/dist/main.js run "inspect the repository" --format text
node packages/cli/dist/main.js run "inspect the repository" --format jsonl
```

The no-argument interactive CLI requires a user-present local terminal and rejects recognized automation even when it allocates a TTY. The one-shot prompt examples require a configured local provider or an injected provider. Codex deliberately rejects this unattended path; use the interactive CLI for user-present Codex Plan work. `--format jsonl` emits the same normalized events used by the interactive runtime; it is not a separate agent path.

### ACP stdio agent

`recurs acp` serves Recurs as an Agent Client Protocol v1 agent over standard input and output. It is a thin host over the same standalone runtime: every ACP `session/new` creates a distinct pinned Recurs session, and `session/prompt` uses the ordinary coordinator, provider, permissions, tools, sessions, and child/team engine. Model text and reasoning, tool lifecycles, and Recurs child, batch, and team activity are projected into typed ACP session updates. A client permission prompt can grant or reject one operation; Recurs does not advertise an always-allow choice through this boundary.

The endpoint deliberately classifies prompts as local, unattended, scripted SDK work. Direct local, environment-BYOK, and supported brokered-model providers can run only when their existing policy admits that context. The ChatGPT Codex subscription adapter remains local, manual, user-present CLI-only and therefore fails closed through ACP. An editor connection is not treated as proof that a user is present.

The v0 handshake advertises baseline text and resource-link prompts plus session cancellation and close. Image, audio, and embedded-resource prompts are rejected. Additional workspace roots and client-supplied MCP servers are rejected, and no MCP capability is advertised. Recurs uses its own bounded host tools rather than delegating filesystem or terminal authority to the ACP client. On connection loss, active Recurs runtimes are cancelled.

### Agent Skills

Recurs supports the open [Agent Skills `SKILL.md` specification](https://agentskills.io/specification) for bounded, progressive instruction loading. At startup it scans direct child directories in `~/.agents/skills` and `$RECURS_HOME/skills`, with the Recurs directory taking precedence. It also detects `.agents/skills` and `.recurs/skills` in the active workspace, with `.recurs` taking precedence, but repository-provided skills are disabled by default. `/skills enable-project` requires a local, user-present, manual CLI or desktop invocation plus explicit confirmation; trust lasts only for that Recurs process. `/skills disable-project` removes them immediately from subsequent model context.

Discovery validates the skill name against its directory, requires bounded YAML frontmatter and UTF-8 Markdown instructions, skips symlinks, hard-linked files, and credential-classified resources, limits each scope to 64 skills, and reports malformed or colliding entries through `/skills`. Enabled name/description metadata is added to the parent direct-provider system context under a 16 KiB catalog budget; `/skills` still lists the complete discovered catalog. The read-only `activate_skill` tool loads one skill's instructions and lists at most 64 bundled resource files; an exact listed UTF-8 resource can then be loaded through the same tool. Paths are confined to the skill directory and tool invocation remains subject to the ordinary parent read policy.

This is not a plugin installer. Recurs does not download skills, automatically execute bundled scripts, interpret `allowed-tools` as authority, persist project trust, expose skills through historical bounded child profiles, or inject them into an opaque delegated runtime's private prompt. Executable MCP servers use the separate authority boundary below; a skill cannot enable one.

### MCP stdio tools

The parent direct-provider loop can use user-configured stdio MCP servers. Recurs reads only `$RECURS_HOME/config/mcp-servers.json` (normally `~/.recurs/config/mcp-servers.json`). The present file must be owned by the current user, mode `0600` or stricter, a regular single-link file, valid bounded JSON, and no larger than 64 KiB. A missing file means MCP is unconfigured. `/mcp` lists configuration without starting a server.

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

Configuration supports at most 32 stable server IDs, absolute commands, at most 32 bounded literal arguments, and `network: "allow"` or `"deny"`. It cannot define environment variables or a shell string. Each `list_tools` or `call_tool` operation starts a fresh process, negotiates a supported MCP protocol version, checks the advertised tools capability, bounds pagination/output/time, and closes the whole process group. The process gets Recurs's private home/config/cache/temp environment and never inherits API keys, tokens, proxy settings, or provider authority.

The model-facing `mcp` tool is classified as mutating because server initialization and tool annotations cannot prove read-only behavior. It is unavailable in Plan mode, always declares an elevated shell intent, adds an elevated network intent only for `network: "allow"`, and uses normal Ask Always/Approved for Me/Full Access decisions. On macOS it receives the same workspace sandbox as other arbitrary processes; on Linux the documented `local_guarded` limitation remains. Existing child/team profiles do not receive MCP.

Server metadata, JSON Schemas, annotations, instructions, and results are untrusted data. They cannot widen Recurs permissions or change policy. Project MCP configuration, automatic installation, persistent server sessions, Streamable HTTP/OAuth, prompts, resources, sampling, elicitation, and ACP-client-supplied MCP servers remain intentionally absent.

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
| Approved for Me | Normal guarded project reads/writes run automatically. Shell commands still ask. On macOS an approved command also runs in the workspace sandbox; Linux and Windows retain the guarded host-authority path. Network, external, sensitive, deployment, and destructive actions also ask. Classified credential paths are denied. |
| Full Access | Routine workspace, command, network, deployment, and destructive prompts are skipped after explicit confirmation. Sensitive and external paths still ask, and classified credential paths are denied. Integrity controls remain enabled. On macOS command subprocesses remain sandboxed; on Linux and Windows arbitrary commands are not OS-isolated. |

An explicit outside path can run only after its external-path intent is approved, including in Full Access. A hidden symlink escape remains blocked because the model did not request that outside path explicitly.

Credential classification is shared across direct and aggregate built-in operations. It covers `.env` and `.env.*`, common private-key and credential filenames, certificate/key suffixes, and auth directories such as `.ssh`, `.aws`, `.azure`, `.docker`, `.gnupg`, `.kube`, and `.config/gcloud`, case-insensitively. Slash and literal-backslash path variants use the same exclusions. Direct or canonical classified targets are denied. List, search, Git status/diff, and checkpoint enumeration exclude them. Patch accepts exact slash-separated declarations without surrounding whitespace or backslashes, rejects rename/copy operations, denies canonical credential aliases before checkpoint capture, and requires Git's complete parsed path set to equal the declared revision-checked files before mutation. Configured `sensitivePatterns` remain a separate approvable policy.

This protects the built-in interfaces only. A permitted shell script can spell, discover, or open any host path available to the current user, regardless of the path classifier.

## Tool security profiles

The embedding assembly option `toolSecurityProfile` has three values:

| Profile | Behavior |
| --- | --- |
| `workspace_sandboxed` | Standalone default on macOS. Applies the normal guards and runs shell/verification children under Apple Seatbelt with workspace-only writes, common credential-path read denial, and intent-gated network. Fails closed when unavailable. |
| `local_guarded` | Standalone default on Linux and Windows. Advertises the registered tools and applies Plan mode, permission evaluation, path checks, process bounds, and checkpoints. Arbitrary commands still retain host authority. |
| `tools_disabled` | Advertises no model tools and rejects every direct model-tool invocation before parsing, permissions, or checkpoint capture. This is fail-closed but is not a useful coding profile. |

Every fixed or arbitrary child process receives a fresh private home, config, cache, and temporary directory plus only a filtered absolute `PATH` and selected locale/terminal variables. It does not inherit the real home, parent `SHELL`, cloud/provider variables, proxies, sockets, Git config variables, or workspace-contained `PATH` entries. `/bin/sh -c` is used for `run_command` on macOS and Linux; it is not a login shell. Recurs terminates the process group on completion, cancellation, timeout, or output overflow, bounds output-pipe draining, destroys its pipe handles, and then performs synthetic-tree cleanup. A descendant that deliberately enters another process group or session can survive this application-level cleanup; preventing that requires the later OS containment boundary. Subprocess tools fail with a typed unsupported-platform error on Windows.

Fixed Git operations first require Git 2.45 or newer, then pin the requested worktree and disable optional index writes, lazy object fetching, repository hooks, fsmonitor commands, external diff/text conversion, configured clean/smudge/process filters, and expanded dirty-submodule diffs. Recurs enumerates filter key names only and replaces their commands with empty command-line overrides before status, diff, patch, or checkpoint Git work; configured command values are never returned to the harness. This preflight is not protection against a hostile same-user process racing repository configuration.

Environment cleanup prevents direct inheritance on every platform. The macOS workspace profile adds an OS boundary for shell and verification children; Linux and Windows do not yet have equivalent containment. No Recurs-owned API, coding-plan, OAuth, or cloud credential may enter the TypeScript process under any profile. The Codex adapter remains vendor-authenticated and Recurs neither imports nor stores its credential.

## Plan and Act modes

Act mode is normal coding. Plan mode is enforced read-only at the tool registry:

- Available: file reads/listing/search and Git status/diff.
- Hidden and denied: patching and shell commands.

`/plan [prompt]` enters Plan mode and can immediately submit a planning prompt. `/plan exit` restores the permission preset that was active before planning. `/review` uses a temporary read-only override without changing the stored Act/Plan mode.

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
| Explore (`explore_v1`) | Plan; read-only | `read_file`, `list_files`, `search_text`, `git_status`, `git_diff` |
| Implement (`implement_v1`) | Act parent required; scoped edits and verification | Explore tools plus `apply_patch`, `run_command`, `run_verification` |
| Review (`review_v1`) | Act parent required; read-only inspection | Explore tools |

Where Recurs owns tool execution, the registry enforces both the exact tool names and each profile's permission-category/risk ceiling before approval. `run_verification`, available to `implement_v1`, parses one allowlisted npm, pnpm, yarn, Bun, Cargo, Go, Pytest, or Swift test/check command and executes it directly without a shell; pipes, redirection, substitution, arbitrary programs, install/deploy commands, and mutating test flags are rejected. It is still workspace-effectful because builds and tests can write artifacts, so Implement delegation receives parent-level checkpoints. The invoked project task and its arguments retain ordinary host-process authority; an allowlisted task name is not containment or proof that the task is side-effect free. Implement's separate `run_command` tool remains an approval-gated arbitrary shell with host authority: command classification and checkpoints are application defenses, not containment, and embedded scripts can evade semantic classification.

Version-4 durable teams use stricter profiles with no arbitrary-command or verification tools. Only hardened Git inspection may spawn a process, and candidate project scripts cannot be executed before Recurs has an enforceable OS boundary:

| Profile | Purpose | Exact host-controlled tools |
| --- | --- | --- |
| Implement (`implement_v2`) | Isolated staged edits | `read_file`, `list_files`, `search_text`, `apply_patch`, `git_status`, `git_diff` |
| Review (`review_v2`) | Read-only staged review with strict JSON findings | `read_file`, `list_files`, `search_text`, `git_status`, `git_diff` |
| Repair (`repair_v1`) | Finding-scoped edits to the staged candidate | Implement v2 tools |

Every child receives a backend route and a permission preset that cannot exceed the parent. Current production routing selects only the immutable parent pin; the provider-neutral role-candidate contract is real, but multiple live role-specific backends are not. Explore narrows execution to Plan. Implement, Review, and Repair require Act. Child profiles exclude every delegation tool, so depth remains one. Retries are zero, and parent/run cancellation is linked to active children. A started failed or cancelled attempt consumes its child slot and request reservation; validation, preflight, or worktree setup that fails before child allocation does not. Child failures, cancellation, profile-correlated lifecycle, results, usage, and evidence remain visible as normalized events and durable session state.

Single-child `delegate_task` retains the parent-workspace behavior. Implement can edit and run approved verification there through the existing approval and checkpoint seams; Review remains read-only.

`delegate_tasks` runs independent Explore/Review children in detached Git worktrees rather than the parent workspace. The session must be at the canonical repository root, the repository must have no staged, unstaged, untracked, or submodule changes, and `HEAD` must identify a commit. Ignored local files are not present in the child. Recurs creates each lease outside the repository under `<project-data>/agent-worktrees`, records its exact revision in the child session/result, and cleans it after success, failure, or cancellation. Cleanup failure is visible and fatal. Batch worktree changes are never merged back.

`delegate_team` is the durable editing-team path. Its exact input is a description, one to four concrete Implement tasks, review instructions, and optional `execution: "foreground" | "background"`; the selected v4 mode may impose a lower task limit. Every Implement child runs at the same exact revision in its own worktree. All workers must succeed and return a nonempty patch before Recurs stages any result. Patch artifacts are hash-addressed and limited to 1 MiB and 256 unambiguous text paths; binaries, credential paths, symlinks, submodules, mode changes, renames/copies, foreign handles, and base drift are rejected. Recurs applies worker artifacts in input order to a dedicated private staging worktree and captures one cumulative durable candidate. It never commits.

The mode's `review_v2` panel inspects the staged candidate and must return exact bounded JSON. Unanimous valid approval is `approved`; any valid change request is `changes_requested`; malformed or failed reviews without a valid change request are `unverified`. Only valid structured findings can start a `repair_v1` child. Repair runs in the same staging workspace, receives only those findings, and is followed by another Review round. Repair is a fresh depth-one sibling rather than a retry or recursive child, and v4 policy caps it at zero, one, or two rounds.

Foreground is the default. An approved foreground candidate is applied to the parent through a durable two-phase checkpoint transaction before the tool returns. A failed checkpoint-preparation attempt leaves the reviewed candidate at `ready_to_apply` instead of discarding it. Non-approved runs do not mutate the parent. Historical version-3 policies retain their original foreground behavior when selected by exact ID.

`execution: "background"` returns after the run has a durable owner and continues only while that Recurs process remains alive. It never mutates the parent: approval stops at `ready_to_apply`, and `/agents apply <id>` or `apply_team` performs the explicit parent transaction later. Recurs releases the staging worktree before publishing ready and best-effort discards intermediate artifacts; bounded wait and direct apply confirm the cross-process owner handoff before treating ready as actionable. Starting or resuming background work requires Full Access, a local/manual/user-present Act invocation, and a backend eligible for background host-tool control. Apply requires Full Access or one explicit elevated write approval. This is useful process-lifetime concurrency, not a daemon.

One unresolved durable team may belong to a parent at a time. A separate private JSONL journal freezes its policy, parent/backend/base, role routes, tasks, review contract, allocation, child reservations/results, artifacts, rounds, cancellation, usage/cost coverage, and outcome. Cross-process owner leases admit one live parent/run writer and fence stale owners. List and detail output deliberately omit prompts, patch bodies, private worktree paths, credentials, and provider/account configuration.

Startup recovery runs before provider-policy and conversational-session activation. It reclaims only dead owners, validates a completed child's exact task/workspace/assignment binding, settles accounting, and removes stale worktrees only below Recurs's private project-data root. Recovery attempts every run, sanitizes failures, and blocks startup with one safe error when any run cannot be reconciled. Active compute cannot survive process exit: a running ownerless team becomes `interrupted`. `/agents resume <id>` or `resume_team` may restart a safely interrupted background run under fresh authorization and fresh depth-one child attempts; it never reuses a terminal child session. A stable reviewed candidate survives restart.

Parent apply records a durable checkpoint and `apply_prepared` before mutation, applies the cumulative artifact, validates the complete dirty path set, completes the checkpoint, and records `apply_committed`. If startup finds an interrupted apply, an unchanged clean base returns to `ready_to_apply`, an exact candidate diff completes idempotently, and any other workspace state remains `interrupted` with manual attention required. Recurs never silently resets or overwrites an ambiguous parent.

For an opaque delegated runtime, Recurs cannot advertise or filter vendor-internal tools. Explore is accepted only when the pinned runtime guarantees enforced Plan mode. Implement, Review, and Repair require host-controlled tools and checkpointing and therefore fail preflight on the current opaque Codex ACP runtime. Recurs does not claim visibility into vendor-internal model calls, tool catalogs, or spend.

`/agents` shows the exact policy version, concurrency, workflow child/request budget, per-child reservation, team width/review/repair policy, batch eligibility, and reported-cost ceiling. `/agents profiles` shows the profile enforcement boundaries. `/agents activity` lists durable children owned by the current parent, and `/agents activity <exact-child-or-session-id>` shows one child's safe status, usage, files, evidence, failure, and isolation revision without exposing its prompt, worktree path, account fingerprint, or provider configuration. `/agents mode economy|standard|balanced|performance|max` selects the current version-4 policy; an exact historical ID remains selectable for deterministic replay. Names are display labels, while logs and sessions store IDs such as `balanced_v4`.

| Current mode | Children | Concurrency | Requests | Reserved/child | Implement max | Review initial/max | Repair rounds | Quality | Cost ceiling |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Economy (`economy_v4`) | 2 | 1 | 8 | 4 | 1 | 1/1 | 0 | essential | $0.25 |
| Standard (`standard_v4`) | 6 | 2 | 36 | 6 | 1 | 1/2 | 1 | standard | $1 |
| Balanced (`balanced_v4`) | 7 | 3 | 56 | 8 | 2 | 1/2 | 1 | balanced | $3 |
| Performance (`performance_v4`) | 10 | 4 | 100 | 10 | 3 | 2/3 | 1 | thorough | $10 |
| Max (`max_v4`) | 18 | 6 | 216 | 12 | 4 | 2/4 | 2 | maximum | $25 |

Immutable version-1 through version-3 IDs remain valid for old sessions and explicit selection. Version 1 keeps concurrency one and its original total workflow budgets; version 2 keeps its original bounded Explore/Review fan-out; version 3 keeps the original foreground team semantics without durable repair/background controls. Historical policies never silently acquire v4 behavior. Display-name selection chooses version 4.

Every mode uses `inherit_parent`; independent child model routing is not implemented. At child start, Recurs atomically claims one child slot and reserves that child's request allowance from the shared run budget. Starting or resuming detached work reserves the complete live parent-turn delegation budget; resume separately reconstructs the frozen run's remaining accounting, so ordinary delegation cannot share that turn. Direct runs report observed steps; an opaque runtime consumes the full reservation because its internal calls are not observable. The parent continues to use its own backend authorization ceiling. Reported USD cost becomes known only after provider/runtime telemetry arrives, so already-active siblings can complete past the ceiling; the overrun is reported and no later child starts. Missing USD telemetry remains explicitly unavailable rather than estimated.

Economy and every version-1 mode provide a sequential batch fallback. Standard through Max version 4 cap concurrent children at two, three, four, or six. Batch results include completed, failed, and cancelled entries; ordinary partial failure is returned for synthesis, while linked cancellation or worktree-cleanup failure fails the tool. Durable teams emit normalized sequence/phase/round, routing, repair, ready, apply, interruption, recovery, failure, cancellation, and team-correlated child lifecycle activity. `/agents` projections and `agent_team_activity` omit prompts, patch bodies, private worktree paths, credentials, and account data. The private team journal and child session logs persist assigned prompts and tool calls; the general JSONL transcript can include prompts and tool arguments and is not a redacted audit feed.

Existing `explore_v1` session records remain valid. Because Recurs is still unreleased `0.0.0`, the earlier two-field `delegate_task` draft is not retained: embeddings must now provide an exact `profile` rather than receiving an implicit Explore child.

A daemon that outlives the CLI, recursive depth, automatic task decomposition, terminal-child retries, dirty-workspace snapshots, arbitrary worktree continuation, multiple live role-specific models, dynamic role libraries, auto-commit/push/deploy, schedules, and the company interface remain later milestones. Current teams are explicit depth-one workflows over a clean committed parent; only bounded valid Review findings trigger Repair. Worktree isolation and owner leases are not OS containment. See the [primary-source harness comparison](research/SUBAGENT_HARNESS_COMPARISON.md).

## Slash commands

| Command | Purpose |
| --- | --- |
| `/help` | Show concise command help. |
| `/goal ...` | Create, inspect, pause, resume, complete, or clear the durable goal. |
| `/plan [prompt\|exit]` | Enter enforced read-only planning or return to Act. |
| `/permissions [ask\|approved\|full]` | Inspect or change the permission preset. |
| `/agents [profiles\|activity [exact-id]\|teams\|team <id>\|wait <id>\|cancel <id>\|resume <id>\|apply <id>\|mode ...]` | Inspect profiles, child/team activity, control an owned durable team, or change the bounded policy. |
| `/skills [enable-project\|disable-project]` | List Agent Skills or change process-lifetime trust for repository skills. |
| `/mcp` | List private user-configured stdio MCP servers and current limits. |
| `/status` | Show session, workspace, model identifier, modes, goal, usage, and pending tools. |
| `/init` | Confirm and create a starter `AGENTS.md`; never overwrite an existing path. |
| `/new` | Start a new durable session in the same workspace. |
| `/resume [id]` | List sessions newest-first or resume one exact ID. Prefix matching is not used. |
| `/compact` | Ask a direct provider for a continuation summary and retain roughly the latest six messages without splitting tool-call/result groups. Delegated Codex sessions reject this because the vendor runtime owns its transcript. |
| `/diff [--staged] [path]` | Show a bounded Git diff without repository hooks, filters, external diff/text conversion, or expanded dirty-submodule content. |
| `/review` | Submit staged/unstaged changes for a temporary read-only review. |
| `/undo` | Restore the latest checkpoint that actually changed files. |
| `/cancel` | Abort the current provider/tool run. |
| `/quit`, `/exit`, `/q` | Exit the interactive CLI. |

Without an explicit primary, the workspace shell exposes only `/help`, `/connect`, `/model`, `/permissions`, `/agents`, `/skills`, `/mcp`, `/status`, `/resume`, `/init`, `/diff`, and exit commands. `/agents` explains the default but cannot persist a policy until a model connection creates a session. `/skills` can inspect discovery and establish process-lifetime project trust before a model is connected; `/mcp` inspects user configuration without executing it. Secondary records are never selected by file order. `/resume <exact-id>` may load a historical pinned session for inspection and, when its exact connection still exists and matches, continued work. A changed or disconnected record fails preflight before provider/runtime work. `/connect` gives both `recurs setup codex` and the credential-free local setup command; `/model` reports that no connection is active.

## Sessions and recovery

By default, project data lives under:

```text
~/.recurs/projects/<workspace-hash>/
```

Set `RECURS_HOME` to move the Recurs data root. New session logs use strict version-2 append-only JSONL. Sequence zero pins the provider lane, connection, adapter, account fingerprint, model identity, billing choice, catalog, and policy revisions; local pins also bind a digest of the normalized loopback origin. Each run rereads the registry and reconstructs that complete pin. A primary switch cannot redirect history, while a changed or missing record fails closed. Every mutation holds a cross-process lock and exact sequence; stale or concurrent writers fail. Version-1 logs remain readable and listable but cannot be changed.

Completed messages and tool/permission/turn boundaries are flushed to disk. A partial final JSONL record is quarantined during recovery; committed corruption in the middle fails loudly. Before the next turn, pending tools receive durable failure results and the prior open turn is closed as interrupted. An orphaned compaction is closed locally with unknown usage and never retried automatically.

Delegated turns persist normalized results, usage, changed files, evidence, failures/cancellation, and opaque continuation handles. Vendor session IDs stay in a bounded process-scoped continuation store rather than JSONL. A new continuation is recorded as uncertain before terminal settlement and committed only alongside the matching durable terminal. While its process-scoped payload remains available, a later prompt first probes the uncertain tip with separate authorization. Core can record a runtime-proven committed or gone result, but the current ACP path treats an existing resumable vendor session as still uncertain and proceeds only when the session is proven gone; it never repeats remote work automatically. After process loss the payload cannot be resumed, so the durable uncertain record blocks unsafe replay. This is durable lifecycle accounting and fail-closed recovery, not persistent vendor-session storage.

Durable teams use a separate private `team-runs` JSONL store so background progress never contends with the parent conversation lease. Each append is strictly validated, sequence-checked, flushed, and fsynced. Separate parent/run owner directories provide cross-process admission and stale-writer fencing. At startup, ownerless active runs are reconciled conservatively: exact bound child terminals may settle, stable candidates remain ready, stale owned worktrees are removed, and unsafe in-flight work becomes `interrupted`. Resume is explicit and creates fresh attempts. An interrupted apply is never guessed from timestamps or a partial checkpoint; Recurs compares the canonical parent workspace with the frozen base and candidate and requires manual attention for any third state.

Compaction is also append-only: the log keeps the audit history, while replay replaces active context with the summary plus retained recent messages.

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

- The macOS workspace sandbox covers shell and verification subprocesses, not the whole Recurs process. Linux and Windows still lack an equivalent OS sandbox or container.
- `local_guarded` arbitrary commands have host filesystem, network, IPC, and process authority. Shell classification is conservative but cannot prove scripts safe.
- Permanent credential-path denial covers every built-in tool. On macOS, the workspace sandbox additionally denies common host credential locations to shell children. No profile makes the TypeScript process an appropriate persistent credential authority.
- The macOS component foundation supplies the fixed launcher-created engine bridge, production-gated recovered broker lifecycle, authenticated journal-v2 profile binding, bounded OpenAI/Anthropic/Kimi onboarding, exact model-catalog verification, broker-owned Responses/Messages/Chat Completions streaming, encrypted OpenAI continuation storage, and route authority. There is no signed/notarized installed artifact or successful production smoke.
- The npm builder keeps third-party libraries as exact dependencies, preserves legal comments in Recurs' bundle, and enforces a four-file tarball allowlist. Publication still requires a selected project license, complete third-party notices, and a non-placeholder version.
- Checkpoints enumerate Git tracked and non-ignored untracked files; ignored files are not restored by checkpoint undo.
- Output, read, patch, command-time, and agent-step limits are bounded, but very large repositories can still make full snapshots expensive.
- OpenAI API, Anthropic API, and Kimi Code setup and generation exist only through the private native authority and have not shipped as an installed artifact. There is still no arbitrary public-endpoint/cloud-identity onboarding, general model picker, plugin system, MCP marketplace/project loading/remote OAuth, persistent background daemon, recursive company coordinator, desktop app, cloud worker, scheduler, or endless `/loop` in v0. Agent Skills are bounded text/resource context, not executable plugins. The ACP endpoint exposes the real current Recurs runtime; it does not add those absent capabilities. Team `background` means process-lifetime work with durable interruption and explicit resume/apply controls.
