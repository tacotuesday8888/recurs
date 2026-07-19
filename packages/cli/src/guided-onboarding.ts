import type { Writable } from "node:stream";

import {
  DEFAULT_OPERATING_MODE_ID,
  getOperatingModePolicy,
  operatingModePolicies,
  type OperatingModeId,
  type TeamRunRole,
} from "@recurs/contracts";
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
  executeCommand(argv: readonly string[]): Promise<number>;
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
    const modelId = hasEnvironmentProviderModelDiscovery(action.providerId)
      ? await selectEnvironmentModel(
          action.providerId,
          label,
          environmentVariable,
          ports,
        )
      : await selectCatalogModel(action.providerId, label, ports);
    if (modelId === null) return 2;
    return await ports.executeCommand([
      "setup",
      "byok",
      "--provider",
      action.providerId,
      "--model",
      modelId,
      "--key-env",
      environmentVariable,
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
    "Build a working agent team: connect its parent model, set its safety boundary, choose its operating mode, and optionally route specialist roles.",
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
  await writeOutput(ports.stdout, "1 / 4 · Parent model\n");
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
  const selected = choices.find((choice) => choice.id === selectedId);
  if (selected === undefined) {
    await writeOutput(ports.stderr, "Error: Invalid setup selection\n");
    return { state: "failed", exitCode: 2 };
  }
  const connectionExit = await executeConnectionAction(
    selected.action,
    providers,
    ports,
  );
  if (connectionExit !== 0) {
    return { state: "failed", exitCode: connectionExit };
  }
  await writeOutput(ports.stdout, "\n2 / 4 · Safety boundary\n");
  const permissionMode = await selectPermission(ports);
  await writeOutput(ports.stdout, "\n3 / 4 · Team operating mode\n");
  const operatingModeId = await selectOperatingMode(ports);
  await writeOutput(ports.stdout, "\n4 / 4 · Specialist routing\n");
  const accountsAfterConnection = await ports.listAccounts?.() ?? [];
  const routed = await configureTeamRoutes(
    accountsAfterConnection,
    operatingModeId,
    ports,
  );
  if (!routed) return { state: "failed", exitCode: 2 };
  const accountsAfterRouting = await ports.listAccounts?.() ?? accountsAfterConnection;
  const primary = accountsAfterRouting.find((account) => account.primary);
  const operatingMode = getOperatingModePolicy(operatingModeId);
  await writeOutput(ports.stdout, [
    "Onboarding complete",
    `Connection: ${primary === undefined ? "ready" : `${primary.label} · ${primary.modelId}`}`,
    `Permissions: ${permissionMode.replaceAll("_", " ")}`,
    `Mode: ${operatingMode.displayName} · ${operatingMode.id}`,
    `Team: ${routeSummary(accountsAfterRouting)}`,
    "Starting a fresh durable session. Change these later with /provider, /model, /permissions, or /agents mode.",
    "",
  ].join("\n"));
  return { state: "configured", permissionMode, operatingModeId };
}
