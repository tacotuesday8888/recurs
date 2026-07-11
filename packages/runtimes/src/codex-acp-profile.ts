import { realpathSync, statSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { NewSessionResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { z } from "zod";

import {
  authenticateAcpRuntime,
  inspectAcpRuntime,
  inspectAcpRuntimeExtension,
  probeAcpRuntimeMapping,
  type AcpAuthenticationResult,
  type AcpRuntimeInspection,
} from "./acp-runtime.js";
import {
  createAcpRuntimeProfile,
  deepFreeze,
  type AcpRuntimeProfile,
  type AcpSessionMapping,
} from "./acp-profile.js";

export const CODEX_ACP_ADAPTER_VERSION = "1.1.2";
export const CODEX_ACP_ADAPTER_INTEGRITY =
  "sha512-qE/R1WdqJJ9OFHsHGvbmVmS2j9iCMZzpWT3g2XIViXrGHu1fLOALLINBIlW+WzKDllCh131aB6cqcIWSt0otbw==";
export const CODEX_CLI_VERSION = "0.144.0";
export const CODEX_CLI_INTEGRITY =
  "sha512-QFh6f+v5QUx/Vg0HjIl9HB94p7aDLBDkZjc4IXX5RXUcXHPVCZNb6Hl2R49Og/fqW7orgZkeDcgWfRANUa1WoQ==";
export const CODEX_ACP_PROFILE_REVISION =
  "codex-acp-1.1.2-codex-0.144.0-plan-only-v1";
export const CODEX_ACP_ADAPTER_ID = "codex-acp";
export const CODEX_PLAN_MODE_ID = "read-only";

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly main?: unknown;
  readonly bin?: unknown;
  readonly os?: unknown;
  readonly cpu?: unknown;
}

interface PlatformArtifact {
  readonly id: string;
  readonly suffix: string;
  readonly integrity: string;
  readonly os: string;
  readonly cpu: string;
}

const platformArtifacts: Readonly<Record<string, PlatformArtifact>> = deepFreeze({
  "darwin-arm64": {
    id: "@openai/codex-darwin-arm64",
    suffix: "darwin-arm64",
    integrity:
      "sha512-rqFAJdOa2I0VRgepVsSZeLxs96+Y+LXTjccOOvH6894FyaFAYPZ/o+6hgpB1iGHxxdoY/DsGa8jrJC8Leqn9Kg==",
    os: "darwin",
    cpu: "arm64",
  },
  "darwin-x64": {
    id: "@openai/codex-darwin-x64",
    suffix: "darwin-x64",
    integrity:
      "sha512-4p2jxRbN+Khg5UQzpkzT9upFj+qkEF/abmdvrtflkkWmVKP6Nt+yi8ospdqv9PDqvQ9SotPvX7iXaFaeUTrtmA==",
    os: "darwin",
    cpu: "x64",
  },
  "linux-arm64": {
    id: "@openai/codex-linux-arm64",
    suffix: "linux-arm64",
    integrity:
      "sha512-k++xhZrn9P3laO00Q92APG6mdOFDD66nUBo+8ExCa1NXi2pjLEMLC4+UNJTUUtUT1PEflOZ5pDKxPXgzaiFFFg==",
    os: "linux",
    cpu: "arm64",
  },
  "linux-x64": {
    id: "@openai/codex-linux-x64",
    suffix: "linux-x64",
    integrity:
      "sha512-GmKtQeX+cO9lN7mQD1FEVcXYEMLMgMByHwZdvlluH0bj/+c2ind3hwbRtE3eECFDekNhEiB80Ez0FfbkyFQqoA==",
    os: "linux",
    cpu: "x64",
  },
  "win32-arm64": {
    id: "@openai/codex-win32-arm64",
    suffix: "win32-arm64",
    integrity:
      "sha512-e2yGSgwdzrT1SoJMoOzWD58WBEsIaAMZpEchuV2VGkE2T955SG7dn7EyVQTQcy7/rdpE8aEDktZ/1eQQfjkdtQ==",
    os: "win32",
    cpu: "arm64",
  },
  "win32-x64": {
    id: "@openai/codex-win32-x64",
    suffix: "win32-x64",
    integrity:
      "sha512-QiholLCYqNeYvNM77HOmPtrOFrY0rQc/N9nXt+sQGXO3rEGmcWjpLzujY4Oegl3CLRHoieWqlep3EqEvFBjoIA==",
    os: "win32",
    cpu: "x64",
  },
});

const allowedEnvironmentKeys = Object.freeze([
  "APPDATA",
  "CODEX_HOME",
  "COLORTERM",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_BROWSER",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "XDG_RUNTIME_DIR",
]);

export interface CodexAcpInstallation {
  readonly adapterEntry: string;
  readonly adapterPackageJson: string;
  readonly adapterVersion: typeof CODEX_ACP_ADAPTER_VERSION;
  readonly codexPackageJson: string;
  readonly codexVersion: typeof CODEX_CLI_VERSION;
  readonly platformPackageId: string;
  readonly platformPackageJson: string;
  readonly platformVersion: string;
  readonly platformIntegrity: string;
}

function readPackage(packageJsonPath: string): PackageJson {
  const value = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Installed Codex package metadata is invalid");
  }
  return value as PackageJson;
}

function realContainedFile(root: string, candidate: string, label: string): string {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !statSync(realCandidate).isFile()
  ) {
    throw new TypeError(`${label} is outside its reviewed package`);
  }
  return realCandidate;
}

export function resolveCodexAcpInstallation(): CodexAcpInstallation {
  const require = createRequire(import.meta.url);
  const adapterPackageJson = realpathSync(
    require.resolve("@agentclientprotocol/codex-acp/package.json"),
  );
  const adapterPackage = readPackage(adapterPackageJson);
  const adapterRoot = path.dirname(adapterPackageJson);
  if (
    adapterPackage.name !== "@agentclientprotocol/codex-acp" ||
    adapterPackage.version !== CODEX_ACP_ADAPTER_VERSION ||
    adapterPackage.main !== "dist/index.js" ||
    typeof adapterPackage.bin !== "object" ||
    adapterPackage.bin === null ||
    (adapterPackage.bin as Record<string, unknown>)["codex-acp"] !==
      "dist/index.js"
  ) {
    throw new TypeError("Installed Codex ACP adapter is not the reviewed release");
  }
  const adapterEntry = realContainedFile(
    adapterRoot,
    path.join(adapterRoot, adapterPackage.main),
    "Codex ACP entry",
  );

  const codexPackageJson = realpathSync(require.resolve("@openai/codex/package.json"));
  const codexPackage = readPackage(codexPackageJson);
  if (
    codexPackage.name !== "@openai/codex" ||
    codexPackage.version !== CODEX_CLI_VERSION
  ) {
    throw new TypeError("Installed Codex CLI is not the reviewed release");
  }

  const artifact = platformArtifacts[`${process.platform}-${process.arch}`];
  if (artifact === undefined) {
    throw new TypeError("This platform has no reviewed Codex executable artifact");
  }
  const platformPackageJson = realpathSync(
    require.resolve(`${artifact.id}/package.json`),
  );
  const platformPackage = readPackage(platformPackageJson);
  const platformVersion = `${CODEX_CLI_VERSION}-${artifact.suffix}`;
  if (
    platformPackage.name !== "@openai/codex" ||
    platformPackage.version !== platformVersion ||
    !Array.isArray(platformPackage.os) ||
    platformPackage.os.length !== 1 ||
    platformPackage.os[0] !== artifact.os ||
    !Array.isArray(platformPackage.cpu) ||
    platformPackage.cpu.length !== 1 ||
    platformPackage.cpu[0] !== artifact.cpu
  ) {
    throw new TypeError("Installed Codex platform artifact is not the reviewed release");
  }
  return deepFreeze({
    adapterEntry,
    adapterPackageJson,
    adapterVersion: CODEX_ACP_ADAPTER_VERSION,
    codexPackageJson,
    codexVersion: CODEX_CLI_VERSION,
    platformPackageId: artifact.id,
    platformPackageJson,
    platformVersion,
    platformIntegrity: artifact.integrity,
  });
}

function validateConfiguredCodexHome(): void {
  const configured = process.env.CODEX_HOME;
  if (configured === undefined) return;
  if (
    configured.trim() !== configured ||
    !path.isAbsolute(configured) ||
    configured.includes("\0") ||
    !statSync(configured).isDirectory()
  ) {
    throw new TypeError("CODEX_HOME must name an existing absolute directory");
  }
}

export interface CreateCodexAcpProfileInput {
  readonly connectionId: string;
  readonly modelId: string;
}

function codexMapping(
  modelId: string,
  permissionMode: "ask_always" | "approved_for_me" | "full_access",
): AcpSessionMapping {
  return {
    modelId,
    executionMode: "plan",
    permissionMode,
    modeId: CODEX_PLAN_MODE_ID,
    configOptions: [
      { configId: "mode", value: CODEX_PLAN_MODE_ID },
      { configId: "model", value: modelId },
    ],
  };
}

export function createCodexAcpProfile(
  input: CreateCodexAcpProfileInput,
): AcpRuntimeProfile {
  validateConfiguredCodexHome();
  const installation = resolveCodexAcpInstallation();
  return createAcpRuntimeProfile({
    adapterId: CODEX_ACP_ADAPTER_ID,
    connectionId: input.connectionId,
    capabilityProfileRevision: CODEX_ACP_PROFILE_REVISION,
    protocol: "acp",
    protocolVersion: 1,
    command: process.execPath,
    args: [installation.adapterEntry],
    clientInfo: { name: "recurs", version: "0.0.0", title: "Recurs" },
    allowedEnvironmentKeys,
    usageSemantics: "prompt_response",
    mappings: [
      codexMapping(input.modelId, "ask_always"),
      codexMapping(input.modelId, "approved_for_me"),
      codexMapping(input.modelId, "full_access"),
    ],
    capabilities: {
      resume: true,
      cancellation: "protocol",
      fileEvents: true,
      usageEvents: true,
      supportedPermissionModes: [
        "ask_always",
        "approved_for_me",
        "full_access",
      ],
      approvalControl: "host",
      planMode: "enforced",
      toolExecution: "opaque",
      checkpointing: "none",
    },
    bounds: {
      maxFrameBytes: 1024 * 1024,
      maxStdinBytes: 2 * 1024 * 1024,
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 128 * 1024,
      maxFrames: 20_000,
      maxInboundQueueMessages: 512,
      maxInboundQueueBytes: 4 * 1024 * 1024,
      maxEvents: 10_000,
      maxEventBytes: 16 * 1024 * 1024,
      maxEventQueueEvents: 512,
      maxEventQueueBytes: 4 * 1024 * 1024,
      startupTimeoutMs: 30_000,
      promptTimeoutMs: 30 * 60 * 1_000,
      cancelSettlementTimeoutMs: 10_000,
      shutdownTimeoutMs: 5_000,
    },
  });
}

const codexStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unauthenticated") }).strict(),
  z.object({ type: z.literal("api-key") }).strict(),
  z.object({
    type: z.literal("chat-gpt"),
    email: z.string().max(320),
  }).strict(),
  z.object({
    type: z.literal("gateway"),
    name: z.string().min(1).max(256),
  }).strict(),
]);

export type CodexAcpAuthenticationStatus = z.infer<typeof codexStatusSchema>;

export interface CodexAcpInspection {
  readonly inspection: AcpRuntimeInspection;
  readonly status: CodexAcpAuthenticationStatus;
}

export async function inspectCodexAcp(
  profile: AcpRuntimeProfile,
  signal: AbortSignal,
): Promise<CodexAcpInspection> {
  const inspection = await inspectAcpRuntime(profile, signal);
  const status = await inspectAcpRuntimeExtension(
    profile,
    "authentication/status",
    (value) => codexStatusSchema.parse(value),
    signal,
  );
  return deepFreeze({ inspection, status });
}

export async function authenticateCodexAcpChatGpt(
  profile: AcpRuntimeProfile,
  signal: AbortSignal,
): Promise<AcpAuthenticationResult> {
  return await authenticateAcpRuntime(profile, "chat-gpt", signal);
}

function flattenedValues(option: SessionConfigOption): readonly string[] {
  if (option.type === "boolean") return [];
  return option.options.flatMap((candidate) =>
    "value" in candidate
      ? [candidate.value]
      : candidate.options.map((nested) => nested.value)
  );
}

function selectProbeMapping(
  state: NewSessionResponse,
  requestedModelId: string | undefined,
): AcpSessionMapping {
  const mode = state.configOptions?.find((option) => option.id === "mode");
  const model = state.configOptions?.find((option) => option.id === "model");
  if (
    !state.modes?.availableModes.some((candidate) =>
      candidate.id === CODEX_PLAN_MODE_ID
    ) ||
    mode === undefined ||
    mode.category !== "mode" ||
    !flattenedValues(mode).includes(CODEX_PLAN_MODE_ID) ||
    model === undefined ||
    model.category !== "model" ||
    model.type === "boolean"
  ) {
    throw new TypeError("Codex did not expose the reviewed model and mode controls");
  }
  const selectedModel = requestedModelId ??
    (typeof model.currentValue === "string" ? model.currentValue : undefined);
  if (
    selectedModel === undefined ||
    !flattenedValues(model).includes(selectedModel)
  ) {
    throw new TypeError("Selected Codex model is unavailable");
  }
  return codexMapping(selectedModel, "ask_always");
}

export interface ProbeCodexAcpInput {
  readonly profile: AcpRuntimeProfile;
  readonly cwd: string;
  readonly modelId?: string;
}

export interface CodexAcpProbeResult {
  readonly modelId: string;
  readonly modeId: typeof CODEX_PLAN_MODE_ID;
  readonly executionMode: "plan";
}

export async function probeCodexAcp(
  input: ProbeCodexAcpInput,
  signal: AbortSignal,
): Promise<CodexAcpProbeResult> {
  const mapping = await probeAcpRuntimeMapping(
    input.profile,
    input.cwd,
    (state) => selectProbeMapping(state, input.modelId),
    signal,
  );
  return deepFreeze({
    modelId: mapping.modelId,
    modeId: CODEX_PLAN_MODE_ID,
    executionMode: "plan",
  });
}
