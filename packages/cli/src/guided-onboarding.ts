import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  COMPANY_REPOSITORY_MARKERS,
  DEFAULT_OPERATING_MODE_ID,
  getOperatingModePolicy,
  operatingModePolicies,
  type CompanyBlueprintV1,
  type CompanyBlueprintV2,
  type CompanyDesignMode,
  type CompanyOnboardingDepth,
  type CompanyDevelopmentStyle,
  type CompanyProjectStage,
  type CompanyProjectType,
  type CompanyRepositoryFactsV1,
  type CompanyRepositoryMarker,
  type ModelReasoningEffort,
  type OperatingModeId,
  type TeamRunRole,
} from "@recurs/contracts";
import {
  approveCompanyBlueprint,
  compileCompanyBlueprint,
  CompanyOnboardingCoordinatorError,
  type CompanyOnboardingCoordinator,
} from "@recurs/core";
import { openAIResponsesReasoningEfforts } from "@recurs/app";
import {
  hasEnvironmentProviderModelDiscovery,
  type DiscoveredCatalogProvider,
  type EnvironmentModelDescriptor,
  type LocalRuntimeDetection,
  type ProviderCatalogSnapshot,
} from "@recurs/providers";
import type { PermissionMode } from "@recurs/tools";

import type {
  AccountSummary,
  ProviderSummary,
} from "./provider-account.js";
import {
  isValidProjectBriefText,
  type ProjectBriefInput,
  type ProjectInstructionDocument,
} from "./project-instructions.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { writeOutput } from "./render.js";

export interface GuidedChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export type GuidedConnectionAction =
  | { readonly kind: "account"; readonly accountId: string }
  | {
    readonly kind: "local";
    readonly runtimeId: LocalRuntimeDetection["id"];
    readonly baseUrl: string;
  }
  | { readonly kind: "codex" }
  | { readonly kind: "byok"; readonly providerId: string }
  | {
    readonly kind: "native";
    readonly provider: "openai" | "anthropic" | "kimi";
  };

export interface GuidedConnectionChoice extends GuidedChoice {
  readonly action: GuidedConnectionAction;
}

export interface GuidedOnboardingInventory {
  readonly accounts: readonly AccountSummary[];
  readonly localRuntimes: readonly LocalRuntimeDetection[];
  readonly providers: readonly ProviderSummary[];
  readonly nativeProviders: ReadonlySet<"openai" | "anthropic" | "kimi">;
}

const NATIVE_PROVIDER_IDS = Object.freeze({
  openai: "openai-api",
  anthropic: "anthropic-api",
  kimi: "kimi-code",
} as const);

const CATALOG_PROVIDER_IDS: Readonly<Record<string, string>> = Object.freeze({
  "openai-api": "openai",
  "anthropic-api": "anthropic",
  "openrouter-api": "openrouter",
  "xai-api": "xai",
  "opencode-go": "opencode-go",
  "kilo-gateway": "kilo",
  "alibaba-model-studio-api": "alibaba",
  "alibaba-coding-plan": "alibaba-coding-plan",
  "kimi-platform-api": "moonshotai",
  "kimi-code": "kimi-for-coding",
  "minimax-api": "minimax",
  "minimax-token-plan": "minimax-coding-plan",
  "zai-api": "zai",
  "zai-glm-coding-plan": "zai-coding-plan",
  "deepseek-api": "deepseek",
});

function providerById(
  providers: readonly ProviderSummary[],
  id: string,
): ProviderSummary | undefined {
  return providers.find((provider) => provider.id === id);
}

export function guidedConnectionChoices(
  inventory: GuidedOnboardingInventory,
): readonly GuidedConnectionChoice[] {
  const choices: GuidedConnectionChoice[] = [];
  for (const account of [...inventory.accounts].sort((left, right) =>
    Number(right.primary) - Number(left.primary) ||
    left.label.localeCompare(right.label)
  )) {
    choices.push({
      id: `account:${account.id}`,
      label: `${account.primary ? "Use primary" : "Use saved"}: ${account.label}`,
      detail: `${account.modelId} · ${account.execution}`,
      action: { kind: "account", accountId: account.id },
    });
  }
  for (const runtime of inventory.localRuntimes.filter((entry) => entry.detected)) {
    choices.push({
      id: `local:${runtime.id}`,
      label: `Use detected ${runtime.name}`,
      detail: `${runtime.baseUrl} · local compute`,
      action: {
        kind: "local",
        runtimeId: runtime.id,
        baseUrl: runtime.baseUrl,
      },
    });
  }
  const codex = providerById(inventory.providers, "openai-codex-chatgpt");
  if (codex?.status === "runnable") {
    choices.push({
      id: "codex",
      label: "Connect Codex with ChatGPT",
      detail: "official Codex runtime · Plan-only · vendor-owned login",
      action: { kind: "codex" },
    });
  }
  for (const provider of inventory.providers) {
    if (provider.status !== "runnable_byok") continue;
    choices.push({
      id: `byok:${provider.id}`,
      label: `Connect ${provider.displayName}`,
      detail: "environment key · reviewed fixed origin · Act + Plan",
      action: { kind: "byok", providerId: provider.id },
    });
  }
  for (const provider of ["openai", "anthropic", "kimi"] as const) {
    if (!inventory.nativeProviders.has(provider)) continue;
    const summary = providerById(inventory.providers, NATIVE_PROVIDER_IDS[provider]);
    if (summary === undefined || summary.status === "blocked") continue;
    choices.push({
      id: `native:${provider}`,
      label: `Connect ${summary.displayName} with Keychain`,
      detail: "native credential authority · metered or coding-plan billing",
      action: { kind: "native", provider },
    });
  }
  return Object.freeze(choices.map((choice) => Object.freeze(choice)));
}

export function catalogProviderId(providerId: string): string | null {
  return CATALOG_PROVIDER_IDS[providerId] ?? null;
}

export const GUIDED_PERMISSION_CHOICES: readonly GuidedChoice[] = Object.freeze([
  Object.freeze({
    id: "approved_for_me",
    label: "Approved for Me (recommended)",
    detail: "automate routine workspace work; ask before consequential actions",
  }),
  Object.freeze({
    id: "ask_always",
    label: "Ask Always",
    detail: "require approval before changes and commands",
  }),
  Object.freeze({
    id: "full_access",
    label: "Full Access",
    detail: "skip routine prompts inside the active execution boundary",
  }),
]);

const currentOperatingModeVersion = getOperatingModePolicy(
  DEFAULT_OPERATING_MODE_ID,
).version;

export const GUIDED_OPERATING_MODE_CHOICES: readonly GuidedChoice[] =
  Object.freeze(operatingModePolicies
    .filter((policy) => policy.version === currentOperatingModeVersion)
    .map((policy) => {
      const team = policy.workflow.team;
      const billing = policy.model.selection === "configured_role_candidate"
        ? policy.model.eligibleBillingSources.join(", ")
        : "parent model only";
      return Object.freeze({
        id: policy.id,
        label: `${policy.displayName}${policy.id === DEFAULT_OPERATING_MODE_ID ? " (recommended)" : ""}`,
        detail: `${team?.maxImplementers ?? 1} implementer${team?.maxImplementers === 1 ? "" : "s"} · ${policy.orchestration.maxConcurrentChildren} concurrent · ${billing}`,
      });
    }));

export function guidedOperatingModeId(value: string): OperatingModeId | null {
  return GUIDED_OPERATING_MODE_CHOICES.some((choice) => choice.id === value)
    ? value as OperatingModeId
    : null;
}

export function guidedPermissionMode(value: string): PermissionMode | null {
  return value === "ask_always" || value === "approved_for_me" ||
      value === "full_access"
    ? value
    : null;
}

export function filterCatalogModels(
  modelIds: readonly string[],
  query: string,
  limit = 30,
): readonly string[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return Object.freeze(modelIds.slice(0, limit));
  const matches = modelIds.filter((modelId) =>
    modelId.toLowerCase().includes(normalized)
  );
  const exact = matches.find((modelId) => modelId.toLowerCase() === normalized);
  return Object.freeze([
    ...(exact === undefined ? [] : [exact]),
    ...matches.filter((modelId) => modelId !== exact),
  ].slice(0, limit));
}

export function credentialEnvironmentSuggestion(providerId: string): string {
  if (providerId === "google-gemini-api") return "GEMINI_API_KEY";
  const stem = providerId
    .replace(/-(api|gateway)$/u, "")
    .replaceAll("-", "_")
    .toUpperCase();
  return `${stem}_API_KEY`;
}

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const SAFE_CREDENTIAL_ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export function isSafeModelId(value: string): boolean {
  return SAFE_MODEL_ID.test(value);
}

export function isSafeCredentialEnvironmentVariable(value: string): boolean {
  if (!SAFE_CREDENTIAL_ENVIRONMENT_VARIABLE.test(value)) return false;
  const segments = new Set(value.split("_"));
  return segments.has("KEY") || segments.has("TOKEN") ||
    segments.has("SECRET");
}

export type GuidedOnboardingOutcome =
  | {
    readonly state: "configured";
    readonly permissionMode: PermissionMode;
    readonly operatingModeId: OperatingModeId;
    readonly companyBlueprint?: CompanyBlueprintV1;
    readonly companyBlueprintV2?: CompanyBlueprintV2;
  }
  | { readonly state: "skipped" }
  | { readonly state: "failed"; readonly exitCode: number };

export interface GuidedOnboardingPorts {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly interactive: boolean;
  readonly automation: boolean;
  readonly signal?: AbortSignal;
  readonly nativeProviders: ReadonlySet<"openai" | "anthropic" | "kimi">;
  selectChoice(
    message: string,
    choices: readonly GuidedChoice[],
  ): Promise<string | null>;
  promptText(message: string, suggestion?: string): Promise<string | null>;
  credentialEnvironmentAvailable?(name: string): boolean;
  confirm?(message: string): Promise<boolean>;
  listAccounts?(): Promise<readonly AccountSummary[]>;
  listProviders?(input: {
    includeBlocked: boolean;
  }): Promise<readonly ProviderSummary[]>;
  detectProviders?(
    signal?: AbortSignal,
  ): Promise<readonly LocalRuntimeDetection[]>;
  discoverProviders?(
    query: string,
    signal?: AbortSignal,
  ): Promise<ProviderCatalogSnapshot>;
  discoverEnvironmentModels?(
    providerId: string,
    credentialEnvironmentVariable: string,
    signal?: AbortSignal,
  ): Promise<readonly EnvironmentModelDescriptor[]>;
  inspectProjectInstructions?(): Promise<readonly ProjectInstructionDocument[]>;
  inspectCompanyRepositoryFacts?(): Promise<CompanyRepositoryFactsV1>;
  createCompanyOnboarding?(input: {
    readonly permissionMode: PermissionMode;
    readonly operatingModeId: OperatingModeId;
  }): Promise<{
    readonly coordinator: CompanyOnboardingCoordinator;
    readonly projectRoot: string;
    readonly backendFingerprint: string;
  }>;
  createProjectInstructions?(
    input: ProjectBriefInput,
  ): Promise<"created" | "exists">;
  executeCommand(argv: readonly string[]): Promise<number>;
}

export async function inspectCompanyRepositoryFacts(
  cwd: string,
): Promise<CompanyRepositoryFactsV1> {
  const root = await realpath(cwd);
  const discovered: CompanyRepositoryMarker[] = [];
  await Promise.all(COMPANY_REPOSITORY_MARKERS.map(async (marker) => {
    try {
      const stat = await lstat(path.join(root, marker));
      if (!stat.isSymbolicLink()) discovered.push(marker);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }));
  return Object.freeze({
    inspected: true,
    markers: Object.freeze(discovered.sort()),
  });
}

async function catalogProvider(
  providerId: string,
  ports: GuidedOnboardingPorts,
): Promise<DiscoveredCatalogProvider | null> {
  const catalogId = catalogProviderId(providerId);
  if (catalogId === null || ports.discoverProviders === undefined) return null;
  try {
    const snapshot = await ports.discoverProviders(catalogId, ports.signal);
    return snapshot.providers.find((provider) => provider.id === catalogId) ?? null;
  } catch {
    return null;
  }
}

async function promptExactModel(
  label: string,
  ports: GuidedOnboardingPorts,
): Promise<string | null> {
  const modelId = (await ports.promptText(
    `Enter the exact model ID for ${label}`,
  ))?.trim() ?? "";
  if (isSafeModelId(modelId)) return modelId;
  await writeOutput(ports.stderr, "Error: A valid exact model ID is required\n");
  return null;
}

async function selectCatalogModel(
  providerId: string,
  label: string,
  ports: GuidedOnboardingPorts,
): Promise<string | null> {
  const provider = await catalogProvider(providerId, ports);
  if (provider === null || provider.modelIds.length === 0) {
    return await promptExactModel(label, ports);
  }
  let models = provider.modelIds;
  if (models.length > 30) {
    const query = await ports.promptText(
      `Search ${provider.modelCount} models for ${label}`,
    );
    if (query === null) return null;
    models = filterCatalogModels(models, query);
    if (models.length === 0) {
      await writeOutput(
        ports.stderr,
        `Error: No ${label} catalog models matched that search\n`,
      );
      return null;
    }
  }
  const selected = await ports.selectChoice(
    `Choose a model for ${label}`,
    models.map((modelId) => ({
      id: modelId,
      label: modelId,
      detail: `models.dev · ${provider.wire}`,
    })),
  );
  return selected !== null && models.includes(selected) ? selected : null;
}

async function selectEnvironmentModel(
  providerId: string,
  label: string,
  credentialEnvironmentVariable: string,
  ports: GuidedOnboardingPorts,
): Promise<string | null> {
  if (ports.discoverEnvironmentModels === undefined) {
    await writeOutput(
      ports.stderr,
      `Error: Authenticated model discovery is unavailable for ${label}\n`,
    );
    return null;
  }
  const discovered = await ports.discoverEnvironmentModels(
    providerId,
    credentialEnvironmentVariable,
    ports.signal,
  );
  if (discovered.length === 0) {
    await writeOutput(
      ports.stderr,
      `Error: The ${label} credential reported no available models\n`,
    );
    return null;
  }
  let models = discovered;
  if (models.length > 30) {
    const query = (await ports.promptText(
      `Search ${models.length} credential-visible models for ${label}`,
    ))?.trim().toLowerCase();
    if (query === undefined) return null;
    models = models.filter((model) =>
      `${model.id} ${model.displayName}`.toLowerCase().includes(query)
    ).slice(0, 30);
    if (models.length === 0) {
      await writeOutput(
        ports.stderr,
        `Error: No credential-visible ${label} models matched that search\n`,
      );
      return null;
    }
  }
  const selected = await ports.selectChoice(
    `Choose a credential-visible model for ${label}`,
    models.map((model) => ({
      id: model.id,
      label: model.displayName,
      detail: `${model.id} · ${model.maxInputTokens ?? "unknown"} input tokens`,
    })),
  );
  return selected !== null && models.some((model) => model.id === selected)
    ? selected
    : null;
}

async function selectReasoningEffort(
  modelId: string,
  ports: GuidedOnboardingPorts,
): Promise<ModelReasoningEffort | undefined> {
  const supported = openAIResponsesReasoningEfforts(modelId);
  if (supported.length === 0) return undefined;
  const selected = await ports.selectChoice(
    "Choose the model reasoning effort",
    Object.freeze([
      Object.freeze({
        id: "provider-default",
        label: "Provider default (recommended)",
        detail: "leave the Responses API effort unset",
      }),
      ...supported.map((effort) => Object.freeze({
        id: effort,
        label: effort,
        detail: "pin this effort into every request in the new session",
      })),
    ]),
  );
  return supported.includes(selected as ModelReasoningEffort)
    ? selected as ModelReasoningEffort
    : undefined;
}

async function executeConnectionAction(
  action: GuidedConnectionAction,
  providers: readonly ProviderSummary[],
  ports: GuidedOnboardingPorts,
): Promise<number> {
  if (action.kind === "account") {
    const verified = await ports.executeCommand([
      "account",
      "verify",
      action.accountId,
    ]);
    return verified === 0
      ? await ports.executeCommand(["account", "set-primary", action.accountId])
      : verified;
  }
  if (action.kind === "local") {
    const modelId = await promptExactModel(action.runtimeId, ports);
    return modelId === null
      ? 2
      : await ports.executeCommand([
          "setup",
          "local",
          "--url",
          action.baseUrl,
          "--model",
          modelId,
        ]);
  }
  if (action.kind === "codex") {
    return await ports.executeCommand(["setup", "codex"]);
  }
  if (action.kind === "byok") {
    const summary = providers.find((provider) => provider.id === action.providerId);
    const label = summary?.displayName ?? action.providerId;
    const suggestion = credentialEnvironmentSuggestion(action.providerId);
    const environmentVariable = (await ports.promptText(
      `Environment variable containing the ${label} credential`,
      suggestion,
    ))?.trim() ?? "";
    if (!isSafeCredentialEnvironmentVariable(environmentVariable)) {
      await writeOutput(
        ports.stderr,
        "Error: A KEY, TOKEN, or SECRET environment-variable name is required\n",
      );
      return 2;
    }
    if (ports.credentialEnvironmentAvailable?.(environmentVariable) === false) {
      await writeOutput(
        ports.stderr,
        `Error: Credential environment variable ${environmentVariable} is not set in this Recurs process\n`,
      );
      return 2;
    }
    const modelId = hasEnvironmentProviderModelDiscovery(action.providerId)
      ? await selectEnvironmentModel(
          action.providerId,
          label,
          environmentVariable,
          ports,
        )
      : await selectCatalogModel(action.providerId, label, ports);
    if (modelId === null) return 2;
    const reasoningEffort = action.providerId === "openai-api"
      ? await selectReasoningEffort(modelId, ports)
      : undefined;
    return await ports.executeCommand([
      "setup",
      "byok",
      "--provider",
      action.providerId,
      "--model",
      modelId,
      "--key-env",
      environmentVariable,
      ...(reasoningEffort === undefined
        ? []
        : ["--reasoning-effort", reasoningEffort]),
    ]);
  }
  if (action.provider === "openai") {
    return await ports.executeCommand(["setup", "openai"]);
  }
  const providerId = action.provider === "anthropic"
    ? "anthropic-api"
    : "kimi-code";
  const label = action.provider === "anthropic" ? "Anthropic API" : "Kimi Code";
  const modelId = await selectCatalogModel(providerId, label, ports);
  return modelId === null
    ? 2
    : await ports.executeCommand([
        "setup",
        action.provider,
        "--model",
        modelId,
      ]);
}

async function selectPermission(
  ports: GuidedOnboardingPorts,
): Promise<PermissionMode> {
  const selected = await ports.selectChoice(
    "Choose how much Recurs may do without asking",
    GUIDED_PERMISSION_CHOICES,
  );
  const mode = selected === null
    ? "ask_always"
    : guidedPermissionMode(selected) ?? "ask_always";
  if (mode !== "full_access") return mode;
  const accepted = await ports.confirm?.([
    "Full Access skips routine approval prompts inside Recurs's active execution boundary.",
    "Direct credential requests remain blocked, but commands approved by this preset may access resources exposed by the current platform sandbox.",
    "Windows does not yet have Recurs-owned OS sandbox containment.",
    "Enable Full Access for the new session?",
  ].join("\n")) ?? false;
  if (accepted) return mode;
  await writeOutput(
    ports.stdout,
    "Full Access was not enabled; using Ask Always.\n",
  );
  return "ask_always";
}

async function selectOperatingMode(
  ports: GuidedOnboardingPorts,
): Promise<OperatingModeId> {
  const selected = await ports.selectChoice(
    "Choose how much agent teamwork Recurs should use",
    GUIDED_OPERATING_MODE_CHOICES,
  );
  return selected === null
    ? DEFAULT_OPERATING_MODE_ID
    : guidedOperatingModeId(selected) ?? DEFAULT_OPERATING_MODE_ID;
}

const TEAM_ROLES: readonly TeamRunRole[] = Object.freeze([
  "implement",
  "review",
  "repair",
]);

function routeCandidates(
  accounts: readonly AccountSummary[],
  operatingModeId: OperatingModeId,
): readonly AccountSummary[] {
  const policy = getOperatingModePolicy(operatingModeId);
  if (policy.model.selection !== "configured_role_candidate") return [];
  const eligible = new Set(policy.model.eligibleBillingSources);
  return accounts.filter((account) =>
    !account.primary &&
    account.execution === "Act + Plan" &&
    account.billingSources[0] !== undefined &&
    eligible.has(account.billingSources[0])
  );
}

function currentRoute(
  accounts: readonly AccountSummary[],
  role: TeamRunRole,
): string | null {
  return accounts.find((account) => account.agentRoles.includes(role))?.id ?? null;
}

function routeSummary(accounts: readonly AccountSummary[]): string {
  return TEAM_ROLES.map((role) => {
    const account = accounts.find((candidate) =>
      candidate.agentRoles.includes(role)
    );
    return `${role}: ${account?.label ?? "parent"}`;
  }).join(" · ");
}

async function configureTeamRoutes(
  accounts: readonly AccountSummary[],
  operatingModeId: OperatingModeId,
  ports: GuidedOnboardingPorts,
): Promise<boolean> {
  const candidates = routeCandidates(accounts, operatingModeId);
  if (candidates.length === 0) {
    await writeOutput(
      ports.stdout,
      "Team routing: every role inherits the parent model. Add a second eligible Act + Plan connection later to specialize roles.\n",
    );
    return true;
  }
  const setup = await ports.selectChoice(
    "Choose whether to specialize Implement, Review, and Repair",
    Object.freeze([
      Object.freeze({
        id: "keep",
        label: "Keep current routing (recommended)",
        detail: routeSummary(accounts),
      }),
      Object.freeze({
        id: "customize",
        label: "Customize specialist models",
        detail: "assign eligible saved connections role by role",
      }),
    ]),
  );
  if (setup !== "customize") return true;

  for (const role of TEAM_ROLES) {
    const existing = currentRoute(accounts, role);
    const selected = await ports.selectChoice(
      `Choose the ${role} model`,
      Object.freeze([
        Object.freeze({
          id: "parent",
          label: "Inherit the parent model",
          detail: "no separate connection or billing source",
        }),
        ...candidates.map((account) => Object.freeze({
          id: account.id,
          label: account.label,
          detail: `${account.modelId} · ${account.billingSources.join(" + ")}`,
        })),
      ]),
    );
    if (selected === null) continue;
    const connectionId = selected === "parent" ? null : selected;
    if (connectionId === existing) continue;
    const exitCode = await ports.executeCommand([
      "account",
      "route",
      role,
      connectionId ?? "parent",
    ]);
    if (exitCode !== 0) return false;
  }
  return true;
}

interface CapturedProjectBrief {
  readonly purpose: string;
  readonly notes?: string;
}

interface CompanyOnboardingResult {
  readonly blueprint?: CompanyBlueprintV1;
  readonly blueprintV2?: CompanyBlueprintV2;
  readonly brief?: CapturedProjectBrief;
}

const COMPANY_ONBOARDING_DEPTH_CHOICES: readonly GuidedChoice[] = Object.freeze([
  Object.freeze({
    id: "quick",
    label: "Quick",
    detail: "a short interview with no project-research agents",
  }),
  Object.freeze({
    id: "guided",
    label: "Guided (recommended)",
    detail: "adaptive questions and up to three bounded read-only investigations",
  }),
  Object.freeze({
    id: "deep",
    label: "Deep",
    detail: "a longer interview and up to eight mode-clamped investigations",
  }),
]);

const COMPANY_DESIGN_MODE_CHOICES: readonly GuidedChoice[] = Object.freeze([
  Object.freeze({
    id: "stable_core_specialists",
    label: "Stable core + specialists (recommended)",
    detail: "fixed accountability departments with project-tailored specialist roles",
  }),
  Object.freeze({
    id: "guardrailed_dynamic",
    label: "Guardrailed dynamic",
    detail: "project-specific departments and roles with mandatory orchestration and independent review",
  }),
]);

const COMPANY_PROJECT_TYPE_CHOICES: readonly GuidedChoice[] = Object.freeze([
  Object.freeze({ id: "existing_project", label: "Existing project", detail: "improve or extend a repository that already exists" }),
  Object.freeze({ id: "web_app", label: "Web app", detail: "browser-based product or service" }),
  Object.freeze({ id: "backend", label: "Backend", detail: "service, API, or data system" }),
  Object.freeze({ id: "ios_app", label: "iOS app", detail: "native iPhone or iPad product" }),
  Object.freeze({ id: "macos_app", label: "macOS app", detail: "native Mac product" }),
  Object.freeze({ id: "ai_ml", label: "AI / ML", detail: "model, agent, evaluation, or data workflow" }),
  Object.freeze({ id: "infrastructure", label: "Infrastructure", detail: "developer tooling, platform, or operations" }),
  Object.freeze({ id: "plugin", label: "Plugin", detail: "extension or integration" }),
  Object.freeze({ id: "game", label: "Game", detail: "interactive game or simulation" }),
  Object.freeze({ id: "other", label: "Something else", detail: "use the project description as the source of truth" }),
]);

const COMPANY_PROJECT_STAGE_CHOICES: readonly GuidedChoice[] = Object.freeze([
  Object.freeze({ id: "idea", label: "Idea", detail: "shape and prove the first useful slice" }),
  Object.freeze({ id: "prototype", label: "Prototype", detail: "turn an early implementation into a dependable product" }),
  Object.freeze({ id: "active", label: "Active", detail: "continue development in a live codebase" }),
  Object.freeze({ id: "maintenance", label: "Maintenance", detail: "stabilize, repair, or evolve an established system" }),
]);

const COMPANY_STYLE_CHOICES: readonly GuidedChoice[] = Object.freeze([
  Object.freeze({
    id: "layered_company",
    label: "Layered company (recommended)",
    detail: "planning, architecture, implementation, QA, and release roles; work is still spawned only when assigned",
  }),
  Object.freeze({
    id: "orchestrator",
    label: "Lean team",
    detail: "one orchestrator, one scoped builder role, and one independent reviewer role",
  }),
  Object.freeze({
    id: "single_agent",
    label: "Single agent",
    detail: "keep the approved company context but do not enable child-role handoffs",
  }),
]);

function companyChoice<T extends string>(
  value: string | null,
  choices: readonly GuidedChoice[],
): T | null {
  return value !== null && choices.some((choice) => choice.id === value)
    ? value as T
    : null;
}

async function setupCompanyBlueprint(
  ports: GuidedOnboardingPorts,
  permissionMode: PermissionMode,
  operatingModeId: OperatingModeId,
): Promise<CompanyOnboardingResult> {
  if (ports.createCompanyOnboarding !== undefined && ports.confirm !== undefined) {
    return await setupCompanyBlueprintV2(ports, permissionMode, operatingModeId);
  }
  if (
    ports.inspectCompanyRepositoryFacts === undefined ||
    ports.confirm === undefined
  ) {
    return {};
  }
  const action = await ports.selectChoice(
    "Tailor the first Recurs agent company to this project",
    Object.freeze([
      Object.freeze({
        id: "create",
        label: "Design my company (recommended)",
        detail: "review a durable roster, tool plan, quality bar, and initial goal before it is activated",
      }),
      Object.freeze({
        id: "skip",
        label: "Skip for now",
        detail: "start a normal parent-agent session and configure a company later",
      }),
    ]),
  );
  if (action !== "create") return {};

  const purpose = (await ports.promptText(
    "What should this project become? Describe the outcome in one or two sentences",
  ))?.trim() ?? "";
  if (!isValidProjectBriefText(purpose)) {
    await writeOutput(
      ports.stdout,
      "Company setup skipped because no valid project description was entered.\n",
    );
    return {};
  }
  const type = companyChoice<CompanyProjectType>(
    await ports.selectChoice("What kind of project is this?", COMPANY_PROJECT_TYPE_CHOICES),
    COMPANY_PROJECT_TYPE_CHOICES,
  );
  const stage = companyChoice<CompanyProjectStage>(
    await ports.selectChoice("What stage is the project in?", COMPANY_PROJECT_STAGE_CHOICES),
    COMPANY_PROJECT_STAGE_CHOICES,
  );
  const developmentStyle = companyChoice<CompanyDevelopmentStyle>(
    await ports.selectChoice("How should the agent company be structured?", COMPANY_STYLE_CHOICES),
    COMPANY_STYLE_CHOICES,
  );
  if (type === null || stage === null || developmentStyle === null) {
    await writeOutput(ports.stdout, "Company setup was not completed.\n");
    return { brief: { purpose } };
  }
  const rawConstraint = (await ports.promptText(
    "Add one important architecture, testing, or safety constraint (optional)",
  ))?.trim() ?? "";
  if (
    rawConstraint.length > 0 &&
    (!isValidProjectBriefText(rawConstraint) ||
      new TextEncoder().encode(rawConstraint).byteLength > 512)
  ) {
    await writeOutput(
      ports.stdout,
      "Company setup skipped because the constraint was not valid text of at most 512 bytes.\n",
    );
    return { brief: { purpose } };
  }

  let repository: CompanyRepositoryFactsV1 = { inspected: false, markers: [] };
  const inspect = await ports.confirm(
    "Allow Recurs to check only the approved root filenames (.git, package manifests, AGENTS.md, and similar markers)? It will not read file contents during this step.",
  );
  if (inspect) {
    try {
      repository = await ports.inspectCompanyRepositoryFacts();
    } catch {
      await writeOutput(
        ports.stderr,
        "Repository marker inspection failed safely; no repository facts were added.\n",
      );
    }
  }
  const createdAt = new Date().toISOString();
  const proposed = compileCompanyBlueprint({
    id: randomUUID(),
    createdAt,
    project: {
      type,
      stage,
      purpose,
      constraints: rawConstraint.length === 0 ? [] : [rawConstraint],
      repository,
    },
    developmentStyle,
    permissionMode,
    operatingModeId,
  });
  const requiredTools = proposed.toolPlan
    .filter((tool) => tool.status === "required")
    .map((tool) => tool.id);
  const approved = await ports.confirm([
    "Approve and activate this company blueprint?",
    `Project: ${proposed.project.purpose}`,
    `Structure: ${proposed.developmentStyle.replaceAll("_", " ")}`,
    `Roles: ${proposed.roles.map((role) => role.displayName).join(", ")}`,
    `Authority: ${proposed.authority.permissionMode.replaceAll("_", " ")} · ${proposed.authority.operatingModeId}`,
    `Repository facts: ${proposed.project.repository.markers.join(", ") || "none approved"}`,
    `Additional tool bundles: ${requiredTools.join(", ") || "none"}`,
    `Quality: ${proposed.quality.standard} · ${proposed.quality.initialReviewers} initial reviewer(s)`,
    `Initial goal: ${proposed.initialGoal}`,
    "Approval creates the roster and policy; agents run only after concrete assignments.",
  ].join("\n"));
  const brief = {
    purpose,
    ...(rawConstraint.length === 0 ? {} : { notes: rawConstraint }),
  };
  if (!approved) {
    await writeOutput(ports.stdout, "Company blueprint was not activated.\n");
    return { brief };
  }
  const blueprint = approveCompanyBlueprint(proposed, new Date().toISOString());
  await writeOutput(
    ports.stdout,
    `Company blueprint approved: ${blueprint.roles.length} role(s), ${blueprint.developmentStyle.replaceAll("_", " ")}.\n`,
  );
  return { blueprint, brief };
}

async function setupCompanyBlueprintV2(
  ports: GuidedOnboardingPorts,
  permissionMode: PermissionMode,
  operatingModeId: OperatingModeId,
): Promise<CompanyOnboardingResult> {
  const action = await ports.selectChoice(
    "Tailor the first Recurs agent company to this project",
    Object.freeze([
      Object.freeze({
        id: "create",
        label: "Design my company (recommended)",
        detail: "interview, inspect with consent, review, then explicitly approve",
      }),
      Object.freeze({
        id: "skip",
        label: "Skip for now",
        detail: "start without activating a company",
      }),
    ]),
  );
  if (action !== "create") return {};

  const depth = companyChoice<CompanyOnboardingDepth>(
    await ports.selectChoice(
      "How deeply should Recurs understand the project before proposing your company?",
      COMPANY_ONBOARDING_DEPTH_CHOICES,
    ),
    COMPANY_ONBOARDING_DEPTH_CHOICES,
  ) ?? "guided";
  const designMode = companyChoice<CompanyDesignMode>(
    await ports.selectChoice(
      "How should Recurs form the company?",
      COMPANY_DESIGN_MODE_CHOICES,
    ),
    COMPANY_DESIGN_MODE_CHOICES,
  ) ?? "stable_core_specialists";
  const repositoryConsent = await ports.confirm!(
    "Allow company formation to inspect this project read-only? Only bounded file, outline, search, and read-only Git tools are exposed. No shell, writes, network, credentials, installation, MCP, skills, or project commands are available before approval.",
  );

  let service;
  try {
    service = await ports.createCompanyOnboarding!({
      permissionMode,
      operatingModeId,
    });
  } catch (error) {
    await writeOutput(
      ports.stderr,
      `Company formation is unavailable: ${safeCliErrorMessage(error)}\n`,
    );
    return {};
  }
  const start = {
    projectRoot: service.projectRoot,
    depth,
    designMode,
    permissionMode,
    operatingModeId,
    backendFingerprint: service.backendFingerprint,
    repositoryConsent,
    ...(ports.signal === undefined ? {} : { signal: ports.signal }),
  };
  let run;
  try {
    run = await service.coordinator.resume(start);
  } catch (error) {
    if (!(error instanceof CompanyOnboardingCoordinatorError) ||
      error.code !== "resume_mismatch") {
      throw error;
    }
    const choice = await ports.selectChoice(
      "An unfinished company interview uses different model or authority settings",
      Object.freeze([
        Object.freeze({
          id: "new",
          label: "Start a new interview (recommended)",
          detail: "preserve the earlier run unchanged",
        }),
        Object.freeze({
          id: "stop",
          label: "Save and stop",
          detail: "change back to the earlier settings before resuming",
        }),
      ]),
    );
    if (choice !== "new") return {};
    run = null;
  }
  if (run !== null) {
    const choice = await ports.selectChoice(
      "Resume the unfinished company interview?",
      Object.freeze([
        Object.freeze({
          id: "resume",
          label: "Resume (recommended)",
          detail: `${run.state.depth} · ${run.state.interview.answers.length} answered · ${run.state.research.length} investigations`,
        }),
        Object.freeze({
          id: "new",
          label: "Start a new interview",
          detail: "preserve the unfinished run and create another",
        }),
        Object.freeze({
          id: "stop",
          label: "Save and stop",
          detail: "leave all durable onboarding state unchanged",
        }),
      ]),
    );
    if (choice === "stop" || choice === null) return {};
    if (choice === "new") run = null;
  }
  if (run === null) run = await service.coordinator.start(start);

  for (;;) {
    const advanced = await service.coordinator.advance(run.state.id, ports.signal);
    run = advanced.run;
    if (advanced.kind === "researched") {
      const completed = run.state.research.filter((item) =>
        item.status === "completed"
      ).length;
      await writeOutput(
        ports.stdout,
        `Project understanding updated from ${completed} bounded investigation(s).\n`,
      );
      continue;
    }
    if (advanced.kind === "question") {
      const answer = (await ports.promptText(advanced.question.question))?.trim();
      if (answer === undefined || answer.length === 0) {
        await writeOutput(
          ports.stdout,
          `Company interview saved. Resume run ${run.state.id} during setup.\n`,
        );
        return {};
      }
      run = await service.coordinator.answer(
        run.state.id,
        run.sequence,
        answer,
        ports.signal,
      );
      continue;
    }

    const blueprint = advanced.blueprint;
    const requiredTools = blueprint.toolPlan
      .filter((tool) => tool.status === "required")
      .map((tool) => tool.id);
    const approved = await ports.confirm!([
      "Approve this company and freeze its first goal?",
      `Project: ${blueprint.project.purpose}`,
      `Design: ${blueprint.designMode.replaceAll("_", " ")}`,
      `Departments: ${blueprint.departments.map((item) => item.displayName).join(", ")}`,
      `Roles: ${blueprint.roles.map((item) => item.displayName).join(", ")}`,
      `Authority: ${blueprint.authority.permissionMode.replaceAll("_", " ")} · ${blueprint.authority.operatingModeId}`,
      `Required capabilities: ${requiredTools.join(", ") || "none"}`,
      `Initial goal: ${blueprint.initialGoal}`,
      "Approval does not begin implementation. The approved /goal starts bounded company operation later.",
    ].join("\n"));
    const brief = { purpose: blueprint.project.purpose };
    if (!approved) {
      await service.coordinator.abandon(
        run.state.id,
        run.sequence,
        "The user declined the proposed company.",
        ports.signal,
      );
      await writeOutput(ports.stdout, "Company proposal was not activated.\n");
      return { brief };
    }
    const approvedRun = await service.coordinator.approve(
      run.state.id,
      run.sequence,
      ports.signal,
    );
    const approvedBlueprint = await service.coordinator.approvedBlueprint(
      approvedRun.state.approvedBlueprintId!,
      ports.signal,
    );
    await writeOutput(
      ports.stdout,
      `Company approved: ${approvedBlueprint.departments.length} department(s), ${approvedBlueprint.roles.length} role(s).\n`,
    );
    return { blueprintV2: approvedBlueprint, brief };
  }
}

async function setupProjectContext(
  ports: GuidedOnboardingPorts,
  captured?: CapturedProjectBrief,
): Promise<void> {
  if (ports.inspectProjectInstructions === undefined) {
    await writeOutput(
      ports.stdout,
      "Project context: run /init later to create AGENTS.md instructions.\n",
    );
    return;
  }
  const existing = await ports.inspectProjectInstructions();
  if (existing.length > 0) {
    await writeOutput(
      ports.stdout,
      `Project context: ${existing.map((document) => document.source).join(" → ")} will load at the start of every agent turn.\n`,
    );
    return;
  }
  if (ports.createProjectInstructions === undefined || ports.confirm === undefined) {
    await writeOutput(
      ports.stdout,
      "Project context: no AGENTS.md found; run /init later to create one.\n",
    );
    return;
  }
  const action = await ports.selectChoice(
    "Give the new agent team project context",
    Object.freeze([
      Object.freeze({
        id: "create",
        label: "Create a project brief (recommended)",
        detail: "write a confirmed AGENTS.md without overwriting existing files",
      }),
      Object.freeze({
        id: "skip",
        label: "Skip for now",
        detail: "use /init or write AGENTS.md later",
      }),
    ]),
  );
  if (action !== "create") return;
  const purpose = captured?.purpose ?? (await ports.promptText(
    "Describe what this project is building in one or two sentences",
  ))?.trim() ?? "";
  if (!isValidProjectBriefText(purpose)) {
    await writeOutput(
      ports.stdout,
      "Project brief skipped because no valid project description was entered.\n",
    );
    return;
  }
  const rawNotes = captured?.notes ?? (await ports.promptText(
    "Add important build, test, architecture, or safety notes (optional)",
  ))?.trim() ?? "";
  const notes = rawNotes.length === 0
    ? undefined
    : isValidProjectBriefText(rawNotes)
      ? rawNotes
      : null;
  if (notes === null) {
    await writeOutput(
      ports.stdout,
      "Project brief skipped because the project notes were not valid text of at most 2000 characters.\n",
    );
    return;
  }
  const confirmed = await ports.confirm([
    "Create AGENTS.md with this project context? Recurs will never overwrite an existing project-instruction file.",
    `Project: ${purpose}`,
    ...(notes === undefined ? [] : [`Working agreements: ${notes}`]),
  ].join("\n"));
  if (!confirmed) {
    await writeOutput(ports.stdout, "Project brief was not created.\n");
    return;
  }
  const result = await ports.createProjectInstructions({
    purpose,
    ...(notes === undefined ? {} : { notes }),
  });
  await writeOutput(
    ports.stdout,
    result === "created"
      ? "Project context: created AGENTS.md; it will load at the start of every agent turn.\n"
      : "Project context appeared concurrently; Recurs did not overwrite it.\n",
  );
}

export async function runGuidedOnboarding(
  ports: GuidedOnboardingPorts,
): Promise<GuidedOnboardingOutcome> {
  if (!ports.interactive || ports.automation) {
    await writeOutput(
      ports.stderr,
      "Error: Guided setup requires a user-present local terminal\n",
    );
    return { state: "failed", exitCode: 2 };
  }
  await writeOutput(ports.stdout, [
    "\nWelcome to Recurs",
    "Build a working agent company: connect its parent model, set its safety boundary, choose its operating mode, route specialists, and review a project-tailored roster.",
    "Credentials stay with the vendor runtime, native authority, or named process environment—never this generic prompt.",
    "",
  ].join("\n"));
  const [accounts, localRuntimes, providers] = await Promise.all([
    ports.listAccounts?.() ?? Promise.resolve([]),
    ports.detectProviders?.(ports.signal).catch(() => []) ?? Promise.resolve([]),
    ports.listProviders?.({ includeBlocked: false }) ?? Promise.resolve([]),
  ]);
  const choices = guidedConnectionChoices({
    accounts,
    localRuntimes,
    providers,
    nativeProviders: ports.nativeProviders,
  });
  if (choices.length === 0) {
    await writeOutput(
      ports.stderr,
      "No reviewed setup path is currently available. Use /provider for diagnostics.\n",
    );
    return { state: "skipped" };
  }
  const companyOnboarding = ports.confirm !== undefined &&
    (ports.createCompanyOnboarding !== undefined ||
      ports.inspectCompanyRepositoryFacts !== undefined);
  const stepCount = companyOnboarding ? 6 : 5;
  await writeOutput(ports.stdout, `1 / ${stepCount} · Parent model\n`);
  let selected: GuidedConnectionChoice | null = null;
  while (true) {
    if (selected === null) {
      const selectedId = await ports.selectChoice(
        "Choose how Recurs should access a model",
        choices,
      );
      if (selectedId === null) {
        await writeOutput(
          ports.stdout,
          "Setup skipped. Run recurs setup or /provider whenever you are ready.\n",
        );
        return { state: "skipped" };
      }
      selected = choices.find((choice) => choice.id === selectedId) ?? null;
      if (selected === null) {
        await writeOutput(ports.stderr, "Error: Invalid setup selection\n");
        return { state: "failed", exitCode: 2 };
      }
    }

    let connectionExit: number;
    try {
      connectionExit = await executeConnectionAction(
        selected.action,
        providers,
        ports,
      );
    } catch (error) {
      await writeOutput(
        ports.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      connectionExit = 1;
    }
    if (connectionExit === 0) break;
    if (connectionExit === 130 || ports.signal?.aborted === true) {
      return { state: "failed", exitCode: 130 };
    }

    const recovery = await ports.selectChoice(
      "The parent-model connection was not completed",
      Object.freeze([
        Object.freeze({
          id: "retry_connection",
          label: "Try this connection again",
          detail: selected.label,
        }),
        Object.freeze({
          id: "change_connection",
          label: "Choose another connection",
          detail: "return to the available provider and runtime list",
        }),
        Object.freeze({
          id: "stop_setup",
          label: "Stop setup",
          detail: "leave without creating a configured session",
        }),
      ]),
    );
    if (recovery === "retry_connection") continue;
    if (recovery === "change_connection") {
      selected = null;
      continue;
    }
    return { state: "failed", exitCode: connectionExit };
  }
  await writeOutput(ports.stdout, `\n2 / ${stepCount} · Safety boundary\n`);
  const permissionMode = await selectPermission(ports);
  await writeOutput(ports.stdout, `\n3 / ${stepCount} · Team operating mode\n`);
  const operatingModeId = await selectOperatingMode(ports);
  await writeOutput(ports.stdout, `\n4 / ${stepCount} · Specialist routing\n`);
  const accountsAfterConnection = await ports.listAccounts?.() ?? [];
  const routed = await configureTeamRoutes(
    accountsAfterConnection,
    operatingModeId,
    ports,
  );
  if (!routed) return { state: "failed", exitCode: 2 };
  let company: CompanyOnboardingResult = {};
  if (companyOnboarding) {
    await writeOutput(ports.stdout, "\n5 / 6 · Agent company\n");
    company = await setupCompanyBlueprint(
      ports,
      permissionMode,
      operatingModeId,
    );
  }
  await writeOutput(
    ports.stdout,
    `\n${companyOnboarding ? 6 : 5} / ${stepCount} · Project context\n`,
  );
  await setupProjectContext(ports, company.brief);
  const accountsAfterRouting = await ports.listAccounts?.() ?? accountsAfterConnection;
  const primary = accountsAfterRouting.find((account) => account.primary);
  const operatingMode = getOperatingModePolicy(operatingModeId);
  await writeOutput(ports.stdout, [
    "Onboarding complete",
    `Connection: ${primary === undefined ? "ready" : `${primary.label} · ${primary.modelId}`}`,
    `Permissions: ${permissionMode.replaceAll("_", " ")}`,
    `Mode: ${operatingMode.displayName} · ${operatingMode.id}`,
    `Team: ${routeSummary(accountsAfterRouting)}`,
    `Company: ${company.blueprintV2 !== undefined
      ? `${company.blueprintV2.departments.length} department(s) · ${company.blueprintV2.roles.length} approved role(s)`
      : company.blueprint === undefined
        ? "not activated"
        : `${company.blueprint.roles.length} approved role(s) · ${company.blueprint.developmentStyle.replaceAll("_", " ")}`}`,
    "Starting a fresh durable session. Change these later with /provider, /model, /permissions, or /agents mode.",
    "",
  ].join("\n"));
  return {
    state: "configured",
    permissionMode,
    operatingModeId,
    ...(company.blueprint === undefined
      ? {}
      : { companyBlueprint: company.blueprint }),
    ...(company.blueprintV2 === undefined
      ? {}
      : { companyBlueprintV2: company.blueprintV2 }),
  };
}
