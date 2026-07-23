# Recurs architecture

Recurs is a TypeScript coding-agent harness. One portable core owns provider
access, agent execution, tools, durable state, and team orchestration. Platform
code is limited to process containment and terminal integration.

This follows the durable shape used by strong coding-agent projects: one
dominant implementation language, a small CLI edge, explicit provider
adapters, and an orchestration core that does not depend on presentation code.

## Package map

```text
packages/cli ──────────────── application entrypoint and terminal/ACP surfaces
    │
    ├── packages/app ─────── connection registry and onboarding policy
    ├── packages/core ────── agent loop, sessions, teams, goals, checkpoints
    ├── packages/runtimes ── delegated vendor runtimes
    ├── packages/providers ─ direct and local model adapters
    └── packages/tools ───── bounded filesystem, Git, process, and MCP tools

packages/contracts ───────── shared data contracts; depends on no workspace code
```

The dependency direction is inward:

- `@recurs/contracts` defines stable, provider-neutral data shapes.
- `@recurs/providers` implements model transports against those contracts.
- `@recurs/app` owns non-secret connection metadata and activation policy.
- `@recurs/runtimes` adapts delegated vendor runtimes.
- `@recurs/tools` owns host-facing tool implementations and containment.
- `@recurs/core` owns execution and orchestration.
- `@recurs/cli` composes the packages and owns user-facing I/O.

No package imports the CLI. Provider adapters do not own onboarding, storage,
or orchestration. The core does not parse terminal input.

## Process model

The published command starts one Node.js process:

```text
terminal / ACP client
        │
        ▼
     CLI host
        │
        ├── connection selection
        ├── agent runtime
        ├── provider adapter or delegated runtime
        └── bounded tools
```

There is no private second engine, platform broker, or platform-specific model
client. macOS and Linux differences live at the subprocess containment edge.
Windows subprocess tools currently fail closed.

## Multi-provider connection architecture

One shared interface supports many model providers without coupling the runtime
to one vendor. Recurs currently supports three explicit connection families:

1. `local_openai_compatible` for reviewed loopback endpoints.
2. `environment_model_provider` for fixed-origin BYOK adapters.
3. `delegated_agent` for vendor-owned runtimes such as Codex.

Saved records contain routing and policy metadata, never reusable credential
bytes. Environment BYOK stores the environment-variable name and a one-way
credential fingerprint. At runtime, the named value must be present and match
that fingerprint before a request can begin.

Provider manifests are discovery and policy data, not executable authority.
An integration is runnable only when a reviewed adapter, endpoint policy,
billing acknowledgement, and current usage policy all agree.

There is no silent provider fallback. The optional Auto model-team layer ranks
only immutable configured company-goal evaluations that pass declared
decomposition, evidence, and synthesis gates. It never ranks a model from its
brand name or changes an already-pinned session.

## Execution lifecycle

A new run:

1. resolves the canonical working root;
2. selects an injected, saved, or explicit provider connection;
3. freezes a backend pin, permissions, and operating mode;
4. creates or resumes a durable session;
5. streams the parent agent loop;
6. validates tool calls against the active tool profile;
7. records bounded events and normalized provider usage; and
8. closes owned processes and state handles.

Resumed sessions retain their original backend pin. Changing the primary
connection affects future sessions, not historical ones.

## Agent teams

The parent runtime may create bounded Explore, Implement, Review, and Repair
children according to a versioned operating-mode policy.

- Explore and Review are read-only.
- Implement works in isolated Git worktrees.
- Review findings are structured and bounded.
- Repair is allowed only when the active policy permits it.
- The parent owns apply authority.

Child depth, concurrency, requests, retries, cost reports, and tool profiles
are frozen before execution. A child cannot widen the parent’s permission
boundary or create unbounded recursion.

## Tools and containment

Tool registration is capability-based. The runtime supplies only the tools
allowed by the current role, execution mode, and permission profile.

Filesystem and Git tools enforce canonical workspace boundaries. Process tools
receive a filtered environment and a private synthetic home/config/cache/temp
tree. The default macOS path uses Seatbelt; Linux uses Bubblewrap with a fresh
network namespace unless the approved command requires network.

Containment reduces host exposure but is not a credential-safe sandbox. A
user-selected credential is present in the parent Node.js process for
environment BYOK and may be observable by same-user host authority.

## Durable state

State is stored below the Recurs data directory:

- non-secret connection metadata;
- append-only session events;
- checkpoints and patch artifacts;
- team-run journals and leases;
- company blueprints, amendments, knowledge, and goals; and
- immutable model-team evaluations and selections.

Writes use private directories, bounded documents, canonical parsing, atomic
replacement, and revision checks. User prompts and tool arguments may appear
in private session logs; redacted projections are not substitutes for those
logs.

## Generated sources

Two policy sources are canonical:

- `policy/non-secret-policy.v1.json`
- `policy/provider-activation-profiles.v1.json`

Generation produces TypeScript consumed by the portable runtime. CI checks that
generated files match their sources.

## Verification

`npm run check` is the repository gate. It runs generated-source checks, lint,
TypeScript project references, contract type tests, the Vitest suite, the
production build, and npm-package verification.

CI runs the portable gate on Linux and macOS. Platform-specific tests exercise
the containment implementation without introducing a second application core.
