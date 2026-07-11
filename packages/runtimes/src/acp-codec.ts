import {
  methods,
  type AnyMessage,
  type RequestPermissionRequest,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { z } from "zod";

import { AcpUpdateError } from "./acp-updates.js";

const implementationSchema = z.object({
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  title: z.string().min(1).max(256).nullish(),
}).passthrough();

const authMethodSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  type: z.enum(["agent", "env_var", "terminal"]).optional(),
}).passthrough();

export const initializeResponseSchema = z.object({
  protocolVersion: z.number().int().nonnegative(),
  agentInfo: implementationSchema.nullish(),
  authMethods: z.array(authMethodSchema).max(64).optional(),
  agentCapabilities: z.object({
    sessionCapabilities: z.object({
      resume: z.object({}).passthrough().nullish(),
      close: z.object({}).passthrough().nullish(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const modeStateSchema = z.object({
  currentModeId: z.string().min(1).max(256),
  availableModes: z.array(z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
  }).passthrough()).max(128),
}).passthrough();

const selectOptionSchema = z.object({
  value: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
}).passthrough();

const selectGroupSchema = z.object({
  group: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  options: z.array(selectOptionSchema).max(256),
}).passthrough();

export const configOptionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    type: z.literal("boolean"),
    currentValue: z.boolean(),
  }).passthrough(),
  z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    type: z.literal("select"),
    currentValue: z.string().min(1).max(256),
    options: z.union([
      z.array(selectOptionSchema).max(256),
      z.array(selectGroupSchema).max(64),
    ]),
  }).passthrough(),
]);

export const sessionStateSchema = z.object({
  modes: modeStateSchema.nullish(),
  configOptions: z.array(configOptionSchema).max(128).nullish(),
}).passthrough();

export const newSessionResponseSchema = sessionStateSchema.extend({
  sessionId: z.string().min(1).max(1_024),
});

export const configResponseSchema = z.object({
  configOptions: z.array(configOptionSchema).max(128),
}).passthrough();

const usageSchema = z.object({
  totalTokens: z.number().int().nonnegative().safe(),
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  thoughtTokens: z.number().int().nonnegative().safe().nullish(),
  cachedReadTokens: z.number().int().nonnegative().safe().nullish(),
  cachedWriteTokens: z.number().int().nonnegative().safe().nullish(),
}).passthrough().refine(
  (usage) => usage.totalTokens >= usage.inputTokens + usage.outputTokens,
  "totalTokens must cover input and output tokens",
);

export const promptResponseSchema = z.object({
  stopReason: z.enum([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ]),
  usage: usageSchema.nullish(),
}).passthrough();

export const authResponseSchema = z.object({
  content: z.string().max(16_384).optional(),
}).passthrough();

export const emptyResponseSchema = z.object({}).passthrough();

const sessionNotificationBaseSchema = z.object({
  sessionId: z.string().min(1).max(1_024),
  update: z.object({
    sessionUpdate: z.string().min(1).max(128),
  }).passthrough(),
}).passthrough();

const textUpdateSchema = z.object({
  sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk"]),
  content: z.object({
    type: z.string().min(1).max(64),
    text: z.string().optional(),
  }).passthrough(),
}).passthrough();

const toolKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

const toolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
const toolLocationSchema = z.object({
  path: z.string().min(1).max(4_096),
}).passthrough();
const toolContentSchema = z.object({
  type: z.string().min(1).max(64),
  path: z.string().min(1).max(4_096).optional(),
}).passthrough();
const toolCallUpdateSchema = z.object({
  sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
  toolCallId: z.string().min(1).max(1_024),
  title: z.string().max(1_024).nullish(),
  kind: toolKindSchema.nullish(),
  status: toolStatusSchema.nullish(),
  content: z.array(toolContentSchema).max(256).nullish(),
  locations: z.array(toolLocationSchema).max(256).nullish(),
}).passthrough();

const permissionRequestWireSchema = z.object({
  sessionId: z.string().min(1).max(1_024),
  toolCall: z.object({
    toolCallId: z.string().min(1).max(1_024),
    title: z.string().max(1_024).nullish(),
    kind: toolKindSchema.nullish(),
    status: toolStatusSchema.nullish(),
    locations: z.array(toolLocationSchema).max(256).nullish(),
  }).passthrough(),
  options: z.array(z.object({
    optionId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
  }).passthrough()).min(1).max(16),
}).passthrough();

function parseTolerantSessionNotification(value: unknown): SessionNotification | null {
  const base = sessionNotificationBaseSchema.parse(value);
  const discriminator = base.update.sessionUpdate;
  if (
    discriminator === "agent_message_chunk" ||
    discriminator === "agent_thought_chunk"
  ) {
    const update = textUpdateSchema.parse(base.update);
    if (update.content.type !== "text") return null;
    if (update.content.text === undefined) {
      throw new AcpUpdateError("ACP text update omitted its text payload");
    }
    return {
      sessionId: base.sessionId,
      update: {
        sessionUpdate: update.sessionUpdate,
        content: { type: "text", text: update.content.text },
      },
    } as SessionNotification;
  }
  if (discriminator === "tool_call" || discriminator === "tool_call_update") {
    const update = toolCallUpdateSchema.parse(base.update);
    if (update.sessionUpdate === "tool_call" && update.title == null) {
      throw new AcpUpdateError("ACP tool-call update omitted its title");
    }
    const content = (update.content ?? [])
      .filter((item) => item.type === "diff" && item.path !== undefined)
      .map((item) => ({ type: "diff", path: item.path as string, newText: "" }));
    return {
      sessionId: base.sessionId,
      update: {
        sessionUpdate: update.sessionUpdate,
        toolCallId: update.toolCallId,
        ...(update.title == null ? {} : { title: update.title }),
        ...(update.kind == null ? {} : { kind: update.kind }),
        ...(update.status == null ? {} : { status: update.status }),
        ...(content.length === 0 ? {} : { content }),
        ...(update.locations == null
          ? {}
          : {
              locations: update.locations.map((location) => ({
                path: location.path,
              })),
            }),
      },
    } as SessionNotification;
  }
  if (discriminator === "current_mode_update") {
    const update = z.object({
      sessionUpdate: z.literal("current_mode_update"),
      currentModeId: z.string().min(1).max(256),
    }).passthrough().parse(base.update);
    return { sessionId: base.sessionId, update } as SessionNotification;
  }
  if (discriminator === "config_option_update") {
    const update = z.object({
      sessionUpdate: z.literal("config_option_update"),
      configOptions: z.array(configOptionSchema).max(128),
    }).passthrough().parse(base.update);
    return { sessionId: base.sessionId, update } as SessionNotification;
  }
  return null;
}

function sanitizePermissionRequest(value: unknown): RequestPermissionRequest {
  const parsed = permissionRequestWireSchema.parse(value);
  return {
    sessionId: parsed.sessionId,
    toolCall: {
      toolCallId: parsed.toolCall.toolCallId,
      ...(parsed.toolCall.title == null ? {} : { title: parsed.toolCall.title }),
      ...(parsed.toolCall.kind == null ? {} : { kind: parsed.toolCall.kind }),
      ...(parsed.toolCall.status == null ? {} : { status: parsed.toolCall.status }),
      ...(parsed.toolCall.locations == null
        ? {}
        : {
            locations: parsed.toolCall.locations.map((location) => ({
              path: location.path,
            })),
          }),
    },
    options: parsed.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}

export function sanitizeAcpStream(
  stream: Stream,
  allowSessionTraffic: boolean,
): Stream {
  const transformer = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      const record = message as unknown as Record<string, unknown>;
      if (record.method === methods.client.session.update) {
        const notification = parseTolerantSessionNotification(record.params);
        if (notification === null) return;
        if (!allowSessionTraffic) {
          throw new AcpUpdateError(
            "ACP session update arrived outside a runtime turn",
          );
        }
        controller.enqueue({ ...message, params: notification } as AnyMessage);
        return;
      }
      if (record.method === methods.client.session.requestPermission) {
        if (!allowSessionTraffic) {
          throw new AcpUpdateError("ACP permission arrived outside a runtime turn");
        }
        controller.enqueue({
          ...message,
          params: sanitizePermissionRequest(record.params),
        } as AnyMessage);
        return;
      }
      controller.enqueue(message);
    },
  });
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(transformer),
  };
}
