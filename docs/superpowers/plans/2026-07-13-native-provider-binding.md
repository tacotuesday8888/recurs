# Native Provider Binding and Route Authority Implementation Plan

> **Execution rule:** Use test-driven development task by task. Do not begin
> TTY capture, provider HTTP, provider request/stream codecs, CLI onboarding,
> or direct-provider activation in this plan.

**Goal:** Give every broker-owned credential one immutable, authenticated
provider/profile identity; make that identity consistent across TypeScript and
Swift; and add dormant, broker-internal setup/run/maintenance route authority
that proves endpoint feasibility before any future credential load or send.

**Architecture:** A tiny canonical catalog generates only versioned activation-
profile identity for TypeScript and Swift. Swift remains authoritative for
endpoint routes, authentication, headers, codecs, and custom URL validation.
The credential journal moves to schema v2 and stores one connection-level
`ProviderProfileBinding` on every record. The existing staging order persists
the bound `.storePending` record before Keychain storage. A per-launcher-style
service actor can mint opaque route capabilities from authoritative bound
staging/ready state, resolve only the profile-owned host, apply the existing
public-address policy, recheck the journal after awaits, and return a dormant
feasibility receipt. Nothing is wired to the launcher, Node, or a provider yet.

**Technology:** TypeScript, Vitest, Node ESM generation scripts, Swift 6.2,
Swift Testing, authenticated canonical JSON, Data Protection Keychain test
doubles, and the existing endpoint policy.

## Frozen decisions and boundaries

1. Canonical activation-profile IDs are append-only:
   `openai_api_v1`, `anthropic_api_v1`, `kimi_code_v1`, and
   `custom_openai_compatible_v1`. A security-affecting change to origin, route,
   auth, codec, compatibility, or billing evidence requires a new ID.
2. `ProviderManifest` schema becomes v2 and always contains
   `activationProfileId`, using `null` for every path not mapped by the
   generated catalog. Profile presence never makes a manifest runnable.
3. Journal schema becomes v2. Every record has one non-optional binding. The
   repository has no supported signed/notarized credential-bearing artifact,
   so v1 journals fail closed with `unsupportedVersion`; there is no inferred,
   dummy, optional, or in-place migration. Development users must remove their
   unpublished native broker journal and reconnect.
4. Binding is connection-level, not duplicated per generation. Failed/aborted
   stages, vacant records, reconnects, and tombstones retain it. A changed
   profile or custom base requires a fresh connection UUID.
5. Built-in bindings contain an exact generated provider/profile pair and no
   custom endpoint. Custom binding uses the fixed synthetic provider ID
   `custom-openai-compatible`, the custom profile ID, and canonical
   host/port/base-path/catalog fields validated by `EndpointProfile`.
6. The existing stage journal CAS remains the staging-candidate reservation.
   It must durably select the exact binding before `CredentialStore.store` sees
   secret bytes. No new journal phase or parallel binding store is introduced.
7. Private XPC stage metadata carries a bounded non-secret binding descriptor.
   Replies remain redacted. No binding, endpoint, generation, authority token,
   or receipt enters TypeScript or descriptor 3.
8. Route capabilities and receipts are internal opaque reference identities:
   not Codable, not Hashable, empty reflection, fixed descriptions, and useful
   only to the actor that issued them. Setup and maintenance allow catalog only;
   run allows generation only.
9. Route feasibility is not transport authority. It performs no Keychain load,
   credential reservation, HTTP, TLS, proxy selection, peer connection, or
   send. Future transport must still validate its actual connected peer.
10. Every broker-owned manifest remains disabled. Kimi is declared but not
    activated. OpenAI, Anthropic, and custom endpoints remain unusable until
    later vertical slices complete.

---

## Task 1: Generate one cross-language activation-profile catalog

**Files:**

- Create: `policy/provider-activation-profiles.v1.json`
- Create: `scripts/generate-provider-activation-profiles.mjs`
- Create: `packages/contracts/src/provider-activation-profiles.ts`
- Create: `native/macos/Sources/RecursBrokerCore/GeneratedProviderActivationProfiles.swift`
- Create: `packages/contracts/test/provider-activation-profiles.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/manifests.ts`
- Modify: `packages/providers/src/bundled-manifests.ts`
- Modify: `packages/providers/src/manifest-validator.ts`
- Modify: `packages/providers/test/manifests.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing generator and manifest tests**

Assert canonical source bytes, four sorted unique versioned IDs, exact nullable
provider mappings, deterministic TypeScript/Swift output, check mode without
writes, atomic generation, and one fixed non-disclosing error for missing,
malformed, noncanonical, duplicate, unsorted, or unversioned input. Assert only
`openai-api`, `anthropic-api`, and `kimi-code` receive their exact profile ID;
all other bundled manifests receive `null`; custom is absent from the bundled
map; mismatched/unknown/missing fields fail validation; and all broker-owned
paths remain non-runnable.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run packages/contracts/test/provider-activation-profiles.test.ts \
  packages/providers/test/manifests.test.ts
```

Expected: FAIL because the canonical catalog and manifest v2 field do not
exist.

- [ ] **Step 3: Implement the narrow generator and manifest v2**

The source is exact canonical JSON:

```json
{
  "schemaVersion": 1,
  "profiles": [
    { "id": "anthropic_api_v1", "bundledProviderId": "anthropic-api" },
    { "id": "custom_openai_compatible_v1", "bundledProviderId": null },
    { "id": "kimi_code_v1", "bundledProviderId": "kimi-code" },
    { "id": "openai_api_v1", "bundledProviderId": "openai-api" }
  ]
}
```

Generate a frozen TypeScript catalog, `ProviderActivationProfileId`, and exact
provider-to-profile map. Generate a Swift `ProviderActivationProfileID` raw-
string enum with `CaseIterable` and a generated nullable `bundledProviderID`.
Do not generate endpoints, routes, headers, billing, policies, or wire numbers.

`ProviderManifest` schema v2 requires:

```ts
activationProfileId: ProviderActivationProfileId | null;
```

The bundled-manifest helper derives this field from the generated map. The
validator requires the exact generated mapping and rejects any profile on all
other provider IDs. Keep the unconditional broker-owned runnable rejection.
Add the generator to both normal generation and `check:generated`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
node scripts/generate-provider-activation-profiles.mjs
node scripts/generate-provider-activation-profiles.mjs --check
npx vitest run packages/contracts/test/provider-activation-profiles.test.ts \
  packages/providers/test/manifests.test.ts
npm run typecheck
npm run check:generated
```

```bash
git add policy/provider-activation-profiles.v1.json \
  scripts/generate-provider-activation-profiles.mjs package.json \
  packages/contracts packages/providers \
  native/macos/Sources/RecursBrokerCore/GeneratedProviderActivationProfiles.swift
git commit -m "feat: share provider activation profile identity"
```

---

## Task 2: Make Swift endpoint profiles reconstructible from one binding

**Files:**

- Create: `native/macos/Sources/RecursBrokerCore/ProviderProfileBinding.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/ProviderProfileBindingTests.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/EndpointPolicy.swift`
- Modify: `native/macos/Tests/RecursBrokerCoreTests/EndpointPolicyTests.swift`

- [ ] **Step 1: Write failing binding tests**

Cover all three built-ins and one canonical custom binding. Assert exact
provider/profile pairs, custom provider identity, canonical host/port/base path
and catalog behavior, reconstructed endpoint equality, and fixed redacted
errors. Reject unknown IDs, pair mismatches, built-ins with custom fields,
custom without every required field, reserved built-in custom origins,
noncanonical URLs, invalid ports/paths, and any attempt to reuse a profile ID
with different endpoint policy.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos --filter ProviderProfileBindingTests
```

- [ ] **Step 3: Implement the minimum closed binding**

Replace `EndpointProfile.kind` and the aggregate `revision` with generated
`activationProfileID`. Retain the separate codec, compatibility, and billing-
evidence revisions. `ProviderProfileBinding` has no general public initializer:
built-in factories derive exact generated provider IDs, and the custom factory
first constructs `EndpointProfile.customOpenAICompatible` and then retains only
its canonical structural fields. A computed `endpointProfile` reconstructs and
revalidates the closed policy.

- [ ] **Step 4: Verify GREEN and commit**

```bash
swift test --package-path native/macos --filter ProviderProfileBindingTests
swift test --package-path native/macos --filter EndpointPolicyTests
swift build --package-path native/macos
```

```bash
git add native/macos/Sources/RecursBrokerCore \
  native/macos/Tests/RecursBrokerCoreTests
git commit -m "feat: bind native provider endpoint profiles"
```

---

## Task 3: Authenticate the immutable binding in journal v2

**Files:**

- Modify: `native/macos/Sources/RecursBrokerCore/BrokerJournalModel.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerJournalCodec.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerJournalRecordAdapter.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerJournalRecovery.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerCredentialStateMachine.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerCredentialState.swift`
- Modify: relevant `native/macos/Tests/RecursBrokerCoreTests/*Journal*Tests.swift`
- Modify: `native/macos/Tests/RecursBrokerCoreTests/CredentialUseReservationTests.swift`
- Modify: test journal/store fixtures that construct `BrokerJournalRecord`

- [ ] **Step 1: Write failing journal/binding tests**

Add exact independent v2 canonical bytes for built-in and custom bindings.
Assert v1/unknown schemas fail `unsupportedVersion`; mismatched and malformed
binding fields fail before recovery; the non-secret scanner still passes exact
canonical values; and binding survives every phase, terminal FIFO, crash,
cleanup, reconnect, abort, ready, and tombstone transition.

Assert first-stage `.storePending` CAS contains the binding before the fake
credential store is called. A same-connection reconnect with another binding
must fail before journal mutation or store access. Exact same binding succeeds.
Unknown-CAS reconciliation accepts only the exact selected binding. Stage
operation replay includes binding in its fingerprint. Ready credential-use
reservation requires `expectedBinding` and rejects mismatches before Keychain
load.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos --filter BrokerJournalCodecTests
swift test --package-path native/macos --filter BrokerCredentialJournalStageTests
swift test --package-path native/macos --filter CredentialUseReservationTests
```

- [ ] **Step 3: Implement journal v2 and propagation**

`BrokerJournalRecord` stores non-optional `providerBinding` and schema version
2. Canonical JSON places the exact binding at a fixed top-level position:

```text
providerID, activationProfileID, customEndpoint
```

Built-ins encode `customEndpoint: null`; custom encodes canonical host, nullable
port, base path, and catalog behavior. Decode through `ProviderProfileBinding`
so well-formed but unknown/mismatched identity fails closed.

Only the initial store-pending construction accepts the proposed binding.
Every later adapter copies the predecessor binding. Transition validation
requires exact equality. The state machine's stage proposal, reservation, CAS
reconciliation, and terminal replay fingerprint bind it. The stage API requires
the binding and preserves the existing order:

```text
validate -> journal storePending CAS -> recheck -> credential store -> staging CAS
```

Do not expose it through lifecycle projections. Require `expectedBinding` when
reserving a ready credential and compare the authenticated snapshot before any
store load.

- [ ] **Step 4: Run the full core suite and commit**

```bash
swift test --package-path native/macos --filter RecursBrokerCoreTests
swift build --package-path native/macos -c release -Xswiftc -warnings-as-errors
```

```bash
git add native/macos/Sources/RecursBrokerCore \
  native/macos/Tests/RecursBrokerCoreTests
git commit -m "feat: authenticate provider binding in broker state"
```

---

## Task 4: Carry the binding through the private stage XPC metadata

**Files:**

- Modify: `native/component-version.json`
- Modify generated native component-version outputs
- Modify: `native/macos/Sources/RecursBrokerXPC/BrokerCredentialLifecycleCodec.swift`
- Modify: `native/macos/Sources/RecursBrokerService/BrokerCredentialAuthority.swift`
- Modify: `native/macos/Sources/RecursBrokerService/BrokerCredentialLifecycleGateway.swift`
- Modify: focused broker service/XPC/codec tests
- Modify: docs that state provider metadata is not durably bound

- [ ] **Step 1: Write failing codec and gateway tests**

Extend only `BrokerCredentialStageRequest` with a bounded non-secret binding
descriptor: versioned profile ID plus either no custom fields or exact custom
base URL/catalog behavior. Test every truncation/length/UTF-8/ASCII/category
edge, unknown IDs mapped to a fixed invalid request, custom validation, request
ID consumption, alias copying, and reply/error redaction. Assert the gateway
passes the exact binding to authority and rejects it before authority/store work
when invalid. Lifecycle projection/control replies remain byte-for-byte free of
provider/profile/URL data.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos --filter BrokerCredentialLifecycleCodecTests
swift test --package-path native/macos --filter BrokerCredentialLifecycleGatewayTests
swift test --package-path native/macos --filter BrokerCredentialLifecycleXPCTests
```

- [ ] **Step 3: Implement the bounded private descriptor**

Use the raw generated profile string, not a second handwritten numeric enum.
Bound the profile ID to 64 ASCII bytes and the canonical custom base to 2,048
ASCII bytes. Encode explicit lengths and an exact custom catalog discriminator;
increase only the private credential-frame maximum needed for that closed
shape. Map the descriptor to `ProviderProfileBinding` inside the service before
calling the state actor. Keep the XPC method signature and redacted replies.

This is a breaking private metadata revision, so bump the native component
version from `0.1.0` to `0.2.0` through its generator. Do not add any field to
`RecursNativeProtocol` or the launcher-to-engine bridge.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm run generate:native-component-version
swift test --package-path native/macos --filter RecursBrokerServiceTests
npm run check:generated
npm run native:engine-bridge-smoke
```

```bash
git add native/component-version.json package.json packages/contracts \
  native/macos/Sources/RecursBrokerXPC \
  native/macos/Sources/RecursBrokerService \
  native/macos/Tests/RecursBrokerServiceTests native/macos/Resources \
  README.md ARCHITECTURE.md SECURITY.md PRODUCT.md docs
git commit -m "feat: bind private credential staging metadata"
```

---

## Task 5: Add dormant setup/run/maintenance route capabilities

**Files:**

- Create: `native/macos/Sources/RecursBrokerService/BrokerProviderRouteAuthority.swift`
- Create: `native/macos/Tests/RecursBrokerServiceTests/BrokerProviderRouteAuthorityTests.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerCredentialState.swift`
- Modify: `native/macos/Sources/RecursBrokerService/BrokerCredentialAuthority.swift`

- [ ] **Step 1: Write failing authority tests**

Cover opaque empty-reflection non-Encodable handles and receipts; exact setup
staging-attempt and run/maintenance ready-generation fencing; exact binding-
derived profiles; scope separation; missing catalog route; cancellation, task
cancellation, expiry, actor close, byte overflow, request/byte budget, and
concurrent final debit. Use scripted resolver and journal gates—not sleeps—to
change attempt, fence, generation, binding, cancellation, and expiry during
each await.

Prove wrong scope and over-budget requests fail before resolver; empty, mixed,
private, reserved, or malformed address sets fail before authoritative
projection; event order is resolve, trusted address validation, authoritative
journal read, final capability recheck/debit; and no credential-store or
`CredentialUseReservation` dependency is reachable. Resolver/journal failures
map to fixed safe errors without raw details.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos --filter BrokerProviderRouteAuthorityTests
```

- [ ] **Step 3: Implement the dormant authority session**

Add an internal authoritative bound-projection reader that returns exact native
binding plus staging or ready state and never loads Keychain. The service actor
owns all capability entries by handle object identity. It derives the endpoint
profile only from the authenticated binding.

Hard route scopes are:

```text
setup       -> model_catalog
maintenance -> model_catalog
run         -> generation
```

For each preflight: validate handle/scope/expiry/cancellation/bounds; resolve
only bound host and canonical port; call `EndpointProfile.validateResolution`;
recheck after resolver reentry; read and exactly match authoritative staging or
ready projection plus binding; recheck again; atomically debit one route permit
and checked byte budget; return an opaque feasibility receipt. Failed checks do
not mint a receipt. The receipt contains no method that loads a credential or
sends data.

- [ ] **Step 4: Verify GREEN and commit**

```bash
swift test --package-path native/macos --filter BrokerProviderRouteAuthorityTests
swift test --package-path native/macos --filter RecursBrokerServiceTests
swift build --package-path native/macos -c release -Xswiftc -warnings-as-errors
```

```bash
git add native/macos/Sources/RecursBrokerCore/BrokerCredentialState.swift \
  native/macos/Sources/RecursBrokerService \
  native/macos/Tests/RecursBrokerServiceTests
git commit -m "feat: fence native provider route authority"
```

---

## Task 6: Independent review, documentation, and clean matrix

- [ ] **Step 1: Update truthful product/security documentation**

Document the shared versioned profile identity, required authenticated journal
binding, binding-aware private stage metadata, and dormant route feasibility.
State equally clearly that there is still no TTY capture, provider verification,
live resolver, credential reservation from a route receipt, HTTP/TLS/proxy,
codec, model catalog, CLI onboarding, signed artifact evidence, or enabled
broker-owned provider. Explain the journal v1 development reset and why there
is no migration of unreleased credential state.

- [ ] **Step 2: Run independent security and quality reviews**

Review from `3839a8e` through `HEAD` against this plan and the Provider
Activation v1 design. Security review must trace binding source-to-journal,
CAS-before-store order, replay/reconnect mismatch, XPC bounds/redaction, no
Node/descriptor-3 expansion, capability opacity, reentrant rechecks, and
resolver-before-authority proof. Quality review must reject duplicate schemas,
unnecessary abstractions, generated-policy overreach, and inflated claims.
Fix every actionable finding and repeat until both pass.

- [ ] **Step 3: Run the clean verification matrix**

```bash
rm -rf native/macos/.build
npm test
npm run typecheck
npm run lint
npm run build
npm run check:native
swift test --package-path native/macos
swift build --package-path native/macos -c release \
  -Xswiftc -warnings-as-errors
npm run native:lint-resources
npm run native:engine-bundle-smoke
npm run native:engine-bridge-smoke
npm run native:doctor-smoke
npm run native:smoke
```

- [ ] **Step 4: Run boundary/secret/drift scans and commit review fixes**

Assert generated outputs are current; every broker-owned manifest remains
non-runnable; TypeScript and `RecursNativeProtocol` gained no custom URL,
generation, credential reference, authority token, route receipt, auth header,
or secret field; provider binding occurs only in native private XPC/broker code
and declarative manifest metadata; and branch additions contain no secrets.
Inspect status, diff, staged diff, and commit history before committing only
intended review fixes.

## Completion boundary

This plan is complete only when profile identity cannot drift across languages,
every v2 credential journal record authenticates one immutable binding, staging
persists that binding before Keychain storage, reconnect/replay cannot substitute
it, private XPC accepts only a bounded valid descriptor, and opaque native route
capabilities recheck exact bound state after endpoint feasibility. All tests and
reviews must pass while Node remains credential/authority/URL-free and every
broker-owned provider remains disabled.

The next plan may add native TTY capture and fuse a successful route receipt to
candidate/ready credential reservation. It must still stop before provider HTTP
unless the transport, proxy, actual-peer, redirect, sanitization, and delivery-
uncertainty contract has been separately frozen.
