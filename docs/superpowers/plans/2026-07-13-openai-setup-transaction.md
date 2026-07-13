# OpenAI Setup Transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a UI-neutral, crash-recoverable OpenAI API onboarding transaction that records only an exact reviewed model and never exposes credential bytes or credential-derived fingerprints in its public result.

**Architecture:** Keep native credential setup authoritative through the existing `NativeOpenAIOnboardingPort`, and use the existing private activation sidecar as the transaction bridge to the non-secret connection registry. Tighten the sidecar operations to exact compare-and-swap semantics, intersect the native `/v1/models` catalog with one reviewed static Responses capability profile, then coordinate begin, verify, prepare, native finalize, registry commit, and cleanup from a focused app-layer module. Native success is the commit point: after that point caller cancellation cannot interrupt durable convergence.

**Tech Stack:** TypeScript 5, Node.js ESM, Vitest, existing `@recurs/contracts`, `@recurs/providers`, and `@recurs/app` secure registry primitives.

## Global Constraints

- This slice is CLI-engine infrastructure only; it adds no desktop UI and no heavy sub-agent architecture.
- OpenAI credentials remain native-owned and are never accepted through Node arguments, environment variables, ordinary stdin, configuration, callbacks, errors, or return values.
- The fixed provider identity is `openai-api` / `openai-responses` / `openai_api_v1` at `https://api.openai.com/v1`.
- API billing is `metered_api`, separate from ChatGPT, and requires the exact current billing and disclosure revisions with `strict_primary_only`.
- `/v1/models` proves visibility only; selectable IDs must also be in the reviewed static Responses/tool-calling profile.
- Mutable aliases are excluded because the current registry stores only one exact `modelId` and cannot yet preserve a separate resolved revision.
- Do not mark the connection runnable in the onboarding catalog until brokered execution, verify, and disconnect are complete.
- Every native failure message is reconstructed from its contracts-owned code; dependency-supplied messages and thrown errors never cross the app boundary.
- No new runtime dependency is permitted.

---

## File Structure

- `packages/app/src/connection-activations.ts`: exact sidecar compare-and-swap operations and cancellable reads.
- `packages/app/src/connection-registry.ts`: cancellable registry reads used during recovery.
- `packages/app/src/openai-model-capabilities.ts`: one reviewed, exact OpenAI Responses model allowlist and deterministic catalog intersection.
- `packages/app/src/openai-onboarding.ts`: UI-neutral transaction, redacted result/failure types, and pending-activation recovery.
- `packages/app/src/index.ts`: public app-layer exports.
- `packages/app/test/connection-activations.test.ts`: storage CAS, replay, cancellation, and uncertainty tests.
- `packages/app/test/connection-registry.test.ts`: cancellable read test.
- `packages/app/test/openai-model-capabilities.test.ts`: capability profile and intersection tests.
- `packages/app/test/openai-onboarding.test.ts`: scripted native-port transaction and crash-recovery matrix.

### Task 1: Exact activation CAS and cancellable reads

**Files:**
- Modify: `packages/app/src/connection-activations.ts`
- Modify: `packages/app/src/connection-registry.ts`
- Test: `packages/app/test/connection-activations.test.ts`
- Test: `packages/app/test/connection-registry.test.ts`

**Interfaces:**
- Consumes: `PendingConnectionActivation`, `RegistryFileStore.transaction(signal, operation)`, and the existing immutable parsers.
- Produces: `read(options?: { signal?: AbortSignal })`, `commitToRegistry(expected: PendingConnectionActivation, options?)`, and `discard(expected: PendingConnectionActivation, options?)`.

- [ ] **Step 1: Write failing exact-CAS and cancellation tests**

Add tests that call the new signatures and prove a same-ID/different-fingerprint activation cannot commit, discard, or satisfy a sidecar-absent replay:

```ts
const expected = activation();
const forged = activation({
  connection: connection({
    credentialIdentityFingerprint: `sha256:${"c".repeat(64)}`,
  }),
});
await store.prepare(expected);
await expect(store.commitToRegistry(forged)).rejects.toMatchObject({
  code: "activation_conflict",
});
await expect(store.discard(forged)).rejects.toMatchObject({
  code: "activation_conflict",
});
await store.commitToRegistry(expected);
await store.discard(expected);
await expect(store.commitToRegistry(forged)).rejects.toMatchObject({
  code: "activation_not_found",
});
```

Add pre-aborted-signal tests for both store reads:

```ts
const controller = new AbortController();
controller.abort();
await expect(store.read({ signal: controller.signal })).rejects.toMatchObject({
  name: "AbortError",
});
await expect(registry.read({ signal: controller.signal })).rejects.toMatchObject({
  name: "AbortError",
});
```

Update existing calls in `connection-activations.test.ts` to pass the complete `activation()` object rather than its ID.

- [ ] **Step 2: Run the focused tests and confirm the API mismatch**

Run:

```bash
npx vitest run packages/app/test/connection-activations.test.ts packages/app/test/connection-registry.test.ts
```

Expected: FAIL because the production methods still accept a string and `read` accepts no options.

- [ ] **Step 3: Implement exact parsing, comparison, replay, and signal forwarding**

Parse the expected value once through the existing strict document parser, compare the complete pending activation under the shared registry lock, and accept sidecar-absent replay only when the registry contains the exact expected connection:

```ts
function canonicalActivation(
  activation: PendingConnectionActivation,
): PendingConnectionActivation {
  const document = parseConnectionActivationDocument({
    schemaVersion: 1,
    activation,
  });
  if (document.activation === null) throw conflict();
  return document.activation;
}

async read(
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionActivationDocument> {
  return this.#store.transaction(options.signal, async (access) =>
    immutableConnectionActivationDocument(
      (await access.readActivation()).document,
    )
  );
}

async commitToRegistry(
  expectedActivation: PendingConnectionActivation,
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionRegistryDocument> {
  const expected = canonicalActivation(expectedActivation);
  return this.#store.transaction(options.signal, async (access) => {
    const pending = await access.readActivation();
    const activation = pending.document.activation;
    const current = await access.readRegistry();
    if (activation === null) {
      const completed = current.document.connections.find(
        (candidate) => candidate.id === expected.connection.id,
      );
      if (completed === undefined) throw notFound();
      if (!isDeepStrictEqual(completed, expected.connection)) throw conflict();
      return immutableRegistryDocument(current.document);
    }
    if (!isDeepStrictEqual(activation, expected)) throw conflict();
    // Preserve the existing idempotent insert and first-only-primary logic.
  });
}
```

Make `discard` compare the complete canonical activation before unlinking. Add a private `notFound()` helper with the existing fixed message. Change `FileConnectionRegistry.read` to use `#store.transaction(options.signal, ...)` so cancellation also covers lock acquisition.

- [ ] **Step 4: Run focused tests and app type checking**

Run:

```bash
npx vitest run packages/app/test/connection-activations.test.ts packages/app/test/connection-registry.test.ts
npx tsc -p packages/app/tsconfig.json --pretty false
```

Expected: both commands PASS.

- [ ] **Step 5: Review and commit the storage boundary**

Run `git diff --check`, inspect the two source files and focused tests, then:

```bash
git add packages/app/src/connection-activations.ts packages/app/src/connection-registry.ts packages/app/test/connection-activations.test.ts packages/app/test/connection-registry.test.ts
git commit -m "fix: make provider activation commits exact"
```

### Task 2: Reviewed OpenAI Responses capability profile

**Files:**
- Create: `packages/app/src/openai-model-capabilities.ts`
- Create: `packages/app/test/openai-model-capabilities.test.ts`
- Modify: `packages/app/src/index.ts`

**Interfaces:**
- Consumes: native catalog model IDs after strict contract decoding.
- Produces: `OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION`, `OPENAI_RESPONSES_EXACT_MODEL_IDS`, `compatibleOpenAIResponsesModelIds(visibleIds)` and `isCompatibleOpenAIResponsesModelId(modelId)`.

- [ ] **Step 1: Write failing capability-profile tests**

Use the exact current OpenAI model IDs verified from the official model pages on 2026-07-13:

```ts
expect(OPENAI_RESPONSES_EXACT_MODEL_IDS).toEqual([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);
expect(compatibleOpenAIResponsesModelIds([
  "gpt-5.6",
  "gpt-5.6-terra",
  "unreviewed-model",
  "gpt-5.6-sol",
  "gpt-5.6-sol",
])).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
expect(isCompatibleOpenAIResponsesModelId("gpt-5.6")).toBe(false);
```

Also assert the result and exported list are deeply frozen and that control characters, surrounding whitespace, aliases, and arbitrary prefix matches are rejected.

- [ ] **Step 2: Run the focused test and confirm missing exports**

Run:

```bash
npx vitest run packages/app/test/openai-model-capabilities.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement one exact, deterministic profile**

Create the module with no regex capability inference:

```ts
export const OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION =
  "openai-responses-tools-2026-07-13-v1";

export const OPENAI_RESPONSES_EXACT_MODEL_IDS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const);

const exactModelIds = new Set<string>(OPENAI_RESPONSES_EXACT_MODEL_IDS);

export function isCompatibleOpenAIResponsesModelId(modelId: string): boolean {
  return exactModelIds.has(modelId);
}

export function compatibleOpenAIResponsesModelIds(
  visibleIds: readonly string[],
): readonly string[] {
  return Object.freeze(
    [...new Set(visibleIds)]
      .filter(isCompatibleOpenAIResponsesModelId)
      .sort((left, right) => Buffer.compare(
        Buffer.from(left, "utf8"),
        Buffer.from(right, "utf8"),
      )),
  );
}
```

Document the official source URLs in a short module comment and export the module from `packages/app/src/index.ts`.

- [ ] **Step 4: Run focused tests and app build**

Run:

```bash
npx vitest run packages/app/test/openai-model-capabilities.test.ts
npx tsc -p packages/app/tsconfig.json --pretty false
```

Expected: both commands PASS.

- [ ] **Step 5: Review and commit the capability profile**

Run `git diff --check`, verify no mutable alias is included, then:

```bash
git add packages/app/src/openai-model-capabilities.ts packages/app/test/openai-model-capabilities.test.ts packages/app/src/index.ts
git commit -m "feat: review OpenAI Responses model capabilities"
```

### Task 3: Crash-safe UI-neutral OpenAI setup coordinator

**Files:**
- Create: `packages/app/src/openai-onboarding.ts`
- Create: `packages/app/test/openai-onboarding.test.ts`
- Modify: `packages/app/src/index.ts`

**Interfaces:**
- Consumes: `NativeOpenAIOnboardingPort`, exact current `OnboardingCatalog` entry, `FileConnectionActivationStore`, and Task 2 model intersection.
- Produces: `openAIOnboardingDisclosure(options?)`, `setupOpenAIConnection(dataDirectory, input, dependencies)`, `recoverPendingOpenAIConnection(dataDirectory, dependencies)`, and redacted immutable result/failure unions.

- [ ] **Step 1: Write the scripted native port and happy-path failing test**

The fake port records only method names/arguments and returns scripted contract outcomes. The success test must prove this exact order:

```ts
expect(fake.calls).toEqual([
  "begin",
  "verify",
  "catalog:2",
  "finalize:gpt-5.6-sol",
]);
expect(result).toMatchObject({
  state: "ready",
  disposition: "created",
  connection: {
    id: CONNECTION_ID,
    label: "OpenAI API",
    providerId: "openai-api",
    adapterId: "openai-responses",
    modelId: "gpt-5.6-sol",
    primary: true,
    account: "verified (identifier redacted)",
  },
  cleanupPending: false,
});
expect(JSON.stringify(result)).not.toContain(FINGERPRINT);
expect((await activationStore.read()).activation).toBeNull();
```

Assert the stored brokered record contains the exact fixed provider/adapter/profile, selected model, native ID/fingerprint, current policy/billing revisions, `metered_api`, and canonical timestamps. Add a second setup test that preserves the first primary.

- [ ] **Step 2: Write failure, cancellation, and recovery tests before implementation**

Cover these focused cases with exact assertions:

- stale policy, billing, or disclosure acknowledgement fails in `preflight` before `begin`;
- a visible but unreviewed model fails as `model_not_compatible`, calls native abort, and stores nothing;
- every native failure is normalized by code even when the fake supplies a hostile `safeMessage`;
- thrown native errors become `authority_unavailable` with no raw cause/message;
- cancellation before native commit calls abort and returns `cancelled` only after abort succeeds;
- cancellation during/after successful finalize does not prevent registry commit and sidecar cleanup;
- prepare conflict aborts this native attempt and preserves the existing sidecar;
- native finalize ambiguity retains the sidecar with `pending_reconciliation`;
- registry fault after native success retains the exact sidecar;
- discard fault after registry success returns ready with `cleanupPending: true`;
- pending + `ready_openai` replays exact commit and discard;
- pending + `absent` discards only when no exact registry record exists;
- pending + `unresolved` or native failure retains the sidecar;
- pending + native `absent` plus exact ready registry record fails as inconsistent and retains evidence;
- every result/error/serialized file remains free of a credential canary.

- [ ] **Step 3: Run the focused test and confirm the module is missing**

Run:

```bash
npx vitest run packages/app/test/openai-onboarding.test.ts
```

Expected: FAIL because `openai-onboarding.ts` and its exports do not exist.

- [ ] **Step 4: Define narrow public inputs and redacted outcomes**

Use these shapes; do not return a registry record or fingerprint:

```ts
export interface OpenAIOnboardingAcknowledgement {
  readonly policyRevision: string;
  readonly billingPolicyRevision: string;
  readonly billingDisclosureRevision: string;
  readonly mode: "strict_primary_only";
}

export interface SetupOpenAIConnectionInput {
  readonly modelId: string;
  readonly acknowledgement: OpenAIOnboardingAcknowledgement;
  readonly signal?: AbortSignal;
  readonly now?: string;
}

export type OpenAISetupPhase =
  | "preflight" | "begin" | "verify" | "catalog" | "prepare"
  | "native_commit" | "registry_commit" | "cleanup" | "recovery";

export type OpenAISetupRecovery =
  | "none" | "retry" | "pending_reconciliation"
  | "ready_cleanup_pending";

export type OpenAISetupOutcome =
  | Readonly<{
      state: "ready";
      disposition: "created" | "recovered";
      connection: ConnectionSummary;
      cleanupPending: boolean;
    }>
  | Readonly<{ state: "cancelled"; cleanup: "confirmed" }>
  | Readonly<{
      state: "failed";
      phase: OpenAISetupPhase;
      code: NativeOpenAIOnboardingFailureCode
        | "acknowledgement_required"
        | "policy_unavailable"
        | "model_not_compatible"
        | "activation_conflict"
        | "persistence_failed"
        | "inconsistent_recovery";
      safeMessage: string;
      recovery: OpenAISetupRecovery;
      connectionId?: string;
    }>;

export type OpenAIRecoveryOutcome =
  | Readonly<{ state: "none" }>
  | OpenAISetupOutcome;
```

Dependencies contain only `nativeAuthority`, optional structural `activationStore`, optional `catalog`, and optional clock. They contain no prompt, TTY, key, environment, or credential callback.

- [ ] **Step 5: Implement disclosure validation, pagination, and exact record construction**

Resolve the single `openai-api` catalog entry for the exact current time, require `requires_native_broker`, require all acknowledgement revisions to match, and require `strict_primary_only`. Fetch all native pages by following only each returned `nextCursor`; collect model IDs, intersect through Task 2, then require `input.modelId` to be an exact member.

Build the pending record from fixed and reviewed data only:

```ts
const pending: PendingConnectionActivation = {
  connection: {
    kind: "brokered_model_provider",
    id: begun.connectionId,
    providerId: "openai-api",
    adapterId: "openai-responses",
    activationProfileId: "openai_api_v1",
    label: entry.displayName,
    modelId: input.modelId,
    credentialIdentityFingerprint: begun.credentialIdentityFingerprint,
    policyRevision: entry.policy.revision,
    billingPolicy: structuredClone(entry.billing),
    billingSelection: {
      mode: "strict_primary_only",
      policyRevision: entry.billing.revision,
      disclosureRevision: entry.billing.disclosureRevision,
      allowedSources: ["metered_api"],
      acknowledgedAt: now,
    },
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  },
  stagedAt: now,
};
```

Canonicalize the timestamp and all native data through the existing strict activation parser before persisting.

- [ ] **Step 6: Implement the durable commit and recovery state machine**

Before finalize, abort on validation, persistence, or caller cancellation and report clean cancellation only when native abort succeeds. After `finalizeOpenAIOnboarding` returns the exact expected receipt, use a non-aborted internal signal for `commitToRegistry(pending)` and `discard(pending)`.

At the start of a fresh recovery invocation:

```ts
const pending = (await store.read({ signal })).activation;
if (pending === null) return Object.freeze({ state: "none" });
const reconciled = await native.reconcileOpenAIActivation(
  pending.connection.id,
  pending.connection.credentialIdentityFingerprint,
  signal,
);
```

For `ready_openai`, exact-commit then exact-discard and return redacted `recovered`. For `absent`, read the registry: discard only if no connection with that ID exists; an exact or conflicting registry record is inconsistent and retains the sidecar. For `unresolved`, failures, and thrown errors, retain the sidecar and return a normalized failure. A discard failure after an exact registry commit is a ready result with `cleanupPending: true`, never a false failure.

- [ ] **Step 7: Run the coordinator tests and all app tests**

Run:

```bash
npx vitest run packages/app/test/openai-onboarding.test.ts
npx vitest run packages/app/test
npx tsc -p packages/app/tsconfig.json --pretty false
```

Expected: all commands PASS with no snapshots containing native fingerprints or canaries.

- [ ] **Step 8: Export, review, secret-scan, and commit**

Export the new module from `packages/app/src/index.ts`. Run:

```bash
git diff --check
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' 'sk-[A-Za-z0-9_-]{16,}|OPENAI_API_KEY|api[_-]?key\s*[:=]' packages/app docs/superpowers/plans/2026-07-13-openai-setup-transaction.md
git status --short
```

Inspect every match as test fixture text or documentation, then:

```bash
git add packages/app/src/openai-onboarding.ts packages/app/src/index.ts packages/app/test/openai-onboarding.test.ts
git commit -m "feat: add crash-safe OpenAI setup transaction"
```

### Task 4: Milestone verification and truthful progress docs

**Files:**
- Modify: `.superpowers/sdd/progress.md`
- Modify: `.superpowers/sdd/provider-activation/typescript-onboarding-client-report.md`

**Interfaces:**
- Consumes: the three committed implementation tasks.
- Produces: one reproducible verification report that explicitly says setup metadata is not yet a runnable provider path.

- [ ] **Step 1: Run the strongest repository verification**

Run:

```bash
npm run check
git status --short --branch
git log --oneline -4
```

Expected: generated checks, lint, all TypeScript builds/type tests, all Vitest suites, package build, native engine bundle, bridge, and doctor smokes PASS; only intentional report edits remain.

- [ ] **Step 2: Review the complete milestone diff and history**

Run:

```bash
git diff 3b5371b..HEAD --stat
git diff 3b5371b..HEAD -- packages/app/src packages/app/test
git diff --check 3b5371b..HEAD
```

Confirm exact CAS, immutable static intersection, redacted outcomes, caller-cancellation handling, native-finalize convergence, and recovery retention are all visible in code and tests.

- [ ] **Step 3: Update internal progress truthfully**

Record the exact commands/test totals and these remaining boundaries:

```markdown
- OpenAI setup now has a UI-neutral, crash-recoverable metadata transaction.
- The native authority remains the only credential owner; Node sees only public IDs and a non-secret identity fingerprint used in the private sidecar.
- OpenAI remains `requires_native_broker`; setup is not advertised as runnable until the brokered Responses execution, verify, and disconnect paths pass their own gates.
- Anthropic and explicit public-HTTPS compatible activation remain in the Provider Activation v1 goal after the OpenAI vertical slice.
```

- [ ] **Step 4: Re-run status and preserve ignored internal reports**

Run `git status --short --branch`. Do not force-add ignored `.superpowers` files and do not push. The implementation branch should otherwise be clean.

---

## Self-Review

- Spec coverage: this plan implements Sections 12 and 13 only for the OpenAI setup metadata transaction and explicitly preserves the Section 15 runtime gate. OpenAI execution, Anthropic, compatible endpoints, CLI rendering, and installed-artifact release evidence remain separate working slices under the active Provider Activation v1 goal.
- Placeholder scan: every code-changing step includes concrete interfaces, code, commands, and expected behavior.
- Type consistency: every activation mutation accepts the complete `PendingConnectionActivation`; setup and recovery both use the same exact value; public outcomes use `ConnectionSummary` and never return the registry record or fingerprint.
