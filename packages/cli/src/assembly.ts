import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentRuntime,
  BackendResolver,
  IntegrationFailure,
  RuntimeApprovalRequest,
  RuntimeContinuationStore,
  SessionBackendPin,
} from "@recurs/contracts";
import {
  FileConnectionRegistry,
  OnboardingCatalog,
  type ConnectionRecord,
  type DelegatedConnectionRecord,
  type LocalConnectionRecord,
} from "@recurs/app";
import {
  AgentLoopDirectExecutor,
  BackendRunCoordinator,
  DelegatedAgentExecutor,
  JsonlSessionStore,
  ProcessScopedRuntimeContinuationStore,
  bindRunAuthorization,
  createWorkspaceShell,
  isPinnedSessionState,
  type EventSink,
  type PinnedSessionState,
  type WorkspaceShellState,
} from "@recurs/core";
import {
  LocalOpenAICompatibleProvider,
  type ModelProvider,
} from "@recurs/providers";
import { CODEX_ACP_PROFILE_REVISION } from "@recurs/runtimes";
import {
  FileCheckpointStore,
  ToolRegistry,
  createApplyPatchTool,
  createGitDiffTool,
  createGitStatusTool,
  createListFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchTextTool,
  type ToolSecurityProfile,
} from "@recurs/tools";

import { createCommandRegistry } from "./commands/create.js";
import type { LocalConnectionConfiguration } from "./local-connection.js";
import { createCodexAgentRuntime } from "./codex-connection.js";
import { RecursRuntime } from "./runtime.js";

export interface StandaloneRuntimeOptions {
  cwd?: string;
  dataDirectory?: string;
  provider?: ModelProvider;
  model?: string;
  toolSecurityProfile?: ToolSecurityProfile;
  delegatedRuntimeFactory?: (
    connection: DelegatedConnectionRecord,
    store: RuntimeContinuationStore,
  ) => AgentRuntime;
}

function injectedBackendPin(
  provider: ModelProvider,
  modelId: string,
  at: string,
): SessionBackendPin {
  return {
    kind: "model_provider",
    providerId: provider.id,
    adapterId: `injected:${provider.id}`,
    connectionId: `injected:${provider.id}`,
    modelId,
    modelIdentityKind: "versioned",
    providerResolvedModelRevisionAtCreation: modelId,
    catalogRevision: "injected-v1",
    policyRevisionAtCreation: "injected-test-only-v1",
    billingPolicyRevisionAtCreation: "injected-test-only-v1",
    primaryBillingSourceAtCreation: "local_compute",
    billingSelectionAtCreation: {
      mode: "strict_primary_only",
      policyRevision: "injected-test-only-v1",
      disclosureRevision: "injected-test-only-v1",
      allowedSources: ["local_compute"],
      acknowledgedAt: at,
    },
    accountSubjectFingerprint: `injected:${provider.id}`,
  };
}

function localBackendPin(
  connection: LocalConnectionConfiguration,
  at: string,
): SessionBackendPin {
  return {
    kind: "model_provider",
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    connectionId: connection.id,
    modelId: connection.modelId,
    modelIdentityKind: "mutable_alias",
    providerResolvedModelRevisionAtCreation: null,
    catalogRevision: null,
    policyRevisionAtCreation: "local-loopback-v1",
    billingPolicyRevisionAtCreation: "local-compute-v1",
    primaryBillingSourceAtCreation: "local_compute",
    billingSelectionAtCreation: {
      mode: "strict_primary_only",
      policyRevision: "local-compute-v1",
      disclosureRevision: "local-model-v1",
      allowedSources: ["local_compute"],
      acknowledgedAt: at,
    },
    accountSubjectFingerprint: connection.id,
  };
}

interface DirectRuntimeBackend {
  readonly kind: "direct";
  pin(at: string): SessionBackendPin;
  commandProvider: ModelProvider;
  createProvider(): ModelProvider;
}

interface DelegatedRuntimeBackend {
  readonly kind: "delegated";
  readonly connection: DelegatedConnectionRecord;
  pin(at: string): SessionBackendPin & { readonly kind: "agent_runtime" };
  createRuntime(store: RuntimeContinuationStore): AgentRuntime;
}

type RuntimeBackend = DirectRuntimeBackend | DelegatedRuntimeBackend;

interface StandaloneBackendResolver extends BackendResolver {
  readonly runtimeContinuationStore: RuntimeContinuationStore;
}

function exactRuntimeOption(
  request: RuntimeApprovalRequest,
  kind: "allow_once" | "reject_once",
) {
  const options = request.options.filter((option) => option.kind === kind);
  return options.length === 1 ? options[0]! : null;
}

function runtimeApprovalPrompt(request: RuntimeApprovalRequest): string {
  return `Allow delegated runtime request? ${JSON.stringify({
    action: request.action,
    resource: request.resource,
    risk: request.risk,
    summary: request.summary,
  })}`;
}

function localConfiguration(
  connection: LocalConnectionRecord,
): LocalConnectionConfiguration {
  return {
    schemaVersion: 1,
    kind: "local_openai_compatible",
    id: connection.id,
    label: connection.label,
    baseUrl: connection.baseUrl,
    modelId: connection.modelId,
    primary: false,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function selectedConnection(
  document: Awaited<ReturnType<FileConnectionRegistry["read"]>>,
): ConnectionRecord | null {
  if (document.primaryConnectionId !== null) {
    return document.connections.find(
      (connection) => connection.id === document.primaryConnectionId,
    ) ?? null;
  }
  return document.connections[0] ?? null;
}

function delegatedBackendPin(
  connection: DelegatedConnectionRecord,
): SessionBackendPin & { readonly kind: "agent_runtime" } {
  return {
    kind: "agent_runtime",
    providerId: connection.providerId,
    adapterId: connection.adapterId,
    connectionId: connection.id,
    modelId: connection.modelId,
    modelIdentityKind: "mutable_alias",
    providerResolvedModelRevisionAtCreation: null,
    catalogRevision: connection.policyRevision,
    policyRevisionAtCreation: connection.policyRevision,
    billingPolicyRevisionAtCreation: connection.billingPolicy.revision,
    primaryBillingSourceAtCreation: connection.billingPolicy.primarySource,
    billingSelectionAtCreation: structuredClone(connection.billingSelection),
    accountSubjectFingerprint: connection.accountSubjectFingerprint,
    runtimeCapabilityProfileRevisionAtCreation: CODEX_ACP_PROFILE_REVISION,
  };
}

function policyBlocked(
  diagnosticId: string,
  message: string,
  code: "policy_blocked" | "policy_stale" | "billing_policy_blocked" =
    "policy_blocked",
): IntegrationFailure {
  return {
    domain: "policy",
    phase: "preflight",
    code,
    safeMessage: message,
    diagnosticId,
    retryable: false,
  };
}

function assertCodexPolicy(
  connection: DelegatedConnectionRecord,
  diagnosticId: string,
): void {
  const entry = new OnboardingCatalog().list({ includeBlocked: true }).find(
    (candidate) => candidate.id === connection.providerId,
  );
  if (entry === undefined || entry.status !== "runnable") {
    throw policyBlocked(
      diagnosticId,
      "The reviewed Codex usage policy is unavailable",
      "policy_stale",
    );
  }
  if (
    connection.providerId !== "openai-codex-chatgpt" ||
    connection.adapterId !== "codex-acp" ||
    connection.policyRevision !== entry.policy.revision
  ) {
    throw policyBlocked(
      diagnosticId,
      "The Codex connection no longer matches the reviewed policy",
      "policy_stale",
    );
  }
  if (
    !isDeepStrictEqual(connection.billingPolicy, entry.billing) ||
    connection.billingSelection.mode !== "allow_declared_additional" ||
    connection.billingSelection.policyRevision !== entry.billing.revision ||
    connection.billingSelection.disclosureRevision !==
      entry.billing.disclosureRevision ||
    !isDeepStrictEqual(connection.billingSelection.allowedSources, [
      entry.billing.primarySource,
      ...entry.billing.possibleAdditionalSources,
    ])
  ) {
    throw policyBlocked(
      diagnosticId,
      "The Codex billing acknowledgement no longer matches provider behavior",
      "billing_policy_blocked",
    );
  }
}

export async function createStandaloneRuntime(
  events: EventSink,
  options: StandaloneRuntimeOptions = {},
): Promise<RecursRuntime> {
  const cwd = await realpath(options.cwd ?? process.cwd());
  const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  const root =
    options.dataDirectory ??
    process.env.RECURS_HOME ??
    path.join(homedir(), ".recurs");
  const projectData = path.join(root, "projects", projectId);
  const sessions = new JsonlSessionStore(path.join(projectData, "sessions"));
  const checkpoints = new FileCheckpointStore(
    path.join(projectData, "checkpoints"),
  );
  const injected = options.provider;
  const connectionRegistry = new FileConnectionRegistry(root);
  const registryDocument = injected === undefined
    ? await connectionRegistry.migrateLegacyLocal()
    : null;
  const configuredConnection = registryDocument === null
    ? null
    : selectedConnection(registryDocument);
  const backend: RuntimeBackend | undefined = injected !== undefined
    ? {
        kind: "direct",
        pin: (at) => injectedBackendPin(
          injected,
          options.model ?? injected.id,
          at,
        ),
        commandProvider: injected,
        createProvider: () => injected,
      }
    : configuredConnection === null
      ? undefined
      : configuredConnection.kind === "local_openai_compatible"
        ? (() => {
            const localConnection = localConfiguration(configuredConnection);
            return {
              kind: "direct" as const,
              pin: (at: string) => localBackendPin(localConnection, at),
              commandProvider: new LocalOpenAICompatibleProvider({
                baseUrl: localConnection.baseUrl,
              }),
              createProvider: () => new LocalOpenAICompatibleProvider({
                baseUrl: localConnection.baseUrl,
              }),
            };
          })()
        : (() => {
            assertCodexPolicy(configuredConnection, randomUUID());
            const factory = options.delegatedRuntimeFactory ??
              createCodexAgentRuntime;
            return {
              kind: "delegated" as const,
              connection: configuredConnection,
              pin: () => delegatedBackendPin(configuredConnection),
              createRuntime: (store: RuntimeContinuationStore) =>
                factory(configuredConnection, store),
            };
          })();
  const existing = await sessions.list();
  let state: PinnedSessionState | WorkspaceShellState;
  if (backend === undefined) {
    state = createWorkspaceShell(cwd);
  } else {
    const pin = backend.pin(new Date().toISOString());
    let matching: PinnedSessionState | null = null;
    for (const entry of existing) {
      const candidate = await sessions.loadState(entry.id);
      if (
        isPinnedSessionState(candidate) &&
        candidate.backend.pin.connectionId === pin.connectionId &&
        candidate.backend.pin.adapterId === pin.adapterId &&
        candidate.backend.pin.modelId === pin.modelId
      ) {
        matching = candidate;
        break;
      }
    }
    let pinnedState: PinnedSessionState;
    if (matching === null) {
      const createdAt = new Date().toISOString();
      pinnedState = await sessions.createPinnedSession({
        id: randomUUID(),
        cwd,
        backend: backend.pin(createdAt),
        at: createdAt,
      });
    } else {
      await sessions.recoverInterruptedOperations(
        matching.id,
        new Date().toISOString(),
      );
      const loaded = await sessions.loadState(matching.id);
      if (!isPinnedSessionState(loaded)) {
        throw new TypeError("Configured sessions require pinned version 2 state");
      }
      pinnedState = loaded;
    }
    if (backend.kind === "delegated") {
      if (pinnedState.executionMode !== "plan") {
        await sessions.withSessionMutation(
          pinnedState.id,
          pinnedState.lastSequence,
          async (mutation) => {
            await mutation.append({
              type: "mode_updated",
              source: "command",
              at: new Date().toISOString(),
              executionMode: "plan",
              permissionMode: pinnedState.permissionMode,
              prePlanPermissionMode: pinnedState.permissionMode,
            });
          },
        );
        const loaded = await sessions.loadState(pinnedState.id);
        if (!isPinnedSessionState(loaded)) {
          throw new TypeError("Delegated sessions require pinned version 2 state");
        }
        pinnedState = loaded;
      }
    }
    state = pinnedState;
  }

  const tools = new ToolRegistry([], {
    checkpoints,
    securityProfile: options.toolSecurityProfile ?? "local_guarded",
  });
  tools.register(createReadFileTool());
  tools.register(createListFilesTool());
  tools.register(createSearchTextTool());
  tools.register(createApplyPatchTool());
  tools.register(createRunCommandTool());
  tools.register(createGitStatusTool());
  tools.register(createGitDiffTool());

  const runtimeReference: { current?: RecursRuntime } = {};
  const approvals = {
    async request(intent: {
      readonly category: string;
      readonly resource: string;
    }) {
      const allowed =
        (await runtimeReference.current?.confirm(
          `Allow ${intent.category} access to ${intent.resource}?`,
        )) ?? false;
      return allowed ? "allow_once" as const : "deny" as const;
    },
  };
  const continuations = new ProcessScopedRuntimeContinuationStore();
  const delegated = new DelegatedAgentExecutor({
    continuationAuthority: continuations.authority,
    tools,
    approvals,
    runtimeApprovals: {
      async request(request) {
        const reject = exactRuntimeOption(request, "reject_once");
        if (request.action === "credential") {
          return reject === null
            ? { decision: { outcome: "cancelled" as const }, scope: "cancel" as const }
            : {
                decision: {
                  outcome: "selected" as const,
                  optionId: reject.optionId,
                },
                scope: "deny" as const,
              };
        }
        const allowed =
          (await runtimeReference.current?.confirm(
            runtimeApprovalPrompt(request),
          )) ?? false;
        const selected = allowed
          ? exactRuntimeOption(request, "allow_once")
          : reject;
        if (selected === null) {
          return {
            decision: { outcome: "cancelled" as const },
            scope: "cancel" as const,
          };
        }
        return {
          decision: {
            outcome: "selected" as const,
            optionId: selected.optionId,
          },
          scope: allowed ? "allow_once" as const : "deny" as const,
        };
      },
    },
    emit(event) {
      return events.emit(event);
    },
    createToolContext(session, signal) {
      return {
        sessionId: session.id,
        cwd: session.cwd,
        signal,
        executionMode: session.executionMode,
        readRevisions: new Map(),
      };
    },
  });
  const direct = backend === undefined ? undefined : new AgentLoopDirectExecutor({
    tools,
    approvals,
    sessions,
    emit(event) {
      return events.emit(event);
    },
    createToolContext(session, signal) {
      return {
        sessionId: session.id,
        cwd: session.cwd,
        signal,
        executionMode: session.executionMode,
        readRevisions: new Map(),
      };
    },
  });
  const resolver: StandaloneBackendResolver | undefined = backend === undefined
    ? undefined
    : {
        runtimeContinuationStore: continuations.runtimeStore,
        async resolve(input) {
          const expectedPin = backend.pin(
            input.pin.billingSelectionAtCreation.acknowledgedAt,
          );
          if (!isDeepStrictEqual(input.pin, expectedPin)) {
            throw new Error("The configured provider does not match the session pin");
          }
          if (backend.kind === "delegated") {
            if (
              input.context.presence !== "present" ||
              input.context.location !== "local" ||
              input.context.automation !== "manual" ||
              input.context.embedding !== "cli"
            ) {
              throw policyBlocked(
                input.operationId,
                "This Codex subscription connection is limited to local, user-present, manual CLI use",
              );
            }
            const current = await connectionRegistry.read();
            const currentRecord = current.connections.find(
              (connection): connection is DelegatedConnectionRecord =>
                connection.kind === "delegated_agent" &&
                connection.id === backend.connection.id,
            );
            if (
              currentRecord === undefined ||
              !isDeepStrictEqual(currentRecord, backend.connection)
            ) {
              throw policyBlocked(
                input.operationId,
                "The Codex connection changed after this session was pinned",
                "policy_stale",
              );
            }
            assertCodexPolicy(currentRecord, input.operationId);
            return {
              kind: "delegated" as const,
              pin: input.pin,
              authorization: bindRunAuthorization({
                id: randomUUID(),
                operation: input.operation,
                sessionId: input.sessionId,
                operationId: input.operationId,
                turnId: input.turnId,
                pin: input.pin,
                connectionRevision: current.revision,
                policyRevision: input.pin.policyRevisionAtCreation,
                context: input.context,
                maxRequests: 1,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              }),
              async createRuntime() {
                return backend.createRuntime(continuations.runtimeStore);
              },
            };
          }
          return {
            kind: "direct" as const,
            pin: input.pin,
            authorization: bindRunAuthorization({
              id: randomUUID(),
              operation: input.operation,
              sessionId: input.sessionId,
              operationId: input.operationId,
              turnId: input.turnId,
              pin: input.pin,
              connectionRevision: 1,
              policyRevision: input.pin.policyRevisionAtCreation,
              context: input.context,
              maxRequests: 40,
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }),
            async createProvider() {
              return backend.createProvider();
            },
          };
        },
      };
  const coordinator = direct === undefined || resolver === undefined
    ? undefined
    : new BackendRunCoordinator({
        sessions,
        resolver,
        direct,
        delegated,
        continuationAuthority: continuations.authority,
      });
  const commands = createCommandRegistry({
    sessions,
    ...(backend?.kind === "direct"
      ? { provider: backend.commandProvider }
      : {}),
    checkpoints,
    signal: () =>
      runtimeReference.current?.currentSignal() ?? new AbortController().signal,
  });
  const runtime = new RecursRuntime(
    {
      commands,
      ...(coordinator === undefined ? {} : { coordinator }),
      sessions,
      confirm: async () => false,
      ...(backend === undefined
        ? {
            promptUnavailableMessage:
              "No model connection is ready. Run recurs setup in an interactive terminal, then try again.",
          }
        : {}),
    },
    state,
  );
  runtimeReference.current = runtime;
  return runtime;
}
