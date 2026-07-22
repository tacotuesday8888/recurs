import { parseCompanyBlueprintV2, type CompanyBlueprintV2 } from "./company-v2.js";
import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractInteger,
  contractOptionalText,
  contractRecord,
  contractText,
  contractTimestamp,
} from "./company-contract-utils.js";

export type CompanyKnowledgeKind =
  | "project_fact"
  | "decision"
  | "preference"
  | "successful_pattern"
  | "review_finding";

export type CompanyKnowledgeSourceType =
  | "user"
  | "repository"
  | "goal_evidence"
  | "review";

export interface CompanyKnowledgeEntryV1 {
  readonly id: string;
  readonly kind: CompanyKnowledgeKind;
  readonly statement: string;
  readonly source: {
    readonly type: CompanyKnowledgeSourceType;
    readonly id: string;
    readonly evidence: string;
  };
  readonly confidence: "low" | "medium" | "high";
  readonly createdAt: string;
  readonly supersedes: string | null;
}

export interface CompanyKnowledgeV1 {
  readonly companyId: string;
  readonly version: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly entries: readonly CompanyKnowledgeEntryV1[];
}

export interface CompanyAmendmentV1 {
  readonly id: string;
  readonly version: 1;
  readonly companyId: string;
  readonly baseBlueprintId: string;
  readonly baseBlueprintRevision: number;
  readonly state: "proposed" | "approved" | "rejected";
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly reason: string;
  readonly proposedBlueprint: CompanyBlueprintV2;
  readonly resultingBlueprintId: string | null;
  readonly decisionReason: string | null;
}

const knowledgeKinds = new Set<string>([
  "project_fact", "decision", "preference", "successful_pattern",
  "review_finding",
]);
const sourceTypes = new Set<string>([
  "user", "repository", "goal_evidence", "review",
]);

function parseEntry(value: unknown): CompanyKnowledgeEntryV1 {
  const entry = contractRecord(value, "Company knowledge entry");
  contractExact(entry, [
    "id", "kind", "statement", "source", "confidence", "createdAt",
    "supersedes",
  ], "Company knowledge entry");
  const source = contractRecord(entry.source, "Company knowledge source");
  contractExact(source, ["type", "id", "evidence"],
    "Company knowledge source");
  return {
    id: contractId(entry.id, "Company knowledge entry id"),
    kind: contractEnum<CompanyKnowledgeKind>(
      entry.kind,
      knowledgeKinds,
      "Company knowledge kind",
    ),
    statement: contractText(entry.statement, "Company knowledge statement", 4_000),
    source: {
      type: contractEnum<CompanyKnowledgeSourceType>(
        source.type,
        sourceTypes,
        "Company knowledge source type",
      ),
      id: contractId(source.id, "Company knowledge source id"),
      evidence: contractText(source.evidence, "Company knowledge evidence", 4_000),
    },
    confidence: contractEnum(
      entry.confidence,
      new Set(["low", "medium", "high"]),
      "Company knowledge confidence",
    ),
    createdAt: contractTimestamp(entry.createdAt, "Knowledge entry timestamp"),
    supersedes: entry.supersedes === null
      ? null
      : contractId(entry.supersedes, "Superseded knowledge entry id"),
  };
}

export function parseCompanyKnowledge(value: unknown): CompanyKnowledgeV1 {
  const knowledge = contractRecord(value, "Company knowledge");
  contractExact(knowledge, [
    "companyId", "version", "revision", "updatedAt", "entries",
  ], "Company knowledge");
  if (knowledge.version !== 1 || !Array.isArray(knowledge.entries) ||
    knowledge.entries.length > 2_048) {
    throw new TypeError("Company knowledge version or entries are invalid");
  }
  const entries = knowledge.entries.map(parseEntry);
  const positions = new Map(entries.map((entry, index) => [entry.id, index] as const));
  if (positions.size !== entries.length) {
    throw new TypeError("Company knowledge entry ids must be unique");
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.supersedes !== null &&
      (positions.get(entry.supersedes) === undefined ||
        positions.get(entry.supersedes)! >= index)) {
      throw new TypeError("Knowledge may supersede only an earlier entry");
    }
  }
  const parsed: CompanyKnowledgeV1 = {
    companyId: contractId(knowledge.companyId, "Company knowledge company id"),
    version: 1,
    revision: contractInteger(knowledge.revision, "Company knowledge revision", 1),
    updatedAt: contractTimestamp(knowledge.updatedAt, "Knowledge updated timestamp"),
    entries,
  };
  return contractDeepFreeze(structuredClone(parsed)) as CompanyKnowledgeV1;
}

export function parseCompanyAmendment(value: unknown): CompanyAmendmentV1 {
  const amendment = contractRecord(value, "Company amendment");
  contractExact(amendment, [
    "id", "version", "companyId", "baseBlueprintId",
    "baseBlueprintRevision", "state", "createdAt", "decidedAt", "reason",
    "proposedBlueprint", "resultingBlueprintId", "decisionReason",
  ], "Company amendment");
  if (amendment.version !== 1) {
    throw new TypeError("Company amendment version is invalid");
  }
  const baseBlueprintId = contractId(
    amendment.baseBlueprintId,
    "Amendment base blueprint id",
  );
  const baseBlueprintRevision = contractInteger(
    amendment.baseBlueprintRevision,
    "Amendment base revision",
    1,
  );
  const proposedBlueprint = parseCompanyBlueprintV2(amendment.proposedBlueprint);
  if (proposedBlueprint.state !== "proposed" ||
    proposedBlueprint.revision !== baseBlueprintRevision + 1 ||
    proposedBlueprint.previousBlueprintId !== baseBlueprintId) {
    throw new TypeError("Amendment proposal lineage is invalid");
  }
  const state = contractEnum<CompanyAmendmentV1["state"]>(
    amendment.state,
    new Set(["proposed", "approved", "rejected"]),
    "Company amendment state",
  );
  const decidedAt = amendment.decidedAt === null
    ? null
    : contractTimestamp(amendment.decidedAt, "Amendment decision timestamp");
  const resultingBlueprintId = amendment.resultingBlueprintId === null
    ? null
    : contractId(amendment.resultingBlueprintId, "Resulting blueprint id");
  const decisionReason = contractOptionalText(
    amendment.decisionReason,
    "Amendment decision reason",
    2_000,
  );
  if ((state === "proposed") !== (decidedAt === null) ||
    (state === "approved") !== (resultingBlueprintId !== null) ||
    (state === "proposed") !== (decisionReason === null)) {
    throw new TypeError("Company amendment decision state is inconsistent");
  }
  const parsed: CompanyAmendmentV1 = {
    id: contractId(amendment.id, "Company amendment id"),
    version: 1,
    companyId: contractId(amendment.companyId, "Amendment company id"),
    baseBlueprintId,
    baseBlueprintRevision,
    state,
    createdAt: contractTimestamp(amendment.createdAt, "Amendment created timestamp"),
    decidedAt,
    reason: contractText(amendment.reason, "Amendment reason", 4_000),
    proposedBlueprint,
    resultingBlueprintId,
    decisionReason,
  };
  return contractDeepFreeze(structuredClone(parsed)) as CompanyAmendmentV1;
}
