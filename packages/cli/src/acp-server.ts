import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import {
  RECURS_VERSION,
  createHostInvocation,
  type HostInvocation,
  type RunResult,
} from "@recurs/contracts";
import type { EventSink, RecursEvent } from "@recurs/core";

import type { CommandResult } from "./commands/types.js";
import { isCancellation } from "./runtime.js";

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_EVENT_TEXT_BYTES = 64 * 1024;

const ACP_INVOCATION: HostInvocation = createHostInvocation({
  invocation: "one_shot",
  userPresent: false,
  remote: false,
  scripted: true,
  embedding: "sdk",
});

export interface AcpRuntime {
  submit(
    input: string,
    invocation: HostInvocation,
  ): Promise<CommandResult | RunResult>;
  cancel(): boolean;
  setConfirmHandler(confirm: (message: string) => Promise<boolean>): void;
  close?(): Promise<void>;
}

export interface RecursAcpDependencies {
  createRuntime(cwd: string, events: EventSink): Promise<AcpRuntime>;
}

interface AcpSession {
  readonly runtime: AcpRuntime;
  readonly bridge: AcpEventBridge;
  active: boolean;
  cancellationRequested: boolean;
}

function safeEventText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_EVENT_TEXT_BYTES) return text;
  return `${Buffer.from(text, "utf8").subarray(0, MAX_EVENT_TEXT_BYTES).toString("utf8")}\n… output truncated by Recurs`;
}

function toolKind(name: string): acp.ToolKind {
  if (name === "read_file" || name === "list_files" || name.startsWith("git_")) {
    return "read";
  }
  if (name === "search_text") return "search";
  if (name === "web_fetch") return "fetch";
  if (name === "apply_patch") return "edit";
  if (name.startsWith("run_")) return "execute";
  if (name.includes("agent") || name.includes("team")) return "think";
  return "other";
}

function inputLocations(
  cwd: string,
  input: unknown,
): acp.ToolCallLocation[] | undefined {
  if (typeof input !== "object" || input === null || !("path" in input)) {
    return undefined;
  }
  const candidate = input.path;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  return [{ path: path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate) }];
}

function eventFailureText(event: Extract<RecursEvent, {
  type: "tool_failed" | "agent_failed";
}>): string {
  return event.type === "tool_failed"
    ? event.error.message
    : event.failure.safeMessage;
}

class AcpEventBridge implements EventSink {
  #currentTool: acp.ToolCallUpdate | null = null;
  #sawAgentText = false;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly client: acp.AgentContext,
  ) {}

  beginPrompt(): void {
    this.#currentTool = null;
    this.#sawAgentText = false;
  }

  get sawAgentText(): boolean {
    return this.#sawAgentText;
  }

  async #notify(update: acp.SessionUpdate): Promise<void> {
    await this.client.notify(acp.methods.client.session.update, {
      sessionId: this.sessionId,
      update,
    });
  }

  async #toolCall(toolCall: acp.ToolCall): Promise<void> {
    this.#currentTool = toolCall;
    await this.#notify({ sessionUpdate: "tool_call", ...toolCall });
  }

  async #toolUpdate(update: acp.ToolCallUpdate): Promise<void> {
    if (this.#currentTool?.toolCallId === update.toolCallId) {
      this.#currentTool = { ...this.#currentTool, ...update };
    }
    await this.#notify({ sessionUpdate: "tool_call_update", ...update });
  }

  async confirm(message: string): Promise<boolean> {
    const toolCall = this.#currentTool ?? {
      toolCallId: `recurs-permission:${randomUUID()}`,
      title: safeEventText(message),
      kind: "other" as const,
      status: "pending" as const,
    };
    try {
      const response = await this.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId: this.sessionId,
          toolCall,
          options: [
            {
              optionId: "recurs-allow-once",
              name: "Allow once",
              kind: "allow_once",
            },
            {
              optionId: "recurs-reject-once",
              name: "Reject",
              kind: "reject_once",
            },
          ],
        },
      );
      return response.outcome.outcome === "selected" &&
        response.outcome.optionId === "recurs-allow-once";
    } catch {
      return false;
    }
  }

  async emit(event: RecursEvent): Promise<void> {
    switch (event.type) {
      case "model_text_delta":
        this.#sawAgentText = true;
        await this.#notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: safeEventText(event.text) },
        });
        return;
      case "model_reasoning_delta":
        await this.#notify({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: safeEventText(event.text) },
        });
        return;
      case "tool_requested": {
        const locations = inputLocations(this.cwd, event.call.arguments);
        await this.#toolCall({
          toolCallId: event.call.id,
          title: event.call.name,
          kind: toolKind(event.call.name),
          status: "pending",
          rawInput: event.call.arguments,
          ...(locations === undefined ? {} : { locations }),
        });
        return;
      }
      case "tool_started":
        await this.#toolUpdate({
          toolCallId: event.call.id,
          title: event.call.name,
          kind: toolKind(event.call.name),
          status: "in_progress",
        });
        return;
      case "tool_completed":
        await this.#toolUpdate({
          toolCallId: event.callId,
          status: "completed",
          content: [{
            type: "content",
            content: { type: "text", text: safeEventText(event.result.output) },
          }],
          rawOutput: event.result.metadata === undefined
            ? { output: event.result.output }
            : { output: event.result.output, metadata: event.result.metadata },
        });
        return;
      case "tool_failed":
        await this.#toolUpdate({
          toolCallId: event.callId,
          status: "failed",
          content: [{
            type: "content",
            content: { type: "text", text: safeEventText(event.error.message) },
          }],
        });
        return;
      case "tool_denied":
        await this.#toolUpdate({
          toolCallId: event.callId,
          status: "failed",
          content: [{
            type: "content",
            content: { type: "text", text: "Permission denied" },
          }],
        });
        return;
      case "agent_started":
        await this.#toolCall({
          toolCallId: `recurs-agent:${event.childAgentId}`,
          title: event.description,
          kind: "think",
          status: "in_progress",
          rawInput: {
            profileId: event.profileId,
            operatingModeId: event.operatingModeId,
            taskId: event.taskId,
          },
        });
        return;
      case "agent_completed":
        await this.#toolUpdate({
          toolCallId: `recurs-agent:${event.childAgentId}`,
          status: "completed",
          rawOutput: {
            changedFiles: event.changedFiles,
            evidence: event.evidence,
            usage: event.usage,
          },
        });
        return;
      case "agent_failed":
        await this.#toolUpdate({
          toolCallId: `recurs-agent:${event.childAgentId}`,
          status: "failed",
          content: [{
            type: "content",
            content: { type: "text", text: safeEventText(eventFailureText(event)) },
          }],
        });
        return;
      case "agent_cancelled":
        await this.#toolUpdate({
          toolCallId: `recurs-agent:${event.childAgentId}`,
          status: "failed",
          content: [{
            type: "content",
            content: { type: "text", text: safeEventText(event.reason) },
          }],
        });
        return;
      case "agent_batch_started":
        await this.#toolCall({
          toolCallId: `recurs-batch:${event.batchId}`,
          title: `Agent batch (${event.taskCount} tasks)`,
          kind: "think",
          status: "in_progress",
          rawInput: {
            taskCount: event.taskCount,
            maxConcurrentChildren: event.maxConcurrentChildren,
            operatingModeId: event.operatingModeId,
          },
        });
        return;
      case "agent_batch_completed":
      case "agent_batch_failed":
      case "agent_batch_cancelled":
        await this.#toolUpdate({
          toolCallId: `recurs-batch:${event.batchId}`,
          status: event.type === "agent_batch_completed" ? "completed" : "failed",
          rawOutput: { counts: event.counts, workflow: event.workflow },
        });
        return;
      case "agent_team_started":
        await this.#toolCall({
          toolCallId: `recurs-team:${event.teamId}`,
          title: `Agent team: ${event.description}`,
          kind: "think",
          status: "in_progress",
          rawInput: {
            implementerCount: event.implementerCount,
            qualityStandard: event.qualityStandard,
            operatingModeId: event.operatingModeId,
          },
        });
        return;
      case "agent_team_activity":
        await this.#toolUpdate({
          toolCallId: `recurs-team:${event.teamId}`,
          status: "in_progress",
          rawOutput: {
            status: event.status,
            phase: event.phase,
            round: event.round,
            activity: event.activity,
            counts: event.counts,
          },
        });
        return;
      case "agent_team_completed":
        await this.#toolUpdate({
          toolCallId: `recurs-team:${event.teamId}`,
          status: "completed",
          rawOutput: {
            status: event.status,
            changedFiles: event.changedFiles,
            evidence: event.evidence,
            workflow: event.workflow,
          },
        });
        return;
      case "agent_team_failed":
      case "agent_team_cancelled":
        await this.#toolUpdate({
          toolCallId: `recurs-team:${event.teamId}`,
          status: "failed",
          content: [{
            type: "content",
            content: {
              type: "text",
              text: safeEventText(
                event.type === "agent_team_failed"
                  ? event.failure.message
                  : event.reason,
              ),
            },
          }],
        });
        return;
      default:
        return;
    }
  }

  async message(text: string): Promise<void> {
    this.#sawAgentText = true;
    await this.#notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: safeEventText(text) },
    });
  }
}

function promptText(prompt: readonly acp.ContentBlock[]): string {
  const parts = prompt.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource_link") {
      return `[Referenced resource: ${block.name} (${block.uri})]`;
    }
    throw acp.RequestError.invalidParams(
      { contentType: block.type },
      `Recurs does not support ${block.type} prompt content`,
    );
  });
  const text = parts.join("\n\n").trim();
  if (text.length === 0) {
    throw acp.RequestError.invalidParams(undefined, "Prompt cannot be empty");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
    throw acp.RequestError.invalidParams(
      { maxBytes: MAX_PROMPT_BYTES },
      "Prompt is too large",
    );
  }
  return text;
}

function isRunResult(result: CommandResult | RunResult): result is RunResult {
  return "finalText" in result;
}

export function createRecursAcpApp(
  dependencies: RecursAcpDependencies,
): acp.AgentApp {
  const sessions = new Map<string, AcpSession>();

  const session = (sessionId: string): AcpSession => {
    const current = sessions.get(sessionId);
    if (current === undefined) {
      throw acp.RequestError.resourceNotFound(`recurs-session:${sessionId}`);
    }
    return current;
  };

  return acp.agent({ name: "recurs" })
    .onConnect((connection) => {
      connection.signal.addEventListener("abort", () => {
        const closing: Promise<void>[] = [];
        for (const current of sessions.values()) {
          current.cancellationRequested = current.active;
          current.runtime.cancel();
          if (current.runtime.close !== undefined) {
            closing.push(current.runtime.close());
          }
        }
        sessions.clear();
        void Promise.allSettled(closing);
      }, { once: true });
    })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "recurs", version: RECURS_VERSION },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, async (context) => {
      if (context.params.additionalDirectories?.length) {
        throw acp.RequestError.invalidParams(
          undefined,
          "Recurs does not support additional workspace roots yet",
        );
      }
      if (context.params.mcpServers.length > 0) {
        throw acp.RequestError.invalidParams(
          undefined,
          "Recurs does not support ACP-provided MCP servers yet",
        );
      }
      if (!path.isAbsolute(context.params.cwd)) {
        throw acp.RequestError.invalidParams(undefined, "cwd must be absolute");
      }
      const sessionId = randomUUID();
      const bridge = new AcpEventBridge(
        sessionId,
        context.params.cwd,
        context.client,
      );
      let runtime: AcpRuntime;
      try {
        runtime = await dependencies.createRuntime(context.params.cwd, bridge);
      } catch {
        throw acp.RequestError.internalError(
          undefined,
          "Recurs could not create the session",
        );
      }
      runtime.setConfirmHandler((message) => bridge.confirm(message));
      sessions.set(sessionId, {
        runtime,
        bridge,
        active: false,
        cancellationRequested: false,
      });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      const current = session(context.params.sessionId);
      if (current.active) {
        throw acp.RequestError.invalidRequest(
          undefined,
          "A prompt is already active for this session",
        );
      }
      const text = promptText(context.params.prompt);
      current.active = true;
      current.cancellationRequested = false;
      current.bridge.beginPrompt();
      const abort = (): void => {
        current.cancellationRequested = true;
        current.runtime.cancel();
      };
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) abort();
      try {
        if (current.cancellationRequested) return { stopReason: "cancelled" };
        const result = await current.runtime.submit(text, ACP_INVOCATION);
        if (current.cancellationRequested) return { stopReason: "cancelled" };
        if (isRunResult(result)) {
          if (!current.bridge.sawAgentText && result.finalText.length > 0) {
            await current.bridge.message(result.finalText);
          }
        } else if (result.type === "message") {
          await current.bridge.message(result.text);
        }
        return { stopReason: "end_turn" };
      } catch (error) {
        if (current.cancellationRequested || isCancellation(error)) {
          return { stopReason: "cancelled" };
        }
        throw acp.RequestError.internalError(
          undefined,
          "Recurs could not complete the prompt",
        );
      } finally {
        context.signal.removeEventListener("abort", abort);
        current.active = false;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (context) => {
      const current = sessions.get(context.params.sessionId);
      if (current === undefined || !current.active) return;
      current.cancellationRequested = true;
      current.runtime.cancel();
    })
    .onRequest(acp.methods.agent.session.close, async (context) => {
      const current = session(context.params.sessionId);
      current.cancellationRequested = current.active;
      current.runtime.cancel();
      sessions.delete(context.params.sessionId);
      await current.runtime.close?.();
      return {};
    });
}

export async function serveRecursAcpStdio(
  dependencies: RecursAcpDependencies,
  input: Readable,
  output: Writable,
): Promise<void> {
  const stream = acp.ndJsonStream(
    Writable.toWeb(output),
    Readable.toWeb(input) as ReadableStream<Uint8Array>,
  );
  const connection = createRecursAcpApp(dependencies).connect(stream);
  await connection.closed;
}
