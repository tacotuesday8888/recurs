import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

import type {
  BackendResolver,
  RuntimeApprovalRequest,
  RuntimeContinuationStore,
  SessionBackendPin,
} from "@recurs/contracts";
import {
  AgentLoopDirectExecutor,
  BackendRunCoordinator,
  DelegatedAgentExecutor,
  JsonlSessionStore,
  ProcessScopedRuntimeContinuationStore,
  bindRunAuthorization,
  createWorkspaceShell,
  type EventSink,
} from "@recurs/core";
import {
  LocalOpenAICompatibleProvider,
  type ModelProvider,
} from "@recurs/providers";
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
import {
  readLocalConnection,
  type LocalConnectionConfiguration,
} from "./local-connection.js";
import { RecursRuntime } from "./runtime.js";

export interface StandaloneRuntimeOptions {
  cwd?: string;
  dataDirectory?: string;
  provider?: ModelProvider;
  model?: string;
  toolSecurityProfile?: ToolSecurityProfile;
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

interface RuntimeBackend {
  pin(at: string): SessionBackendPin;
  commandProvider: ModelProvider;
  createProvider(): ModelProvider;
}

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
  const localConnection = injected === undefined
    ? await readLocalConnection(root)
    : null;
  const backend: RuntimeBackend | undefined = injected !== undefined
    ? {
        pin: (at) => injectedBackendPin(
          injected,
          options.model ?? injected.id,
          at,
        ),
        commandProvider: injected,
        createProvider: () => injected,
      }
    : localConnection === null
      ? undefined
      : {
          pin: (at) => localBackendPin(localConnection, at),
          commandProvider: new LocalOpenAICompatibleProvider({
            baseUrl: localConnection.baseUrl,
          }),
          createProvider: () => new LocalOpenAICompatibleProvider({
            baseUrl: localConnection.baseUrl,
          }),
        };
  const existing = await sessions.list();
  let state;
  if (backend === undefined) {
    state = createWorkspaceShell(cwd);
  } else {
    const pin = backend.pin(new Date().toISOString());
    let matching = null;
    for (const entry of existing) {
      const candidate = await sessions.loadState(entry.id);
      if (
        candidate.backend.type === "pinned" &&
        candidate.backend.pin.connectionId === pin.connectionId &&
        candidate.backend.pin.adapterId === pin.adapterId &&
        candidate.backend.pin.modelId === pin.modelId
      ) {
        matching = candidate;
        break;
      }
    }
    if (matching === null) {
      const createdAt = new Date().toISOString();
      state = await sessions.createPinnedSession({
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
      state = await sessions.loadState(matching.id);
    }
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
          if (
            input.pin.connectionId !== backend.pin(input.pin.billingSelectionAtCreation.acknowledgedAt).connectionId ||
            input.pin.adapterId !== backend.pin(input.pin.billingSelectionAtCreation.acknowledgedAt).adapterId ||
            input.pin.modelId !== backend.pin(input.pin.billingSelectionAtCreation.acknowledgedAt).modelId
          ) {
            throw new Error("The configured provider does not match the session pin");
          }
          return {
            kind: "direct",
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
    ...(backend === undefined ? {} : { provider: backend.commandProvider }),
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
