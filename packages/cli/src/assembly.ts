import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

import {
  AgentLoop,
  JsonlSessionStore,
  type EventSink,
} from "@recurs/core";
import {
  ProviderError,
  type ModelProvider,
  type ProviderEvent,
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
} from "@recurs/tools";

import { createCommandRegistry } from "./commands/create.js";
import { RecursRuntime } from "./runtime.js";

class UnavailableProvider implements ModelProvider {
  readonly id = "unconfigured";

  stream(): AsyncIterable<ProviderEvent> {
    const error = new ProviderError(
      "authentication",
      "No live LLM provider is configured. The Recurs harness is ready for an injected provider.",
      false,
    );
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<ProviderEvent>> {
            throw error;
          },
        };
      },
    };
  }
}

export interface StandaloneRuntimeOptions {
  cwd?: string;
  dataDirectory?: string;
  provider?: ModelProvider;
  model?: string;
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
  const provider = options.provider ?? new UnavailableProvider();
  const existing = await sessions.list();
  let state;
  if (existing[0] === undefined) {
    const id = randomUUID();
    await sessions.append(id, {
      version: 1,
      type: "session_created",
      sessionId: id,
      at: new Date().toISOString(),
      cwd,
      model: options.model ?? provider.id,
    });
    state = await sessions.loadState(id);
  } else {
    state = await sessions.loadState(existing[0].id);
  }

  const tools = new ToolRegistry([], { checkpoints });
  tools.register(createReadFileTool());
  tools.register(createListFilesTool());
  tools.register(createSearchTextTool());
  tools.register(createApplyPatchTool());
  tools.register(createRunCommandTool());
  tools.register(createGitStatusTool());
  tools.register(createGitDiffTool());

  const runtimeReference: { current?: RecursRuntime } = {};
  const loop = new AgentLoop({
    provider,
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
  const commands = createCommandRegistry({
    sessions,
    provider,
    checkpoints,
    signal: () =>
      runtimeReference.current?.currentSignal() ?? new AbortController().signal,
  });
  const runtime = new RecursRuntime(
    {
      commands,
      loop,
      sessions,
      confirm: async () => false,
      ...(options.provider === undefined
        ? {
            promptUnavailableMessage:
              "No live LLM provider is configured yet. Local slash commands are available, and provider injection is the next integration layer.",
          }
        : {}),
    },
    state,
  );
  runtimeReference.current = runtime;
  return runtime;
}
