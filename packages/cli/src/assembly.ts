import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentRuntime,
  BackendResolver,
  ConnectionBoundModelProvider,
  IntegrationFailure,
  OperatingModeId,
  RuntimeApprovalRequest,
  RuntimeContinuationStore,
  SessionBackendPin,
  NativeOpenAIResponsesPort,
  CompanyBlueprintV1,
} from "@recurs/contracts";
import { parseCompanyBlueprint } from "@recurs/contracts";
import {
  FileConnectionRegistry,
  OnboardingCatalog,
  OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION,
  isCompatibleOpenAIResponsesModelId,
  type BrokeredModelProviderConnectionRecord,
  type ConnectionRecord,
  type DelegatedConnectionRecord,
  type EnvironmentModelProviderConnectionRecord,
  type LocalConnectionRecord,
} from "@recurs/app";
import {
  AgentBackendRouter,
  AgentLoopDirectExecutor,
  AgentReviewPanel,
  BackendRunCoordinator,
  ChildAgentBatchManager,
  ChildAgentManager,
  CompanyOnboardingCoordinator,
  CompanyAgentManager,
  DelegatedAgentExecutor,
  FileGitPatchArtifactStore,
  FileCompanyBlueprintStore,
  FileCompanyBlueprintV2Store,
  FileCompanyOnboardingStore,
  JsonlSessionStore,
  JsonlTeamRunStore,
  SessionStoreError,
  GitWorktreeLeaseManager,
  GitPatchArtifactManager,
  ProcessScopedRuntimeContinuationStore,
  TeamAgentManager,
  TeamRunOwnerLeaseManager,
  TeamRunRecoveryCoordinator,
  TeamRunSupervisor,
  bindRunAuthorization,
  activeGoal,
  companyContextInstructions,
  createRootAgentDescriptor,
  createWorkspaceShell,
  createTeamRunTools,
  isPinnedSessionState,
  recoverDurableTeamChild,
  type AgentBackendCandidate,
  type EventSink,
  type PinnedSessionState,
  type SessionState,
  type WorkspaceShellState,
} from "@recurs/core";
import {
  BUNDLED_PROVIDER_MANIFESTS,
  createEnvironmentProviderConfiguration,
  environmentByokAdapterId,
  environmentCredentialFingerprint,
  LocalOpenAICompatibleProvider,
  NativeOpenAIResponsesProvider,
  resolveEnvironmentProvider,
  type EnvironmentProviderConfiguration,
  type ModelProvider,
} from "@recurs/providers";
import { CODEX_ACP_PROFILE_REVISION } from "@recurs/runtimes";
import {
  FileCheckpointStore,
  OwnedProcessManager,
  ToolError,
  ToolRegistry,
  createApplyPatchTool,
  createCodeOutlineTool,
  createGitDiffTool,
  createGitHistoryTool,
  createGitShowTool,
  createGitStatusTool,
  createListFilesTool,
  createProcessSessionTool,
  createReadFileTool,
  createRunCommandTool,
  createRunVerificationTool,
  createSearchTextTool,
  createTypeScriptDiagnosticsTool,
  createWebFetchTool,
  type PermissionMode,
  type ExecutionMode,
  type PtyDriver,
  type ToolSecurityProfile,
} from "@recurs/tools";

import { createCommandRegistry } from "./commands/create.js";
import { createRequestUserInputTool } from "./user-input-tool.js";
import type {
  ModelSelectionOption,
  ModelSessionService,
} from "./commands/types.js";
import { AgentSkillCatalog } from "./agent-skills.js";
import { McpServerCatalog } from "./mcp-client.js";
import { projectContextInstructions } from "./project-instructions.js";
import type { LocalConnectionConfiguration } from "./local-connection.js";
import { createCodexAgentRuntime } from "./codex-connection.js";
import {
  CompanyOnboardingAgentRuntime,
  companyOnboardingBackendFingerprint,
} from "./company-onboarding-runtime.js";
import { CompanyProposalEditor } from "./company-proposal-editor.js";
import { RecursRuntime, RuntimeError } from "./runtime.js";
import {
  providerDiscoveryOverview,
  providerOverviewText,
} from "./provider-discovery.js";

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
  nativeOpenAIResponses?: NativeOpenAIResponsesPort;
  environment?: Readonly<NodeJS.ProcessEnv>;
  environmentFetch?: typeof globalThis.fetch;
  reuseExistingSession?: boolean;
  resumeSessionId?: string;
  operatingModeId?: OperatingModeId;
  permissionMode?: PermissionMode;
  executionMode?: ExecutionMode;
  connectionId?: string;
  companyBlueprint?: CompanyBlueprintV1;
  skillHomeDirectory?: string;
  ptyDriver?: PtyDriver;
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
  const endpointFingerprint = createHash("sha256")
    .update(`recurs:local-origin:v1\0${connection.baseUrl}`)
    .digest("hex");
  return {
    kind: "model_provider",
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    connectionId: connection.id,
    modelId: connection.modelId,
    modelIdentityKind: "mutable_alias",
    providerResolvedModelRevisionAtCreation: null,
    catalogRevision: null,
    policyRevisionAtCreation: "local-loopback-v2",
    billingPolicyRevisionAtCreation: "local-compute-v1",
    primaryBillingSourceAtCreation: "local_compute",
    billingSelectionAtCreation: {
      mode: "strict_primary_only",
      policyRevision: "local-compute-v1",
      disclosureRevision: "local-model-v1",
      allowedSources: ["local_compute"],
      acknowledgedAt: at,
    },
    accountSubjectFingerprint: `sha256:${endpointFingerprint}`,
  };
}

function environmentBackendPin(
  connection: EnvironmentProviderConfiguration,
  at: string,
): SessionBackendPin {
  const manifest = BUNDLED_PROVIDER_MANIFESTS.find(
    (candidate) => candidate.id === connection.providerId,
  );
  if (
    manifest === undefined ||
    environmentByokAdapterId(manifest) !== connection.provider.adapterId ||
    manifest.supportStatus !== "supported" ||
    !manifest.billingPolicy.availableSelections.includes("strict_primary_only")
  ) {
    throw new TypeError("Environment provider policy is unavailable");
  }
  return {
    kind: "model_provider",
    providerId: connection.providerId,
    adapterId: connection.provider.adapterId,
    connectionId: connection.connectionId,
    modelId: connection.modelId,
    modelIdentityKind: "mutable_alias",
    providerResolvedModelRevisionAtCreation: null,
    catalogRevision: manifest.usagePolicy.revision,
    policyRevisionAtCreation: manifest.usagePolicy.revision,
    billingPolicyRevisionAtCreation: manifest.billingPolicy.revision,
    primaryBillingSourceAtCreation: manifest.billingPolicy.primarySource,
    billingSelectionAtCreation: {
      mode: "strict_primary_only",
      policyRevision: manifest.billingPolicy.revision,
      disclosureRevision: manifest.billingPolicy.disclosureRevision,
      allowedSources: [manifest.billingPolicy.primarySource],
      acknowledgedAt: at,
    },
    accountSubjectFingerprint: connection.credentialFingerprint,
  };
}

interface DirectRuntimeBackend {
  readonly kind: "direct";
  pin(at: string): SessionBackendPin;
  commandProvider: ModelProvider;
  createProvider(): ConnectionBoundModelProvider;
}

interface DelegatedRuntimeBackend {
  readonly kind: "delegated";
  readonly connection: DelegatedConnectionRecord;
  pin(at: string): SessionBackendPin & { readonly kind: "agent_runtime" };
  createRuntime(store: RuntimeContinuationStore): AgentRuntime;
}

type RuntimeBackend = DirectRuntimeBackend | DelegatedRuntimeBackend;
type DelegatedRuntimeFactory = NonNullable<
  StandaloneRuntimeOptions["delegatedRuntimeFactory"]
>;

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
  return null;
}

function modelSelectionOption(
  connection: ConnectionRecord,
  primaryConnectionId: string | null,
): ModelSelectionOption {
  return Object.freeze({
    connectionId: connection.id,
    label: connection.label,
    providerId: connection.providerId,
    modelId: connection.modelId,
    ...(connection.kind === "environment_model_provider" &&
        connection.reasoningEffort !== undefined
      ? { reasoningEffort: connection.reasoningEffort }
      : {}),
    primary: connection.id === primaryConnectionId,
    execution: connection.kind === "delegated_agent" &&
        connection.adapterId === "codex-acp"
      ? "Plan-only" as const
      : "Act + Plan" as const,
    billingSources: connection.kind === "local_openai_compatible"
      ? ["local_compute" as const]
      : Object.freeze([...connection.billingSelection.allowedSources]),
  });
}

function modelSelectionOptions(
  document: Awaited<ReturnType<FileConnectionRegistry["read"]>>,
): readonly ModelSelectionOption[] {
  return Object.freeze(document.connections
    .map((connection) =>
      modelSelectionOption(connection, document.primaryConnectionId)
    )
    .sort((left, right) =>
      Number(right.primary) - Number(left.primary) ||
      left.connectionId.localeCompare(right.connectionId)
    ));
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

function brokeredOpenAIBackendPin(
  connection: BrokeredModelProviderConnectionRecord,
): SessionBackendPin {
  return {
    kind: "model_provider",
    providerId: connection.providerId,
    adapterId: connection.adapterId,
    connectionId: connection.id,
    modelId: connection.modelId,
    modelIdentityKind: "versioned",
    providerResolvedModelRevisionAtCreation: connection.modelId,
    catalogRevision: OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION,
    policyRevisionAtCreation: connection.policyRevision,
    billingPolicyRevisionAtCreation: connection.billingPolicy.revision,
    primaryBillingSourceAtCreation: connection.billingPolicy.primarySource,
    billingSelectionAtCreation: structuredClone(connection.billingSelection),
    accountSubjectFingerprint: connection.credentialIdentityFingerprint,
  };
}

function savedEnvironmentBackendPin(
  connection: EnvironmentModelProviderConnectionRecord,
): SessionBackendPin {
  return {
    kind: "model_provider",
    providerId: connection.providerId,
    adapterId: connection.adapterId,
    connectionId: connection.id,
    modelId: connection.modelId,
    ...(connection.reasoningEffort === undefined
      ? {}
      : { reasoningEffortAtCreation: connection.reasoningEffort }),
    ...(connection.modelLimits === undefined
      ? {}
      : { modelLimitsAtCreation: structuredClone(connection.modelLimits) }),
    modelIdentityKind: "mutable_alias",
    providerResolvedModelRevisionAtCreation: null,
    catalogRevision: connection.policyRevision,
    policyRevisionAtCreation: connection.policyRevision,
    billingPolicyRevisionAtCreation: connection.billingPolicy.revision,
    primaryBillingSourceAtCreation: connection.billingPolicy.primarySource,
    billingSelectionAtCreation: structuredClone(connection.billingSelection),
    accountSubjectFingerprint: connection.credentialIdentityFingerprint,
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

function connectionInvalid(diagnosticId: string): IntegrationFailure {
  return {
    domain: "connection",
    phase: "preflight",
    code: "connection_invalid",
    safeMessage: "The session connection is missing or no longer matches its pin",
    diagnosticId,
    retryable: false,
    action: "select_connection",
  };
}

function unavailableConnectionMessage(connection: ConnectionRecord): string {
  return connection.kind === "environment_model_provider"
    ? `The selected BYOK connection requires ${connection.credentialEnvironmentVariable} with the credential used during setup.`
    : connection.kind === "brokered_model_provider"
    ? "The selected brokered provider is connected, but brokered provider execution is not available yet."
    : "The selected provider connection is not available.";
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

function assertBrokeredProviderPolicy(
  connection: BrokeredModelProviderConnectionRecord,
  diagnosticId: string,
): void {
  const entry = new OnboardingCatalog().list({ includeBlocked: true }).find(
    (candidate) => candidate.id === connection.providerId,
  );
  if (
    entry === undefined ||
    (entry.status !== "requires_native_broker" &&
      entry.status !== "runnable_byok") ||
    !(
      (connection.providerId === "openai-api" &&
        connection.adapterId === "openai-responses" &&
        connection.activationProfileId === "openai_api_v1" &&
        isCompatibleOpenAIResponsesModelId(connection.modelId)) ||
      (connection.providerId === "anthropic-api" &&
        connection.adapterId === "anthropic-messages" &&
        connection.activationProfileId === "anthropic_api_v1") ||
      (connection.providerId === "kimi-code" &&
        connection.adapterId === "openai-chat-completions" &&
        connection.activationProfileId === "kimi_code_v1")
    ) ||
    connection.policyRevision !== entry.policy.revision ||
    connection.modelId.length === 0
  ) {
    throw policyBlocked(
      diagnosticId,
      "The provider connection no longer matches the reviewed capability policy",
      "policy_stale",
    );
  }
  if (
    !isDeepStrictEqual(connection.billingPolicy, entry.billing) ||
    connection.billingSelection.mode !== "strict_primary_only" ||
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
      "The API billing acknowledgement no longer matches provider behavior",
      "billing_policy_blocked",
    );
  }
}

function assertEnvironmentProviderPolicy(
  connection: EnvironmentModelProviderConnectionRecord,
  diagnosticId: string,
): void {
  const entry = new OnboardingCatalog().list({ includeBlocked: true }).find(
    (candidate) => candidate.id === connection.providerId,
  );
  const manifest = BUNDLED_PROVIDER_MANIFESTS.find(
    (candidate) => candidate.id === connection.providerId,
  );
  if (
    entry === undefined ||
    manifest === undefined ||
    entry.status !== "runnable_byok" ||
    entry.connectionOwner !== "process_environment" ||
    environmentByokAdapterId(manifest) !== connection.adapterId ||
    connection.policyRevision !== entry.policy.revision ||
    !isDeepStrictEqual(connection.billingPolicy, entry.billing) ||
    connection.billingSelection.policyRevision !== entry.billing.revision ||
    connection.billingSelection.disclosureRevision !==
      entry.billing.disclosureRevision ||
    !entry.billing.availableSelections.includes(
      connection.billingSelection.mode,
    )
  ) {
    throw policyBlocked(
      diagnosticId,
      "The BYOK connection no longer matches the reviewed provider policy",
      "policy_stale",
    );
  }
}

async function backendForConnection(
  connection: ConnectionRecord,
  delegatedRuntimeFactory: DelegatedRuntimeFactory,
  diagnosticId: string,
  nativeOpenAIResponses?: NativeOpenAIResponsesPort,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  environmentFetch?: typeof globalThis.fetch,
): Promise<RuntimeBackend | null> {
  if (connection.kind === "local_openai_compatible") {
    const localConnection = localConfiguration(connection);
    return {
      kind: "direct",
      pin: (at) => localBackendPin(localConnection, at),
      commandProvider: new LocalOpenAICompatibleProvider({
        baseUrl: localConnection.baseUrl,
        connectionId: localConnection.id,
      }),
      createProvider: () => new LocalOpenAICompatibleProvider({
        baseUrl: localConnection.baseUrl,
        connectionId: localConnection.id,
      }),
    };
  }
  if (connection.kind === "brokered_model_provider") {
    if (nativeOpenAIResponses === undefined) return null;
    assertBrokeredProviderPolicy(connection, diagnosticId);
    const provider = () => new NativeOpenAIResponsesProvider({
      connectionId: connection.id,
      modelId: connection.modelId,
      port: nativeOpenAIResponses,
      providerId: connection.providerId,
      adapterId: connection.adapterId,
    });
    return {
      kind: "direct",
      pin: () => brokeredOpenAIBackendPin(connection),
      commandProvider: provider(),
      createProvider: provider,
    };
  }
  if (connection.kind === "environment_model_provider") {
    assertEnvironmentProviderPolicy(connection, diagnosticId);
    const apiKey = environment[connection.credentialEnvironmentVariable];
    if (
      apiKey === undefined ||
      apiKey.length === 0 ||
      await environmentCredentialFingerprint(connection.providerId, apiKey) !==
        connection.credentialIdentityFingerprint
    ) {
      return null;
    }
    let bound: EnvironmentProviderConfiguration;
    try {
      bound = await createEnvironmentProviderConfiguration({
        providerId: connection.providerId,
        modelId: connection.modelId,
        connectionId: connection.id,
        apiKey,
        ...(environmentFetch === undefined ? {} : { fetch: environmentFetch }),
      });
    } catch {
      return null;
    }
    return {
      kind: "direct",
      pin: () => savedEnvironmentBackendPin(connection),
      commandProvider: bound.provider,
      createProvider: () => bound.provider,
    };
  }
  assertCodexPolicy(connection, diagnosticId);
  return {
    kind: "delegated",
    connection,
    pin: () => delegatedBackendPin(connection),
    createRuntime: (store) => delegatedRuntimeFactory(connection, store),
  };
}

async function companyOnboardingBackend(
  root: string,
  options: StandaloneRuntimeOptions,
): Promise<DirectRuntimeBackend> {
  const injected = options.provider;
  const runtimeEnvironment = options.environment ?? process.env;
  const environmentConnection = injected === undefined
    ? await resolveEnvironmentProvider(
        runtimeEnvironment,
        options.environmentFetch,
      )
    : null;
  const registry = new FileConnectionRegistry(root);
  const document = injected === undefined
    ? await registry.migrateLegacyLocal()
    : null;
  if (options.connectionId !== undefined &&
    (injected !== undefined || environmentConnection !== null)) {
    throw new RuntimeError(
      "invalid_input",
      "A saved connection cannot be selected while a process-scoped provider is active",
    );
  }
  const connection = document === null
    ? null
    : options.connectionId === undefined
      ? selectedConnection(document)
      : document.connections.find((item) => item.id === options.connectionId) ?? null;
  if (options.connectionId !== undefined && connection === null) {
    throw new RuntimeError(
      "invalid_input",
      "The requested saved connection was not found",
    );
  }
  const backend: RuntimeBackend | undefined = injected !== undefined
    ? {
        kind: "direct",
        pin: (at) => injectedBackendPin(
          injected,
          options.model ?? injected.id,
          at,
        ),
        commandProvider: injected,
        createProvider: () => ({
          id: injected.id,
          adapterId: `injected:${injected.id}`,
          connectionId: `injected:${injected.id}`,
          stream: (request) => injected.stream(request),
        }),
      }
    : environmentConnection !== null
      ? {
          kind: "direct",
          pin: (at) => environmentBackendPin(environmentConnection, at),
          commandProvider: environmentConnection.provider,
          createProvider: () => environmentConnection.provider,
        }
      : connection === null
        ? undefined
        : await backendForConnection(
            connection,
            options.delegatedRuntimeFactory ?? createCodexAgentRuntime,
            randomUUID(),
            options.nativeOpenAIResponses,
            runtimeEnvironment,
            options.environmentFetch,
          ) ?? undefined;
  if (backend === undefined) {
    throw new RuntimeError(
      "provider_not_configured",
      "A ready parent-model connection is required for company formation",
    );
  }
  if (backend.kind !== "direct") {
    throw new RuntimeError(
      "provider_not_configured",
      "This delegated subscription runtime cannot yet provide Recurs's restricted pre-approval tool boundary; connect a supported direct or local model for company formation",
    );
  }
  return backend;
}

export async function createStandaloneCompanyOnboarding(
  input: {
    readonly permissionMode: PermissionMode;
    readonly operatingModeId: OperatingModeId;
  },
  options: StandaloneRuntimeOptions = {},
) {
  const cwd = await realpath(options.cwd ?? process.cwd());
  const root = options.dataDirectory ?? process.env.RECURS_HOME ??
    path.join(homedir(), ".recurs");
  const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  const projectData = path.join(root, "projects", projectId);
  const backend = await companyOnboardingBackend(root, options);
  const at = new Date().toISOString();
  const pin = backend.pin(at);
  const agentRuntime = new CompanyOnboardingAgentRuntime({
    backend: pin,
    sessions: new JsonlSessionStore(
      path.join(projectData, "company-onboarding-agent-sessions"),
    ),
    cwd,
    createProvider: () => backend.createProvider(),
  });
  const coordinator = new CompanyOnboardingCoordinator({
    runs: new FileCompanyOnboardingStore(
      path.join(projectData, "company-onboarding-runs"),
    ),
    blueprints: new FileCompanyBlueprintV2Store(
      path.join(projectData, "company-blueprints-v2"),
    ),
    model: agentRuntime,
    research: agentRuntime,
  });
  const proposalEditor = new CompanyProposalEditor({
    coordinator,
    model: agentRuntime,
    environment: options.environment ?? process.env,
  });
  return Object.freeze({
    coordinator,
    proposalEditor,
    projectRoot: cwd,
    backendFingerprint: companyOnboardingBackendFingerprint(pin),
    permissionMode: input.permissionMode,
    operatingModeId: input.operatingModeId,
  });
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
  const skills = await AgentSkillCatalog.discover({
    cwd,
    dataDirectory: root,
    homeDirectory: options.skillHomeDirectory ?? homedir(),
  });
  const mcp = await McpServerCatalog.load({
    dataDirectory: root,
    workspace: cwd,
    projectDataDirectory: projectData,
  });
  const sessions = new JsonlSessionStore(path.join(projectData, "sessions"));
  const companyBlueprints = new FileCompanyBlueprintStore(
    path.join(projectData, "company-blueprints"),
  );
  const requestedCompany = options.companyBlueprint === undefined
    ? null
    : parseCompanyBlueprint(structuredClone(options.companyBlueprint));
  if (requestedCompany !== null && requestedCompany.state !== "approved") {
    throw new RuntimeError(
      "invalid_input",
      "Only an explicitly approved company blueprint can be activated",
    );
  }
  if (requestedCompany !== null && options.resumeSessionId !== undefined) {
    throw new RuntimeError(
      "invalid_input",
      "A company blueprint starts a fresh bound parent session and cannot be attached while resuming",
    );
  }
  const checkpoints = new FileCheckpointStore(
    path.join(projectData, "checkpoints"),
  );
  const worktrees = new GitWorktreeLeaseManager({
    rootDirectory: path.join(projectData, "agent-worktrees"),
  });
  const patches = new GitPatchArtifactManager({
    leases: worktrees,
    store: new FileGitPatchArtifactStore(
      path.join(projectData, "team-patch-artifacts"),
    ),
  });
  const teamRuns = new JsonlTeamRunStore(path.join(projectData, "team-runs"));
  const teamOwners = new TeamRunOwnerLeaseManager({ rootDirectory: projectData });
  const teamRecovery = new TeamRunRecoveryCoordinator({
    runs: teamRuns,
    owners: teamOwners,
    worktrees,
    patches,
    checkpoints,
    recoverChild(input) {
      return recoverDurableTeamChild(sessions, input);
    },
    emit(event) {
      return events.emit(event);
    },
  });
  const recovery = await teamRecovery.recover().catch(() => {
    throw new ToolError(
      "execution_failed",
      "Durable team recovery failed before startup",
    );
  });
  const firstRecoveryFailure = recovery.failures[0];
  if (firstRecoveryFailure !== undefined) {
    throw new ToolError(
      "execution_failed",
      `Durable team recovery failed for ${firstRecoveryFailure.runId}: ${firstRecoveryFailure.message}`,
    );
  }
  const injected = options.provider;
  const runtimeEnvironment = options.environment ?? process.env;
  const environmentConnection = injected === undefined
    ? await resolveEnvironmentProvider(
        runtimeEnvironment,
        options.environmentFetch,
      )
    : null;
  if (
    options.resumeSessionId !== undefined &&
    options.connectionId !== undefined
  ) {
    throw new RuntimeError(
      "invalid_input",
      "An exact resumed session keeps its existing connection, permission, and operating-mode policy",
    );
  }
  const connectionRegistry = new FileConnectionRegistry(root);
  const registryDocument = injected === undefined
    ? await connectionRegistry.migrateLegacyLocal()
    : null;
  if (
    options.connectionId !== undefined &&
    (injected !== undefined || environmentConnection !== null)
  ) {
    throw new RuntimeError(
      "invalid_input",
      "A saved connection cannot be selected while a process-scoped provider is active",
    );
  }
  const configuredConnection = registryDocument === null
    ? null
    : options.connectionId === undefined
    ? selectedConnection(registryDocument)
    : registryDocument.connections.find(
      (connection) => connection.id === options.connectionId,
    ) ?? null;
  if (options.connectionId !== undefined && configuredConnection === null) {
    throw new RuntimeError(
      "invalid_input",
      "The requested saved connection was not found",
    );
  }
  const delegatedRuntimeFactory = options.delegatedRuntimeFactory ??
    createCodexAgentRuntime;
  let initialBackend: RuntimeBackend | undefined = injected !== undefined
    ? {
        kind: "direct",
        pin: (at) => injectedBackendPin(
          injected,
          options.model ?? injected.id,
          at,
        ),
        commandProvider: injected,
        createProvider: () => ({
          id: injected.id,
          adapterId: `injected:${injected.id}`,
          connectionId: `injected:${injected.id}`,
          stream: (request) => injected.stream(request),
        }),
      }
    : environmentConnection !== null
      ? {
          kind: "direct",
          pin: (at) => environmentBackendPin(environmentConnection, at),
          commandProvider: environmentConnection.provider,
          createProvider: () => environmentConnection.provider,
        }
    : configuredConnection === null
      ? undefined
      : await backendForConnection(
          configuredConnection,
          delegatedRuntimeFactory,
          randomUUID(),
          options.nativeOpenAIResponses,
          runtimeEnvironment,
          options.environmentFetch,
        ) ?? undefined;
  const existing = options.resumeSessionId === undefined
    ? await sessions.list()
    : [];
  let requestedSession: PinnedSessionState | null = null;
  if (options.resumeSessionId !== undefined) {
    if (
      options.permissionMode !== undefined ||
      options.operatingModeId !== undefined ||
      options.connectionId !== undefined ||
      options.companyBlueprint !== undefined
    ) {
      throw new RuntimeError(
        "invalid_input",
        "An exact resumed session keeps its existing connection, permission, and operating-mode policy",
      );
    }
    let candidate: SessionState;
    try {
      candidate = await sessions.loadState(options.resumeSessionId);
    } catch (error) {
      if (
        error instanceof SessionStoreError &&
        (error.code === "session_not_found" ||
          error.code === "invalid_session_id")
      ) {
        throw new RuntimeError(
          "invalid_input",
          error.code === "session_not_found"
            ? `Session not found: ${options.resumeSessionId}`
            : "The requested session id is invalid",
        );
      }
      throw error;
    }
    if (!isPinnedSessionState(candidate) || candidate.agent.role !== "parent") {
      throw new RuntimeError(
        "invalid_input",
        "Only a durable parent session can be resumed from one-shot mode",
      );
    }
    if (candidate.cwd !== cwd) {
      throw new RuntimeError(
        "invalid_input",
        "The requested session belongs to a different workspace",
      );
    }

    let requestedBackend: RuntimeBackend | null = null;
    if (injected !== undefined || environmentConnection !== null) {
      if (
        initialBackend !== undefined &&
        isDeepStrictEqual(
          candidate.backend.pin,
          initialBackend.pin(
            candidate.backend.pin.billingSelectionAtCreation.acknowledgedAt,
          ),
        )
      ) {
        requestedBackend = initialBackend;
      }
    } else {
      const connection = registryDocument?.connections.find(
        (entry) => entry.id === candidate.backend.pin.connectionId,
      );
      if (connection !== undefined) {
        try {
          const resolved = await backendForConnection(
            connection,
            delegatedRuntimeFactory,
            randomUUID(),
            options.nativeOpenAIResponses,
            runtimeEnvironment,
            options.environmentFetch,
          );
          if (
            resolved !== null &&
            isDeepStrictEqual(
              candidate.backend.pin,
              resolved.pin(
                candidate.backend.pin.billingSelectionAtCreation.acknowledgedAt,
              ),
            )
          ) {
            requestedBackend = resolved;
          }
        } catch {
          // Resume uses the same fail-closed connection checks as a new run.
        }
      }
    }
    if (requestedBackend === null) {
      throw new RuntimeError(
        "provider_not_configured",
        "The requested session's pinned provider connection is unavailable or has changed",
      );
    }
    initialBackend = requestedBackend;
    requestedSession = candidate;
  }
  let state: PinnedSessionState | WorkspaceShellState;
  if (initialBackend === undefined) {
    if (requestedCompany !== null) {
      throw new RuntimeError(
        "provider_not_configured",
        "An approved company blueprint requires a ready parent-model connection",
      );
    }
    state = createWorkspaceShell(cwd, options.permissionMode);
  } else {
    let matching: PinnedSessionState | null = requestedSession;
    if (
      requestedCompany === null &&
      matching === null &&
      options.reuseExistingSession !== false
    ) {
      for (const entry of existing) {
        const candidate = await sessions.loadState(entry.id);
        if (
          isPinnedSessionState(candidate) &&
          candidate.agent.role === "parent" &&
          candidate.cwd === cwd &&
          isDeepStrictEqual(
            candidate.backend.pin,
            initialBackend.pin(
              candidate.backend.pin.billingSelectionAtCreation.acknowledgedAt,
            ),
          )
        ) {
          matching = candidate;
          break;
        }
      }
    }
    let pinnedState: PinnedSessionState;
    if (matching === null) {
      const createdAt = new Date().toISOString();
      const sessionId = randomUUID();
      const backend = initialBackend.pin(createdAt);
      const companyBinding = requestedCompany === null
        ? undefined
        : {
            blueprintId: requestedCompany.id,
            blueprintVersion: 1 as const,
            roleId: "orchestrator_v1" as const,
            roleVersion: 1 as const,
          };
      const rootAgent = createRootAgentDescriptor(
        sessionId,
        backend,
        options.operatingModeId,
        options.permissionMode,
        options.executionMode,
        companyBinding,
      );
      if (
        requestedCompany !== null &&
        (requestedCompany.authority.permissionMode !==
            rootAgent.permissions.permissionMode ||
          requestedCompany.authority.operatingModeId !==
            rootAgent.operatingMode.id ||
          requestedCompany.authority.operatingModeVersion !==
            rootAgent.operatingMode.version)
      ) {
        throw new RuntimeError(
          "invalid_input",
          "The approved company authority must match the new session authority",
        );
      }
      if (requestedCompany !== null) {
        await companyBlueprints.create(requestedCompany);
      }
      pinnedState = await sessions.createPinnedSession({
        id: sessionId,
        cwd,
        backend,
        agent: rootAgent,
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
    if (initialBackend.kind === "delegated") {
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
    if (requestedCompany !== null) {
      const goalAt = new Date().toISOString();
      await sessions.withSessionMutation(
        pinnedState.id,
        pinnedState.lastSequence,
        async (mutation) => {
          await mutation.append({
            type: "goal_updated",
            source: "command",
            at: goalAt,
            goal: activeGoal(requestedCompany.initialGoal, goalAt),
          });
        },
      );
      const loaded = await sessions.loadState(pinnedState.id);
      if (!isPinnedSessionState(loaded)) {
        throw new TypeError("Company activation requires pinned version 2 state");
      }
      pinnedState = loaded;
    }
    state = pinnedState;
  }

  const coordinatorReference: { current?: BackendRunCoordinator } = {};
  const processes = new OwnedProcessManager({
    checkpoints,
    ...(options.ptyDriver === undefined ? {} : { ptyDriver: options.ptyDriver }),
  });
  const tools = new ToolRegistry([], {
    checkpoints,
    securityProfile: options.toolSecurityProfile
      ?? (process.platform === "win32" ? "local_guarded" : "workspace_sandboxed"),
  });
  tools.register(createReadFileTool());
  tools.register(createListFilesTool());
  tools.register(createSearchTextTool());
  tools.register(createCodeOutlineTool());
  tools.register(createTypeScriptDiagnosticsTool());
  tools.register(createWebFetchTool());
  tools.register(createApplyPatchTool());
  tools.register(createRunCommandTool(processes));
  tools.register(createProcessSessionTool(processes));
  tools.register(createRunVerificationTool());
  tools.register(createGitStatusTool());
  tools.register(createGitDiffTool());
  tools.register(createGitHistoryTool());
  tools.register(createGitShowTool());
  if (skills.hasSkills) tools.register(skills.createTool());
  if (mcp.hasServers) tools.register(mcp.createTool());
  const backendRouter = new AgentBackendRouter();
  const childAgents = new ChildAgentManager({
    sessions,
    backendRouter,
    getCoordinator: () => coordinatorReference.current,
    emit(event) {
      return events.emit(event);
    },
  });
  tools.register(childAgents.createTool());
  tools.register(new CompanyAgentManager({
    sessions,
    blueprints: companyBlueprints,
    children: childAgents,
  }).createTool());
  const childBatches = new ChildAgentBatchManager({
    sessions,
    children: childAgents,
    worktrees,
    emit(event) {
      return events.emit(event);
    },
  });
  tools.register(childBatches.createTool());
  const reviews = new AgentReviewPanel({ sessions, children: childAgents });
  const teamSupervisor = new TeamRunSupervisor({
    sessions,
    runs: teamRuns,
    owners: teamOwners,
    children: childAgents,
    worktrees,
    patches,
    reviews,
    router: backendRouter,
    checkpoints,
    async backendCandidates(parent) {
      const candidates: AgentBackendCandidate[] = [{
        id: "parent-session-pin",
        pin: parent.backend.pin,
        parent: true,
        roles: ["implement", "review", "repair"],
        executionModes: ["act"],
        permissionModes: [parent.permissionMode],
        hostTools: parent.backend.pin.kind === "model_provider",
        background: parent.backend.pin.kind === "model_provider",
        ready: true,
      }];
      if (injected !== undefined || environmentConnection !== null) {
        return candidates;
      }
      let current;
      try {
        current = await connectionRegistry.read();
      } catch {
        return candidates;
      }
      const rolesByConnection = new Map<string, ("implement" | "review" | "repair")[]>();
      for (const role of ["implement", "review", "repair"] as const) {
        const connectionId = current.agentRoutes[role];
        if (connectionId === null || connectionId === parent.backend.pin.connectionId) {
          continue;
        }
        const roles = rolesByConnection.get(connectionId) ?? [];
        roles.push(role);
        rolesByConnection.set(connectionId, roles);
      }
      for (const [connectionId, roles] of [...rolesByConnection].sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        const connection = current.connections.find(
          (candidate) => candidate.id === connectionId,
        );
        if (connection === undefined) continue;
        let backend: RuntimeBackend | null;
        try {
          backend = await backendForConnection(
            connection,
            delegatedRuntimeFactory,
            randomUUID(),
            options.nativeOpenAIResponses,
            runtimeEnvironment,
            options.environmentFetch,
          );
        } catch {
          continue;
        }
        if (backend === null || backend.kind !== "direct") continue;
        const pin = backend.pin(
          parent.backend.pin.billingSelectionAtCreation.acknowledgedAt,
        );
        if (pin.kind !== "model_provider") continue;
        candidates.push({
          id: `configured-${createHash("sha256").update(connectionId).digest("hex").slice(0, 32)}`,
          pin,
          parent: false,
          roles,
          executionModes: ["act"],
          permissionModes: [parent.permissionMode],
          hostTools: true,
          background: true,
          ready: true,
        });
      }
      return candidates;
    },
    emit(event) {
      return events.emit(event);
    },
  });
  const teams = new TeamAgentManager({
    sessions,
    supervisor: teamSupervisor,
    children: childAgents,
    worktrees,
    patches,
    reviews,
    checkpoints,
    emit(event) {
      return events.emit(event);
    },
  });
  tools.register(teams.createTool());
  for (const tool of createTeamRunTools(teamSupervisor)) tools.register(tool);

  const runtimeReference: { current?: RecursRuntime } = {};
  tools.register(createRequestUserInputTool(async (request, signal) => {
    const runtime = runtimeReference.current;
    if (runtime === undefined) {
      throw new ToolError("tool_unavailable", "User input is unavailable");
    }
    return await runtime.requestUserInput(request, signal);
  }));
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
    createToolContext(session, signal, runContext) {
      return {
        sessionId: session.id,
        cwd: session.cwd,
        signal,
        executionMode: session.executionMode,
        readRevisions: new Map(),
        ...(runContext === undefined ? {} : { runContext }),
      };
    },
  });
  const direct = new AgentLoopDirectExecutor({
    tools,
    approvals,
    sessions,
    emit(event) {
      return events.emit(event);
    },
    contextInstructions: async (session) => [
      ...await projectContextInstructions(session.cwd),
      ...(isPinnedSessionState(session) && session.agent.role === "parent" &&
          session.agent.company !== undefined
        ? companyContextInstructions(
            await companyBlueprints.load(session.agent.company.blueprintId),
          )
        : []),
      ...(isPinnedSessionState(session) && session.agent.profile === null
        ? [...skills.contextInstructions(), ...mcp.contextInstructions()]
        : []),
    ],
    createToolContext(session, signal, runContext) {
      return {
        sessionId: session.id,
        cwd: session.cwd,
        signal,
        executionMode: session.executionMode,
        readRevisions: new Map(),
        ...(runContext === undefined ? {} : { runContext }),
      };
    },
  });
  const resolver: StandaloneBackendResolver = {
    runtimeContinuationStore: continuations.runtimeStore,
    async resolve(input) {
      let selected: RuntimeBackend;
      let connectionRevision: number;
      if (injected !== undefined || environmentConnection !== null) {
        if (initialBackend === undefined) throw connectionInvalid(input.operationId);
        selected = initialBackend;
        connectionRevision = 1;
      } else {
        let current;
        try {
          current = await connectionRegistry.read();
        } catch {
          throw connectionInvalid(input.operationId);
        }
        const connection = current.connections.find(
          (candidate) => candidate.id === input.pin.connectionId,
        );
        if (connection === undefined) throw connectionInvalid(input.operationId);
        try {
          const resolved = await backendForConnection(
            connection,
            delegatedRuntimeFactory,
            input.operationId,
            options.nativeOpenAIResponses,
            runtimeEnvironment,
            options.environmentFetch,
          );
          if (resolved === null) {
            throw policyBlocked(
              input.operationId,
              unavailableConnectionMessage(connection),
            );
          }
          selected = resolved;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "domain" in error
          ) {
            throw error;
          }
          throw connectionInvalid(input.operationId);
        }
        connectionRevision = current.revision;
      }
      const expectedPin = selected.pin(
        input.pin.billingSelectionAtCreation.acknowledgedAt,
      );
      if (!isDeepStrictEqual(input.pin, expectedPin)) {
        throw connectionInvalid(input.operationId);
      }
      if (selected.kind === "delegated") {
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
            connectionRevision,
            policyRevision: input.pin.policyRevisionAtCreation,
            context: input.context,
            maxRequests: 1,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          }),
          async createRuntime() {
            return selected.createRuntime(continuations.runtimeStore);
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
          connectionRevision,
          policyRevision: input.pin.policyRevisionAtCreation,
          context: input.context,
          maxRequests: 40,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        async createProvider() {
          return selected.createProvider();
        },
      };
    },
  };
  const coordinator = new BackendRunCoordinator({
    sessions,
    resolver,
    direct,
    delegated,
    continuationAuthority: continuations.authority,
  });
  coordinatorReference.current = coordinator;
  const resolveCommandProvider = async (
    session: SessionState,
    signal: AbortSignal,
  ): Promise<ModelProvider | null> => {
    if (
      signal.aborted ||
      !isPinnedSessionState(session) ||
      session.backend.pin.kind !== "model_provider"
    ) {
      return null;
    }
    let selected: RuntimeBackend;
    if (injected !== undefined || environmentConnection !== null) {
      if (initialBackend === undefined) return null;
      selected = initialBackend;
    } else {
      let current;
      try {
        current = await connectionRegistry.read();
        const connection = current.connections.find(
          (candidate) => candidate.id === session.backend.pin.connectionId,
        );
        if (connection === undefined) return null;
        const resolved = await backendForConnection(
          connection,
          delegatedRuntimeFactory,
          randomUUID(),
          options.nativeOpenAIResponses,
          runtimeEnvironment,
          options.environmentFetch,
        );
        if (resolved === null) return null;
        selected = resolved;
      } catch {
        return null;
      }
    }
    const expected = selected.pin(
      session.backend.pin.billingSelectionAtCreation.acknowledgedAt,
    );
    return selected.kind === "direct" &&
        isDeepStrictEqual(expected, session.backend.pin)
      ? selected.createProvider()
      : null;
  };
  const modelSessions: ModelSessionService | undefined =
    injected !== undefined || environmentConnection !== null
      ? undefined
      : {
          async list(signal) {
            if (signal.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            const document = await connectionRegistry.migrateLegacyLocal({
              signal,
            });
            if (signal.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            return modelSelectionOptions(document);
          },
          async create(input) {
            if (input.signal.aborted) return { status: "cancelled" };
            let document;
            try {
              document = await connectionRegistry.migrateLegacyLocal({
                signal: input.signal,
              });
            } catch {
              return input.signal.aborted
                ? { status: "cancelled" }
                : { status: "failed" };
            }
            const connection = document.connections.find((candidate) =>
              candidate.id === input.expected.connectionId
            );
            if (connection === undefined) return { status: "not_found" };
            const actual = modelSelectionOption(
              connection,
              document.primaryConnectionId,
            );
            if (!isDeepStrictEqual(actual, input.expected)) {
              return { status: "changed" };
            }
            let backend: RuntimeBackend | null;
            try {
              backend = await backendForConnection(
                connection,
                delegatedRuntimeFactory,
                randomUUID(),
                options.nativeOpenAIResponses,
                runtimeEnvironment,
                options.environmentFetch,
              );
            } catch {
              return input.signal.aborted
                ? { status: "cancelled" }
                : { status: "unavailable" };
            }
            if (backend === null) return { status: "unavailable" };
            const comparisonAt = isPinnedSessionState(input.current)
              ? input.current.backend.pin.billingSelectionAtCreation.acknowledgedAt
              : input.at;
            if (
              isPinnedSessionState(input.current) &&
              isDeepStrictEqual(input.current.backend.pin, backend.pin(comparisonAt))
            ) {
              return { status: "unchanged" };
            }
            if (input.signal.aborted) return { status: "cancelled" };
            let confirmed;
            try {
              confirmed = await connectionRegistry.migrateLegacyLocal({
                signal: input.signal,
              });
            } catch {
              return input.signal.aborted
                ? { status: "cancelled" }
                : { status: "failed" };
            }
            if (confirmed.revision !== document.revision) {
              return { status: "changed" };
            }
            const id = randomUUID();
            const pin = backend.pin(input.at);
            const operatingModeId = isPinnedSessionState(input.current)
              ? input.current.agent.operatingMode.id
              : options.operatingModeId;
            const permissionMode = input.current.permissionMode;
            const executionMode = backend.kind === "delegated"
              ? "plan" as const
              : input.current.executionMode;
            const baseAgent = createRootAgentDescriptor(
              id,
              pin,
              operatingModeId,
              permissionMode,
            );
            const agent = executionMode === "act"
              ? baseAgent
              : {
                  ...baseAgent,
                  permissions: {
                    ...baseAgent.permissions,
                    parentExecutionMode: executionMode,
                    executionMode,
                  },
                };
            try {
              const session = await sessions.createPinnedSession({
                id,
                cwd: input.current.cwd,
                backend: pin,
                agent,
                at: input.at,
              });
              return { status: "created", session };
            } catch {
              return input.signal.aborted
                ? { status: "cancelled" }
                : { status: "failed" };
            }
          },
        };
  const commands = createCommandRegistry({
    sessions,
    ...(initialBackend?.kind === "direct"
      ? { provider: initialBackend.commandProvider }
      : {}),
    resolveProvider: resolveCommandProvider,
    checkpoints,
    processes,
    teamRuns: teamSupervisor,
    skills,
    mcp,
    ...(modelSessions === undefined ? {} : { models: modelSessions }),
    signal: () =>
      runtimeReference.current?.currentSignal() ?? new AbortController().signal,
  });
  const runtime = new RecursRuntime(
    {
      commands,
      coordinator,
      sessions,
      processes,
      confirm: async () => false,
      dispose: async () => {
        const settled = await Promise.allSettled([
          processes.close(),
          mcp.close(),
        ]);
        if (settled.some((result) => result.status === "rejected")) {
          throw new ToolError(
            "execution_failed",
            "Runtime resource cleanup failed",
          );
        }
      },
      providerGuide: async (query, signal) =>
        providerOverviewText(
          await providerDiscoveryOverview(root, query, signal),
          query,
        ),
      ...(initialBackend === undefined
        ? {
            promptUnavailableMessage: configuredConnection === null
              ? "No model connection is ready. Run recurs setup in an interactive terminal, then try again."
              : unavailableConnectionMessage(configuredConnection),
          }
        : {}),
    },
    state,
  );
  runtimeReference.current = runtime;
  if (
    requestedCompany !== null &&
    !("type" in state) &&
    isPinnedSessionState(state)
  ) {
    await events.emit({
      type: "company_blueprint_activated",
      sessionId: state.id,
      at: new Date().toISOString(),
      parentAgentId: state.agent.id,
      blueprintId: requestedCompany.id,
      blueprintVersion: 1,
      developmentStyle: requestedCompany.developmentStyle,
      operatingModeId: state.agent.operatingMode.id,
      roleCount: requestedCompany.roles.length,
    });
  }
  return runtime;
}
