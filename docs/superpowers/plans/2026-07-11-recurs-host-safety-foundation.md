# Recurs Tool Safety Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove direct credential leakage through built-in file/search/diff tools, checkpoints, inherited child-process state, provider errors, and CLI errors without claiming that the current Node process is a credential-safe sandbox.

**Architecture:** Keep the TypeScript harness and its current `local_guarded` execution model. Add one normative credential-path policy used by path tools, aggregate search/Git tools, permissions, and checkpoint storage. Clean every child environment at the shared process boundary. Add execution-class metadata and a fail-closed `tools_disabled` registry profile that advertises and executes no model tools. Do not add a fake pathname-based “validated storage capability”: hardened auth storage and live-credential tool isolation require a native broker/sandbox design with descriptor-relative no-follow access and an OS authority boundary.

**Tech Stack:** TypeScript 6, Node.js 22.22+, npm workspaces, Vitest 4, Node filesystem/process APIs, append-only JSONL.

## Global Constraints

- Do not accept, persist, import, or transmit a live provider credential.
- Do not claim that environment cleanup, regex command classification, path preflight, package boundaries, or TypeScript brands are an OS security boundary.
- `local_guarded` remains the default for the current credential-free injected/local-provider harness. Its arbitrary shell can access the host filesystem and network after permission handling.
- `tools_disabled` exposes no model-callable tools and rejects direct invocation before parsing or checkpoint capture. It is a fail-closed composition option, not a useful coding profile.
- A `credential` permission intent is never approvable in any preset. This protects built-in classified surfaces, not indirect shell behavior.
- Built-in aggregate tools exclude the normative credential-path set even when invoked on `.` or a parent directory.
- New checkpoint stores carry a format marker proving credential exclusion was active from their first capture. Nonempty unversioned legacy stores are rejected and require an explicit manual reset; this slice performs no destructive automatic migration.
- Every child process gets a synthetic private home and allowlisted environment. This does not restrict its filesystem, network, IPC, or process-inspection authority.
- Unknown and provider-originated raw error text never enters durable events or terminal output.
- Windows subprocess use fails at the shared process boundary with a typed error.
- Version-1 sessions remain readable and read-only; version-2 persistence semantics remain unchanged.
- Do not add `@recurs/auth`, live onboarding, provider HTTP, OAuth, secrets, an npm release, Bun runtime support, curl, or Homebrew in this slice.

---

### Task 1: Establish one credential-path policy across built-in tools

**Files:**
- Modify: `packages/tools/src/path-policy.ts`
- Modify: `packages/tools/src/builtins/read-file.ts`
- Modify: `packages/tools/src/builtins/list-files.ts`
- Modify: `packages/tools/src/builtins/search-text.ts`
- Modify: `packages/tools/src/builtins/apply-patch.ts`
- Modify: `packages/tools/src/builtins/git-diff.ts`
- Modify: `packages/tools/src/builtins/git-status.ts`
- Modify: `packages/tools/test/files.test.ts`
- Modify: `packages/tools/test/git-tools.test.ts`

**Interfaces:**
- Produces `isCredentialPath()`, `credentialRipgrepGlobs()`, and `credentialGitPathspecs()` from one normative built-in rule set.
- Preserves configurable `sensitivePatterns` as elevated-but-approvable user policy; those patterns are not silently converted into process globs.

- [ ] **Step 1: Write failing direct, alias, and aggregate-tool tests**

Cover these built-in cases with POSIX and backslash separators and mixed case where the filesystem permits it: `.env`, `.env.*`, `id_rsa`, `id_ed25519`, `credentials`, `.netrc`, `.npmrc`, `.pypirc`, `*.pem`, `*.key`, `*.p12`, and any path under `.ssh`, `.aws`, `.azure`, `.docker`, `.gnupg`, `.kube`, or `.config/gcloud`.

Tests must prove:

```ts
it("denies a readable symlink alias whose canonical target is .env", async () => {
  await symlink(".env", path.join(cwd, "innocent.txt"));
  await expect(readFileTool("innocent.txt")).rejects.toMatchObject({
    code: "permission_denied",
  });
});

it("excludes tracked credentials from aggregate tools", async () => {
  expect(await listFiles(".")).not.toContain(".env");
  expect(await searchText("CANARY", ".")).not.toContain("CANARY");
  expect(await gitDiff()).not.toContain("CANARY");
  expect(await gitStatus()).not.toContain(".env");
});
```

Add apply-patch and explicit git-diff path tests showing direct and canonical credential targets fail before a subprocess starts.

- [ ] **Step 2: Run the focused tests and observe current leaks**

Run: `npx vitest run packages/tools/test/files.test.ts packages/tools/test/git-tools.test.ts`

Expected: FAIL because classification uses raw input, aggregate tools scan all descendants, and Git tools have no credential exclusions.

- [ ] **Step 3: Split credential classification from configurable sensitivity**

Implement `isCredentialPath(input)` from one normalized, case-insensitive segment/basename rule set. `isSensitivePath()` becomes `isCredentialPath(input) || matchesConfiguredSensitivePattern(input)`. Add deterministic helpers that derive equivalent ripgrep case-insensitive `--iglob !<pattern>` exclusions and Git `:(glob,icase,exclude)<pattern>` pathspecs from the same documented cases.

`pathPermissionIntents()` emits `credential` rather than `sensitive` for built-in credential paths. External-path intent remains additive.

- [ ] **Step 4: Enforce canonical targets and aggregate exclusions**

After `WorkspacePathPolicy` resolves a readable/writable target, each file tool reclassifies `resolved.relative` and rejects a credential target with `ToolError("permission_denied", "Credential paths are unavailable to model tools")`. For a nonexistent writable target, `resolveWritable()` must return the canonical existing ancestor joined to the unresolved suffix, so `alias/new-key` where `alias -> .ssh` is classified as a credential path. This canonical check is defense in depth against stable symlink aliases; document that Node pathname I/O does not eliminate adversarial symlink-swap races.

List/search append every case-insensitive credential exclusion after all model-controlled include globs and before `--`, so the deny rules are last and cannot be re-included by ripgrep's order-sensitive glob handling. Git diff/status always add `--`, the selected root (`.` or a validated relative path), and all case-insensitive Git exclusion pathspecs. Apply-patch reclassifies every resolved declared file before invoking `git apply`.

- [ ] **Step 5: Run focused and type tests**

Run: `npx vitest run packages/tools/test/files.test.ts packages/tools/test/git-tools.test.ts && npm run typecheck`

Expected: PASS; canaries are absent from output and credential-target subprocess spies remain untouched.

- [ ] **Step 6: Commit the unified path policy**

```bash
git add packages/tools/src/path-policy.ts packages/tools/src/builtins packages/tools/test/files.test.ts packages/tools/test/git-tools.test.ts
git commit -m "fix: exclude credential paths from built-in tools"
```

---

### Task 2: Make credential intents permanently non-approvable

**Files:**
- Modify: `packages/tools/src/permissions.ts`
- Modify: `packages/tools/test/permissions.test.ts`
- Modify: `packages/cli/src/commands/permissions.ts`
- Modify: `packages/cli/test/commands.test.ts`
- Modify: `docs/CLI.md`

**Interfaces:**
- Produces a permanent credential-denial rule that runs before session grants and permission-mode evaluation.
- Keeps Full Access honest about the unsandboxed arbitrary shell.

- [ ] **Step 1: Write failing permission-precedence tests**

```ts
it.each(["ask_always", "approved_for_me", "full_access"] as const)(
  "denies credential intents in %s",
  (mode) => {
    const engine = new PermissionEngine(mode);
    engine.grantForSession(credentialIntent);
    expect(engine.evaluate(credentialIntent)).toBe("deny");
  },
);

it("still asks for sensitive and external paths in Full Access", () => {
  expect(engine.evaluate(sensitiveIntent)).toBe("ask");
  expect(engine.evaluate(externalIntent)).toBe("ask");
});
```

- [ ] **Step 2: Run the tests and observe Full Access/session-grant bypasses**

Run: `npx vitest run packages/tools/test/permissions.test.ts packages/cli/test/commands.test.ts`

Expected: FAIL because current session grants and Full Access allow every category.

- [ ] **Step 3: Enforce deny-first evaluation**

`evaluate()` returns `deny` for `credential` before checking grants. `grantForSession()` ignores credential intents. Full Access returns `ask` for `sensitive` and `external_path`, and otherwise retains broad allow behavior.

Update the preset copy to distinguish built-in credential classification from arbitrary shell authority: direct credential intents are refused, but Full Access is not credential-safe because shell commands lack OS filesystem/network isolation.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run packages/tools/test/permissions.test.ts packages/cli/test/commands.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add packages/tools/src/permissions.ts packages/tools/test/permissions.test.ts packages/cli/src/commands/permissions.ts packages/cli/test/commands.test.ts docs/CLI.md
git commit -m "feat: make credential intents non-approvable"
```

---

### Task 3: Exclude credentials and reject ambiguous legacy checkpoint stores

**Files:**
- Modify: `packages/tools/src/checkpoints.ts`
- Modify: `packages/tools/src/types.ts`
- Modify: `packages/tools/test/checkpoints.test.ts`

**Interfaces:**
- Consumes `isCredentialPath()` from Task 1.
- Produces a versioned checkpoint-store format marker and `FileCheckpointStore.initialize()`; public capture/undo methods also await the same idempotent initialization guard.

- [ ] **Step 1: Write failing future-capture and legacy-rejection tests**

```ts
it("never reads or stores a tracked credential file", async () => {
  await writeFile(path.join(cwd, ".env"), "CHECKPOINT_CANARY=never-store\n");
  await runGit(cwd, ["add", "--force", ".env"]);
  const checkpoint = await store.captureBefore("s1", "call-1", cwd);
  expect(checkpoint.before).not.toHaveProperty(".env");
  expect(await storageContains("never-store")).toBe(false);
});

it("rejects a nonempty unversioned legacy store", async () => {
  await seedLegacyCredentialCheckpoint();
  await expect(store.initialize()).rejects.toMatchObject({
    code: "checkpoint_migration_required",
  });
});
```

Also seed an orphan legacy blob with no manifest and prove it is rejected by the same unversioned-store gate. Add two concurrent initializers against a fresh empty directory and prove they converge on one valid marker without deleting or accepting ambiguous data.

- [ ] **Step 2: Run checkpoint tests and observe both leaks**

Run: `npx vitest run packages/tools/test/checkpoints.test.ts`

Expected: FAIL because capture includes tracked `.env` and no format gate exists.

- [ ] **Step 3: Filter before workspace reads or blob writes**

Filter `git ls-files` results through `isCredentialPath()` before `readWorkspaceContent()` or `#writeBlob()`. Excluded names and hashes never enter new manifests.

- [ ] **Step 4: Implement an idempotent version gate**

Fresh/empty stores receive an atomically created mode-`0600` marker declaring checkpoint format version 2 and credential exclusion. A valid marker means every blob was created by code that filtered credential paths before reads and writes. A nonempty store without the marker, an invalid/symlinked marker, or an unknown version throws `ToolError("checkpoint_migration_required", "Legacy checkpoint storage must be reset before it can be used safely")`; add that code to `ToolErrorCode`. Never scan, rewrite, delete, or automatically bless ambiguous legacy data.

Two processes racing to initialize an empty store use exclusive marker creation plus a bounded empty-directory retry so both either observe the same valid marker or fail closed; neither performs garbage collection. Capture and undo await a memoized initialization promise so direct callers cannot bypass the gate. The documented reset is acceptable only because Recurs is unreleased `0.0.0`; it must be explicit and user-initiated. The marker is an upgrade-safety invariant, not a hostile-user security boundary, and the path-based store remains unsuitable for auth secrets.

- [ ] **Step 5: Run focused and end-to-end tests**

Run: `npx vitest run packages/tools/test/checkpoints.test.ts tests/e2e/coding-agent.test.ts && npm run typecheck`

Expected: PASS; no new canary is stored and seeded legacy/orphan data is never accepted or mutated.

- [ ] **Step 6: Commit checkpoint hygiene**

```bash
git add packages/tools/src/checkpoints.ts packages/tools/src/types.ts packages/tools/test/checkpoints.test.ts
git commit -m "fix: gate credential-safe checkpoint capture"
```

---

### Task 4: Clean child processes and add a fail-closed no-tool profile

**Files:**
- Create: `packages/tools/src/process-environment.ts`
- Modify: `packages/tools/src/process.ts`
- Modify: `packages/tools/src/types.ts`
- Modify: `packages/tools/src/registry.ts`
- Modify: `packages/tools/src/index.ts`
- Modify: `packages/tools/src/builtins/apply-patch.ts`
- Modify: `packages/tools/src/builtins/git-diff.ts`
- Modify: `packages/tools/src/builtins/git-status.ts`
- Modify: `packages/tools/src/builtins/list-files.ts`
- Modify: `packages/tools/src/builtins/read-file.ts`
- Modify: `packages/tools/src/builtins/run-command.ts`
- Modify: `packages/tools/src/builtins/search-text.ts`
- Modify: `packages/tools/test/command.test.ts`
- Modify: `packages/tools/test/checkpoints.test.ts`
- Modify: `packages/tools/test/registry.test.ts`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Produces `ToolExecutionClass = "in_process" | "fixed_process" | "arbitrary_process"`.
- Produces `ToolSecurityProfile = "local_guarded" | "tools_disabled"`; default remains `local_guarded`.
- `tools_disabled` returns no definitions and rejects every invocation before parsing, permissions, or checkpoints.

- [ ] **Step 1: Write failing environment, Windows, and registry tests**

```ts
it("does not pass parent secrets or the real home to descendants", async () => {
  process.env.RECURS_PROCESS_CANARY = "parent-secret";
  const result = await runNodeDescendant();
  expect(result.stdout).not.toContain("parent-secret");
  expect(result.stdout).not.toContain(homedir());
});

it("tools_disabled advertises and executes no model tools", async () => {
  expect(registry.definitions("act")).toEqual([]);
  await expect(registry.invoke(readCall, context, permissions, approvals))
    .rejects.toMatchObject({ code: "tool_unavailable" });
  expect(checkpoints.captureBefore).not.toHaveBeenCalled();
});
```

Test the shared process boundary with an injected/platform seam so `runProcess()` rejects Windows for fixed helpers and arbitrary commands with `unsupported_platform`.

- [ ] **Step 2: Run focused tests and observe inherited environment/visible tools**

Run: `npx vitest run packages/tools/test/command.test.ts packages/tools/test/registry.test.ts packages/tools/test/checkpoints.test.ts packages/cli/test/assembly.test.ts`

Expected: FAIL because spawn inherits the host environment and the registry lacks execution/profile metadata.

- [ ] **Step 3: Add accurate execution metadata and fail-closed filtering**

Only `read_file` is currently `in_process`. `list_files`, `search_text`, `apply_patch`, Git tools, and checkpoint capture launch fixed `rg`/`git` helpers; `run_command` is `arbitrary_process`. Every built-in and test fixture declares the class explicitly.

`ToolRegistry` receives a security profile. In `tools_disabled`, `definitions()` is empty and `invoke()` throws `ToolError("tool_unavailable", "Model tools are disabled for this runtime")` before lookup details, parsing, permission requests, or checkpoints.

- [ ] **Step 4: Give every child a synthetic environment**

`runProcess()` rejects Windows before spawning. On macOS/Linux it creates a per-child mode-`0700` temporary root under the canonical root-owned sticky system temporary directory (never a parent `TMPDIR` selected inside the workspace), then sets `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `TMP`, and `TEMP` below it. It passes only a filtered absolute `PATH`, locale keys (`LANG`, `LC_ALL`, `LC_CTYPE`) when present, and `TERM` when present. Remove empty, relative, and workspace-contained PATH entries. Do not pass `SHELL`, cloud/provider variables, Git config variables, tokens, sockets, proxy variables, or the parent temporary directories. Cleanup runs after close, spawn error, cancellation, timeout, and output-limit termination.

`run_command` uses `/bin/sh -c` on macOS/Linux, never `process.env.SHELL` and never `-l`.

- [ ] **Step 5: Expose composition without enabling credentials**

Add `toolSecurityProfile?: ToolSecurityProfile` to `StandaloneRuntimeOptions`. Tests can select `tools_disabled`; the default remains `local_guarded`. This option does not create a provider, connection, credential, or session.

- [ ] **Step 6: Run focused, end-to-end, and type tests**

Run: `npx vitest run packages/tools/test/command.test.ts packages/tools/test/registry.test.ts packages/tools/test/checkpoints.test.ts packages/cli/test/assembly.test.ts tests/e2e/coding-agent.test.ts && npm run typecheck`

Expected: PASS; the injected-provider coding flow remains green under `local_guarded` and disabled mode reaches no tool side effect.

- [ ] **Step 7: Commit process hygiene and profile metadata**

```bash
git add packages/tools packages/core/test/agent-loop.test.ts packages/cli/src/assembly.ts packages/cli/test/assembly.test.ts tests/e2e/coding-agent.test.ts
git commit -m "feat: isolate child process state"
```

---

### Task 5: Sanitize process, tool, provider, and CLI failures

**Files:**
- Create: `packages/providers/src/safe-error.ts`
- Modify: `packages/providers/src/index.ts`
- Modify: `packages/providers/test/types.test.ts`
- Modify: `packages/tools/src/process.ts`
- Modify: `packages/tools/src/registry.ts`
- Modify: `packages/tools/test/command.test.ts`
- Modify: `packages/tools/test/registry.test.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/compaction.ts`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/compaction.test.ts`
- Create: `packages/cli/src/error-rendering.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/repl.ts`
- Modify: `packages/cli/src/commands/registry.ts`
- Modify: `packages/cli/test/run-mode.test.ts`
- Modify: `packages/cli/test/repl.test.ts`
- Modify: `packages/cli/test/commands.test.ts`

**Interfaces:**
- Produces `safeProviderErrorMessage()` with canonical text by `ProviderError.code`, shared by normal runs and compaction.
- Produces shared CLI error rendering with generic diagnostic IDs while preserving documented configuration/cancellation behavior and exit codes.

- [ ] **Step 1: Write failing adversarial canary tests**

Test all of these boundaries:

- nonzero child stderr does not enter `ToolError.message` or `cause`;
- an unknown tool error becomes `ToolError("execution_failed", "Tool <name> failed")` before persistence;
- every `ProviderError` code carrying a hostile canary produces only its canonical message in warnings, failures, session JSONL, emitted events, and `/compact` command results;
- unknown one-shot, REPL, and slash-command errors produce a generic `Unexpected failure (diagnostic <uuid>)` message, with no raw message on either stream;
- typed cancellation/configuration errors preserve documented behavior.

- [ ] **Step 2: Run focused tests and observe raw messages crossing boundaries**

Run: `npx vitest run packages/providers/test/types.test.ts packages/tools/test/command.test.ts packages/tools/test/registry.test.ts packages/core/test/agent-loop.test.ts packages/core/test/compaction.test.ts packages/cli/test/run-mode.test.ts packages/cli/test/repl.test.ts packages/cli/test/commands.test.ts`

Expected: FAIL because child stderr, typed provider messages, unknown tool errors, and top-level `Error.message` are currently surfaced.

- [ ] **Step 3: Replace raw details with allowlisted messages**

Nonzero child exits throw `ToolError("process_failed", `<command> exited with <code>`)` without stderr/cause. Unknown tool implementation failures become safe typed tool errors before checkpoint/error persistence.

Map provider codes to canonical messages such as `Provider authentication failed`, `Provider rate limit reached`, `Provider context limit exceeded`, `Provider request failed`, `Provider request cancelled`, and `Provider returned an invalid response`. Retry warnings, final `AgentLoopError` values, and compaction failures use only this mapping; raw provider messages and causes never serialize.

Unknown one-shot and REPL faults receive one UUID diagnostic ID through a shared renderer. Slash-command exceptions become generic error results with a diagnostic ID instead of `error.message`. JSONL stdout remains reserved for documented structured configuration failures and contains no unknown raw fault. Do not print stacks, argv, process output, raw messages, or causes.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run packages/providers/test/types.test.ts packages/tools/test/command.test.ts packages/tools/test/registry.test.ts packages/core/test/agent-loop.test.ts packages/core/test/compaction.test.ts packages/cli/test/run-mode.test.ts packages/cli/test/repl.test.ts packages/cli/test/commands.test.ts && npm run typecheck`

Expected: PASS with no canary in output, events, or session files.

```bash
git add packages/providers packages/tools packages/core/src/agent-loop.ts packages/core/src/compaction.ts packages/core/test/agent-loop.test.ts packages/core/test/compaction.test.ts packages/cli/src/error-rendering.ts packages/cli/src/main.ts packages/cli/src/repl.ts packages/cli/src/commands/registry.ts packages/cli/test/run-mode.test.ts packages/cli/test/repl.test.ts packages/cli/test/commands.test.ts
git commit -m "fix: sanitize runtime failure boundaries"
```

---

### Task 6: Document the real boundary, add repository safety hygiene, and verify

**Files:**
- Modify: `.gitignore`
- Create: `SECURITY.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT.md`
- Modify: `docs/CLI.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md`
- Modify: `docs/superpowers/plans/2026-07-11-recurs-host-safety-foundation.md`

**Interfaces:**
- Documents exact implemented behavior and the native work required before live credentials.

- [ ] **Step 1: Add honest security and repository hygiene**

Ignore `.env`, `.env.*` (while allowing documented examples), common editor swap files, and local OS metadata without deleting any user file. Add `SECURITY.md` covering pre-1.0 support, private reporting through GitHub security advisories once enabled, credential-canary expectations, and the prohibition on public issues containing secrets.

- [ ] **Step 2: Update current-state documentation**

Document the unified exclusions, permanent built-in credential denial, checkpoint format gate/manual legacy reset, clean child environment, `local_guarded`, and `tools_disabled`. State repeatedly and plainly that arbitrary commands still have host filesystem/network/process authority and therefore no live credential may enter this process.

Add an implementation note to the provider/auth design: review proved that Node pathname validation plus an opaque TypeScript object cannot satisfy hardened-storage semantics. Before direct/cloud/subscription credentials, design and test a native broker/storage boundary with descriptor-relative no-follow I/O, ownership/mode/ACL/full-parent validation, filesystem capability checks, and an OS sandbox that denies Recurs/vendor auth access to tool children. A small Rust/native component is appropriate for that boundary; the TypeScript harness does not need a wholesale rewrite.

Keep the credential-free literal-loopback local-provider onboarding slice next after this milestone. Do not add `@recurs/auth` until its public capability is backed by the real authority boundary.

Document that npm is the likely first preview channel; Bun can later install the npm package while Node remains the runtime. Homebrew/curl wait for versioned signed artifacts. No channel is published here, and the repository cannot be called legally open source until the owner selects a license.

- [ ] **Step 3: Review the full diff and scan for sensitive material**

Run: `git status --short && git diff --check main...HEAD && git diff --stat main...HEAD`

Expected: only tool-safety code, tests, and documentation; no environment file, credential, key, certificate, generated output, or local configuration.

- [ ] **Step 4: Run a clean full gate**

Run: `rm -rf packages/*/dist && npm run check`

Expected: lint, strict TypeScript, every Vitest test, and build all pass.

- [ ] **Step 5: Run focused canary verification**

Run: `npx vitest run packages/tools/test/files.test.ts packages/tools/test/git-tools.test.ts packages/tools/test/permissions.test.ts packages/tools/test/checkpoints.test.ts packages/tools/test/command.test.ts packages/tools/test/registry.test.ts packages/core/test/agent-loop.test.ts packages/cli/test/run-mode.test.ts`

Expected: PASS with no newly captured canary present in tool output, checkpoint storage, events, sessions, errors, or CLI streams; legacy canary fixtures are rejected without mutation.

- [ ] **Step 6: Commit documentation and prepare whole-branch review**

```bash
git add .gitignore SECURITY.md README.md ARCHITECTURE.md PRODUCT.md docs
git commit -m "docs: define the native security boundary"
```

Generate a whole-branch review package from the merge base and request correctness/security review before the GitHub lifecycle. Do not mark provider security Slice 1 complete; this is the honest TypeScript safety precursor.
