import {
  getOperatingModePolicy,
  parseOperatingModeId,
  type AgentPermissionMode,
  type OperatingModeId,
  type OperatingModeVersion,
} from "./agents.js";
import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractIds,
  contractInteger,
  contractNumber,
  contractRecord,
  contractText,
  contractTimestamp,
} from "./company-contract-utils.js";
import type { ModelReasoningEffort } from "./model.js";

export const COMPANY_BENCHMARK_MINIMUM_COMPARABLE_PAIRS = 3;

const MAX_COMPANY_ARMS = 3;
const MAX_REPETITIONS = 10;
const MAX_TRIAL_SLOTS = (MAX_COMPANY_ARMS + 1) * MAX_REPETITIONS;
const MAX_REQUESTS = 100_000;
const MAX_REPORTED_COST_USD = 1_000_000;
const MAX_COUNT = 100_000;
const MAX_PATHS = 256;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ARM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export type CompanyBenchmarkTaskClass = "general_coding";
export type CompanyBenchmarkDifficulty = "small" | "medium" | "large";
export type CompanyBenchmarkArmKind = "single_agent" | "company";
export type CompanyBenchmarkRole = "parent" | "implement" | "review" | "repair";
export type CompanyBenchmarkCoverage = "none" | "partial" | "complete";
export type CompanyBenchmarkExecutionStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type CompanyBenchmarkVerificationStatus =
  | "passed"
  | "failed"
  | "not_run";
export type CompanyBenchmarkEligibility =
  | "insufficient_evidence"
  | "comparable";
export type CompanyBenchmarkRationale =
  | "campaign_incomplete"
  | "minimum_comparable_pairs_not_met"
  | "minimum_comparable_pairs_met"
  | "verification_not_run"
  | "verification_or_safety_failed"
  | "usage_incomplete";

export interface CompanyBenchmarkScenarioRefV1 {
  readonly id: string;
  readonly version: 1;
  readonly taskClass: CompanyBenchmarkTaskClass;
  readonly difficulty: CompanyBenchmarkDifficulty;
  readonly fixtureSha256: string;
  readonly verifierId: string;
  readonly objectiveRevision: string;
}

export interface CompanyBenchmarkRouteV1 {
  readonly role: CompanyBenchmarkRole;
  readonly providerId: string;
  readonly adapterId: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly reasoningEffort: ModelReasoningEffort | null;
}

export interface CompanyBenchmarkBlueprintRefV1 {
  readonly id: string;
  readonly revision: number;
  readonly sha256: string;
}

export interface CompanyBenchmarkArmV1 {
  readonly id: string;
  readonly kind: CompanyBenchmarkArmKind;
  readonly configuredRoutes: readonly CompanyBenchmarkRouteV1[];
}

export interface CompanyBenchmarkTrialSlotV1 {
  readonly slotId: string;
  readonly armId: string;
  readonly repetition: number;
}

export interface CompanyBenchmarkCampaignCeilingsV1 {
  readonly maxTrialSlots: number;
  readonly maxRequests: number;
  readonly maxReportedCostUsd: number;
}

export interface CompanyBenchmarkCampaignV1 {
  readonly id: string;
  readonly version: 1;
  readonly createdAt: string;
  readonly scenario: CompanyBenchmarkScenarioRefV1;
  readonly harnessRevision: string;
  readonly launchProtocolRevision: string;
  readonly operatingModeId: OperatingModeId;
  readonly operatingModeVersion: OperatingModeVersion;
  readonly permissionMode: AgentPermissionMode;
  readonly repetitions: number;
  readonly ceilings: CompanyBenchmarkCampaignCeilingsV1;
  readonly blueprint: CompanyBenchmarkBlueprintRefV1;
  readonly baseline: CompanyBenchmarkArmV1 & { readonly kind: "single_agent" };
  readonly companyArms: readonly (
    CompanyBenchmarkArmV1 & { readonly kind: "company" }
  )[];
  readonly armOrder: readonly CompanyBenchmarkTrialSlotV1[];
}

export interface CompanyBenchmarkUsageV1 {
  readonly requestsUsed: number;
  readonly usageReports: number;
  readonly costReports: number;
  readonly tokenCoverage: CompanyBenchmarkCoverage;
  readonly costCoverage: CompanyBenchmarkCoverage;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly reportedCostUsd: number | null;
}

export interface CompanyBenchmarkRoleObservationV1 {
  readonly role: CompanyBenchmarkRole;
  readonly attempts: number;
  readonly completedAttempts: number;
  readonly failedAttempts: number;
  readonly cancelledAttempts: number;
  /** Earliest start to latest completion for this role; not additive. */
  readonly wallClockMs: number;
  /** One elapsed duration per attempt; never summed into trial wall time. */
  readonly attemptLatenciesMs: readonly number[];
  readonly usage: CompanyBenchmarkUsageV1;
  readonly evidenceItems: number;
  readonly changedFiles: readonly string[];
}

export interface CompanyBenchmarkVerificationV1 {
  readonly status: CompanyBenchmarkVerificationStatus;
  readonly workspaceIntegrity: CompanyBenchmarkVerificationStatus;
  readonly checks: readonly {
    readonly id: string;
    readonly status: "passed" | "failed";
  }[];
}

export interface CompanyBenchmarkReviewObservationV1 {
  readonly attempts: number;
  readonly approved: number;
  readonly changesRequested: number;
  readonly unverified: number;
  /** Terminal verdict from the last durable review record. */
  readonly finalVerdict:
    | "approved"
    | "changes_requested"
    | "unverified"
    | null;
  readonly findings: number;
  readonly affectedPaths: readonly string[];
  readonly evidenceItems: number;
}

export interface CompanyBenchmarkInterventionsV1 {
  readonly externalConfirmationRequests: number;
  readonly userInputRequests: number;
  readonly automaticApprovals: number;
  readonly automaticDenials: number;
}

export interface CompanyBenchmarkEvidenceCountsV1 {
  readonly roleItems: number;
  readonly finalItems: number;
}

export interface CompanyBenchmarkOverlapV1 {
  readonly metric: "changed_file_overlap_v1";
  /** Files claimed by at least two parallel Implement attempts. */
  readonly implementOverlappingPaths: readonly string[];
  /** Implement claims beyond the first claim for each overlapping path. */
  readonly implementDuplicateClaims: number;
  /** Repair touches are recorded separately from Implement duplication. */
  readonly repairTouchedImplementationPaths: readonly string[];
}

export interface CompanyBenchmarkFailureV1 {
  readonly stage:
    | "setup"
    | "execution"
    | "verification"
    | "projection"
    | "cleanup";
  /** Stable bounded code only; raw model or tool prose is forbidden. */
  readonly code: string;
}

export interface CompanyBenchmarkTrialV1 {
  readonly id: string;
  readonly version: 1;
  readonly campaignId: string;
  readonly slotId: string;
  readonly armId: string;
  readonly armKind: CompanyBenchmarkArmKind;
  readonly repetition: number;
  readonly scenario: CompanyBenchmarkScenarioRefV1;
  readonly harnessRevision: string;
  readonly launchProtocolRevision: string;
  readonly blueprint: CompanyBenchmarkBlueprintRefV1 | null;
  readonly configuredRoutes: readonly CompanyBenchmarkRouteV1[];
  readonly activatedRoutes: readonly CompanyBenchmarkRouteV1[];
  readonly executionStatus: CompanyBenchmarkExecutionStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  /** Whole-trial elapsed time; role durations may overlap. */
  readonly wallClockMs: number;
  readonly roles: readonly CompanyBenchmarkRoleObservationV1[];
  readonly usage: CompanyBenchmarkUsageV1;
  readonly verification: CompanyBenchmarkVerificationV1;
  readonly review: CompanyBenchmarkReviewObservationV1;
  readonly repairRounds: number;
  readonly interventions: CompanyBenchmarkInterventionsV1;
  readonly evidence: CompanyBenchmarkEvidenceCountsV1;
  readonly changedFiles: readonly string[];
  readonly overlap: CompanyBenchmarkOverlapV1;
  readonly failures: readonly CompanyBenchmarkFailureV1[];
}

export interface CompanyBenchmarkComparablePairV1 {
  readonly companyArmId: string;
  readonly repetition: number;
  readonly baselineTrialId: string;
  readonly companyTrialId: string;
}

export interface CompanyBenchmarkCampaignSummaryV1 {
  readonly id: string;
  readonly version: 1;
  readonly campaignId: string;
  readonly createdAt: string;
  readonly correctnessEligibility: CompanyBenchmarkEligibility;
  readonly efficiencyEligibility: CompanyBenchmarkEligibility;
  readonly tokenCoverage: CompanyBenchmarkCoverage;
  readonly costCoverage: CompanyBenchmarkCoverage;
  readonly completedTrialIds: readonly string[];
  readonly comparablePairs: readonly CompanyBenchmarkComparablePairV1[];
  readonly efficiencyComparablePairs:
    readonly CompanyBenchmarkComparablePairV1[];
  readonly rationale: readonly CompanyBenchmarkRationale[];
}

export interface CompanyBenchmarkSummaryEvidenceV1 {
  readonly correctnessEligibility: CompanyBenchmarkEligibility;
  readonly efficiencyEligibility: CompanyBenchmarkEligibility;
  readonly tokenCoverage: CompanyBenchmarkCoverage;
  readonly costCoverage: CompanyBenchmarkCoverage;
  readonly comparablePairs: readonly CompanyBenchmarkComparablePairV1[];
  readonly efficiencyComparablePairs:
    readonly CompanyBenchmarkComparablePairV1[];
  readonly rationale: readonly CompanyBenchmarkRationale[];
}

const ROLE_ORDER = [
  "parent",
  "implement",
  "review",
  "repair",
] as const satisfies readonly CompanyBenchmarkRole[];
const TASK_CLASSES = new Set<string>(["general_coding"]);
const DIFFICULTIES = new Set<string>(["small", "medium", "large"]);
const ROLES = new Set<string>(ROLE_ORDER);
const EFFORTS = new Set<string>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const ARM_KINDS = new Set<string>(["single_agent", "company"]);
const PERMISSION_MODES = new Set<string>([
  "ask_always",
  "approved_for_me",
  "full_access",
]);
const COVERAGE = new Set<string>(["none", "partial", "complete"]);
const EXECUTION_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const VERIFICATION_STATUSES = new Set<string>([
  "passed",
  "failed",
  "not_run",
]);
const ELIGIBILITY = new Set<string>([
  "insufficient_evidence",
  "comparable",
]);
const RATIONALES = new Set<string>([
  "campaign_incomplete",
  "minimum_comparable_pairs_not_met",
  "minimum_comparable_pairs_met",
  "verification_not_run",
  "verification_or_safety_failed",
  "usage_incomplete",
]);
const FAILURE_STAGES = new Set<string>([
  "setup",
  "execution",
  "verification",
  "projection",
  "cleanup",
]);

function exact(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const parsed = contractRecord(value, label);
  contractExact(parsed, keys, label);
  return parsed;
}

function integerField(
  record: Record<string, unknown>,
  key: string,
  label: string,
  minimum = 0,
  maximum = MAX_COUNT,
): number {
  return contractInteger(record[key], label, minimum, maximum);
}

function idField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  return contractId(record[key], label);
}

function enumField<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  return contractEnum<T>(record[key], allowed, label);
}

function list<T>(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  parse: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.map(parse);
}

function assertUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string,
): void {
  if (new Set(items.map(key)).size !== items.length) {
    throw new TypeError(`${label} must be unique`);
  }
}

function assertSorted(
  values: readonly string[],
  label: string,
): void {
  const sorted = [...values].sort();
  if (values.some((value, index) => value !== sorted[index])) {
    throw new TypeError(`${label} must be sorted`);
  }
}

function armId(value: unknown, label = "Company benchmark arm id"): string {
  const parsed = contractId(value, label);
  if (!SAFE_ARM_ID.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const parsed = contractText(value, label, 64);
  if (!SHA256.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function backendId(value: unknown, label: string): string {
  const parsed = contractText(value, label, 256);
  if (/\s/u.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function optionalInteger(value: unknown, label: string): number | null {
  return value === null ? null : contractInteger(value, label, 0);
}

function optionalNumber(value: unknown, label: string): number | null {
  return value === null
    ? null
    : contractNumber(value, label, 0, MAX_REPORTED_COST_USD);
}

function safePath(value: unknown, label: string): string {
  const path = contractText(value, label, 4_096);
  if (path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.includes("\\") ||
    path.includes("\0")) {
    throw new TypeError(`${label} is unsafe`);
  }
  const segments = path.split("/");
  if (segments.some((segment) =>
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment === ".git" ||
    [...segment].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  )) {
    throw new TypeError(`${label} is unsafe`);
  }
  return path;
}

function pathList(value: unknown, label: string): string[] {
  const parsed = list(value, label, 0, MAX_PATHS, (item) =>
    safePath(item, label)
  );
  assertUnique(parsed, (item) => item, label);
  assertSorted(parsed, label);
  return parsed;
}

function parseScenario(value: unknown): CompanyBenchmarkScenarioRefV1 {
  const item = exact(value, "Company benchmark scenario", [
    "id", "version", "taskClass", "difficulty", "fixtureSha256", "verifierId",
    "objectiveRevision",
  ]);
  if (item.version !== 1) {
    throw new TypeError("Company benchmark scenario version is unsupported");
  }
  return {
    id: idField(item, "id", "Company benchmark scenario id"),
    version: 1,
    taskClass: enumField(
      item,
      "taskClass",
      TASK_CLASSES,
      "Company benchmark task class",
    ),
    difficulty: enumField(
      item,
      "difficulty",
      DIFFICULTIES,
      "Company benchmark difficulty",
    ),
    fixtureSha256: sha256(
      item.fixtureSha256,
      "Company benchmark fixture digest",
    ),
    verifierId: idField(
      item,
      "verifierId",
      "Company benchmark verifier id",
    ),
    objectiveRevision: idField(
      item,
      "objectiveRevision",
      "Company benchmark objective revision",
    ),
  };
}

function parseRoute(value: unknown): CompanyBenchmarkRouteV1 {
  const item = exact(value, "Company benchmark route", [
    "role", "providerId", "adapterId", "connectionId", "modelId",
    "reasoningEffort",
  ]);
  return {
    role: enumField(item, "role", ROLES, "Company benchmark role"),
    providerId: backendId(item.providerId, "Company benchmark provider"),
    adapterId: backendId(item.adapterId, "Company benchmark adapter"),
    connectionId: backendId(item.connectionId, "Company benchmark connection"),
    modelId: backendId(item.modelId, "Company benchmark model"),
    reasoningEffort: item.reasoningEffort === null
      ? null
      : contractEnum(
          item.reasoningEffort,
          EFFORTS,
          "Company benchmark reasoning effort",
        ),
  };
}

function parseConfiguredRoutes(
  value: unknown,
  kind: CompanyBenchmarkArmKind,
): CompanyBenchmarkRouteV1[] {
  const expectedRoles = kind === "single_agent"
    ? ROLE_ORDER.slice(0, 1)
    : ROLE_ORDER;
  const parsed = list(
    value,
    "Company benchmark configured routes",
    expectedRoles.length,
    expectedRoles.length,
    parseRoute,
  );
  if (parsed.some((route, index) => route.role !== expectedRoles[index])) {
    throw new TypeError(
      "Company benchmark configured route roles are invalid",
    );
  }
  return parsed;
}

function parseActivatedRoutes(
  value: unknown,
  configured: readonly CompanyBenchmarkRouteV1[],
): CompanyBenchmarkRouteV1[] {
  const parsed = list(
    value,
    "Company benchmark activated routes",
    0,
    configured.length,
    parseRoute,
  );
  if (parsed.some((route, index) =>
    index > 0 &&
      ROLE_ORDER.indexOf(route.role) <=
        ROLE_ORDER.indexOf(parsed[index - 1]!.role)
  ) ||
    parsed.length > 0 && parsed[0]?.role !== "parent" ||
    parsed.some((route) => {
      const expected = configured.find((item) => item.role === route.role);
      return expected === undefined || !sameRoute(route, expected);
    })) {
    throw new TypeError(
      "Every Company benchmark activated route must match its configured route",
    );
  }
  return parsed;
}

function sameRoute(
  left: CompanyBenchmarkRouteV1,
  right: CompanyBenchmarkRouteV1,
): boolean {
  return left.role === right.role &&
    left.providerId === right.providerId &&
    left.adapterId === right.adapterId &&
    left.connectionId === right.connectionId &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort;
}

function sameRoutes(
  left: readonly CompanyBenchmarkRouteV1[],
  right: readonly CompanyBenchmarkRouteV1[],
): boolean {
  return left.length === right.length &&
    left.every((route, index) => sameRoute(route, right[index]!));
}

function sameScenario(
  left: CompanyBenchmarkScenarioRefV1,
  right: CompanyBenchmarkScenarioRefV1,
): boolean {
  return left.id === right.id &&
    left.version === right.version &&
    left.taskClass === right.taskClass &&
    left.difficulty === right.difficulty &&
    left.fixtureSha256 === right.fixtureSha256 &&
    left.verifierId === right.verifierId &&
    left.objectiveRevision === right.objectiveRevision;
}

function parseBlueprint(value: unknown): CompanyBenchmarkBlueprintRefV1 {
  const item = exact(
    value,
    "Company benchmark blueprint",
    ["id", "revision", "sha256"],
  );
  return {
    id: idField(item, "id", "Company benchmark blueprint id"),
    revision: integerField(
      item,
      "revision",
      "Company benchmark blueprint revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    sha256: sha256(item.sha256, "Company benchmark blueprint digest"),
  };
}

function sameBlueprint(
  left: CompanyBenchmarkBlueprintRefV1 | null,
  right: CompanyBenchmarkBlueprintRefV1 | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.id === right.id &&
      left.revision === right.revision &&
      left.sha256 === right.sha256;
}

function parseArm(
  value: unknown,
  expectedKind: CompanyBenchmarkArmKind,
): CompanyBenchmarkArmV1 {
  const item = exact(
    value,
    "Company benchmark arm",
    ["id", "kind", "configuredRoutes"],
  );
  const kind = enumField<CompanyBenchmarkArmKind>(
    item,
    "kind",
    new Set([expectedKind]),
    "Company benchmark arm kind",
  );
  return {
    id: armId(item.id),
    kind,
    configuredRoutes: parseConfiguredRoutes(item.configuredRoutes, kind),
  };
}

export function companyBenchmarkTrialSlotId(
  candidateArmId: string,
  repetition: number,
): string {
  return contractId(
    `slot_${contractInteger(
      repetition,
      "Company benchmark repetition",
      1,
      MAX_REPETITIONS,
    )}_${armId(candidateArmId)}`,
    "Company benchmark trial slot id",
  );
}

function canonicalArmOrder(
  baselineId: string,
  companyArmIds: readonly string[],
  repetitions: number,
): CompanyBenchmarkTrialSlotV1[] {
  const slots: CompanyBenchmarkTrialSlotV1[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const ids = repetition % 2 === 1
      ? [baselineId, ...companyArmIds]
      : [...companyArmIds].reverse().concat(baselineId);
    for (const candidateArmId of ids) {
      slots.push({
        slotId: companyBenchmarkTrialSlotId(candidateArmId, repetition),
        armId: candidateArmId,
        repetition,
      });
    }
  }
  return slots;
}

function parseTrialSlot(value: unknown): CompanyBenchmarkTrialSlotV1 {
  const item = exact(
    value,
    "Company benchmark trial slot",
    ["slotId", "armId", "repetition"],
  );
  const parsedArmId = armId(item.armId);
  const repetition = integerField(
    item,
    "repetition",
    "Company benchmark repetition",
    1,
    MAX_REPETITIONS,
  );
  const slotId = idField(item, "slotId", "Company benchmark trial slot id");
  if (slotId !== companyBenchmarkTrialSlotId(parsedArmId, repetition)) {
    throw new TypeError("Company benchmark trial slot id is inconsistent");
  }
  return { slotId, armId: parsedArmId, repetition };
}

export function parseCompanyBenchmarkCampaign(
  value: unknown,
): CompanyBenchmarkCampaignV1 {
  const item = exact(value, "Company benchmark campaign", [
    "id", "version", "createdAt", "scenario", "harnessRevision",
    "launchProtocolRevision", "operatingModeId", "operatingModeVersion",
    "permissionMode", "repetitions", "ceilings", "blueprint", "baseline",
    "companyArms", "armOrder",
  ]);
  if (item.version !== 1) {
    throw new TypeError("Company benchmark campaign version is unsupported");
  }

  const baseline = parseArm(item.baseline, "single_agent") as
    CompanyBenchmarkCampaignV1["baseline"];
  const companyArms = list(
    item.companyArms,
    "Company benchmark company arms",
    1,
    MAX_COMPANY_ARMS,
    (arm) => parseArm(arm, "company") as
      CompanyBenchmarkCampaignV1["companyArms"][number],
  );
  const allArmIds = [baseline.id, ...companyArms.map((arm) => arm.id)];
  assertUnique(allArmIds, (id) => id, "Company benchmark arm ids");
  assertSorted(
    companyArms.map((arm) => arm.id),
    "Company benchmark company arms",
  );
  if (companyArms.some((arm) =>
    !sameRoute(arm.configuredRoutes[0]!, baseline.configuredRoutes[0]!)
  )) {
    throw new TypeError(
      "Every company benchmark arm must use the baseline parent route",
    );
  }

  const repetitions = integerField(
    item,
    "repetitions",
    "Company benchmark repetitions",
    1,
    MAX_REPETITIONS,
  );
  const ceilingInput = exact(
    item.ceilings,
    "Company benchmark campaign ceilings",
    ["maxTrialSlots", "maxRequests", "maxReportedCostUsd"],
  );
  const ceilings: CompanyBenchmarkCampaignCeilingsV1 = {
    maxTrialSlots: integerField(
      ceilingInput,
      "maxTrialSlots",
      "Company benchmark trial-slot ceiling",
      1,
      MAX_TRIAL_SLOTS,
    ),
    maxRequests: integerField(
      ceilingInput,
      "maxRequests",
      "Company benchmark request ceiling",
      1,
      MAX_REQUESTS,
    ),
    maxReportedCostUsd: contractNumber(
      ceilingInput.maxReportedCostUsd,
      "Company benchmark reported-cost ceiling",
      0,
      MAX_REPORTED_COST_USD,
    ),
  };
  const armOrder = list(
    item.armOrder,
    "Company benchmark arm order",
    1,
    MAX_TRIAL_SLOTS,
    parseTrialSlot,
  );
  const expectedOrder = canonicalArmOrder(
    baseline.id,
    companyArms.map((arm) => arm.id),
    repetitions,
  );
  if (armOrder.length !== expectedOrder.length ||
    armOrder.some((slot, index) =>
      slot.slotId !== expectedOrder[index]?.slotId ||
      slot.armId !== expectedOrder[index]?.armId ||
      slot.repetition !== expectedOrder[index]?.repetition
    )) {
    throw new TypeError("Company benchmark arm order is not canonical");
  }
  if (ceilings.maxTrialSlots !== armOrder.length) {
    throw new TypeError(
      "Company benchmark trial-slot ceiling must equal the planned slots",
    );
  }
  if (ceilings.maxRequests < armOrder.length) {
    throw new TypeError(
      "Company benchmark request ceiling cannot cover the planned slots",
    );
  }

  const modeText = contractText(
    item.operatingModeId,
    "Company benchmark operating mode",
    128,
  );
  const operatingModeId = parseOperatingModeId(modeText);
  if (operatingModeId === null) {
    throw new TypeError("Company benchmark operating mode is invalid");
  }
  const operatingModeVersion = integerField(
    item,
    "operatingModeVersion",
    "Company benchmark operating-mode version",
    1,
    6,
  ) as OperatingModeVersion;
  if (operatingModeVersion !==
      getOperatingModePolicy(operatingModeId).version) {
    throw new TypeError("Company benchmark operating-mode version is invalid");
  }

  return contractDeepFreeze({
    id: idField(item, "id", "Company benchmark campaign id"),
    version: 1,
    createdAt: contractTimestamp(
      item.createdAt,
      "Company benchmark campaign timestamp",
    ),
    scenario: parseScenario(item.scenario),
    harnessRevision: idField(
      item,
      "harnessRevision",
      "Company benchmark harness revision",
    ),
    launchProtocolRevision: idField(
      item,
      "launchProtocolRevision",
      "Company benchmark launch-protocol revision",
    ),
    operatingModeId,
    operatingModeVersion,
    permissionMode: enumField(
      item,
      "permissionMode",
      PERMISSION_MODES,
      "Company benchmark permission mode",
    ),
    repetitions,
    ceilings,
    blueprint: parseBlueprint(item.blueprint),
    baseline,
    companyArms,
    armOrder,
  }) as CompanyBenchmarkCampaignV1;
}

function expectedCoverage(
  reports: number,
  requests: number,
): CompanyBenchmarkCoverage {
  return reports === 0 ? "none" : reports === requests ? "complete" : "partial";
}

function parseUsage(value: unknown): CompanyBenchmarkUsageV1 {
  const item = exact(value, "Company benchmark usage", [
    "requestsUsed", "usageReports", "costReports", "tokenCoverage",
    "costCoverage", "inputTokens", "outputTokens", "cachedInputTokens",
    "cacheWriteInputTokens", "reasoningTokens", "reportedCostUsd",
  ]);
  const requestsUsed = integerField(
    item,
    "requestsUsed",
    "Company benchmark requests used",
    0,
    MAX_REQUESTS,
  );
  const usageReports = integerField(
    item,
    "usageReports",
    "Company benchmark usage reports",
    0,
    requestsUsed,
  );
  const costReports = integerField(
    item,
    "costReports",
    "Company benchmark cost reports",
    0,
    usageReports,
  );
  const tokenCoverage = enumField<CompanyBenchmarkCoverage>(
    item,
    "tokenCoverage",
    COVERAGE,
    "Company benchmark token coverage",
  );
  const costCoverage = enumField<CompanyBenchmarkCoverage>(
    item,
    "costCoverage",
    COVERAGE,
    "Company benchmark cost coverage",
  );
  if (tokenCoverage !== expectedCoverage(usageReports, requestsUsed)) {
    throw new TypeError("Company benchmark token coverage is inconsistent");
  }
  if (costCoverage !== expectedCoverage(costReports, requestsUsed)) {
    throw new TypeError("Company benchmark cost coverage is inconsistent");
  }

  const inputTokens = optionalInteger(
    item.inputTokens,
    "Company benchmark input tokens",
  );
  const outputTokens = optionalInteger(
    item.outputTokens,
    "Company benchmark output tokens",
  );
  const cachedInputTokens = optionalInteger(
    item.cachedInputTokens,
    "Company benchmark cached input tokens",
  );
  const cacheWriteInputTokens = optionalInteger(
    item.cacheWriteInputTokens,
    "Company benchmark cache-write input tokens",
  );
  const reasoningTokens = optionalInteger(
    item.reasoningTokens,
    "Company benchmark reasoning tokens",
  );
  const reportedCostUsd = optionalNumber(
    item.reportedCostUsd,
    "Company benchmark reported cost",
  );
  const noTokens = inputTokens === null && outputTokens === null;
  if ((tokenCoverage === "none") !== noTokens ||
    tokenCoverage !== "none" && (inputTokens === null || outputTokens === null) ||
    tokenCoverage === "none" &&
      (cachedInputTokens !== null ||
        cacheWriteInputTokens !== null ||
        reasoningTokens !== null)) {
    throw new TypeError("Company benchmark token values are inconsistent");
  }
  if ((costCoverage === "none") !== (reportedCostUsd === null)) {
    throw new TypeError("Company benchmark cost coverage is inconsistent");
  }
  return {
    requestsUsed,
    usageReports,
    costReports,
    tokenCoverage,
    costCoverage,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
    reportedCostUsd,
  };
}

function parseRoleObservation(
  value: unknown,
  trialWallClockMs: number,
): CompanyBenchmarkRoleObservationV1 {
  const item = exact(value, "Company benchmark role observation", [
    "role", "attempts", "completedAttempts", "failedAttempts",
    "cancelledAttempts", "wallClockMs", "attemptLatenciesMs", "usage",
    "evidenceItems", "changedFiles",
  ]);
  const attempts = integerField(
    item,
    "attempts",
    "Company benchmark role attempts",
    1,
    1_000,
  );
  const completedAttempts = integerField(
    item,
    "completedAttempts",
    "Company benchmark completed attempts",
    0,
    attempts,
  );
  const failedAttempts = integerField(
    item,
    "failedAttempts",
    "Company benchmark failed attempts",
    0,
    attempts,
  );
  const cancelledAttempts = integerField(
    item,
    "cancelledAttempts",
    "Company benchmark cancelled attempts",
    0,
    attempts,
  );
  if (completedAttempts + failedAttempts + cancelledAttempts !== attempts) {
    throw new TypeError(
      "Company benchmark role attempt counts are inconsistent",
    );
  }
  const wallClockMs = integerField(
    item,
    "wallClockMs",
    "Company benchmark role wall-clock time",
    0,
    trialWallClockMs,
  );
  const attemptLatenciesMs = list(
    item.attemptLatenciesMs,
    "Company benchmark attempt latencies",
    attempts,
    attempts,
    (latency) => contractInteger(
      latency,
      "Company benchmark attempt latency",
      0,
      trialWallClockMs,
    ),
  );
  if (Math.max(...attemptLatenciesMs) > wallClockMs) {
    throw new TypeError(
      "Company benchmark role wall-clock time is inconsistent",
    );
  }
  return {
    role: enumField(item, "role", ROLES, "Company benchmark observed role"),
    attempts,
    completedAttempts,
    failedAttempts,
    cancelledAttempts,
    wallClockMs,
    attemptLatenciesMs,
    usage: parseUsage(item.usage),
    evidenceItems: integerField(
      item,
      "evidenceItems",
      "Company benchmark role evidence count",
      0,
      MAX_COUNT,
    ),
    changedFiles: pathList(
      item.changedFiles,
      "Company benchmark role changed path",
    ),
  };
}

function parseVerification(
  value: unknown,
): CompanyBenchmarkVerificationV1 {
  const item = exact(value, "Company benchmark verification", [
    "status", "workspaceIntegrity", "checks",
  ]);
  const status = enumField<CompanyBenchmarkVerificationStatus>(
    item,
    "status",
    VERIFICATION_STATUSES,
    "Company benchmark verification status",
  );
  const workspaceIntegrity = enumField<CompanyBenchmarkVerificationStatus>(
    item,
    "workspaceIntegrity",
    VERIFICATION_STATUSES,
    "Company benchmark workspace integrity",
  );
  const checks = list(
    item.checks,
    "Company benchmark verification checks",
    0,
    64,
    (value) => {
      const check = exact(value, "Company benchmark verification check", [
        "id",
        "status",
      ]);
      return {
        id: idField(
          check,
          "id",
          "Company benchmark verification check id",
        ),
        status: enumField<"passed" | "failed">(
          check,
          "status",
          new Set(["passed", "failed"]),
          "Company benchmark verification check status",
        ),
      };
    },
  );
  assertUnique(
    checks,
    (check) => check.id,
    "Company benchmark verification check ids",
  );
  if (
    status === "passed" &&
      (workspaceIntegrity !== "passed" ||
        checks.length === 0 ||
        checks.some((check) => check.status !== "passed")) ||
    status === "failed" &&
      workspaceIntegrity !== "failed" &&
      !checks.some((check) => check.status === "failed") ||
    status === "not_run" &&
      (workspaceIntegrity !== "not_run" || checks.length !== 0)
  ) {
    throw new TypeError(
      "Company benchmark verification result is inconsistent",
    );
  }
  return { status, workspaceIntegrity, checks };
}

function parseReview(value: unknown): CompanyBenchmarkReviewObservationV1 {
  const item = exact(value, "Company benchmark review observation", [
    "attempts", "approved", "changesRequested", "unverified", "findings",
    "finalVerdict", "affectedPaths", "evidenceItems",
  ]);
  const attempts = integerField(
    item,
    "attempts",
    "Company benchmark review attempts",
    0,
    1_000,
  );
  const approved = integerField(
    item,
    "approved",
    "Company benchmark approved reviews",
    0,
    attempts,
  );
  const changesRequested = integerField(
    item,
    "changesRequested",
    "Company benchmark change-request reviews",
    0,
    attempts,
  );
  const unverified = integerField(
    item,
    "unverified",
    "Company benchmark unverified reviews",
    0,
    attempts,
  );
  if (approved + changesRequested + unverified !== attempts) {
    throw new TypeError("Company benchmark review counts are inconsistent");
  }
  const finalVerdict = item.finalVerdict === null
    ? null
    : contractEnum<
      Exclude<CompanyBenchmarkReviewObservationV1["finalVerdict"], null>
    >(
      item.finalVerdict,
      new Set(["approved", "changes_requested", "unverified"]),
      "Company benchmark final review verdict",
    );
  if ((attempts === 0) !== (finalVerdict === null) ||
    finalVerdict === "approved" && approved === 0 ||
    finalVerdict === "changes_requested" && changesRequested === 0 ||
    finalVerdict === "unverified" && unverified === 0) {
    throw new TypeError(
      "Company benchmark final review verdict is inconsistent",
    );
  }
  return {
    attempts,
    approved,
    changesRequested,
    unverified,
    finalVerdict,
    findings: integerField(
      item,
      "findings",
      "Company benchmark review findings",
      0,
      MAX_COUNT,
    ),
    affectedPaths: pathList(
      item.affectedPaths,
      "Company benchmark review affected path",
    ),
    evidenceItems: integerField(
      item,
      "evidenceItems",
      "Company benchmark review evidence count",
      0,
      MAX_COUNT,
    ),
  };
}

function parseCountRecord<K extends string>(
  value: unknown,
  label: string,
  keys: readonly K[],
): Record<K, number> {
  const item = exact(value, label, keys);
  return Object.fromEntries(keys.map((key) => [
    key,
    contractInteger(item[key], `${label} ${key}`, 0, MAX_COUNT),
  ])) as Record<K, number>;
}

function parseInterventions(
  value: unknown,
): CompanyBenchmarkInterventionsV1 {
  return parseCountRecord(value, "Company benchmark interventions", [
    "externalConfirmationRequests",
    "userInputRequests",
    "automaticApprovals",
    "automaticDenials",
  ]);
}

function parseEvidence(
  value: unknown,
): CompanyBenchmarkEvidenceCountsV1 {
  return parseCountRecord(value, "Company benchmark evidence counts", [
    "roleItems",
    "finalItems",
  ]);
}

function parseOverlap(value: unknown): CompanyBenchmarkOverlapV1 {
  const item = exact(value, "Company benchmark overlap", [
    "metric", "implementOverlappingPaths", "implementDuplicateClaims",
    "repairTouchedImplementationPaths",
  ]);
  if (item.metric !== "changed_file_overlap_v1") {
    throw new TypeError("Company benchmark overlap metric is invalid");
  }
  const implementOverlappingPaths = pathList(
    item.implementOverlappingPaths,
    "Company benchmark Implement overlap path",
  );
  const implementDuplicateClaims = integerField(
    item,
    "implementDuplicateClaims",
    "Company benchmark Implement duplicate claims",
    0,
    MAX_COUNT,
  );
  if ((implementOverlappingPaths.length === 0) !==
      (implementDuplicateClaims === 0) ||
    implementDuplicateClaims < implementOverlappingPaths.length) {
    throw new TypeError("Company benchmark Implement overlap is inconsistent");
  }
  return {
    metric: "changed_file_overlap_v1",
    implementOverlappingPaths,
    implementDuplicateClaims,
    repairTouchedImplementationPaths: pathList(
      item.repairTouchedImplementationPaths,
      "Company benchmark Repair overlap path",
    ),
  };
}

function parseFailure(value: unknown): CompanyBenchmarkFailureV1 {
  const item = exact(value, "Company benchmark failure", ["stage", "code"]);
  return {
    stage: enumField(
      item,
      "stage",
      FAILURE_STAGES,
      "Company benchmark failure stage",
    ),
    code: idField(item, "code", "Company benchmark failure code"),
  };
}

type NullableUsageKey =
  | "inputTokens"
  | "outputTokens"
  | "cachedInputTokens"
  | "cacheWriteInputTokens"
  | "reasoningTokens"
  | "reportedCostUsd";

function sumKnownUsage(
  observations: readonly CompanyBenchmarkRoleObservationV1[],
  key: NullableUsageKey,
): number | null {
  const observed = observations.filter((observation) =>
    key === "reportedCostUsd"
      ? observation.usage.costReports > 0
      : observation.usage.usageReports > 0
  );
  if (observed.length === 0) return null;
  const values = observed.map((observation) => observation.usage[key]);
  if (!["inputTokens", "outputTokens", "reportedCostUsd"].includes(key) &&
    values.some((value) => value === null)) {
    return null;
  }
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function validateAggregateUsage(
  aggregate: CompanyBenchmarkUsageV1,
  observations: readonly CompanyBenchmarkRoleObservationV1[],
): void {
  for (const key of [
    "requestsUsed",
    "usageReports",
    "costReports",
  ] as const) {
    const expected = observations.reduce(
      (sum, observation) => sum + observation.usage[key],
      0,
    );
    if (aggregate[key] !== expected) {
      throw new TypeError("Company benchmark aggregate usage is inconsistent");
    }
  }
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningTokens",
    "reportedCostUsd",
  ] as const) {
    if (aggregate[key] !== sumKnownUsage(observations, key)) {
      throw new TypeError("Company benchmark aggregate usage is inconsistent");
    }
  }
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function parseCompanyBenchmarkTrial(
  value: unknown,
): CompanyBenchmarkTrialV1 {
  const item = exact(value, "Company benchmark trial", [
    "id", "version", "campaignId", "slotId", "armId", "armKind",
    "repetition", "scenario", "harnessRevision", "launchProtocolRevision",
    "blueprint", "configuredRoutes", "activatedRoutes", "executionStatus",
    "startedAt", "completedAt", "wallClockMs", "roles", "usage",
    "verification", "review", "repairRounds", "interventions", "evidence",
    "changedFiles", "overlap", "failures",
  ]);
  if (item.version !== 1) {
    throw new TypeError("Company benchmark trial version is unsupported");
  }
  const armKind = enumField<CompanyBenchmarkArmKind>(
    item,
    "armKind",
    ARM_KINDS,
    "Company benchmark trial arm kind",
  );
  const configuredRoutes = parseConfiguredRoutes(
    item.configuredRoutes,
    armKind,
  );
  const activatedRoutes = parseActivatedRoutes(
    item.activatedRoutes,
    configuredRoutes,
  );
  const executionStatus = enumField<CompanyBenchmarkExecutionStatus>(
    item,
    "executionStatus",
    EXECUTION_STATUSES,
    "Company benchmark execution status",
  );
  const startedAt = contractTimestamp(
    item.startedAt,
    "Company benchmark trial start",
  );
  const completedAt = contractTimestamp(
    item.completedAt,
    "Company benchmark trial completion",
  );
  const wallClockMs = integerField(
    item,
    "wallClockMs",
    "Company benchmark trial wall-clock time",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (Date.parse(completedAt) - Date.parse(startedAt) !== wallClockMs) {
    throw new TypeError(
      "Company benchmark trial wall-clock time is inconsistent",
    );
  }

  const observations = list(
    item.roles,
    "Company benchmark role observations",
    0,
    ROLE_ORDER.length,
    (role) => parseRoleObservation(role, wallClockMs),
  );
  if (observations.length !== activatedRoutes.length ||
    observations.some((observation, index) =>
      observation.role !== activatedRoutes[index]?.role
    )) {
    throw new TypeError(
      "Company benchmark role observations must match activated routes",
    );
  }
  const aggregateUsage = parseUsage(item.usage);
  validateAggregateUsage(aggregateUsage, observations);

  const review = parseReview(item.review);
  const reviewAttempts = observations.find((role) =>
    role.role === "review"
  )?.attempts ?? 0;
  if (review.attempts > reviewAttempts ||
    review.attempts > 0 && reviewAttempts === 0 ||
    reviewAttempts === 0 &&
      (review.findings > 0 ||
        review.affectedPaths.length > 0 ||
        review.evidenceItems > 0)) {
    throw new TypeError(
      "Company benchmark review observations require Review activation",
    );
  }
  if (executionStatus === "completed") {
    const requiredRoles: readonly CompanyBenchmarkRole[] =
      armKind === "single_agent"
        ? ["parent"]
        : ["parent", "implement", "review"];
    const requiredSucceeded = requiredRoles.every((role) => {
      const observed = observations.find((candidate) =>
        candidate.role === role
      );
      return observed !== undefined &&
        observed.completedAttempts === observed.attempts &&
        observed.failedAttempts === 0 &&
        observed.cancelledAttempts === 0;
    });
    const reviewApproved = armKind === "single_agent" ||
      review.attempts > 0 &&
        review.finalVerdict === "approved";
    if (!requiredSucceeded || !reviewApproved) {
      throw new TypeError(
        "Completed company benchmark trials require successful mandatory roles and review",
      );
    }
  }
  const repairRounds = integerField(
    item,
    "repairRounds",
    "Company benchmark Repair rounds",
    0,
    100,
  );
  const repairAttempts = observations.find((role) =>
    role.role === "repair"
  )?.attempts ?? 0;
  if (repairRounds !== repairAttempts) {
    throw new TypeError(
      "Company benchmark Repair rounds must match Repair activation",
    );
  }

  const evidence = parseEvidence(item.evidence);
  if (evidence.roleItems !== observations.reduce(
    (sum, observation) => sum + observation.evidenceItems,
    0,
  )) {
    throw new TypeError(
      "Company benchmark aggregate evidence count is inconsistent",
    );
  }
  const changedFiles = pathList(
    item.changedFiles,
    "Company benchmark changed path",
  );
  const observedChangedFiles = [...new Set(
    observations.flatMap((observation) => observation.changedFiles),
  )].sort();
  if (!sameStringSet(changedFiles, observedChangedFiles)) {
    throw new TypeError(
      "Company benchmark aggregate changed paths are inconsistent",
    );
  }

  const overlap = parseOverlap(item.overlap);
  const implement = observations.find((role) => role.role === "implement");
  const repair = observations.find((role) => role.role === "repair");
  if (overlap.implementDuplicateClaims > 0 &&
      (implement?.attempts ?? 0) < 2 ||
    overlap.implementOverlappingPaths.some((path) =>
      !implement?.changedFiles.includes(path)
    ) ||
    overlap.repairTouchedImplementationPaths.some((path) =>
      !repair?.changedFiles.includes(path)
    )) {
    throw new TypeError("Company benchmark overlap paths are inconsistent");
  }

  const failures = list(
    item.failures,
    "Company benchmark failures",
    0,
    16,
    parseFailure,
  );
  assertUnique(
    failures,
    (failure) => `${failure.stage}:${failure.code}`,
    "Company benchmark failures",
  );
  const blueprint = item.blueprint === null
    ? null
    : parseBlueprint(item.blueprint);
  if ((armKind === "single_agent") !== (blueprint === null)) {
    throw new TypeError(
      "Company benchmark trial blueprint does not match its arm kind",
    );
  }
  const parsedArmId = armId(item.armId);
  const repetition = integerField(
    item,
    "repetition",
    "Company benchmark repetition",
    1,
    MAX_REPETITIONS,
  );
  const slotId = idField(item, "slotId", "Company benchmark trial slot id");
  if (slotId !== companyBenchmarkTrialSlotId(parsedArmId, repetition)) {
    throw new TypeError("Company benchmark trial slot id is inconsistent");
  }

  return contractDeepFreeze({
    id: idField(item, "id", "Company benchmark trial id"),
    version: 1,
    campaignId: idField(item, "campaignId", "Company benchmark campaign id"),
    slotId,
    armId: parsedArmId,
    armKind,
    repetition,
    scenario: parseScenario(item.scenario),
    harnessRevision: idField(
      item,
      "harnessRevision",
      "Company benchmark harness revision",
    ),
    launchProtocolRevision: idField(
      item,
      "launchProtocolRevision",
      "Company benchmark launch-protocol revision",
    ),
    blueprint,
    configuredRoutes,
    activatedRoutes,
    executionStatus,
    startedAt,
    completedAt,
    wallClockMs,
    roles: observations,
    usage: aggregateUsage,
    verification: parseVerification(item.verification),
    review,
    repairRounds,
    interventions: parseInterventions(item.interventions),
    evidence,
    changedFiles,
    overlap,
    failures,
  }) as CompanyBenchmarkTrialV1;
}

export function validateCompanyBenchmarkTrialAgainstCampaign(
  trial: CompanyBenchmarkTrialV1,
  campaign: CompanyBenchmarkCampaignV1,
): void {
  const arm = trial.armId === campaign.baseline.id
    ? campaign.baseline
    : campaign.companyArms.find((candidate) => candidate.id === trial.armId);
  const slot = campaign.armOrder.find((candidate) =>
    candidate.slotId === trial.slotId
  );
  const blueprint = arm?.kind === "company" ? campaign.blueprint : null;
  if (
    trial.campaignId !== campaign.id ||
    arm === undefined ||
    trial.armKind !== arm.kind ||
    slot === undefined ||
    slot.armId !== trial.armId ||
    slot.repetition !== trial.repetition ||
    !sameScenario(trial.scenario, campaign.scenario) ||
    trial.harnessRevision !== campaign.harnessRevision ||
    trial.launchProtocolRevision !== campaign.launchProtocolRevision ||
    !sameBlueprint(trial.blueprint, blueprint) ||
    !sameRoutes(trial.configuredRoutes, arm.configuredRoutes)
  ) {
    throw new TypeError(
      "Company benchmark trial does not match its campaign authority",
    );
  }
  if (trial.usage.requestsUsed > campaign.ceilings.maxRequests ||
    (trial.usage.reportedCostUsd ?? 0) >
      campaign.ceilings.maxReportedCostUsd) {
    throw new TypeError("Company benchmark trial exceeds campaign ceilings");
  }
  if (Date.parse(trial.startedAt) < Date.parse(campaign.createdAt)) {
    throw new TypeError(
      "Company benchmark trial predates its campaign authority",
    );
  }
}

function parseComparablePair(
  value: unknown,
): CompanyBenchmarkComparablePairV1 {
  const item = exact(value, "Company benchmark comparable pair", [
    "companyArmId", "repetition", "baselineTrialId", "companyTrialId",
  ]);
  return {
    companyArmId: armId(
      item.companyArmId,
      "Company benchmark company arm id",
    ),
    repetition: integerField(
      item,
      "repetition",
      "Company benchmark repetition",
      1,
      MAX_REPETITIONS,
    ),
    baselineTrialId: idField(
      item,
      "baselineTrialId",
      "Company benchmark baseline trial id",
    ),
    companyTrialId: idField(
      item,
      "companyTrialId",
      "Company benchmark company trial id",
    ),
  };
}

export function parseCompanyBenchmarkCampaignSummary(
  value: unknown,
): CompanyBenchmarkCampaignSummaryV1 {
  const item = exact(value, "Company benchmark campaign summary", [
    "id", "version", "campaignId", "createdAt", "correctnessEligibility",
    "efficiencyEligibility", "tokenCoverage", "costCoverage",
    "completedTrialIds", "comparablePairs", "efficiencyComparablePairs",
    "rationale",
  ]);
  if (item.version !== 1) {
    throw new TypeError(
      "Company benchmark campaign summary version is unsupported",
    );
  }
  const completedTrialIds = contractIds(
    item.completedTrialIds,
    "Company benchmark completed trial ids",
    MAX_TRIAL_SLOTS,
  );
  const comparablePairs = list(
    item.comparablePairs,
    "Company benchmark comparable pairs",
    0,
    MAX_COMPANY_ARMS * MAX_REPETITIONS,
    parseComparablePair,
  );
  assertUnique(
    comparablePairs,
    (pair) => `${pair.companyArmId}:${pair.repetition}`,
    "Company benchmark comparable pairs",
  );
  const efficiencyComparablePairs = list(
    item.efficiencyComparablePairs,
    "Company benchmark efficiency comparable pairs",
    0,
    MAX_COMPANY_ARMS * MAX_REPETITIONS,
    parseComparablePair,
  );
  assertUnique(
    efficiencyComparablePairs,
    (pair) => `${pair.companyArmId}:${pair.repetition}`,
    "Company benchmark efficiency comparable pairs",
  );
  const rationale = list(
    item.rationale,
    "Company benchmark rationale",
    1,
    RATIONALES.size,
    (reason) => contractEnum<CompanyBenchmarkRationale>(
      reason,
      RATIONALES,
      "Company benchmark summary rationale",
    ),
  );
  assertUnique(rationale, (reason) => reason, "Company benchmark rationale");
  return contractDeepFreeze({
    id: idField(item, "id", "Company benchmark summary id"),
    version: 1,
    campaignId: idField(item, "campaignId", "Company benchmark campaign id"),
    createdAt: contractTimestamp(
      item.createdAt,
      "Company benchmark summary timestamp",
    ),
    correctnessEligibility: enumField(
      item,
      "correctnessEligibility",
      ELIGIBILITY,
      "Company benchmark correctness eligibility",
    ),
    efficiencyEligibility: enumField(
      item,
      "efficiencyEligibility",
      ELIGIBILITY,
      "Company benchmark efficiency eligibility",
    ),
    tokenCoverage: enumField(
      item,
      "tokenCoverage",
      COVERAGE,
      "Company benchmark summary token coverage",
    ),
    costCoverage: enumField(
      item,
      "costCoverage",
      COVERAGE,
      "Company benchmark summary cost coverage",
    ),
    completedTrialIds,
    comparablePairs,
    efficiencyComparablePairs,
    rationale,
  }) as CompanyBenchmarkCampaignSummaryV1;
}

export function companyBenchmarkTrialComparability(
  trial: CompanyBenchmarkTrialV1,
): {
  readonly correctness: boolean;
  readonly efficiency: boolean;
} {
  const required: readonly CompanyBenchmarkRole[] =
    trial.armKind === "single_agent"
      ? ["parent"]
      : ["parent", "implement", "review"];
  const successfulRoles = required.every((role) => {
    const observation = trial.roles.find((candidate) =>
      candidate.role === role
    );
    return observation !== undefined &&
      observation.completedAttempts === observation.attempts &&
      observation.failedAttempts === 0 &&
      observation.cancelledAttempts === 0;
  });
  const acceptedReview = trial.armKind === "single_agent" ||
    trial.review.attempts > 0 &&
      trial.review.finalVerdict === "approved";
  const correctness = successfulRoles &&
    acceptedReview &&
    trial.executionStatus === "completed" &&
    trial.verification.status === "passed" &&
    trial.verification.workspaceIntegrity === "passed" &&
    trial.failures.length === 0;
  return {
    correctness,
    efficiency: correctness &&
      trial.usage.tokenCoverage === "complete" &&
      trial.usage.costCoverage === "complete",
  };
}

export function deriveCompanyBenchmarkComparablePairs(
  campaign: CompanyBenchmarkCampaignV1,
  trials: readonly CompanyBenchmarkTrialV1[],
  dimension: "correctness" | "efficiency" = "correctness",
): CompanyBenchmarkComparablePairV1[] {
  const baselineByRepetition = new Map(
    trials
      .filter((trial) =>
        trial.armId === campaign.baseline.id &&
        companyBenchmarkTrialComparability(trial)[dimension]
      )
      .map((trial) => [trial.repetition, trial] as const),
  );
  return campaign.companyArms.flatMap((arm) =>
    trials
      .filter((trial) =>
        trial.armId === arm.id &&
        companyBenchmarkTrialComparability(trial)[dimension] &&
        baselineByRepetition.has(trial.repetition)
      )
      .sort((left, right) => left.repetition - right.repetition)
      .map((companyTrial) => ({
        companyArmId: arm.id,
        repetition: companyTrial.repetition,
        baselineTrialId: baselineByRepetition.get(companyTrial.repetition)!.id,
        companyTrialId: companyTrial.id,
      }))
  );
}

function aggregateCoverage(
  trials: readonly CompanyBenchmarkTrialV1[],
  key: "tokenCoverage" | "costCoverage",
): CompanyBenchmarkCoverage {
  if (trials.length === 0 ||
    trials.every((trial) => trial.usage[key] === "none")) return "none";
  return trials.every((trial) => trial.usage[key] === "complete")
    ? "complete"
    : "partial";
}

function hasMinimumPairs(
  campaign: CompanyBenchmarkCampaignV1,
  pairs: readonly CompanyBenchmarkComparablePairV1[],
): boolean {
  return campaign.companyArms.every((arm) =>
    pairs.filter((pair) => pair.companyArmId === arm.id).length >=
      COMPANY_BENCHMARK_MINIMUM_COMPARABLE_PAIRS
  );
}

export function deriveCompanyBenchmarkSummaryEvidence(
  campaign: CompanyBenchmarkCampaignV1,
  trials: readonly CompanyBenchmarkTrialV1[],
): CompanyBenchmarkSummaryEvidenceV1 {
  const comparablePairs = deriveCompanyBenchmarkComparablePairs(
    campaign,
    trials,
    "correctness",
  );
  const efficiencyComparablePairs = deriveCompanyBenchmarkComparablePairs(
    campaign,
    trials,
    "efficiency",
  );
  const correctnessComparable = hasMinimumPairs(campaign, comparablePairs);
  const efficiencyComparable = hasMinimumPairs(
    campaign,
    efficiencyComparablePairs,
  );
  const rationale: CompanyBenchmarkRationale[] = [
    correctnessComparable
      ? "minimum_comparable_pairs_met"
      : "minimum_comparable_pairs_not_met",
  ];
  if (trials.length < campaign.armOrder.length) {
    rationale.push("campaign_incomplete");
  }
  if (trials.some((trial) =>
    trial.verification.status === "not_run" ||
    trial.verification.workspaceIntegrity === "not_run"
  )) {
    rationale.push("verification_not_run");
  }
  if (trials.some((trial) =>
    trial.executionStatus !== "completed" ||
    trial.verification.status === "failed" ||
    trial.verification.workspaceIntegrity === "failed" ||
    trial.failures.length > 0
  )) {
    rationale.push("verification_or_safety_failed");
  }
  if (trials.some((trial) =>
    trial.usage.tokenCoverage !== "complete" ||
    trial.usage.costCoverage !== "complete"
  )) {
    rationale.push("usage_incomplete");
  }
  return contractDeepFreeze({
    correctnessEligibility: correctnessComparable
      ? "comparable"
      : "insufficient_evidence",
    efficiencyEligibility: efficiencyComparable
      ? "comparable"
      : "insufficient_evidence",
    tokenCoverage: aggregateCoverage(trials, "tokenCoverage"),
    costCoverage: aggregateCoverage(trials, "costCoverage"),
    comparablePairs,
    efficiencyComparablePairs,
    rationale,
  }) as CompanyBenchmarkSummaryEvidenceV1;
}

function samePair(
  left: CompanyBenchmarkComparablePairV1,
  right: CompanyBenchmarkComparablePairV1,
): boolean {
  return left.companyArmId === right.companyArmId &&
    left.repetition === right.repetition &&
    left.baselineTrialId === right.baselineTrialId &&
    left.companyTrialId === right.companyTrialId;
}

export function validateCompanyBenchmarkCampaignSummary(
  summary: CompanyBenchmarkCampaignSummaryV1,
  campaign: CompanyBenchmarkCampaignV1,
  trials: readonly CompanyBenchmarkTrialV1[],
): void {
  if (summary.campaignId !== campaign.id) {
    throw new TypeError(
      "Company benchmark summary does not match its campaign",
    );
  }
  if (Date.parse(summary.createdAt) < Date.parse(campaign.createdAt) ||
    trials.some((trial) =>
      Date.parse(summary.createdAt) < Date.parse(trial.completedAt)
    )) {
    throw new TypeError(
      "Company benchmark summary predates its campaign evidence",
    );
  }

  const byId = new Map<string, CompanyBenchmarkTrialV1>();
  const slots = new Set<string>();
  for (const trial of trials) {
    validateCompanyBenchmarkTrialAgainstCampaign(trial, campaign);
    if (byId.has(trial.id) || slots.has(trial.slotId)) {
      throw new TypeError("Company benchmark summary trials are duplicated");
    }
    byId.set(trial.id, trial);
    slots.add(trial.slotId);
  }
  const suppliedIds = [...byId.keys()].sort();
  const completedIds = [...summary.completedTrialIds].sort();
  if (!sameStringSet(suppliedIds, completedIds)) {
    throw new TypeError(
      "Company benchmark completed trial ids are inconsistent",
    );
  }
  if (trials.length > campaign.ceilings.maxTrialSlots) {
    throw new TypeError("Company benchmark campaign trial ceiling is exceeded");
  }
  const requests = trials.reduce(
    (sum, trial) => sum + trial.usage.requestsUsed,
    0,
  );
  const knownCost = trials.reduce(
    (sum, trial) => sum + (trial.usage.reportedCostUsd ?? 0),
    0,
  );
  if (requests > campaign.ceilings.maxRequests ||
    knownCost > campaign.ceilings.maxReportedCostUsd) {
    throw new TypeError("Company benchmark campaign usage exceeds its ceilings");
  }

  const expected = deriveCompanyBenchmarkSummaryEvidence(campaign, trials);
  if (
    summary.correctnessEligibility !== expected.correctnessEligibility ||
    summary.efficiencyEligibility !== expected.efficiencyEligibility ||
    summary.tokenCoverage !== expected.tokenCoverage ||
    summary.costCoverage !== expected.costCoverage ||
    summary.comparablePairs.length !== expected.comparablePairs.length ||
    summary.comparablePairs.some((pair, index) =>
      !samePair(pair, expected.comparablePairs[index]!)
    ) ||
    summary.efficiencyComparablePairs.length !==
      expected.efficiencyComparablePairs.length ||
    summary.efficiencyComparablePairs.some((pair, index) =>
      !samePair(pair, expected.efficiencyComparablePairs[index]!)
    ) ||
    summary.rationale.length !== expected.rationale.length ||
    summary.rationale.some((reason, index) =>
      reason !== expected.rationale[index]
    )
  ) {
    throw new TypeError(
      "Company benchmark summary derivation is inconsistent",
    );
  }
}
