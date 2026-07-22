import {
  getOperatingModePolicy,
  type AgentPermissionMode,
  type OperatingModeId,
  type OperatingModeVersion,
} from "./agents.js";
import {
  COMPANY_DESIGN_MODES,
  COMPANY_ONBOARDING_DEPTHS,
  parseCompanyBlueprintV2,
  type CompanyBlueprintV2,
  type CompanyDesignMode,
  type CompanyOnboardingDepth,
} from "./company-v2.js";
import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractInteger,
  contractNumber,
  contractOptionalText,
  contractRecord,
  contractText,
  contractTextArray,
  contractTimestamp,
} from "./company-contract-utils.js";

export interface CompanyOnboardingDepthPolicy {
  readonly depth: CompanyOnboardingDepth;
  readonly maxInterviewRounds: number;
  readonly maxResearchChildren: number;
  readonly maxConcurrentResearch: number;
  readonly maxModelRequests: number;
}

const depthPolicies: Readonly<Record<
  CompanyOnboardingDepth,
  CompanyOnboardingDepthPolicy
>> = Object.freeze({
  quick: Object.freeze({
    depth: "quick",
    maxInterviewRounds: 4,
    maxResearchChildren: 0,
    maxConcurrentResearch: 0,
    maxModelRequests: 8,
  }),
  guided: Object.freeze({
    depth: "guided",
    maxInterviewRounds: 10,
    maxResearchChildren: 3,
    maxConcurrentResearch: 2,
    maxModelRequests: 24,
  }),
  deep: Object.freeze({
    depth: "deep",
    maxInterviewRounds: 20,
    maxResearchChildren: 8,
    maxConcurrentResearch: 4,
    maxModelRequests: 64,
  }),
});

export function getCompanyOnboardingDepthPolicy(
  depth: CompanyOnboardingDepth,
  operatingModeId?: OperatingModeId,
): CompanyOnboardingDepthPolicy {
  const policy = depthPolicies[depth];
  if (operatingModeId === undefined) return policy;
  const company = getOperatingModePolicy(operatingModeId).company;
  if (company === undefined) {
    throw new TypeError("Company onboarding requires a company operating mode");
  }
  return Object.freeze({
    ...policy,
    maxResearchChildren: Math.min(
      policy.maxResearchChildren,
      company.maxResearchChildren,
    ),
    maxConcurrentResearch: Math.min(
      policy.maxConcurrentResearch,
      company.maxConcurrentAssignments,
    ),
    maxModelRequests: Math.min(policy.maxModelRequests, company.maxGoalRequests),
  });
}

export type CompanyOnboardingStatus =
  | "interviewing"
  | "researching"
  | "proposed"
  | "approved"
  | "abandoned"
  | "cancelled"
  | "failed";

export interface CompanyInterviewAnswerV1 {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly at: string;
}

export interface CompanyInterviewQuestionV1 {
  readonly id: string;
  readonly question: string;
}

export interface CompanyResearchAssignmentV1 {
  readonly id: string;
  readonly description: string;
  readonly prompt: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly evidence: readonly string[];
  readonly failure: string | null;
}

export interface CompanyProposalRevisionV1 {
  readonly revision: number;
  readonly source: "initial" | "chat" | "yaml";
  readonly createdAt: string;
  readonly blueprint: CompanyBlueprintV2;
}

export interface CompanyOnboardingRunV1 {
  readonly id: string;
  readonly companyId: string;
  readonly version: 1;
  readonly projectRoot: string;
  readonly status: CompanyOnboardingStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly depth: CompanyOnboardingDepth;
  readonly designMode: CompanyDesignMode;
  readonly authority: {
    readonly permissionMode: AgentPermissionMode;
    readonly operatingModeId: OperatingModeId;
    readonly operatingModeVersion: OperatingModeVersion;
  };
  readonly backend: {
    readonly fingerprint: string;
  };
  readonly repositoryAccess: {
    readonly scope: "none" | "project_read";
    readonly grantedAt: string | null;
  };
  readonly interview: {
    readonly complete: boolean;
    readonly pendingQuestion: CompanyInterviewQuestionV1 | null;
    readonly answers: readonly CompanyInterviewAnswerV1[];
  };
  readonly research: readonly CompanyResearchAssignmentV1[];
  readonly usage: {
    readonly modelRequests: number;
    readonly reportedCostUsd: number;
  };
  readonly proposal: CompanyProposalRevisionV1 | null;
  readonly approvedBlueprintId: string | null;
  readonly terminalReason: string | null;
}

const statuses = new Set<string>([
  "interviewing", "researching", "proposed", "approved", "abandoned",
  "cancelled", "failed",
]);
const permissionModes = new Set<string>([
  "ask_always", "approved_for_me", "full_access",
]);
const backendFingerprintPattern = /^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,127}|sha256:[0-9a-f]{64})$/u;

function parseAuthority(value: unknown) {
  const authority = contractRecord(value, "Onboarding authority");
  contractExact(authority, [
    "permissionMode", "operatingModeId", "operatingModeVersion",
  ], "Onboarding authority");
  if (typeof authority.operatingModeId !== "string") {
    throw new TypeError("Onboarding operating mode is invalid");
  }
  let mode;
  try {
    mode = getOperatingModePolicy(authority.operatingModeId as OperatingModeId);
  } catch {
    throw new TypeError("Onboarding operating mode is invalid");
  }
  if (mode.version !== 6 || mode.company === undefined ||
    authority.operatingModeVersion !== mode.version) {
    throw new TypeError("Onboarding requires an exact V6 company mode");
  }
  return {
    permissionMode: contractEnum<AgentPermissionMode>(
      authority.permissionMode,
      permissionModes,
      "Onboarding permission mode",
    ),
    operatingModeId: mode.id,
    operatingModeVersion: mode.version,
  };
}

function parseAnswer(value: unknown): CompanyInterviewAnswerV1 {
  const answer = contractRecord(value, "Company interview answer");
  contractExact(answer, ["id", "question", "answer", "at"],
    "Company interview answer");
  return {
    id: contractId(answer.id, "Company interview answer id"),
    question: contractText(answer.question, "Company interview question", 2_000),
    answer: contractText(answer.answer, "Company interview answer", 8_192),
    at: contractTimestamp(answer.at, "Company interview answer timestamp"),
  };
}

function parseQuestion(value: unknown): CompanyInterviewQuestionV1 {
  const question = contractRecord(value, "Company interview question");
  contractExact(question, ["id", "question"], "Company interview question");
  return {
    id: contractId(question.id, "Company interview question id"),
    question: contractText(
      question.question,
      "Company interview question",
      2_000,
    ),
  };
}

function parseResearch(value: unknown): CompanyResearchAssignmentV1 {
  const research = contractRecord(value, "Company research assignment");
  contractExact(research, [
    "id", "description", "prompt", "status", "evidence", "failure",
  ], "Company research assignment");
  const status = contractEnum<CompanyResearchAssignmentV1["status"]>(
    research.status,
    new Set(["queued", "running", "completed", "failed", "cancelled"]),
    "Company research status",
  );
  const evidence = contractTextArray(
    research.evidence,
    "Company research evidence",
    64,
    2_000,
  );
  const failure = contractOptionalText(
    research.failure,
    "Company research failure",
    2_000,
  );
  if ((status === "completed") !== (evidence.length > 0) ||
    ((status === "failed" || status === "cancelled") !== (failure !== null))) {
    throw new TypeError("Company research terminal state is inconsistent");
  }
  return {
    id: contractId(research.id, "Company research id"),
    description: contractText(
      research.description,
      "Company research description",
      512,
    ),
    prompt: contractText(research.prompt, "Company research prompt", 8_192),
    status,
    evidence,
    failure,
  };
}

function parseProposal(value: unknown): CompanyProposalRevisionV1 {
  const proposal = contractRecord(value, "Company proposal revision");
  contractExact(proposal, ["revision", "source", "createdAt", "blueprint"],
    "Company proposal revision");
  const blueprint = parseCompanyBlueprintV2(proposal.blueprint);
  if (blueprint.state !== "proposed") {
    throw new TypeError("Onboarding proposal blueprint must remain proposed");
  }
  return {
    revision: contractInteger(proposal.revision, "Company proposal revision", 1),
    source: contractEnum(
      proposal.source,
      new Set(["initial", "chat", "yaml"]),
      "Company proposal source",
    ),
    createdAt: contractTimestamp(
      proposal.createdAt,
      "Company proposal timestamp",
    ),
    blueprint,
  };
}

export function parseCompanyOnboardingRun(
  value: unknown,
): CompanyOnboardingRunV1 {
  const run = contractRecord(value, "Company onboarding run");
  contractExact(run, [
    "id", "companyId", "version", "projectRoot", "status", "createdAt",
    "updatedAt", "depth", "designMode", "authority", "backend",
    "repositoryAccess", "interview", "research", "usage", "proposal",
    "approvedBlueprintId", "terminalReason",
  ], "Company onboarding run");
  if (run.version !== 1) throw new TypeError("Onboarding run version is invalid");
  const id = contractId(run.id, "Onboarding run id");
  const companyId = contractId(run.companyId, "Onboarding company id");
  const depth = contractEnum<CompanyOnboardingDepth>(
    run.depth,
    new Set(COMPANY_ONBOARDING_DEPTHS),
    "Onboarding depth",
  );
  const designMode = contractEnum<CompanyDesignMode>(
    run.designMode,
    new Set(COMPANY_DESIGN_MODES),
    "Onboarding design mode",
  );
  const authority = parseAuthority(run.authority);
  const backend = contractRecord(run.backend, "Onboarding backend");
  contractExact(backend, ["fingerprint"], "Onboarding backend");
  const backendFingerprint = contractText(
    backend.fingerprint,
    "Onboarding backend fingerprint",
    128,
  );
  if (!backendFingerprintPattern.test(backendFingerprint)) {
    throw new TypeError("Onboarding backend fingerprint is invalid");
  }
  const policy = getCompanyOnboardingDepthPolicy(depth, authority.operatingModeId);
  const repositoryAccess = contractRecord(
    run.repositoryAccess,
    "Onboarding repository access",
  );
  contractExact(repositoryAccess, ["scope", "grantedAt"],
    "Onboarding repository access");
  const scope = contractEnum<"none" | "project_read">(
    repositoryAccess.scope,
    new Set(["none", "project_read"]),
    "Onboarding repository scope",
  );
  const grantedAt = repositoryAccess.grantedAt === null
    ? null
    : contractTimestamp(repositoryAccess.grantedAt, "Repository consent timestamp");
  if ((scope === "project_read") !== (grantedAt !== null)) {
    throw new TypeError("Repository scope and consent timestamp must agree");
  }
  const interview = contractRecord(run.interview, "Company interview");
  contractExact(interview, ["complete", "pendingQuestion", "answers"],
    "Company interview");
  if (typeof interview.complete !== "boolean" || !Array.isArray(interview.answers) ||
    interview.answers.length > policy.maxInterviewRounds) {
    throw new TypeError("Company interview exceeds its depth policy");
  }
  const answers = interview.answers.map(parseAnswer);
  const pendingQuestion = interview.pendingQuestion === null
    ? null
    : parseQuestion(interview.pendingQuestion);
  if (new Set(answers.map((answer) => answer.id)).size !== answers.length ||
    (pendingQuestion !== null && answers.some((answer) =>
      answer.id === pendingQuestion.id
    ))) {
    throw new TypeError("Company interview answer ids must be unique");
  }
  if (!Array.isArray(run.research) ||
    run.research.length > policy.maxResearchChildren) {
    throw new TypeError("Company research exceeds its depth policy");
  }
  const research = run.research.map(parseResearch);
  if (new Set(research.map((item) => item.id)).size !== research.length ||
    (scope === "none" && research.length > 0)) {
    throw new TypeError("Company research requires unique consented assignments");
  }
  const usage = contractRecord(run.usage, "Onboarding usage");
  contractExact(usage, ["modelRequests", "reportedCostUsd"], "Onboarding usage");
  const modelRequests = contractInteger(
    usage.modelRequests,
    "Onboarding model requests",
    0,
    policy.maxModelRequests,
  );
  const reportedCostUsd = contractNumber(
    usage.reportedCostUsd,
    "Onboarding reported cost",
    0,
    getOperatingModePolicy(authority.operatingModeId).company!.maxReportedCostUsd,
  );
  const proposal = run.proposal === null ? null : parseProposal(run.proposal);
  if (proposal !== null && (
    proposal.blueprint.companyId !== companyId ||
    proposal.blueprint.provenance.onboardingRunId !== id ||
    proposal.blueprint.provenance.depth !== depth ||
    proposal.blueprint.designMode !== designMode ||
    proposal.blueprint.authority.permissionMode !== authority.permissionMode ||
    proposal.blueprint.authority.operatingModeId !== authority.operatingModeId
  )) {
    throw new TypeError("Company proposal does not match its onboarding authority");
  }
  const status = contractEnum<CompanyOnboardingStatus>(
    run.status,
    statuses,
    "Onboarding status",
  );
  const approvedBlueprintId = run.approvedBlueprintId === null
    ? null
    : contractId(run.approvedBlueprintId, "Approved blueprint id");
  const terminalReason = contractOptionalText(
    run.terminalReason,
    "Onboarding terminal reason",
    2_000,
  );
  const terminal = status === "abandoned" || status === "cancelled" ||
    status === "failed";
  if (((status === "proposed" || status === "approved") && proposal === null) ||
    ((status === "interviewing" || status === "researching") &&
      proposal !== null) ||
    (status === "approved") !== (approvedBlueprintId !== null) ||
    (status === "approved" && approvedBlueprintId !== proposal?.blueprint.id) ||
    ((interview.complete || status === "researching" || status === "proposed" ||
      status === "approved") && pendingQuestion !== null) ||
    terminal !== (terminalReason !== null) ||
    (status === "researching" && !research.some((item) =>
      item.status === "queued" || item.status === "running"
    ))) {
    throw new TypeError("Company onboarding lifecycle state is inconsistent");
  }
  const parsed: CompanyOnboardingRunV1 = {
    id,
    companyId,
    version: 1,
    projectRoot: contractText(run.projectRoot, "Onboarding project root", 4_096),
    status,
    createdAt: contractTimestamp(run.createdAt, "Onboarding created timestamp"),
    updatedAt: contractTimestamp(run.updatedAt, "Onboarding updated timestamp"),
    depth,
    designMode,
    authority,
    backend: { fingerprint: backendFingerprint },
    repositoryAccess: { scope, grantedAt },
    interview: { complete: interview.complete, pendingQuestion, answers },
    research,
    usage: { modelRequests, reportedCostUsd },
    proposal,
    approvedBlueprintId,
    terminalReason,
  };
  return contractDeepFreeze(structuredClone(parsed)) as CompanyOnboardingRunV1;
}
