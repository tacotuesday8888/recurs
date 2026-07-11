import path from "node:path";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { RuntimeCapabilities } from "@recurs/contracts";

import type { AcpConfigSelection } from "./acp-updates.js";
import {
  validateAcpProcessBounds,
  type AcpProcessBounds,
} from "./process-supervisor.js";

export type AcpPermissionMode =
  | "ask_always"
  | "approved_for_me"
  | "full_access";

export interface AcpSessionMapping {
  readonly modelId: string;
  readonly executionMode: "act" | "plan";
  readonly permissionMode: AcpPermissionMode;
  readonly modeId: string | null;
  readonly configOptions: readonly AcpConfigSelection[];
}

export interface AcpRuntimeBounds extends AcpProcessBounds {
  readonly maxEvents: number;
  readonly maxEventBytes: number;
  readonly maxEventQueueEvents: number;
  readonly maxEventQueueBytes: number;
  readonly promptTimeoutMs: number;
  readonly cancelSettlementTimeoutMs: number;
}

export interface AcpRuntimeProfile {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly capabilityProfileRevision: string;
  readonly protocol: "acp";
  readonly protocolVersion: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
    readonly title?: string;
  };
  readonly allowedEnvironmentKeys: readonly string[];
  readonly usageSemantics: "prompt_response" | "unavailable";
  readonly mappings: readonly AcpSessionMapping[];
  readonly capabilities: RuntimeCapabilities;
  readonly bounds: AcpRuntimeBounds;
}

export const ACP_TERMINAL_EVENT_RESERVE_BYTES = 1_024;
export const SAFE_ACP_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const secretCanary =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{8,}|\b(?:api[_ -]?key|token|secret|password|credential|cookie)\s*[:=])/iu;

export function containsSecretCanary(value: string): boolean {
  return secretCanary.test(value) || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_ACP_IDENTIFIER_PATTERN.test(value) || containsSecretCanary(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function cloneCapabilities(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  return {
    resume: capabilities.resume,
    cancellation: capabilities.cancellation,
    fileEvents: capabilities.fileEvents,
    usageEvents: capabilities.usageEvents,
    supportedPermissionModes: [...capabilities.supportedPermissionModes],
    approvalControl: capabilities.approvalControl,
    planMode: capabilities.planMode,
    toolExecution: capabilities.toolExecution,
    checkpointing: capabilities.checkpointing,
    ...(capabilities.containmentProfileId === undefined
      ? {}
      : { containmentProfileId: capabilities.containmentProfileId }),
  };
}

export function createAcpRuntimeProfile(input: AcpRuntimeProfile): AcpRuntimeProfile {
  if (input.protocol !== "acp" || input.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError("ACP profile must pin the supported protocol version");
  }
  if (!path.isAbsolute(input.command) || input.command.includes("\0")) {
    throw new TypeError("ACP profile command must be absolute");
  }
  if (
    input.args.length > 128 ||
    input.args.some((argument) =>
      argument.includes("\0") ||
      Buffer.byteLength(argument) > 8_192 ||
      containsSecretCanary(argument)
    )
  ) {
    throw new TypeError("ACP profile arguments are invalid or oversized");
  }
  assertSafeIdentifier(input.adapterId, "adapterId");
  assertSafeIdentifier(input.connectionId, "connectionId");
  assertSafeIdentifier(input.capabilityProfileRevision, "capabilityProfileRevision");
  if (input.clientInfo.name !== "recurs") {
    throw new TypeError("ACP clientInfo must identify Recurs");
  }
  if (
    input.clientInfo.version.length === 0 ||
    input.clientInfo.version.length > 128 ||
    containsSecretCanary(input.clientInfo.version) ||
    (input.clientInfo.title !== undefined &&
      (input.clientInfo.title.length === 0 ||
        input.clientInfo.title.length > 256 ||
        containsSecretCanary(input.clientInfo.title)))
  ) {
    throw new TypeError("ACP clientInfo is invalid");
  }
  validateAcpProcessBounds(input.bounds);
  assertPositive(input.bounds.maxEvents, "maxEvents");
  assertPositive(input.bounds.maxEventBytes, "maxEventBytes");
  assertPositive(input.bounds.maxEventQueueEvents, "maxEventQueueEvents");
  assertPositive(input.bounds.maxEventQueueBytes, "maxEventQueueBytes");
  if (
    input.bounds.maxEvents < 2 ||
    input.bounds.maxEventBytes < ACP_TERMINAL_EVENT_RESERVE_BYTES ||
    input.bounds.maxEventQueueEvents < 2 ||
    input.bounds.maxEventQueueBytes < ACP_TERMINAL_EVENT_RESERVE_BYTES
  ) {
    throw new TypeError("ACP event bounds do not reserve a bounded terminal event");
  }
  assertPositive(input.bounds.promptTimeoutMs, "promptTimeoutMs");
  assertPositive(
    input.bounds.cancelSettlementTimeoutMs,
    "cancelSettlementTimeoutMs",
  );
  if (
    input.capabilities.cancellation !== "protocol" ||
    input.capabilities.toolExecution === "recurs_os_containment" ||
    input.capabilities.containmentProfileId !== undefined
  ) {
    throw new TypeError("ACP profile claims unsupported containment capability");
  }
  if (input.capabilities.toolExecution === "host_tools") {
    throw new TypeError(
      "ACP host tool transport is not implemented in this profile version",
    );
  }
  if (
    input.capabilities.supportedPermissionModes.length === 0 ||
    new Set(input.capabilities.supportedPermissionModes).size !==
      input.capabilities.supportedPermissionModes.length
  ) {
    throw new TypeError("ACP profile permission modes are invalid");
  }
  if (
    input.capabilities.checkpointing !== "none" ||
    input.capabilities.usageEvents !==
      (input.usageSemantics === "prompt_response")
  ) {
    throw new TypeError("ACP profile capability metadata is inconsistent");
  }
  if (input.mappings.length === 0 || input.mappings.length > 128) {
    throw new TypeError("ACP profile must contain bounded reviewed mappings");
  }
  const mappingKeys = new Set<string>();
  for (const mapping of input.mappings) {
    assertSafeIdentifier(mapping.modelId, "mapping modelId");
    if (!input.capabilities.supportedPermissionModes.includes(mapping.permissionMode)) {
      throw new TypeError("ACP mapping uses an unsupported permission mode");
    }
    if (
      mapping.executionMode === "plan" &&
      input.capabilities.planMode !== "enforced"
    ) {
      throw new TypeError("ACP Plan mapping must be enforced by the runtime");
    }
    if (mapping.modeId !== null) {
      assertSafeIdentifier(mapping.modeId, "mapping modeId");
    }
    const key = `${mapping.modelId}\0${mapping.executionMode}\0${mapping.permissionMode}`;
    if (mappingKeys.has(key)) throw new TypeError("ACP profile has duplicate mappings");
    mappingKeys.add(key);
    const configIds = new Set<string>();
    for (const config of mapping.configOptions) {
      assertSafeIdentifier(config.configId, "mapping configId");
      if (configIds.has(config.configId)) {
        throw new TypeError("ACP mapping has duplicate config options");
      }
      configIds.add(config.configId);
      if (typeof config.value === "string") {
        assertSafeIdentifier(config.value, "mapping config value");
      }
    }
  }

  const cloned: AcpRuntimeProfile = {
    adapterId: input.adapterId,
    connectionId: input.connectionId,
    capabilityProfileRevision: input.capabilityProfileRevision,
    protocol: "acp",
    protocolVersion: input.protocolVersion,
    command: input.command,
    args: [...input.args],
    clientInfo: {
      name: input.clientInfo.name,
      version: input.clientInfo.version,
      ...(input.clientInfo.title === undefined
        ? {}
        : { title: input.clientInfo.title }),
    },
    allowedEnvironmentKeys: [...input.allowedEnvironmentKeys],
    usageSemantics: input.usageSemantics,
    mappings: input.mappings.map((mapping) => ({
      modelId: mapping.modelId,
      executionMode: mapping.executionMode,
      permissionMode: mapping.permissionMode,
      modeId: mapping.modeId,
      configOptions: mapping.configOptions.map((option) => ({ ...option })),
    })),
    capabilities: cloneCapabilities(input.capabilities),
    bounds: { ...input.bounds },
  };

  for (const key of cloned.allowedEnvironmentKeys) {
    if (
      !/^[A-Z_][A-Z0-9_]*$/u.test(key) ||
      /(api.?key|token|secret|password|credential|cookie|auth|proxy)/iu.test(key) ||
      /^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|PROMPT_COMMAND|IFS|DYLD_.+|LD_.+)$/u.test(key)
    ) {
      throw new TypeError("ACP profile environment allowlist is unsafe");
    }
  }
  if (
    new Set(cloned.allowedEnvironmentKeys).size !==
      cloned.allowedEnvironmentKeys.length
  ) {
    throw new TypeError("ACP profile environment allowlist has duplicates");
  }
  return deepFreeze(cloned);
}
