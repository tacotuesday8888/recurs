# Recurs CLI Provider Activation v1 Design

**Date:** 2026-07-13
**Status:** Approved for implementation by the user's delegated authority; health-only launcher/engine slice implemented
**Scope:** CLI-only secure direct-provider activation before desktop or heavy
sub-agent work

**Current implementation boundary:** The production-gated Swift launcher now
resolves fixed sealed Node/engine resources, creates the anonymous descriptor-3
socket, serves the bounded `hello`/`health`/`cancel` session, and reaps the exact
child. The public npm/source CLI rejects injected native descriptors. This is
health-only code, not provider activation: no signed/notarized installed bundle
exists, the broker advertises `persistentCredentials: false`, and every broker-
owned manifest remains disabled. The sealed private engine deliberately denies
delegated Codex until its adapter and binary have a fixed reviewed signed layout;
the public npm/source Codex ACP path remains implemented.

## 1. Decision

Provider Activation v1 will add a signed, headless macOS native authority and
three direct protocol families to the existing Recurs CLI:

1. OpenAI BYOK through the Responses API at the fixed official origin.
2. Anthropic BYOK through the Messages API at the fixed official origin.
3. Explicit public-HTTPS OpenAI Chat-compatible connections through versioned
   endpoint profiles. A connection is called a coding plan only when a reviewed
   bundled manifest identifies the provider, credential type, billing policy,
   endpoint, and permitted run contexts. A free-form endpoint is always labeled
   a custom metered/unknown-billing API endpoint.

The production credential authority is a signed Swift CLI launcher plus a
per-user Swift XPC LaunchAgent broker. The broker alone owns Data Protection
Keychain access, credential generations, provider HTTPS, request authority,
and response sanitization. The TypeScript engine receives no key, token,
credential reference, authorization header, XPC endpoint, or broker bearer
capability.

This is not a desktop application. The app-like native bundle exists only
because macOS Keychain access groups, Service Management registration, Hardened
Runtime, and notarization require a stable signed bundle. `recurs` remains a
terminal command and no graphical interface is introduced.

The implementation is one program delivered in ordered vertical slices. No
broker-owned provider becomes runnable until the native authority, matching
protocol codec, connection lifecycle, and security gates all attest ready.

## 2. Why This Is the Next Milestone

The current repository has a good single-agent engine, immutable backend pins,
redacted non-secret connection management, literal-loopback local models, and
an official Codex delegated path. It deliberately has no safe place to hold a
direct API credential.

Simply adding an environment variable or passing a key to `fetch()` would
break the product's central boundary:

- Node, tools, child processes, error objects, heap snapshots, or session logs
  could observe the key;
- a model-selected process could inherit or inspect authorization state;
- a changed endpoint could silently receive an existing credential;
- disconnect and reconnect races could resurrect stale generations; and
- a raw provider error or malicious endpoint could echo credential bytes.

Provider Activation v1 therefore completes the authority and transport layer
before the heavy sub-agent system multiplies concurrency and spend.

## 3. Scope Decomposition

The goal spans six independently reviewable subprojects. Each receives its own
TDD task group and commit sequence, but all are required before this design is
complete:

1. **Native authority and framing.** Signed launcher, XPC broker, Keychain
   store, native policy state, anonymous launcher-to-Node socket, and fake
   authority.
2. **Direct-provider contracts and coordinator binding.** Request identity,
   transport authorization, endpoint profiles, rich usage/failure semantics,
   provider-state handles, and exact provider identity checks.
3. **Direct connection lifecycle and onboarding.** Fenced staging, hidden key
   capture, verify/catalog/model selection, primary selection, reconnect,
   disconnect tombstones, and redacted projections.
4. **OpenAI Responses adapter.** Typed SSE, client function calls, reasoning
   item replay, model discovery intersection, and official billing disclosure.
5. **Anthropic Messages adapter.** Content-block SSE, client tool use,
   cumulative usage, stop/error mapping, model pagination, and exact replay of
   signed/redacted thinking state.
6. **OpenAI Chat-compatible profiles and release activation.** Strict Chat
   codec, public-HTTPS endpoint policy, conformance probes, named coding-plan
   profiles, CLI end-to-end flows, packaging evidence, and final gates.

Desktop UI, company visualization, sub-agent delegation, worker roles, and
agent budgets are explicitly excluded.

## 4. Alternatives Considered

### 4.1 Signed Swift launcher plus per-user XPC broker — selected

Swift has first-party access to Security, LocalAuthentication, XPC,
ServiceManagement, URLSession, code-signing requirements, and entitlements.
One per-user broker serializes credential generations and can later serve both
CLI and desktop without changing the authority boundary. The launcher is the
only signed peer accepted by the broker and gives Node one anonymous inherited
socket with a no-secret schema.

### 4.2 Embedded one-shot XPC service

This is simpler for a single foreground invocation, but it makes concurrent
CLI processes, persistent credentials, refresh serialization, crash recovery,
and a future shared desktop state harder. It remains useful as a test fixture,
not as the production lifecycle.

### 4.3 Rust helper over a Unix socket

Rust can provide a memory-safe parser, but it does not remove Apple bundle,
provisioning, Keychain, XPC, or Service Management requirements. A named socket
authenticated only by UID/GID is a same-user credential oracle. A future
cross-platform pure policy/framing core may be written in Rust, while Swift
continues to own the macOS authority.

### 4.4 Rejected approaches

- A Node native addon shares Node's address space and is not a credential
  boundary.
- The `security` command exposes secrets through process I/O.
- Environment variables and `.env` files expose keys to Node and descendants.
- A localhost HTTP proxy or named same-user socket is discoverable and
  impersonable by model-selected tools.
- Secure Enclave keys cannot store arbitrary imported bearer tokens.
- A root LaunchDaemon cannot use the user-context Data Protection Keychain.

## 5. Process and Trust Architecture

```text
terminal
  |
  v
signed RecursLauncher (headless CLI host)
  |-- authenticated XPC --> per-user RecursBroker LaunchAgent
  |                         |-- Data Protection Keychain
  |                         |-- credential/connection generations
  |                         |-- run/setup/maintenance authority
  |                         `-- provider TLS/HTTP + sanitization
  |
  `-- anonymous socketpair --> Node/TypeScript Recurs engine
                                `-- tool children (broker FD closed)
```

The native launcher starts the TypeScript engine. Node cannot discover or open
the broker's XPC service and never receives a Keychain entitlement. Every
model-selected child is spawned with the launcher socket closed-on-exec and a
clean environment. Starting a fresh signed launcher does not inherit another
launcher's authority.

The broker accepts only the launcher's exact production signing identifier,
Team ID, and signing class. The launcher verifies the broker's exact identity.
"Same Team ID" alone is insufficient. The first XPC exchange is a nonsensitive
protocol/attestation handshake; no account, prompt, endpoint, or authorization
state is sent before it succeeds.

The implemented slice stops at this topology and health exchange. The launcher
validates only its fixed nonsymlinked bundle paths, spawns the child with
descriptors `0`–`3` and a reviewed environment, and mirrors bounded
cancellation/termination. Source, unsigned, and ad-hoc launchers cannot select
an engine from `PATH`, cwd, environment, or argv and fail with fixed empty-
output exit `78`. No installed signed artifact has exercised this path as
production authority.

Production targets macOS 14.4 or newer. macOS 14.4 provides the modern XPC
session/listener code-signing requirement surface without making macOS 26-only
peer-requirement conveniences mandatory.

## 6. Native Storage

Each credential is a Data Protection Keychain generic-password item:

- `kSecUseDataProtectionKeychain = true` on every operation;
- a fixed versioned service name;
- a random public connection UUID as the account;
- `kSecAttrSynchronizable = false`;
- `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`;
- a broker-private Keychain access group; and
- no persistent reference exported outside the broker.

The broker privately maps `(connectionId, generation)` to the Keychain item.
TypeScript stores only non-secret connection metadata and an opaque
credential-bound account fingerprint. No field named `credentialRef`, secret,
header, key path, or token is added to the TypeScript registry.

Keychain protects storage and access, not transient use. The broker minimizes
secret lifetime, avoids Swift `String` conversion where practical, clears
mutable buffers on every path, disables secret-bearing diagnostics, and treats
zeroization as best effort rather than an absolute guarantee.

Development and production use distinct bundle identifiers, access groups,
services, and credentials. Unsigned/ad-hoc/source builds cannot activate
persistent direct credentials. They use a fake authority for tests and retain
the existing local/Codex paths. There is no plaintext fallback.

## 7. Launcher-to-Node Protocol

The implemented health subset accepts only `hello`, `health`, and `cancel`,
with nonzero strictly increasing request IDs and at most 64 active-plus-queued
health requests. It contains no credential, endpoint, header, URL, request-body,
provider-operation, or arbitrary-RPC field. The richer direct-provider protocol
below remains the v1 target and is not implemented by the health bridge.

The launcher gives Node one anonymous `socketpair` endpoint. Frames have a
small fixed header containing protocol version, message type, request ID, and
payload length. The protocol enforces:

- a 64 KiB maximum frame before allocation;
- bounded total request/response bytes and in-flight requests;
- `begin`, `chunk`, `cancel`, and exactly one terminal state;
- rejection of unknown versions/types, duplicate IDs, invalid transitions,
  and post-terminal data;
- fatal UTF-8 and strict duplicate-key JSON where JSON is used;
- no compression, descriptor passing, arbitrary RPC, URLs, credentials,
  authorization headers, Keychain references, or native capability values;
- cancellation propagated to broker work; and
- immediate invalidation when either peer or broker restarts.

Framing is parser safety, not authority. The broker retains the authorizing
record. Node sends an untrusted request descriptor, and the launcher/broker
matches it to native state before use.

## 8. Native Authorization

The broker owns three non-exportable authorization classes:

- **Setup authority:** one fenced onboarding attempt, staging credential,
  endpoint profile, verification/catalog routes, expiry, and byte/request
  budget. It cannot generate model output unless the user separately approves
  a disclosed paid conformance probe.
- **Run authority:** exact launcher session, Recurs session, turn/operation,
  connection and credential generation, provider, adapter, endpoint profile,
  model, policy and billing revisions, trusted invocation context, route set,
  expiry, request count, and byte budget.
- **Maintenance authority:** exact ready connection and identity/catalog/
  verification/revocation routes. It cannot perform an agent turn.

Visible TypeScript authorization records are diagnostic bindings only. Native
authority is mapped by a launcher-local request ID and never serialized. The
broker rechecks current connection state, generation, tombstone fence, endpoint
binding, route, model, policy, billing, trusted context, expiry, cancellation,
and remaining budget before every request.

Broker restart, launcher replacement, session closure, disconnect, or policy
change invalidates authority. A request that may have reached a provider is
never replayed automatically.

## 9. Broker-owned HTTPS

Node supplies an allowlisted `routeId`, method, non-credential safe headers,
and bounded body. It never supplies an arbitrary URL, credential header,
cookie, proxy, custom CA, redirect policy, Host header, or signed request.

The broker performs HTTPS with ephemeral URLSession configuration, system trust
evaluation, no cookie or shared credential storage, and redirects rejected by
the delegate. Repository proxy/CA environment variables are ignored. macOS
system proxy and system root configuration remain part of the trusted host
administrator boundary for v1; the CLI discloses this rather than claiming
that nil URLSession proxy configuration disables system proxies.

Endpoint profiles split:

- canonical scheme/host/port;
- normalized base path;
- protocol and auth scheme;
- exact relative route table and methods;
- request/response header allowlists;
- codec and compatibility revision;
- model-catalog behavior; and
- billing/policy evidence revision.

No redirects forward authorization. Every resolved address and actual peer is
checked against the endpoint profile. Public profiles reject loopback,
link-local, private, metadata, multicast, reserved, unspecified, and ambiguous
numeric addresses, including IPv4-mapped IPv6. Private-network/custom-CA
connections are out of scope.

The broker forwards only status, bounded safe headers, and bounded data. It
never forwards raw vendor error objects, URLSession diagnostics, redirect
locations, cookies, auth challenges, or request metrics. A rolling matcher
blocks the exact credential and constructed authorization value across every
chunk boundary before bytes reach Node. Custom endpoints are explicitly
trusted credential recipients; Recurs cannot prove that a malicious recipient
will not transform or encode a credential, so custom setup warns users to use a
dedicated revocable key.

## 10. Direct-provider Contracts

The current `ModelProvider` contract is upgraded rather than bypassed. A direct
provider is bound to an exact adapter and connection, and each request carries:

- request, Recurs session, turn, and operation identity;
- expected session record sequence and complete backend fingerprint;
- model, messages, client-function schemas, and maximum output tokens;
- diagnostic run authorization binding;
- broker-backed continuation read/write capability handles; and
- cancellation.

Provider events include normalized text/reasoning deltas, complete validated
tool calls, rich usage snapshots, typed terminal failures, and one terminal
completion with an optional direct continuation handle. Unknown usage is
`null`, never invented as zero.

The coordinator verifies that the created provider's `adapterId` and
`connectionId` match the immutable session pin. Compaction becomes a separately
authorized coordinator operation for broker-backed providers; it can return no
tool call or provider-state handle. Until that path is complete, broker-backed
compaction fails closed rather than using a captured provider.

Provider-native reasoning items, Anthropic signed/redacted thinking blocks,
and other opaque state live in the broker continuation store. Session JSONL
contains only non-authorizing handles bound to the exact backend/session/turn
and sequence. Uncertain state requires reconciliation and is never silently
replayed.

## 11. Retry, Cancellation, Usage, and Failures

Every transport attempt records delivery state:

- `not_sent`: eligible for bounded retry on approved transient failures;
- `request_started`: delivery uncertain, no automatic retry;
- `response_started`: never automatically retried; and
- `terminal`: complete or failed.

Retries use a small bounded exponential schedule with injected jitter and a
bounded safe `Retry-After` value. Authentication, permission, billing, policy,
quota, context, invalid request, cancellation, any 2xx stream failure, and any
delivery-uncertain failure are not retried automatically. Cancellation means
Recurs stopped waiting; it does not claim that provider computation or billing
stopped.

Typed failures preserve authentication, permission, billing, rate, quota,
context, model, transport, timeout, policy, and credential-store distinctions
through the CLI and durable terminal record. Raw vendor messages remain native.
Diagnostic IDs and allowlisted provider request IDs may cross the boundary;
headers and response bodies may not.

Usage is one normalized final snapshot or unknown. OpenAI final usage,
Anthropic cumulative updates, cached input, cache writes, and reasoning tokens
are normalized by their own codec. Recurs does not estimate cost or claim zero
when the provider does not report usage.

## 12. Connection and Onboarding Lifecycle

The UI-neutral onboarding service drives the CLI through:

1. select provider/access path and endpoint profile;
2. disclose credential ownership, billing sources, restrictions, system proxy
   trust, and supported run contexts;
3. create a native fenced staging attempt;
4. have the native launcher capture the key from `/dev/tty` with echo disabled;
5. store the staging generation directly in Keychain;
6. verify authentication with a non-generation route when possible;
7. fetch the model catalog and intersect it with a reviewed capability profile;
8. obtain separate consent before any paid forced-tool conformance probe;
9. select an exact compatible model and billing selection;
10. atomically commit the native generation and non-secret registry projection;
11. make the first connection primary and keep later connections secondary;
12. remove staging state on cancellation or failure.

`recurs setup` becomes the guided entry point while explicit commands remain:

```text
recurs setup openai
recurs setup anthropic
recurs setup openai-compatible --url <public-https-base> --model <id>
recurs account list [--json]
recurs account verify <exact-id>
recurs account reconnect <exact-id>
recurs account set-primary <exact-id>
recurs account disconnect <exact-id>
recurs model list [--connection <exact-id>] [--all] [--json]
recurs model set <model-id> --connection <exact-id>
```

Secret entry is never accepted through arguments, environment variables,
ordinary stdin pipes, config files, JSON, or TypeScript callbacks. Reconnect
creates a new credential generation and preserves identity only when the broker
can prove the same account subject. Otherwise it creates a new connection.

Disconnect first commits a higher native fence/tombstone, revokes authority,
deletes the Keychain generation, and then removes the ready projection. A late
setup, refresh, verify, or request cannot resurrect it. Disconnect never claims
to revoke a provider-side API key; the CLI tells the user when provider-console
revocation is still required.

## 13. Model and Capability Discovery

Each connection owns a versioned `ModelCatalogSnapshot` with fetched time,
source provenance, endpoint/profile revision, pagination state, requested and
resolved model identity, availability, and capabilities required by Recurs:

- streaming;
- client function calling and parallelism;
- multi-turn tool results;
- reasoning/state replay requirements;
- input modalities;
- context and output bounds when known; and
- execution/billing location.

OpenAI `/v1/models` establishes credential-visible availability, not coding
capabilities. It is intersected with a reviewed static capability profile.
Anthropic's paginated Models API is likewise intersected with Recurs's codec
and tool-loop requirements. OpenAI-compatible endpoints use their versioned
profile; successful text generation never proves tool compatibility.

Mutable aliases and router IDs stay visibly mutable. The session pin records
the requested ID, resolved revision when reported, catalog revision, and
endpoint profile. A changed endpoint/profile always creates a new connection.

## 14. Protocol-specific Behavior

### 14.1 OpenAI Responses

- Fixed origin `https://api.openai.com` and base path `/v1`.
- Bearer key injected only by the broker; optional organization/project binding
  is broker-owned metadata.
- Typed `response.*` SSE with strict sequence, item, size, and terminal checks.
- Client function tools only; hosted tools, background mode, remote MCP, and
  provider-side code execution are out of scope.
- Complete function calls correlate by `call_id`; tool results use
  `function_call_output`.
- Reasoning items returned with tool calls are stored behind direct
  continuation handles and replayed exactly when required.
- API billing is explicitly separate from ChatGPT and bound to the selected
  organization/project.

### 14.2 Anthropic Messages

- Fixed origin `https://api.anthropic.com` and base path `/v1`.
- Broker injects `x-api-key` and one pinned reviewed `anthropic-version`.
- Strict `message_start`, indexed content blocks, deltas, pings, errors,
  `message_delta`, and `message_stop` state machine.
- Client `tool_use` blocks become complete Recurs calls; `tool_result` blocks
  are placed first in the next user content as required.
- Cumulative usage is normalized once; refusal, pause, max-token, context, and
  mid-stream errors remain distinct.
- Thinking and redacted-thinking blocks are preserved byte-for-byte behind the
  continuation store. Models that require unsupported state are hidden.
- Anthropic API/Console billing is disclosed as separate from Claude consumer
  subscriptions.

### 14.3 OpenAI Chat-compatible profiles

- A separate strict Chat Completions codec is extracted from the loopback
  implementation; cloud transport never reuses its direct `fetch()` path.
- The profile explicitly controls usage chunks, tool-fragment shape, finish
  reasons, reasoning fields, tool choice, parallel calls, model-list behavior,
  and error mapping.
- Unknown finish reasons, malformed usage, truncated EOF, wrong content type,
  malformed/fatal UTF-8, post-terminal data, and mid-stream errors fail closed.
- A custom profile accepts one normalized public-HTTPS origin/base path, fixed
  bearer auth, `/models` when supported, and `/chat/completions`; no arbitrary
  headers or alternate auth schemes.
- Named coding-plan profiles ship one provider at a time only after current
  official endpoint, billing, entitlement, automation, and overage evidence is
  reviewed. The initial named profile is Kimi Code's OpenAI-compatible coding
  plan at `https://api.kimi.com/coding/v1`, using the documented
  `kimi-for-coding` mutable-router ID and an honest Recurs client identifier.
  Its profile is foreground/manual-only until current policy evidence proves a
  broader context. It is never inferred from a user-entered URL.

## 15. Activation and Distribution

A broker-owned provider is effectively runnable only when all of these are
true at runtime:

- its manifest policy is current and permits the trusted context;
- its protocol codec and endpoint profile are registered;
- the signed launcher and broker attest exact versions and identities;
- Data Protection Keychain access and native journals pass health checks;
- the connection generation is ready and not fenced;
- the selected model capability profile is compatible; and
- required process/descriptor containment checks pass.

This replaces the current static assumption that broker-owned manifests can
never be runnable. A missing signed companion leaves OpenAI, Anthropic, and
remote compatible paths visibly `requires_native_broker`; local and Codex
behavior remains unchanged.

Initial distribution is a signed/notarized headless bundle installed by a curl
script and later a Homebrew cask/formula pair. The public `recurs` shim invokes
the signed launcher. npm/Bun source installs remain valid for credential-free
local/Codex development but cannot activate persistent direct credentials.

No such distribution artifact exists yet. The current sealed-engine builder
produces deterministic single-file JavaScript, externalizes only Node built-ins,
and is configured to preserve legal comments. That setting is not a complete
third-party notices inventory; release packaging still requires a
license/notices review.
The sealed engine maps delegated-runtime imports to a fixed Codex denial rather
than searching an ambient `node_modules` tree or invoking an unstaged binary.

No signing identity, Team ID, provisioning profile, or production credential
is committed. CI verifies deterministic builds, entitlements/plist schemas,
Swift tests, TypeScript tests, and fake attestations. Owner-run release gates
verify the installed signed artifact before any public release.

## 16. Security and Host-process Boundary

The current `local_guarded` profile is not an OS sandbox and remains disclosed
as such. The earlier umbrella design treated a general tool OS sandbox as a
prerequisite for every Recurs-owned credential because the contemplated broker
could not yet prove a narrower process authority boundary. This reviewed design
supersedes that blanket prerequisite for the direct-provider credential only:
credentials and reusable authority exist exclusively in a hardened signed
broker, never in Node, the launcher-to-Node schema, or a tool child. General host
filesystem/network isolation remains a separate product-security program and
is not falsely claimed here.

The narrower native authority boundary must prove that model-selected children
cannot obtain a credential or reuse native request authority:

- the launcher socket is anonymous, close-on-exec, and explicitly closed in
  every tool child path;
- the XPC service accepts only the exact signed launcher;
- Keychain access belongs only to the broker access group;
- a fresh launcher receives no prior run authority;
- setup/maintenance require local user presence and reject CI/scripted input;
- run authority is bounded to one trusted operation and request budget;
- broker and launcher processes use Hardened Runtime without debugger/JIT/
  unsigned-code/library-validation exceptions; and
- process attachment, descriptor inheritance, alternate launcher invocation,
  `security`, and same-user IPC attacks are tested on the installed artifact.

If those tests cannot establish the authority boundary on a supported macOS
release, live direct providers stay disabled. `Full Access` cannot override the
gate. If testing shows that Hardened Runtime, exact XPC peer requirements,
broker-only access groups, close-on-exec, and one-launcher authority are
insufficient against a same-user tool process, this design fails closed and the
general OS sandbox returns as a release prerequisite rather than being replaced
with a weaker fallback.

## 17. Testing Strategy

### 17.1 Native unit and contract tests

- strict framing at every byte split, maximum, transition, cancellation, and
  terminal edge;
- Keychain add/read/replace/delete with locked/unavailable and no-plaintext
  fallback behavior;
- credential generation, fencing, setup commit/cancel, reconnect, disconnect,
  crash journal, and stale-writer races;
- exact XPC handshake, protocol version, and native authorization bindings;
- URL/route/method/header/body bounds, DNS/peer policy, redirects, proxies,
  cancellation, retry-after, and delivery uncertainty;
- rolling credential/header echo detection across every chunk boundary; and
- fake Keychain, clock, RNG, resolver, URL protocol, and signing attestation.

### 17.2 TypeScript contracts and codecs

- provider identity and pin matching;
- request/authorization/continuation capability validation;
- strict OpenAI Responses, Anthropic Messages, and OpenAI Chat fixture suites
  with arbitrary chunking, duplicate/out-of-order events, malformed JSON/SSE,
  fatal UTF-8, oversized data, mid-stream failures, truncation, cancellation,
  and post-terminal events;
- complete parallel tool calls/results and opaque-state replay;
- nullable rich usage and preserved typed failure categories;
- bounded retry only when native delivery state proves safe; and
- catalog pagination, alias resolution, capability intersection, and profile
  incompatibility.

### 17.3 Lifecycle and end-to-end tests

- native hidden-input adapter receives a canary while Node receives only a
  redacted attempt/result;
- setup success/failure/cancel at every phase; first-only primary selection;
- verify, reconnect, model selection, switching, immutable historical resume,
  compaction authorization, disconnect tombstones, and restart;
- fake broker/provider tool loops for all three protocols without real keys;
- malicious provider echoes the canary in headers, errors, JSON, SSE, encoded
  output, and arbitrary chunk splits;
- canary absence from Node messages, events, sessions, errors, diagnostics,
  output, checkpoints, environment, argv, tools, and descendant state;
- built CLI JSON/text output, safe exit codes, automation/TTY gates, and no
  prompt/browser/secret collection in noninteractive mode.

### 17.4 Installed-artifact release tests

- valid launcher/broker succeed; unsigned, ad-hoc, same-team/wrong-ID, wrong
  signing class, and version mismatch fail before sensitive data;
- Node and `security` cannot read broker Keychain items;
- tool descendants cannot inherit or discover launcher/broker authority;
- entitlement, provisioning, Hardened Runtime, nested signing, and notarization
  inspection;
- locked Keychain, system proxy/PAC, custom-root, redirect, DNS rebinding,
  broker crash, request-maybe-delivered, and upgrade matrices on macOS 14.4,
  macOS 15, and the latest supported release.

Real OpenAI/Anthropic live smoke tests are optional owner-run release checks.
They are never required in CI and never use a production key. Implementation
and CI use fake broker/provider fixtures, so missing external credentials cannot
weaken or skip a deterministic gate.

The completed health slice additionally tests public fd-3 non-use, fixed bundle
resolution, descriptors `0`–`3` only, hostile environment/argv rejection,
private hello/health downgrade, cancellation, exact-PID reaping, bundle
self-containment, fixed sealed-Codex denial, and broker-owned manifests remaining
non-runnable. These tests do not substitute for Section 17.4 installed-artifact
evidence.

## 18. Documentation and User Truthfulness

README, CLI, architecture, product, and security documentation must state:

- the CLI has no desktop UI;
- which install modes can activate persistent credentials;
- secret bytes stay inside the native authority and are never accepted by
  Node-facing CLI arguments/configuration;
- API billing is separate from consumer subscriptions;
- system proxy/root configuration is trusted in v1;
- custom endpoints are explicit trusted credential recipients and must use a
  dedicated key;
- disconnect removes Recurs authority/storage but may not revoke the provider
  key; and
- the current tool profile is not a general OS sandbox.

No provider, model, billing source, capability, signing state, or security
property is advertised unless current runtime evidence proves it.

## 19. Explicit Non-goals

- Any desktop interface or company visualization.
- Heavy sub-agent orchestration, delegation, roles, budgets, or worker
  workspaces.
- Windows or Linux secure stores.
- OAuth, device flow, workload identity, cloud identity, GitHub Copilot, or
  additional delegated runtimes.
- Hosted/server-side model tools, background Responses, remote MCP, or
  provider-side code execution.
- Private-network endpoints, LAN discovery, custom CA, arbitrary auth headers,
  or user-controlled redirect/proxy behavior.
- Automatic provider/model/account/billing fallback.
- General cost calculation from mutable public price tables.
- Claiming that a malicious custom endpoint cannot transform a credential it
  legitimately receives.

## 20. Completion Criteria

Provider Activation v1 is complete only when:

1. every subproject in Section 3 is implemented and reviewed;
2. OpenAI, Anthropic, the custom public-HTTPS profile, and the named Kimi Code
   profile complete fake-broker coding-agent tool loops;
3. direct connections complete setup, verification, model selection, switching,
   immutable resume, authorized compaction, reconnect, and fenced disconnect;
4. the canary credential is absent from every TypeScript, durable,
   user-visible, tool, and descendant boundary covered above;
5. unsigned/source builds fail closed with no plaintext fallback;
6. the signed-artifact gate is encoded and documented, with any unavailable
   developer signing/notarization step reported as release evidence still
   requiring the project owner's Apple identity rather than falsely passing;
7. TypeScript lint/typecheck/tests/build, Swift tests/build, protocol fixtures,
   CLI end-to-end tests, secret scans, and documentation checks pass; and
8. the verified branch is integrated into local `main` without pushing.

## 21. Primary Source Basis

The implementation must refresh version-sensitive details against these
official sources before enabling a release profile:

- Apple [TN3137: On Mac keychain APIs and implementations](https://developer.apple.com/documentation/Technotes/tn3137-on-mac-keychains),
  [`kSecUseDataProtectionKeychain`](https://developer.apple.com/documentation/security/ksecusedataprotectionkeychain),
  [Keychain access groups](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps),
  [`SMAppService`](https://developer.apple.com/documentation/servicemanagement/smappservice),
  [TN3125: provisioning profiles](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles),
  [TN3127: code-signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements),
  and [notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
- OpenAI [API authentication](https://developers.openai.com/api/reference/overview#authentication),
  [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses#enable-streaming),
  [function calling](https://developers.openai.com/api/docs/guides/function-calling),
  [Models list](https://developers.openai.com/api/reference/resources/models/methods/list),
  [error handling](https://developers.openai.com/api/docs/guides/error-codes),
  and [rate-limit backoff](https://developers.openai.com/api/docs/guides/rate-limits#retrying-with-exponential-backoff).
- Anthropic [authentication](https://platform.claude.com/docs/en/manage-claude/authentication),
  [streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming),
  [client tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview),
  [Models API](https://platform.claude.com/docs/en/api/models/list),
  [errors and request IDs](https://platform.claude.com/docs/en/api/errors),
  and [extended thinking preservation](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking).
- Kimi [Kimi Code overview and API access](https://www.kimi.com/code/docs/en/)
  and [third-party coding-agent configuration](https://www.kimi.com/code/docs/en/third-party-tools/other-coding-agents.html).
