import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout,
} from "node:process";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

import {
  createHostInvocation,
  MAX_MODEL_IMAGES,
  parseOperatingModeId,
  RECURS_VERSION,
  type OperatingModeId,
  type CompanyBlueprint,
  type CompanyEvaluationReportV1,
  type IntegrationFailure,
  type ModelReasoningEffort,
  type RunResult,
  type TeamRunRole,
} from "@recurs/contracts";
import {
  detectLocalRuntimes,
  ProviderError,
  type EnvironmentModelDescriptor,
  type LocalRuntimeDetection,
  type ProviderCatalogSnapshot,
} from "@recurs/providers";
import type { ExecutionMode, PermissionMode, PtyDriver } from "@recurs/tools";
import {
  CodexOnboardingError,
  ConnectionLifecycleError,
  discoverEnvironmentConnectionModels,
  EnvironmentConnectionError,
  setupEnvironmentConnection,
  type ConnectionDisconnection,
  type AgentRouteAssignment,
  type ConnectionVerification,
  type EnvironmentConnectionConfiguration,
} from "@recurs/app";
import { CoordinatedRunError, type EventSink } from "@recurs/core";

import {
  createStandaloneCompanyOnboarding,
  createStandaloneRuntime,
} from "./assembly.js";
import { serveRecursAcpStdio } from "./acp-server.js";
import { setupCodexSubscription } from "./codex-connection.js";
import { CLI_HELP, parseCliHelpRequest } from "./cli-help.js";
import {
  CompanyEvaluationArgumentError,
  parseCompanyEvaluationCommand,
  renderCompanyEvaluationScenarios,
  runCompanyEvaluationCommand,
  type CompanyEvaluationCommandOptions,
  type CompanyEvaluationRunOptions,
} from "./company-evaluation-command.js";
import { renderCompanyEvaluationReport } from "./company-evaluation.js";
import type { CompanyEvaluationProgress } from "./company-evaluation.js";
import {
  createDoctorReport,
  renderDoctorReport,
  type DoctorReport,
} from "./doctor.js";
import { parsePermissionMode } from "./commands/permissions.js";
import type { CommandResult } from "./commands/types.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { ImageInputError, loadImageInputs } from "./image-input.js";
import {
  listAccountSummaries,
  listProviderSummaries,
  disconnectAccount,
  setAccountAgentRoute,
  setAccountAgentRoutes,
  setPrimaryAccount,
  verifyAccount,
  type AccountSummary,
  type ProviderSummary,
} from "./provider-account.js";
import {
  discoverProviderCatalog,
  environmentModelsText,
  localRuntimeText,
  providerCatalogText,
} from "./provider-discovery.js";
import {
  isSafeCredentialEnvironmentVariable,
  isSafeModelId,
  inspectCompanyRepositoryFacts,
  runGuidedOnboarding as runGuidedOnboardingFlow,
  type GuidedChoice,
  type GuidedOnboardingOutcome,
} from "./guided-onboarding.js";
import {
  createProjectInstructions,
  discoverProjectInstructions,
} from "./project-instructions.js";
import {
  LocalConnectionError,
  setupLocalConnection,
  type LocalConnectionConfiguration,
} from "./local-connection.js";
import {
  JsonlEventRenderer,
  TextEventRenderer,
  renderCommandResult,
  writeOutput,
} from "./render.js";
import { startRepl } from "./repl.js";
import {
  RuntimeError,
  isCancellation,
  type RecursRuntime,
} from "./runtime.js";

const help = CLI_HELP;

export interface CliDependencies {
  stdout: Writable;
  stderr: Writable;
  stdin?: Readable;
  cwd?: string;
  interactive?: boolean;
  automation?: boolean;
  signal?: AbortSignal;
  confirm?(message: string): Promise<boolean>;
  selectChoice?(
    message: string,
    choices: readonly GuidedChoice[],
  ): Promise<string | null>;
  promptText?(message: string, suggestion?: string): Promise<string | null>;
  inspectCompanyRepositoryFacts?(
    cwd: string,
  ): ReturnType<typeof inspectCompanyRepositoryFacts>;
  createCompanyOnboarding?(input: {
    readonly permissionMode: PermissionMode;
    readonly operatingModeId: OperatingModeId;
    readonly repositoryConsent: boolean;
    readonly cwd: string;
  }): ReturnType<typeof createStandaloneCompanyOnboarding>;
  evaluateCompany?(input: CompanyEvaluationRunOptions & {
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (
      progress: CompanyEvaluationProgress,
    ) => void | Promise<void>;
  }): Promise<CompanyEvaluationReportV1>;
  credentialEnvironmentAvailable?(name: string): boolean;
  doctor?(cwd: string, signal?: AbortSignal): Promise<DoctorReport>;
  createRuntime(
    events: EventSink,
    options?: {
      readonly operatingModeId?: OperatingModeId;
      readonly permissionMode?: PermissionMode;
      readonly executionMode?: ExecutionMode;
      readonly connectionId?: string;
      readonly cwd?: string;
      readonly reuseExistingSession?: boolean;
      readonly resumeSessionId?: string;
      readonly companyBlueprint?: CompanyBlueprint;
    },
  ): Promise<RecursRuntime>;
  runAcp?(): Promise<void>;
  setupLocal?(input: {
    baseUrl: string;
    modelId: string;
    signal?: AbortSignal;
  }): Promise<Pick<LocalConnectionConfiguration, "id" | "label" | "baseUrl" | "modelId" | "primary">>;
  setupCodex?(input: {
    cwd: string;
    interactive: true;
    billingSelection: "allow_declared_additional";
    signal?: AbortSignal;
  }): Promise<{
    readonly id: string;
    readonly label: string;
    readonly modelId: string;
    readonly planOnly: boolean;
    readonly primary: boolean;
    readonly configuredModels?: readonly string[];
  }>;
  setupEnvironment?(input: {
    providerId: string;
    modelId: string;
    credentialEnvironmentVariable: string;
    billingSelection: "strict_primary_only" | "allow_declared_additional";
    reasoningEffort?: ModelReasoningEffort;
  }, signal?: AbortSignal): Promise<EnvironmentConnectionConfiguration>;
  listProviders?(input: {
    includeBlocked: boolean;
  }): Promise<readonly ProviderSummary[]>;
  discoverProviders?(
    query: string,
    signal?: AbortSignal,
  ): Promise<ProviderCatalogSnapshot>;
  discoverEnvironmentModels?(
    providerId: string,
    credentialEnvironmentVariable: string,
    signal?: AbortSignal,
  ): Promise<readonly EnvironmentModelDescriptor[]>;
  detectProviders?(
    signal?: AbortSignal,
  ): Promise<readonly LocalRuntimeDetection[]>;
  listAccounts?(): Promise<readonly AccountSummary[]>;
  setPrimaryAccount?(id: string, signal?: AbortSignal): Promise<AccountSummary>;
  setAccountAgentRoute?(
    role: TeamRunRole,
    id: string | null,
    signal?: AbortSignal,
  ): Promise<AgentRouteAssignment>;
  setAccountAgentRoutes?(
    assignments: readonly AgentRouteAssignment[],
    signal?: AbortSignal,
  ): Promise<readonly AgentRouteAssignment[]>;
  verifyAccount?(
    id: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ConnectionVerification>;
  disconnectAccount?(id: string): Promise<ConnectionDisconnection>;
}

interface RunArguments {
  prompt: string;
  stdinMode: "none" | "replace" | "append";
  format: "text" | "json" | "jsonl";
  permissionMode?: PermissionMode;
  executionMode?: ExecutionMode;
  operatingModeId?: OperatingModeId;
  connectionId?: string;
  resumeSessionId?: string;
  imagePaths: readonly string[];
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_STDIN_PROMPT_BYTES = 1024 * 1024;
const MAX_WORKING_ROOT_BYTES = 4_096;

interface WorkingRootArguments {
  readonly argv: readonly string[];
  readonly requested?: string;
}

function extractWorkingRoot(
  argv: readonly string[],
): WorkingRootArguments | null {
  let requested: string | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument !== "-C" && argument !== "--cd") {
      remaining.push(argument);
      continue;
    }
    const value = argv[index + 1];
    if (
      requested !== undefined ||
      value === undefined ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_WORKING_ROOT_BYTES ||
      value.includes("\0")
    ) {
      return null;
    }
    requested = value;
    index += 1;
  }
  return {
    argv: remaining,
    ...(requested === undefined ? {} : { requested }),
  };
}

async function canonicalWorkingRoot(
  requested: string,
  base: string,
): Promise<string> {
  try {
    const canonical = await realpath(path.resolve(base, requested));
    if (!(await stat(canonical)).isDirectory()) throw new TypeError();
    return canonical;
  } catch {
    throw new RuntimeError(
      "invalid_input",
      "The requested working directory is unavailable",
    );
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError";
}

function parseAgentArguments(
  command: "run" | "review",
  args: readonly string[],
): RunArguments | null {
  let format: RunArguments["format"] = "text";
  let permissionMode: PermissionMode | undefined;
  let executionMode: ExecutionMode | undefined;
  let operatingModeId: OperatingModeId | undefined;
  let connectionId: string | undefined;
  let resumeSessionId: string | undefined;
  let appendStdin = false;
  const imagePaths: string[] = [];
  const prompt: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--format") {
      const value = args[index + 1];
      if (value !== "text" && value !== "json" && value !== "jsonl") {
        return null;
      }
      format = value;
      index += 1;
      continue;
    }
    if (argument === "--permissions") {
      const value = args[index + 1];
      if (value === undefined || permissionMode !== undefined) return null;
      const parsed = parsePermissionMode(value);
      if (parsed === null) return null;
      permissionMode = parsed;
      index += 1;
      continue;
    }
    if (argument === "--plan") {
      if (executionMode !== undefined || command === "review") return null;
      executionMode = "plan";
      continue;
    }
    if (argument === "--mode") {
      if (operatingModeId !== undefined) return null;
      const value = args[index + 1];
      const parsed = value === undefined ? null : parseOperatingModeId(value);
      if (parsed === null) return null;
      operatingModeId = parsed;
      index += 1;
      continue;
    }
    if (argument === "--connection") {
      const value = args[index + 1];
      if (
        value === undefined ||
        connectionId !== undefined ||
        !SAFE_CONNECTION_ID.test(value)
      ) {
        return null;
      }
      connectionId = value;
      index += 1;
      continue;
    }
    if (argument === "--resume") {
      if (command === "review") return null;
      const value = args[index + 1];
      if (
        value === undefined ||
        resumeSessionId !== undefined ||
        !SAFE_SESSION_ID.test(value)
      ) {
        return null;
      }
      resumeSessionId = value;
      index += 1;
      continue;
    }
    if (argument === "--stdin") {
      if (command === "review") return null;
      if (appendStdin) return null;
      appendStdin = true;
      continue;
    }
    if (argument === "--image") {
      if (command === "review") return null;
      const value = args[index + 1];
      if (
        value === undefined || value.length === 0 ||
        imagePaths.length >= MAX_MODEL_IMAGES
      ) {
        return null;
      }
      imagePaths.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      return null;
    }
    if (command === "review") return null;
    prompt.push(argument);
  }
  if (command === "review") {
    return {
      prompt: "/review",
      stdinMode: "none",
      format,
      imagePaths: Object.freeze([]),
      executionMode: "plan",
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(operatingModeId === undefined ? {} : { operatingModeId }),
      ...(connectionId === undefined ? {} : { connectionId }),
    };
  }
  const joined = prompt.join(" ").trim();
  if (
    resumeSessionId !== undefined &&
    (
      permissionMode !== undefined ||
      operatingModeId !== undefined ||
      connectionId !== undefined ||
      executionMode !== undefined
    )
  ) {
    return null;
  }
  const replaceWithStdin = prompt.length === 1 && prompt[0] === "-";
  if (appendStdin && (joined.length === 0 || replaceWithStdin)) return null;
  return joined.length === 0
    ? null
    : {
        prompt: replaceWithStdin ? "" : joined,
        stdinMode: replaceWithStdin
          ? "replace"
          : appendStdin
          ? "append"
          : "none",
        format,
        imagePaths: Object.freeze(imagePaths),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(executionMode === undefined ? {} : { executionMode }),
        ...(operatingModeId === undefined ? {} : { operatingModeId }),
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      };
}

function stdinPrompt(
  input: Readable | undefined,
  interactive: boolean | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (input === undefined || interactive === true) {
    throw new RuntimeError(
      "invalid_input",
      "Stdin prompt input requires a non-interactive pipe",
    );
  }
  if (signal.aborted) {
    throw new RuntimeError("cancelled", "Reading the stdin prompt was cancelled");
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: RuntimeError) => {
      if (settled) return;
      settled = true;
      input.pause();
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, bytes),
        );
      } catch {
        reject(new RuntimeError(
          "invalid_input",
          "The stdin prompt must be valid UTF-8",
        ));
        return;
      }
      if (value.trim().length === 0) {
        reject(new RuntimeError("invalid_input", "The stdin prompt is empty"));
        return;
      }
      resolve(value);
    };
    const onData = (chunk: unknown) => {
      const next = typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : null;
      if (next === null) {
        fail(new RuntimeError("invalid_input", "The stdin prompt could not be read"));
        return;
      }
      bytes += next.byteLength;
      if (bytes > MAX_STDIN_PROMPT_BYTES) {
        fail(new RuntimeError(
          "invalid_input",
          `The stdin prompt exceeds ${MAX_STDIN_PROMPT_BYTES} bytes`,
        ));
        return;
      }
      chunks.push(next);
    };
    const onEnd = () => finish();
    const onError = () => fail(new RuntimeError(
      "invalid_input",
      "The stdin prompt could not be read",
    ));
    const onClose = () => {
      if (!input.readableEnded) onError();
    };
    const onAbort = () => fail(new RuntimeError(
      "cancelled",
      "Reading the stdin prompt was cancelled",
    ));
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    input.resume();
  });
}

function promptWithStdin(prompt: string, input: string): string {
  const trailingNewline = input.endsWith("\n") ? "" : "\n";
  return `${prompt}\n\n<stdin>\n${input}${trailingNewline}</stdin>`;
}

function parseLocalSetupArguments(
  args: readonly string[],
): { baseUrl: string; modelId: string } | null {
  if (args[0] !== "local") return null;
  let baseUrl: string | undefined;
  let modelId: string | undefined;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--url" && baseUrl === undefined) baseUrl = value;
    else if (flag === "--model" && modelId === undefined) modelId = value;
    else return null;
  }
  return baseUrl === undefined || modelId === undefined
    ? null
    : { baseUrl, modelId };
}

interface ByokSetupArguments {
  readonly providerId: string;
  readonly modelId: string;
  readonly credentialEnvironmentVariable: string;
  readonly billingSelection:
    | "strict_primary_only"
    | "allow_declared_additional";
  readonly reasoningEffort?: ModelReasoningEffort;
}

const SAFE_BYOK_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const BYOK_REASONING_EFFORTS = new Set<ModelReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
function parseByokSetupArguments(
  args: readonly string[],
): ByokSetupArguments | null {
  if (args[0] !== "byok") return null;
  let providerId: string | undefined;
  let modelId: string | undefined;
  let credentialEnvironmentVariable: string | undefined;
  let billingSelection: ByokSetupArguments["billingSelection"] =
    "strict_primary_only";
  let reasoningEffort: ModelReasoningEffort | undefined;
  let billingProvided = false;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--provider" && providerId === undefined) providerId = value;
    else if (flag === "--model" && modelId === undefined) modelId = value;
    else if (
      flag === "--key-env" &&
      credentialEnvironmentVariable === undefined
    ) {
      credentialEnvironmentVariable = value;
    } else if (flag === "--billing" && !billingProvided) {
      billingProvided = true;
      if (value === "strict") billingSelection = "strict_primary_only";
      else if (value === "allow-additional") {
        billingSelection = "allow_declared_additional";
      } else return null;
    } else if (
      flag === "--reasoning-effort" &&
      reasoningEffort === undefined &&
      BYOK_REASONING_EFFORTS.has(value as ModelReasoningEffort)
    ) {
      reasoningEffort = value as ModelReasoningEffort;
    } else return null;
  }
  return providerId === undefined || modelId === undefined ||
      credentialEnvironmentVariable === undefined ||
      !SAFE_BYOK_PROVIDER_ID.test(providerId) ||
      !isSafeModelId(modelId) ||
      !isSafeCredentialEnvironmentVariable(credentialEnvironmentVariable)
    ? null
    : {
        providerId,
        modelId,
        credentialEnvironmentVariable,
        billingSelection,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
}

function parseListArguments(
  args: readonly string[],
  allowAll: boolean,
): { json: boolean; includeBlocked: boolean } | null {
  if (args[0] !== "list") return null;
  let json = false;
  let includeBlocked = false;
  for (const flag of args.slice(1)) {
    if (flag === "--json" && !json) json = true;
    else if (flag === "--all" && allowAll && !includeBlocked) {
      includeBlocked = true;
    } else {
      return null;
    }
  }
  return { json, includeBlocked };
}

type ProviderCommand =
  | { readonly kind: "list"; readonly json: boolean; readonly includeBlocked: boolean }
  | { readonly kind: "catalog"; readonly json: boolean; readonly query: string }
  | { readonly kind: "detect"; readonly json: boolean }
  | {
    readonly kind: "models";
    readonly json: boolean;
    readonly providerId: string;
    readonly credentialEnvironmentVariable: string;
  };

function parseProviderCommand(args: readonly string[]): ProviderCommand | null {
  const listed = parseListArguments(args, true);
  if (listed !== null) return { kind: "list", ...listed };
  if (args[0] === "detect") {
    if (args.length === 1) return { kind: "detect", json: false };
    if (args.length === 2 && args[1] === "--json") {
      return { kind: "detect", json: true };
    }
    return null;
  }
  if (args[0] === "models") {
    let providerId: string | undefined;
    let credentialEnvironmentVariable: string | undefined;
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index];
      if (flag === "--json" && !json) {
        json = true;
        continue;
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      if (flag === "--provider" && providerId === undefined) {
        providerId = value;
      } else if (
        flag === "--key-env" &&
        credentialEnvironmentVariable === undefined
      ) {
        credentialEnvironmentVariable = value;
      } else {
        return null;
      }
      index += 1;
    }
    return providerId !== undefined &&
        credentialEnvironmentVariable !== undefined &&
        SAFE_BYOK_PROVIDER_ID.test(providerId) &&
        isSafeCredentialEnvironmentVariable(credentialEnvironmentVariable)
      ? {
          kind: "models",
          json,
          providerId,
          credentialEnvironmentVariable,
        }
      : null;
  }
  if (args[0] !== "catalog") return null;
  let json = false;
  const query: string[] = [];
  for (const argument of args.slice(1)) {
    if (argument === "--json" && !json) json = true;
    else if (argument.startsWith("--")) return null;
    else query.push(argument);
  }
  const joined = query.join(" ").trim();
  return joined.length <= 256 ? { kind: "catalog", json, query: joined } : null;
}

type AccountCommand =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "set_primary"; readonly id: string }
  | {
      readonly kind: "route";
      readonly role: TeamRunRole;
      readonly id: string | null;
    }
  | { readonly kind: "verify"; readonly id: string }
  | { readonly kind: "disconnect"; readonly id: string };

const ACCOUNT_CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function parseAccountCommand(args: readonly string[]): AccountCommand | null {
  const listed = parseListArguments(args, false);
  if (listed !== null) return { kind: "list", json: listed.json };
  if (args[0] === "route" && args.length === 3) {
    const role = args[1];
    const id = args[2];
    if ((role === "implement" || role === "review" || role === "repair") &&
      id !== undefined && (id === "parent" || ACCOUNT_CONNECTION_ID.test(id))) {
      return { kind: "route", role, id: id === "parent" ? null : id };
    }
    return null;
  }
  if (args.length !== 2) return null;
  const [action, id] = args;
  if (id === undefined || !ACCOUNT_CONNECTION_ID.test(id)) return null;
  if (action === "set-primary") return { kind: "set_primary", id };
  if (action === "verify") return { kind: "verify", id };
  if (action === "disconnect") return { kind: "disconnect", id };
  return null;
}

function providerText(providers: readonly ProviderSummary[]): string {
  if (providers.length === 0) return "No provider paths are available.\n";
  return `${providers.map((provider) => {
    const sources = [
      provider.billing.primarySource,
      ...provider.billing.possibleAdditionalSources,
    ].join(" + ");
    return [
      `${provider.id} — ${provider.displayName}`,
      `  Status: ${provider.status} (${provider.supportStatus})`,
      `  Access: ${provider.accessKind} · ${provider.adapterKind} · ${provider.protocol}`,
      `  Credential owner: ${provider.connectionOwner}`,
      `  Billing: ${sources} · fallback ${provider.billing.providerFallback}`,
      ...provider.restrictions.slice(0, 2).map(
        (restriction) => `  Restriction: ${restriction}`,
      ),
    ].join("\n");
  }).join("\n\n")}\n`;
}

function accountText(accounts: readonly AccountSummary[]): string {
  if (accounts.length === 0) return "No configured accounts.\n";
  return `${accounts.map((account) => [
    `${account.primary ? "*" : " "} ${account.id} — ${account.label}`,
    `  Provider: ${account.providerId} · ${account.adapterId}`,
    `  Model: ${account.modelId} · ${account.execution}`,
    `  Account: ${account.account}`,
    `  Team roles: ${account.agentRoles.length === 0 ? "none" : account.agentRoles.join(", ")}`,
    `  Billing: ${account.billingSources.join(" + ")}`,
  ].join("\n")).join("\n\n")}\n`;
}

function isCommandResult(value: unknown): value is CommandResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "message" ||
      value.type === "attach_process" ||
      value.type === "submit_prompt" ||
      value.type === "quit")
  );
}

function exitCodeFor(error: unknown, signal?: AbortSignal): number {
  if (signal?.aborted === true) return 130;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "cancelled"
  ) {
    return 130;
  }
  if (isCancellation(error) || isAbortError(error)) {
    return 130;
  }
  if (error instanceof RuntimeError && error.code === "cancelled") {
    return 130;
  }
  if (
    error instanceof RuntimeError &&
    (error.code === "invalid_input" || error.code === "provider_not_configured")
  ) {
    return 2;
  }
  if (error instanceof LocalConnectionError) return 2;
  if (error instanceof ImageInputError) return 2;
  if (error instanceof EnvironmentConnectionError) {
    return error.code === "cancelled" ? 130 : 2;
  }
  if (error instanceof ProviderError && error.code === "cancelled") {
    return 130;
  }
  if (error instanceof CodexOnboardingError) return 2;
  if (error instanceof ConnectionLifecycleError) {
    return error.code === "cancelled" ? 130 : 2;
  }
  if (error instanceof CoordinatedRunError && error.failure.phase === "preflight") {
    return 2;
  }
  return 1;
}

async function closeRuntime(
  runtime: RecursRuntime | undefined,
  stderr?: Writable,
): Promise<boolean> {
  if (runtime?.close === undefined) return true;
  try {
    await runtime.close();
    return true;
  } catch {
    if (stderr !== undefined) {
      await writeOutput(
        stderr,
        "Error: Runtime resources could not be closed safely\n",
      );
    }
    return false;
  }
}

function configurationFailure(error: unknown): IntegrationFailure | null {
  if (error instanceof CoordinatedRunError && error.failure.phase === "preflight") {
    return error.failure;
  }
  if (error instanceof ImageInputError) {
    return {
      domain: "runtime",
      phase: "preflight",
      code: "runtime_failed",
      safeMessage: error.message,
      diagnosticId: randomUUID(),
      retryable: false,
    };
  }
  if (
    error instanceof RuntimeError &&
    (error.code === "invalid_input" || error.code === "provider_not_configured")
  ) {
    return {
      domain: "connection",
      phase: "preflight",
      code: "connection_invalid",
      safeMessage: error.message,
      diagnosticId: randomUUID(),
      retryable: false,
      action: "select_connection",
    };
  }
  return null;
}

function terminalRunFailure(
  error: unknown,
  phase: IntegrationFailure["phase"],
): IntegrationFailure {
  if (error instanceof CoordinatedRunError) return error.failure;
  const diagnosticId = randomUUID();
  const cancelled = isCancellation(error) || isAbortError(error) ||
    (error instanceof RuntimeError && error.code === "cancelled") ||
    (error instanceof ProviderError && error.code === "cancelled");
  const providerCode = error instanceof ProviderError
    ? error.code === "authentication"
      ? "authentication_failed"
      : error.code === "rate_limit"
      ? "rate_limited"
      : error.code === "context_overflow"
      ? "context_overflow"
      : error.code === "invalid_response"
      ? "invalid_response"
      : error.code === "cancelled"
      ? "cancelled"
      : "transport"
    : null;
  return {
    domain: error instanceof ProviderError || cancelled ? "provider" : "runtime",
    phase,
    code: cancelled ? "cancelled" : providerCode ?? "runtime_failed",
    safeMessage: safeCliErrorMessage(error, diagnosticId),
    diagnosticId,
    retryable: cancelled ? false : error instanceof ProviderError && error.retryable,
    ...(error instanceof ProviderError && error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
    ...(providerCode === "authentication_failed"
      ? { action: "reauthenticate" as const }
      : providerCode === "rate_limited"
      ? { action: "wait" as const }
      : {}),
  };
}

function runtimeSessionId(runtime: RecursRuntime | undefined): string | null {
  if (runtime === undefined) return null;
  const state = runtime.state;
  return state.type === "session" ? state.session.id : null;
}

async function runGuidedOnboarding(
  dependencies: CliDependencies,
): Promise<GuidedOnboardingOutcome> {
  if (
    dependencies.selectChoice === undefined ||
    dependencies.promptText === undefined
  ) {
    await writeOutput(
      dependencies.stderr,
      "Error: Guided setup requires a user-present local terminal\n",
    );
    return { state: "failed", exitCode: 2 };
  }
  return await runGuidedOnboardingFlow({
    stdout: dependencies.stdout,
    stderr: dependencies.stderr,
    interactive: dependencies.interactive === true,
    automation: dependencies.automation === true,
    selectChoice: dependencies.selectChoice,
    promptText: dependencies.promptText,
    ...(dependencies.credentialEnvironmentAvailable === undefined
      ? {}
      : {
          credentialEnvironmentAvailable:
            dependencies.credentialEnvironmentAvailable,
        }),
    executeCommand: (argv) => runCli(argv, dependencies),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(dependencies.setAccountAgentRoutes === undefined
      ? {}
      : { setTeamRoutes: dependencies.setAccountAgentRoutes }),
    ...(dependencies.confirm === undefined ? {} : { confirm: dependencies.confirm }),
    ...(dependencies.listAccounts === undefined
      ? {}
      : { listAccounts: dependencies.listAccounts }),
    ...(dependencies.listProviders === undefined
      ? {}
      : { listProviders: dependencies.listProviders }),
    ...(dependencies.detectProviders === undefined
      ? {}
      : { detectProviders: dependencies.detectProviders }),
    ...(dependencies.discoverProviders === undefined
      ? {}
      : { discoverProviders: dependencies.discoverProviders }),
    ...(dependencies.discoverEnvironmentModels === undefined
      ? {}
      : { discoverEnvironmentModels: dependencies.discoverEnvironmentModels }),
    inspectProjectInstructions: () => discoverProjectInstructions(
      dependencies.cwd ?? process.cwd(),
    ),
    ...(dependencies.inspectCompanyRepositoryFacts === undefined
      ? {}
      : {
          inspectCompanyRepositoryFacts: () =>
            dependencies.inspectCompanyRepositoryFacts!(
              dependencies.cwd ?? process.cwd(),
            ),
        }),
    ...(dependencies.createCompanyOnboarding === undefined
      ? {}
      : {
          createCompanyOnboarding: (input) =>
            dependencies.createCompanyOnboarding!({
              ...input,
              cwd: dependencies.cwd ?? process.cwd(),
            }),
        }),
    createProjectInstructions: (input) => createProjectInstructions(
      dependencies.cwd ?? process.cwd(),
      input,
    ),
  });
}

async function startInteractiveRepl(
  runtime: RecursRuntime,
  dependencies: CliDependencies,
): Promise<void> {
  await startRepl(runtime, {
    ...(dependencies.stdin === undefined ? {} : { input: dependencies.stdin }),
    output: dependencies.stdout,
    cwd: dependencies.cwd ?? process.cwd(),
    invocation: createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    }),
  });
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const workingRoot = extractWorkingRoot(argv);
  if (workingRoot === null) {
    await writeOutput(dependencies.stderr, help);
    return 2;
  }
  argv = workingRoot.argv;
  const helpRequest = parseCliHelpRequest(argv);
  if (helpRequest !== null) {
    await writeOutput(
      helpRequest.valid ? dependencies.stdout : dependencies.stderr,
      helpRequest.valid ? helpRequest.text : help,
    );
    return helpRequest.valid ? 0 : 2;
  }
  if (
    argv.length === 1 &&
    (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "-v" ||
      argv[0] === "version")
  ) {
    await writeOutput(dependencies.stdout, `recurs ${RECURS_VERSION}\n`);
    return 0;
  }
  if (workingRoot.requested !== undefined) {
    if (argv[0] === "acp") {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    let cwd: string;
    try {
      cwd = await canonicalWorkingRoot(
        workingRoot.requested,
        dependencies.cwd ?? process.cwd(),
      );
    } catch (error) {
      const safeMessage = safeCliErrorMessage(error);
      const structured = (argv[0] === "run" || argv[0] === "review") && argv.some(
        (argument, index) =>
          argument === "--format" &&
          (argv[index + 1] === "json" || argv[index + 1] === "jsonl"),
      );
      if (structured) {
        await writeOutput(
          dependencies.stdout,
          `${JSON.stringify({
            version: 1,
            type: "configuration_error",
            error: {
              domain: "runtime",
              phase: "preflight",
              code: "runtime_failed",
              safeMessage,
              diagnosticId: randomUUID(),
              retryable: false,
            },
          })}\n`,
        );
      } else {
        await writeOutput(dependencies.stderr, `Error: ${safeMessage}\n`);
      }
      return 2;
    }
    const createRuntime = dependencies.createRuntime;
    dependencies = {
      ...dependencies,
      cwd,
      createRuntime: (events, options) => createRuntime(events, {
        ...options,
        cwd: options?.cwd ?? cwd,
      }),
    };
  }
  if (argv[0] === "eval") {
    let command: CompanyEvaluationCommandOptions;
    try {
      command = parseCompanyEvaluationCommand(argv.slice(1));
    } catch (error) {
      if (error instanceof CompanyEvaluationArgumentError) {
        await writeOutput(dependencies.stderr, `Error: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
    if (command.action === "list") {
      await writeOutput(
        dependencies.stdout,
        `${renderCompanyEvaluationScenarios(command.json)}\n`,
      );
      return 0;
    }
    if (dependencies.evaluateCompany === undefined) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      const report = await dependencies.evaluateCompany({
        ...command,
        cwd: dependencies.cwd ?? process.cwd(),
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal }),
        ...(command.json
          ? {}
          : {
              onProgress: async (progress) => {
                await writeOutput(
                  dependencies.stderr,
                  `${progress.message}\n`,
                );
              },
            }),
      });
      await writeOutput(
        dependencies.stdout,
        command.json
          ? `${JSON.stringify(report)}\n`
          : `${renderCompanyEvaluationReport(report)}\n`,
      );
      return report.status === "failed" || report.status === "cancelled" ? 1 : 0;
    } catch (error) {
      if (dependencies.signal?.aborted === true || isAbortError(error)) {
        await writeOutput(
          dependencies.stderr,
          "Error: Company evaluation was cancelled\n",
        );
        return 130;
      }
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return 1;
    }
  }
  if (argv[0] === "doctor") {
    const readinessJson = argv.length === 2 && argv[1] === "--json";
    const doctor = dependencies.doctor;
    if ((argv.length === 1 || readinessJson) && doctor !== undefined) {
      try {
        const report = await doctor(
          dependencies.cwd ?? process.cwd(),
          dependencies.signal,
        );
        await writeOutput(
          dependencies.stdout,
          readinessJson
            ? `${JSON.stringify(report)}\n`
            : renderDoctorReport(report),
        );
        return report.overallStatus === "fail" ? 1 : 0;
      } catch (error) {
        if (isAbortError(error)) {
          await writeOutput(dependencies.stderr, "Error: Doctor was cancelled\n");
          return 130;
        }
        await writeOutput(
          dependencies.stderr,
          `Error: ${safeCliErrorMessage(error)}\n`,
        );
        return 1;
      }
    }

    await writeOutput(dependencies.stderr, help);
    return 2;
  }

  if (argv.length === 0) {
    if (
      dependencies.interactive !== true ||
      dependencies.automation === true
    ) {
      await writeOutput(
        dependencies.stderr,
        "Error: The interactive CLI requires a user-present local terminal. Use recurs run for supported noninteractive providers.\n",
      );
      return 2;
    }
    const renderer = new TextEventRenderer(dependencies.stdout);
    let runtime: RecursRuntime | undefined;
    try {
      runtime = await dependencies.createRuntime(renderer);
      if (
        runtime.state?.type === "workspace" &&
        dependencies.selectChoice !== undefined &&
        dependencies.promptText !== undefined
      ) {
        const onboarding = await runGuidedOnboarding(dependencies);
        if (onboarding.state === "failed") return onboarding.exitCode;
        if (onboarding.state === "configured") {
          if (dependencies.signal?.aborted === true) {
            throw new DOMException("Guided setup was cancelled", "AbortError");
          }
          await runtime.close?.();
          runtime = await dependencies.createRuntime(renderer, {
            operatingModeId: onboarding.operatingModeId,
            permissionMode: onboarding.permissionMode,
            reuseExistingSession: false,
            ...(onboarding.companyBlueprintV2 === undefined &&
                onboarding.companyBlueprint === undefined
              ? {}
              : {
                  companyBlueprint:
                    onboarding.companyBlueprintV2 ?? onboarding.companyBlueprint,
                }),
          });
        }
      }
      await startInteractiveRepl(runtime, dependencies);
      return 0;
    } catch (error) {
      if (dependencies.signal?.aborted === true || isAbortError(error)) {
        await writeOutput(dependencies.stderr, "Error: Guided setup was cancelled\n");
        return 130;
      }
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCodeFor(error);
    } finally {
      await runtime?.close?.().catch(() => {});
    }
  }

  if (argv.length === 1 && argv[0] === "setup") {
    try {
      const onboarding = await runGuidedOnboarding(dependencies);
      if (onboarding.state === "failed") return onboarding.exitCode;
      if (onboarding.state === "skipped") return 0;
      if (dependencies.signal?.aborted === true) {
        throw new DOMException("Guided setup was cancelled", "AbortError");
      }
      const renderer = new TextEventRenderer(dependencies.stdout);
      const runtime = await dependencies.createRuntime(renderer, {
        operatingModeId: onboarding.operatingModeId,
        permissionMode: onboarding.permissionMode,
        reuseExistingSession: false,
        ...(onboarding.companyBlueprintV2 === undefined &&
            onboarding.companyBlueprint === undefined
          ? {}
          : {
              companyBlueprint:
                onboarding.companyBlueprintV2 ?? onboarding.companyBlueprint,
            }),
      });
      await startInteractiveRepl(runtime, dependencies);
      return 0;
    } catch (error) {
      if (dependencies.signal?.aborted === true || isAbortError(error)) {
        await writeOutput(dependencies.stderr, "Error: Guided setup was cancelled\n");
        return 130;
      }
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCodeFor(error);
    }
  }

  if (argv[0] === "acp") {
    if (argv.length !== 1 || dependencies.runAcp === undefined) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      await dependencies.runAcp();
      return 0;
    } catch (error) {
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCodeFor(error);
    }
  }

  if (argv[0] === "provider") {
    const parsed = parseProviderCommand(argv.slice(1));
    if (parsed === null) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      if (parsed.kind === "list") {
        if (dependencies.listProviders === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const providers = await dependencies.listProviders({
          includeBlocked: parsed.includeBlocked,
        });
        await writeOutput(
          dependencies.stdout,
          parsed.json
            ? `${JSON.stringify({ version: 1, providers })}\n`
            : providerText(providers),
        );
      } else if (parsed.kind === "catalog") {
        if (dependencies.discoverProviders === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const snapshot = await dependencies.discoverProviders(
          parsed.query,
          dependencies.signal,
        );
        await writeOutput(
          dependencies.stdout,
          parsed.json
            ? `${JSON.stringify({ version: 1, ...snapshot })}\n`
            : providerCatalogText(snapshot),
        );
      } else if (parsed.kind === "detect") {
        if (dependencies.detectProviders === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const providers = await dependencies.detectProviders(dependencies.signal);
        await writeOutput(
          dependencies.stdout,
          parsed.json
            ? `${JSON.stringify({ version: 1, providers })}\n`
            : localRuntimeText(providers),
        );
      } else {
        if (dependencies.discoverEnvironmentModels === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const models = await dependencies.discoverEnvironmentModels(
          parsed.providerId,
          parsed.credentialEnvironmentVariable,
          dependencies.signal,
        );
        await writeOutput(
          dependencies.stdout,
          parsed.json
            ? `${JSON.stringify({
                version: 1,
                providerId: parsed.providerId,
                models,
              })}\n`
            : environmentModelsText(parsed.providerId, models),
        );
      }
      return 0;
    } catch (error) {
      const exitCode = exitCodeFor(error, dependencies.signal);
      if (exitCode === 130) {
        if (dependencies.signal?.aborted !== true) {
          await writeOutput(
            dependencies.stderr,
            "Error: Provider discovery was cancelled\n",
          );
        }
        return exitCode;
      }
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCode;
    }
  }

  if (argv[0] === "account") {
    const command = parseAccountCommand(argv.slice(1));
    if (command === null) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      if (command.kind === "list") {
        if (dependencies.listAccounts === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const accounts = await dependencies.listAccounts();
        await writeOutput(
          dependencies.stdout,
          command.json
            ? `${JSON.stringify({ version: 1, accounts })}\n`
            : accountText(accounts),
        );
        return 0;
      }
      if (command.kind === "set_primary") {
        if (dependencies.setPrimaryAccount === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const account = await dependencies.setPrimaryAccount(
          command.id,
          dependencies.signal,
        );
        await writeOutput(
          dependencies.stdout,
          `Primary connection — ${account.id} · ${account.modelId}\nProvider: ${account.providerId} · Billing: ${account.billingSources.join(" + ")}\nExisting sessions keep their pinned backend.\n`,
        );
        return 0;
      }
      if (
        dependencies.interactive !== true ||
        dependencies.automation === true
      ) {
        await writeOutput(
          dependencies.stderr,
          "Error: Account verification and disconnection require a user-present local terminal\n",
        );
        return 2;
      }
      if (command.kind === "route") {
        if (dependencies.setAccountAgentRoute === undefined ||
          dependencies.confirm === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const target = command.id ?? "the parent backend";
        const confirmed = await dependencies.confirm(
          `Route future ${command.role} team agents to ${target}? Existing runs keep their frozen routes and provider billing still applies.`,
        );
        if (!confirmed) {
          await writeOutput(
            dependencies.stderr,
            "Error: Agent route change was not confirmed\n",
          );
          return 2;
        }
        const route = await dependencies.setAccountAgentRoute(
          command.role,
          command.id,
          dependencies.signal,
        );
        await writeOutput(
          dependencies.stdout,
          route.connectionId === null
            ? `${route.role} team agents will inherit the parent backend.\n`
            : `${route.role} team agents will use ${route.connectionId} when the operating mode and live policy permit it; otherwise they inherit the parent backend.\n`,
        );
        return 0;
      }
      if (command.kind === "verify") {
        if (dependencies.verifyAccount === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const result = await dependencies.verifyAccount(
          command.id,
          dependencies.cwd ?? process.cwd(),
          dependencies.signal,
        );
        const verification = result.connection.kind ===
            "environment_model_provider"
          ? "Credential binding verified"
          : "Verified";
        await writeOutput(
          dependencies.stdout,
          `${verification} — ${result.connection.id} · ${result.connection.modelId}\nProvider: ${result.connection.providerId} · ${result.connection.execution}\n`,
        );
        return 0;
      }
      if (
        dependencies.confirm === undefined ||
        dependencies.disconnectAccount === undefined
      ) {
        await writeOutput(dependencies.stderr, help);
        return 2;
      }
      const confirmed = await dependencies.confirm(
        `Disconnect ${command.id} from Recurs? This removes Recurs metadata only; vendor authentication will not be changed.`,
      );
      if (!confirmed) {
        await writeOutput(
          dependencies.stderr,
          "Error: Account disconnection was not confirmed\n",
        );
        return 2;
      }
      const result = await dependencies.disconnectAccount(command.id);
      await writeOutput(
        dependencies.stdout,
        `Disconnected ${result.connectionId}. Vendor authentication was not changed.\n${result.primaryCleared ? "No primary connection is selected.\n" : ""}`,
      );
      return 0;
    } catch (error) {
      const exitCode = exitCodeFor(error, dependencies.signal);
      if (exitCode === 130) {
        if (dependencies.signal?.aborted !== true) {
          await writeOutput(
            dependencies.stderr,
            "Error: Account operation was cancelled\n",
          );
        }
        return exitCode;
      }
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCode;
    }
  }

  if (argv[0] === "setup") {
    const byokCommand = parseByokSetupArguments(argv.slice(1));
    if (byokCommand !== null) {
      if (
        dependencies.interactive !== true ||
        dependencies.automation === true ||
        dependencies.confirm === undefined ||
        dependencies.setupEnvironment === undefined
      ) {
        await writeOutput(
          dependencies.stderr,
          "Error: BYOK setup requires an interactive local terminal\n",
        );
        return 2;
      }
      const accepted = await dependencies.confirm([
        `Connect ${byokCommand.providerId} with model ${byokCommand.modelId}.`,
        `Recurs will save the environment-variable name ${byokCommand.credentialEnvironmentVariable} and a one-way credential fingerprint, never the key value.`,
        "Requests use the reviewed fixed HTTPS origin for this provider.",
        byokCommand.billingSelection === "strict_primary_only"
          ? "Only the provider policy's primary billing source is acknowledged."
          : "All billing sources declared by the reviewed provider policy are acknowledged.",
        ...(byokCommand.reasoningEffort === undefined
          ? ["Reasoning effort remains at the provider default."]
          : [`Reasoning effort ${byokCommand.reasoningEffort} will be pinned into new sessions.`]),
        "The provider validates and bills the credential when a model request runs.",
      ].join("\n"));
      if (!accepted) {
        await writeOutput(
          dependencies.stderr,
          "Error: BYOK credential and billing disclosure was not accepted\n",
        );
        return 2;
      }
      try {
        const connection = await dependencies.setupEnvironment(
          byokCommand,
          dependencies.signal,
        );
        await writeOutput(
          dependencies.stdout,
          `Ready — ${connection.label} · ${connection.modelId}\nProvider: ${connection.providerId}\nReasoning effort: ${connection.reasoningEffort ?? "provider default"}\nCredential: ${connection.credentialEnvironmentVariable} (value not stored; fingerprint bound)\nBilling: ${connection.billingSelection}\n${connection.primary ? "Primary connection\n" : `Saved as secondary; use recurs account set-primary ${connection.id} to select it, or recurs account route implement ${connection.id} to assign team work\n`}`,
        );
        return 0;
      } catch (error) {
        const exitCode = exitCodeFor(error, dependencies.signal);
        if (exitCode === 130) return exitCode;
        await writeOutput(
          dependencies.stderr,
          `Error: ${safeCliErrorMessage(error)}\n`,
        );
        return exitCode;
      }
    }
    if (argv.length === 2 && argv[1] === "codex") {
      if (
        dependencies.interactive !== true ||
        dependencies.automation === true ||
        dependencies.confirm === undefined ||
        dependencies.setupCodex === undefined
      ) {
        await writeOutput(
          dependencies.stderr,
          "Error: Codex setup requires an interactive local terminal\n",
        );
        return 2;
      }
      const accepted = await dependencies.confirm(
        "OpenAI documents Codex as included with eligible ChatGPT plans. After included limits, Codex may automatically use prepaid credits when available. Continue and allow both included subscription usage and that declared prepaid-credit fallback?",
      );
      if (!accepted) {
        await writeOutput(
          dependencies.stderr,
          "Error: Codex billing disclosure was not accepted\n",
        );
        return 2;
      }
      try {
        const connection = await dependencies.setupCodex({
          cwd: dependencies.cwd ?? process.cwd(),
          interactive: true,
          billingSelection: "allow_declared_additional",
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal }),
        });
        await writeOutput(
          dependencies.stdout,
          `Ready — ${connection.label} · ${connection.modelId}\nMode: ${connection.planOnly ? "Plan-only" : "Act + Plan through Recurs permissions"}\nAccount: verified by the vendor runtime; credentials remain vendor-owned\n${connection.configuredModels === undefined ? "" : `Company routes: ${connection.configuredModels.join(", ")}\n`}${connection.primary ? "Primary connection\n" : `Saved as secondary; use recurs account set-primary ${connection.id} to select it\n`}`,
        );
        return 0;
      } catch (error) {
        const exitCode = exitCodeFor(error, dependencies.signal);
        if (exitCode === 130) return exitCode;
        await writeOutput(
          dependencies.stderr,
          `Error: ${safeCliErrorMessage(error)}\n`,
        );
        return exitCode;
      }
    }
    const input = parseLocalSetupArguments(argv.slice(1));
    if (input === null || dependencies.setupLocal === undefined) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      const connection = await dependencies.setupLocal({
        ...input,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal }),
      });
      await writeOutput(
        dependencies.stdout,
        `Ready — ${connection.label} · ${connection.modelId}\nEndpoint: ${connection.baseUrl}\n${connection.primary ? "Primary connection\n" : `Saved as secondary; use recurs account set-primary ${connection.id} to select it, or recurs account route implement ${connection.id} to assign team work\n`}`,
      );
      return 0;
    } catch (error) {
      const exitCode = exitCodeFor(error, dependencies.signal);
      if (exitCode === 130) return exitCode;
      await writeOutput(dependencies.stderr, `Error: ${safeCliErrorMessage(error)}\n`);
      return exitCode;
    }
  }

  if (argv[0] !== "run" && argv[0] !== "review") {
    await writeOutput(dependencies.stderr, help);
    return 2;
  }
  const parsed = parseAgentArguments(argv[0], argv.slice(1));
  if (parsed === null) {
    await writeOutput(dependencies.stderr, help);
    return 2;
  }
  const renderer = parsed.format === "jsonl"
    ? new JsonlEventRenderer(dependencies.stdout)
    : parsed.format === "json"
    ? { async emit() {} }
    : new TextEventRenderer(dependencies.stdout);
  let runtime: RecursRuntime | undefined;
  let aggregateResult:
    | { readonly kind: "agent"; readonly value: RunResult }
    | { readonly kind: "command"; readonly value: CommandResult }
    | undefined;
  let aggregateSessionId: string | null = null;
  let aggregateFailure:
    | {
        readonly type: "configuration_error";
        readonly error: IntegrationFailure;
      }
    | {
        readonly type: "run_error";
        readonly sessionId: string | null;
        readonly error: IntegrationFailure;
      }
    | undefined;
  let exitCode = 0;
  try {
    let prompt = parsed.prompt;
    if (parsed.stdinMode !== "none") {
      const piped = await stdinPrompt(
        dependencies.stdin,
        dependencies.interactive,
        dependencies.signal ?? new AbortController().signal,
      );
      prompt = parsed.stdinMode === "replace"
        ? piped
        : promptWithStdin(prompt, piped);
    }
    const images = parsed.imagePaths.length === 0
      ? undefined
      : await loadImageInputs(
          parsed.imagePaths,
          dependencies.cwd ?? process.cwd(),
        );
    runtime = await dependencies.createRuntime(
      renderer,
      {
        reuseExistingSession: false,
        ...(parsed.operatingModeId === undefined
          ? {}
          : { operatingModeId: parsed.operatingModeId }),
        ...(parsed.connectionId === undefined
          ? {}
          : { connectionId: parsed.connectionId }),
        ...(parsed.permissionMode === undefined
          ? {}
          : { permissionMode: parsed.permissionMode }),
        ...(parsed.executionMode === undefined
          ? {}
          : { executionMode: parsed.executionMode }),
        ...(parsed.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: parsed.resumeSessionId }),
      },
    );
    const result = await runtime.submit(
      prompt,
      createHostInvocation({
        invocation: "one_shot",
        userPresent: false,
        remote: false,
        scripted: true,
        embedding: "cli",
      }),
      images === undefined ? {} : { images },
    );
    if (parsed.format === "json") {
      aggregateResult = isCommandResult(result)
        ? { kind: "command", value: result }
        : { kind: "agent", value: result };
      aggregateSessionId = runtimeSessionId(runtime);
    } else if (isCommandResult(result)) {
      await renderCommandResult(result, dependencies.stdout, dependencies.stderr);
    }
  } catch (error) {
    const failure = configurationFailure(error);
    if (
      parsed.format === "json" &&
      failure !== null &&
      failure.code !== "cancelled"
    ) {
      aggregateFailure = { type: "configuration_error", error: failure };
      exitCode = exitCodeFor(error);
    } else if (parsed.format === "json") {
      aggregateFailure = {
        type: "run_error",
        sessionId: runtimeSessionId(runtime),
        error: terminalRunFailure(
          error,
          runtime === undefined ? "preflight" : "started",
        ),
      };
      exitCode = exitCodeFor(error);
    } else if (parsed.format === "jsonl" && failure !== null) {
      await writeOutput(
        dependencies.stdout,
        `${JSON.stringify({
          version: 1,
          type: "configuration_error",
          error: failure,
        })}\n`,
      );
      exitCode = exitCodeFor(error);
    } else {
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      exitCode = exitCodeFor(error);
    }
  }
  const closed = await closeRuntime(
    runtime,
    parsed.format === "json" ? undefined : dependencies.stderr,
  );
  if (parsed.format === "json" && !closed) {
    aggregateFailure = {
      type: "run_error",
      sessionId: runtimeSessionId(runtime),
      error: terminalRunFailure(
        new RuntimeError(
          "busy",
          "Runtime resources could not be closed safely",
        ),
        runtime === undefined ? "preflight" : "started",
      ),
    };
    exitCode = 1;
  }
  if (parsed.format === "json" && aggregateFailure !== undefined) {
    await writeOutput(
      dependencies.stdout,
      `${JSON.stringify({
        version: 1,
        ...aggregateFailure,
      })}\n`,
    );
  }
  if (
    parsed.format === "json" &&
    exitCode === 0 &&
    closed &&
    aggregateFailure === undefined &&
    aggregateResult !== undefined
  ) {
    await writeOutput(
      dependencies.stdout,
      `${JSON.stringify({
        version: 1,
        type: "run_result",
        sessionId: aggregateSessionId,
        result: {
          kind: aggregateResult.kind,
          ...aggregateResult.value,
        },
      })}\n`,
    );
  }
  return closed ? exitCode : exitCode === 0 ? 1 : exitCode;
}

const AUTOMATION_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "TEAMCITY_VERSION",
  "JENKINS_URL",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
]);

export function isAutomationEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  return AUTOMATION_ENVIRONMENT_KEYS.some((key) => {
    const value = environment[key]?.trim().toLowerCase();
    return value !== undefined && value !== "" && value !== "0" &&
      value !== "false" && value !== "no" && value !== "off";
  });
}

export async function runCliProcess(
  processOptions: { readonly ptyDriver?: PtyDriver } = {},
): Promise<void> {
  const argv = process.argv.slice(2);
  const doctorRequested = argv[0] === "doctor" && (
    argv.length === 1 ||
    (argv.length === 2 && argv[1] === "--json")
  );
  const interactiveOperationRequested = doctorRequested ||
    argv.length === 0 ||
    argv[0] === "provider" ||
    argv[0] === "account" ||
    argv[0] === "setup";
  const interactiveOperationController = interactiveOperationRequested
    ? new AbortController()
    : undefined;
  const cancelInteractiveOperation = (): void => {
    interactiveOperationController?.abort();
  };
  if (interactiveOperationController !== undefined) {
    process.once("SIGINT", cancelInteractiveOperation);
  }
  const confirm = async (message: string): Promise<boolean> => {
    const terminal = createInterface({
      input: processStdin,
      output: processStdout,
    });
    try {
      const answer = await terminal.question(
        `${message}\nContinue? [y/N] `,
        interactiveOperationController === undefined
          ? {}
          : { signal: interactiveOperationController.signal },
      );
      return answer.trim().toLowerCase() === "y" ||
        answer.trim().toLowerCase() === "yes";
    } finally {
      terminal.close();
    }
  };
  const promptText = async (
    message: string,
    suggestion?: string,
  ): Promise<string | null> => {
    const terminal = createInterface({
      input: processStdin,
      output: processStdout,
    });
    try {
      const suffix = suggestion === undefined ? "" : ` [${suggestion}]`;
      const answer = (await terminal.question(
        `${message}${suffix}: `,
        interactiveOperationController === undefined
          ? {}
          : { signal: interactiveOperationController.signal },
      )).trim();
      return answer.length > 0 ? answer : suggestion ?? null;
    } finally {
      terminal.close();
    }
  };
  const selectChoice = async (
    message: string,
    choices: readonly GuidedChoice[],
  ): Promise<string | null> => {
    const rendered = choices.map((choice, index) =>
      `  ${index + 1}. ${choice.label}\n     ${choice.detail}`
    ).join("\n");
    const answer = await promptText(
      `${message}:\n${rendered}\nEnter a number or exact ID`,
    );
    if (answer === null) return null;
    if (/^[1-9][0-9]*$/u.test(answer)) {
      return choices[Number(answer) - 1]?.id ?? null;
    }
    return choices.some((choice) => choice.id === answer) ? answer : null;
  };
  const dataDirectory = process.env.RECURS_HOME ?? path.join(homedir(), ".recurs");
  try {
    process.exitCode = await runCli(argv, {
      stdin: processStdin,
      stdout: processStdout,
      stderr: processStderr,
      cwd: process.cwd(),
      interactive: processStdin.isTTY === true && processStdout.isTTY === true,
      automation: isAutomationEnvironment(process.env),
      ...(interactiveOperationController === undefined
        ? {}
        : { signal: interactiveOperationController.signal }),
      confirm,
      promptText,
      selectChoice,
      doctor: (cwd, signal) => createDoctorReport({
        cwd,
        dataDirectory,
        ...(signal === undefined ? {} : { signal }),
      }),
      inspectCompanyRepositoryFacts,
      createCompanyOnboarding: ({ cwd, ...input }) => createStandaloneCompanyOnboarding(
        input,
        {
          cwd,
          dataDirectory,
          environment: process.env,
        },
      ),
      evaluateCompany: ({ cwd, signal, onProgress, ...options }) =>
        runCompanyEvaluationCommand(options, {
          projectRoot: cwd,
          dataDirectory,
          environment: process.env,
          ...(signal === undefined ? {} : { signal }),
          ...(onProgress === undefined ? {} : { onProgress }),
        }),
      createRuntime: (events, options) => createStandaloneRuntime(
        events,
        {
          ...(processOptions.ptyDriver === undefined
            ? {}
            : { ptyDriver: processOptions.ptyDriver }),
          ...(options?.permissionMode === undefined
            ? {}
            : { permissionMode: options.permissionMode }),
          ...(options?.executionMode === undefined
            ? {}
            : { executionMode: options.executionMode }),
          ...(options?.operatingModeId === undefined
            ? {}
            : { operatingModeId: options.operatingModeId }),
          ...(options?.connectionId === undefined
            ? {}
            : { connectionId: options.connectionId }),
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.reuseExistingSession === undefined
            ? {}
            : { reuseExistingSession: options.reuseExistingSession }),
          ...(options?.resumeSessionId === undefined
            ? {}
            : { resumeSessionId: options.resumeSessionId }),
          ...(options?.companyBlueprint === undefined
            ? {}
            : { companyBlueprint: options.companyBlueprint }),
        },
      ),
      runAcp: () => serveRecursAcpStdio(
        {
          createRuntime: (cwd, events) => createStandaloneRuntime(events, {
            cwd,
            dataDirectory,
            reuseExistingSession: false,
            ...(processOptions.ptyDriver === undefined
              ? {}
              : { ptyDriver: processOptions.ptyDriver }),
          }),
        },
        processStdin,
        processStdout,
      ),
      setupLocal: (input) => setupLocalConnection(dataDirectory, input),
      setupEnvironment: (input, signal) => setupEnvironmentConnection(
        dataDirectory,
        { ...input, environment: process.env },
        signal === undefined ? {} : { signal },
      ),
      setupCodex: (input) => setupCodexSubscription(dataDirectory, input),
      credentialEnvironmentAvailable: (name) => {
        const value = process.env[name];
        return value !== undefined && value.length > 0;
      },
      listProviders: async ({ includeBlocked }) =>
        listProviderSummaries(includeBlocked),
      discoverProviders: (query, signal) =>
        discoverProviderCatalog(query, signal),
      discoverEnvironmentModels: (
        providerId,
        credentialEnvironmentVariable,
        signal,
      ) => discoverEnvironmentConnectionModels({
        providerId,
        credentialEnvironmentVariable,
        environment: process.env,
      }, signal === undefined ? {} : { signal }),
      detectProviders: (signal) =>
        detectLocalRuntimes(signal === undefined ? {} : { signal }),
      listAccounts: () => listAccountSummaries(dataDirectory),
      setPrimaryAccount: (id, signal) => setPrimaryAccount(
        dataDirectory,
        id,
        signal,
      ),
      setAccountAgentRoute: (role, id, signal) =>
        setAccountAgentRoute(
          dataDirectory,
          role,
          id,
          signal,
        ),
      setAccountAgentRoutes: (assignments, signal) =>
        setAccountAgentRoutes(
          dataDirectory,
          assignments,
          signal,
        ),
      verifyAccount: (id, cwd, signal) => verifyAccount(
        dataDirectory,
        id,
        cwd,
        signal,
        { environment: process.env },
      ),
      disconnectAccount: (id) => disconnectAccount(dataDirectory, id),
    });
  } finally {
    process.removeListener("SIGINT", cancelInteractiveOperation);
  }
}
