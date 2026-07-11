import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

import type {
  BackendResolver,
  SessionBackendPin,
} from "@recurs/contracts";
import {
  AgentLoopDirectExecutor,
  BackendRunCoordinator,
  JsonlSessionStore,
  createWorkspaceShell,
  type EventSink,
} from "@recurs/core";
import type { ModelProvider } from "@recurs/providers";
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
  const provider = options.provider;
  const existing = await sessions.list();
  let state;
  if (provider === undefined) {
    state = createWorkspaceShell(cwd);
  } else {
    const model = options.model ?? provider.id;
    let matching = null;
    for (const entry of existing) {
      const candidate = await sessions.loadState(entry.id);
      if (
        candidate.backend.type === "pinned" &&
        candidate.backend.pin.connectionId === `injected:${provider.id}` &&
        candidate.backend.pin.adapterId === `injected:${provider.id}` &&
        candidate.backend.pin.modelId === model
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
        backend: injectedBackendPin(provider, model, createdAt),
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
  const direct = provider === undefined ? undefined : new AgentLoopDirectExecutor({
    tools,
    approvals: {
      async request(intent) {
        const allowed =
          (await runtimeReference.current?.confirm(
            `Allow ${intent.category} access to ${intent.resource}?`,
          )) ?? false;
        return allowed ? "allow_once" : "deny";
      },
    },
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
  const resolver: BackendResolver | undefined = provider === undefined
    ? undefined
    : {
        async resolve(input) {
          if (
            input.pin.connectionId !== `injected:${provider.id}` ||
            input.pin.adapterId !== `injected:${provider.id}`
          ) {
            throw new Error("The injected provider does not match the session pin");
          }
          return {
            kind: "direct",
            pin: input.pin,
            authorization: {
              kind: "run",
              id: randomUUID(),
              operation: input.operation,
              sessionId: input.sessionId,
              operationId: input.operationId,
              turnId: input.turnId,
              connectionId: input.pin.connectionId,
              modelId: input.pin.modelId,
              backendFingerprint: createHash("sha256")
                .update(JSON.stringify(input.pin))
                .digest("hex"),
              connectionRevision: 1,
              policyRevision: input.pin.policyRevisionAtCreation,
              billingMode: input.pin.billingSelectionAtCreation.mode,
              billingSelectionDigest: createHash("sha256")
                .update(JSON.stringify(input.pin.billingSelectionAtCreation))
                .digest("hex"),
              contextDigest: createHash("sha256")
                .update(JSON.stringify(input.context))
                .digest("hex"),
              maxRequests: 40,
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
            async createProvider() {
              return provider;
            },
          };
        },
      };
  const coordinator = direct === undefined || resolver === undefined
    ? undefined
    : new BackendRunCoordinator({ sessions, resolver, direct });
  const commands = createCommandRegistry({
    sessions,
    ...(provider === undefined ? {} : { provider }),
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
      ...(options.provider === undefined
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
