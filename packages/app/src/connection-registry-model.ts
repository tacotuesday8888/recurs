import type {
  BillingPolicy,
  BillingSelection,
  BillingSelectionMode,
  BillingSource,
} from "@recurs/contracts";
import { normalizeLoopbackOpenAIBaseUrl } from "@recurs/providers";

import {
  isForbiddenNonSecretKey,
  looksLikeSecretValue,
} from "./non-secret-policy.js";

export const REGISTRY_INVALID = "Connection registry is invalid";
export const STORAGE_UNSAFE = "Connection registry storage is unsafe";
export const REVISION_CONFLICT = "Connection registry revision changed";
export const LOCK_UNAVAILABLE =
  "Connection registry lock could not be acquired";
export const MIGRATION_CONFLICT =
  "Legacy local connection conflicts with the registry";
export const MAX_REGISTRY_BYTES = 256 * 1024;
export const MAX_LEGACY_BYTES = 64 * 1024;
export const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

const MAX_CONNECTIONS = 256;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const BROKER_CONNECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BILLING_SOURCES = new Set<BillingSource>([
  "metered_api",
  "included_subscription",
  "prepaid_credits",
  "cloud_account",
  "local_compute",
]);
const BILLING_SELECTION_MODES = new Set<BillingSelectionMode>([
  "provider_default",
  "strict_primary_only",
  "allow_declared_additional",
]);
export type ConnectionRegistryErrorCode =
  | "registry_invalid"
  | "storage_unsafe"
  | "revision_conflict"
  | "lock_timeout"
  | "migration_conflict";

export class ConnectionRegistryError extends Error {
  constructor(
    public readonly code: ConnectionRegistryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectionRegistryError";
  }
}

export interface LocalConnectionRecord {
  kind: "local_openai_compatible";
  id: string;
  providerId: "local-openai-compatible";
  adapterId: "openai-chat-completions";
  label: string;
  baseUrl: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DelegatedConnectionRecord {
  kind: "delegated_agent";
  id: string;
  providerId: string;
  adapterId: string;
  label: string;
  accountLabel: string;
  organizationLabel: string | null;
  modelId: string;
  accountSubjectFingerprint: string;
  policyRevision: string;
  billingPolicy: BillingPolicy;
  billingSelection: BillingSelection;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrokeredModelProviderConnectionRecord {
  kind: "brokered_model_provider";
  id: string;
  providerId: "openai-api" | "anthropic-api";
  adapterId: "openai-responses" | "anthropic-messages";
  activationProfileId: "openai_api_v1" | "anthropic_api_v1";
  label: string;
  modelId: string;
  credentialIdentityFingerprint: string;
  policyRevision: string;
  billingPolicy: BillingPolicy;
  billingSelection: BillingSelection;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionRecord =
  | LocalConnectionRecord
  | DelegatedConnectionRecord
  | BrokeredModelProviderConnectionRecord;

export interface ConnectionRegistryDocument {
  schemaVersion: 1;
  revision: number;
  primaryConnectionId: string | null;
  connections: ConnectionRecord[];
}

export type ConnectionRegistryMutationResult =
  | ConnectionRegistryDocument
  | Pick<ConnectionRegistryDocument, "primaryConnectionId" | "connections">
  | void;

export type ConnectionRegistryMutation = (
  draft: ConnectionRegistryDocument,
) => ConnectionRegistryMutationResult | Promise<ConnectionRegistryMutationResult>;

export type RegistryFaultPoint =
  | "before_rename"
  | "after_rename"
  | "before_remove"
  | "after_remove_retirement"
  | "after_remove_durable_rename"
  | "after_remove"
  | "after_lock_stat";

export interface FileConnectionRegistryOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  faultInjector?: (point: RegistryFaultPoint) => void | Promise<void>;
}

export function invalidRegistry(cause?: unknown): ConnectionRegistryError {
  return new ConnectionRegistryError(
    "registry_invalid",
    REGISTRY_INVALID,
    cause === undefined ? undefined : { cause },
  );
}

export function unsafeStorage(cause?: unknown): ConnectionRegistryError {
  return new ConnectionRegistryError(
    "storage_unsafe",
    STORAGE_UNSAFE,
    cause === undefined ? undefined : { cause },
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class StrictJsonParser {
  #index = 0;
  #depth = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.#space();
    const value = this.#value();
    this.#space();
    if (this.#index !== this.text.length) throw invalidRegistry();
    return value;
  }

  #value(): unknown {
    if (this.#depth >= 32) throw invalidRegistry();
    const character = this.text[this.#index];
    if (character === "{") return this.#container(() => this.#object());
    if (character === "[") return this.#container(() => this.#array());
    if (character === '"') return this.#string();
    if (character === "t") return this.#literal("true", true);
    if (character === "f") return this.#literal("false", false);
    if (character === "n") return this.#literal("null", null);
    return this.#number();
  }

  #container<T>(parse: () => T): T {
    this.#depth += 1;
    try {
      return parse();
    } finally {
      this.#depth -= 1;
    }
  }

  #object(): Record<string, unknown> {
    this.#index += 1;
    this.#space();
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.text[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    while (true) {
      if (this.text[this.#index] !== '"') throw invalidRegistry();
      const key = this.#string();
      if (keys.has(key)) throw invalidRegistry();
      keys.add(key);
      this.#space();
      if (this.text[this.#index] !== ":") throw invalidRegistry();
      this.#index += 1;
      this.#space();
      result[key] = this.#value();
      this.#space();
      const separator = this.text[this.#index];
      this.#index += 1;
      if (separator === "}") return result;
      if (separator !== ",") throw invalidRegistry();
      this.#space();
    }
  }

  #array(): unknown[] {
    this.#index += 1;
    this.#space();
    const result: unknown[] = [];
    if (this.text[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    while (true) {
      result.push(this.#value());
      this.#space();
      const separator = this.text[this.#index];
      this.#index += 1;
      if (separator === "]") return result;
      if (separator !== ",") throw invalidRegistry();
      this.#space();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.text.length) {
      const character = this.text[this.#index];
      this.#index += 1;
      if (!escaped && character === '"') {
        try {
          return JSON.parse(this.text.slice(start, this.#index)) as string;
        } catch (error) {
          throw invalidRegistry(error);
        }
      }
      escaped = !escaped && character === "\\";
    }
    throw invalidRegistry();
  }

  #literal<T>(source: string, value: T): T {
    if (this.text.slice(this.#index, this.#index + source.length) !== source) {
      throw invalidRegistry();
    }
    this.#index += source.length;
    return value;
  }

  #number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.text.slice(this.#index),
    );
    if (match === null) throw invalidRegistry();
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw invalidRegistry();
    return value;
  }

  #space(): void {
    while (
      this.text[this.#index] === " " ||
      this.text[this.#index] === "\t" ||
      this.text[this.#index] === "\r" ||
      this.text[this.#index] === "\n"
    ) {
      this.#index += 1;
    }
  }
}

export function parseStrictJson(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return new StrictJsonParser(text).parse();
  } catch (error) {
    if (error instanceof ConnectionRegistryError) throw error;
    throw invalidRegistry(error);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    throw invalidRegistry();
  }
}

function rejectSecretMaterial(value: unknown): void {
  if (typeof value === "string") {
    if (looksLikeSecretValue(value)) throw invalidRegistry();
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) rejectSecretMaterial(entry);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (isForbiddenNonSecretKey(key)) throw invalidRegistry();
    rejectSecretMaterial(entry);
  }
}

const UNSAFE_DISPLAY_CODE_POINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function boundedString(
  value: unknown,
  maximum: number,
  options: { trim?: boolean; pattern?: RegExp } = {},
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => UNSAFE_DISPLAY_CODE_POINT.test(character)) ||
    (options.trim === true && value.trim() !== value) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    throw invalidRegistry();
  }
  return value;
}

function boundedUtf8String(
  value: unknown,
  maximumBytes: number,
  options: { trim?: boolean; pattern?: RegExp } = {},
): string {
  const text = boundedString(value, maximumBytes, options);
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw invalidRegistry();
  }
  return text;
}

export function parseCanonicalTimestamp(value: unknown): string {
  const text = boundedString(value, 32);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw invalidRegistry();
  }
  return text;
}

const timestamp = parseCanonicalTimestamp;

function uniqueEnumArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  maximum: number,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidRegistry();
  }
  const result: T[] = [];
  const seen = new Set<T>();
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry as T)) {
      throw invalidRegistry();
    }
    const typed = entry as T;
    if (seen.has(typed)) throw invalidRegistry();
    seen.add(typed);
    result.push(typed);
  }
  return result;
}

function parseBillingPolicy(value: unknown): BillingPolicy {
  if (!isRecord(value)) throw invalidRegistry();
  exactKeys(value, [
    "revision",
    "disclosureRevision",
    "primarySource",
    "possibleAdditionalSources",
    "providerFallback",
    "availableSelections",
  ]);
  if (
    typeof value.primarySource !== "string" ||
    !BILLING_SOURCES.has(value.primarySource as BillingSource) ||
    (value.providerFallback !== "none" &&
      value.providerFallback !== "user_configured" &&
      value.providerFallback !== "automatic" &&
      value.providerFallback !== "unknown")
  ) {
    throw invalidRegistry();
  }
  const primarySource = value.primarySource as BillingSource;
  const possibleAdditionalSources = uniqueEnumArray(
    value.possibleAdditionalSources,
    BILLING_SOURCES,
    BILLING_SOURCES.size,
  );
  if (possibleAdditionalSources.includes(primarySource)) {
    throw invalidRegistry();
  }
  const availableSelections = uniqueEnumArray(
    value.availableSelections,
    BILLING_SELECTION_MODES,
    BILLING_SELECTION_MODES.size,
  );
  if (availableSelections.length === 0) throw invalidRegistry();
  const providerFallback = value.providerFallback;
  if (
    providerFallback === "unknown" ||
    (providerFallback === "automatic" &&
      availableSelections.includes("strict_primary_only")) ||
    (providerFallback === "none" &&
      possibleAdditionalSources.length > 0) ||
    ((providerFallback === "user_configured" ||
      providerFallback === "automatic") &&
      possibleAdditionalSources.length === 0) ||
    (possibleAdditionalSources.length > 0 &&
      !availableSelections.includes("allow_declared_additional")) ||
    (possibleAdditionalSources.length === 0 &&
      availableSelections.includes("allow_declared_additional")) ||
    (availableSelections.includes("provider_default") &&
      providerFallback !== "automatic")
  ) {
    throw invalidRegistry();
  }
  return {
    revision: boundedString(value.revision, 256, { trim: true }),
    disclosureRevision: boundedString(value.disclosureRevision, 256, {
      trim: true,
    }),
    primarySource,
    possibleAdditionalSources,
    providerFallback,
    availableSelections,
  };
}

function parseBillingSelection(
  value: unknown,
  policy: BillingPolicy,
): BillingSelection {
  if (!isRecord(value)) throw invalidRegistry();
  exactKeys(value, [
    "mode",
    "policyRevision",
    "disclosureRevision",
    "allowedSources",
    "acknowledgedAt",
  ]);
  if (
    typeof value.mode !== "string" ||
    !BILLING_SELECTION_MODES.has(value.mode as BillingSelectionMode)
  ) {
    throw invalidRegistry();
  }
  const mode = value.mode as BillingSelectionMode;
  const policyRevision = boundedString(value.policyRevision, 256, {
    trim: true,
  });
  const disclosureRevision = boundedString(value.disclosureRevision, 256, {
    trim: true,
  });
  if (
    policyRevision !== policy.revision ||
    disclosureRevision !== policy.disclosureRevision ||
    !policy.availableSelections.includes(mode)
  ) {
    throw invalidRegistry();
  }
  const allowedSources = uniqueEnumArray(
    value.allowedSources,
    BILLING_SOURCES,
    BILLING_SOURCES.size,
  );
  const declared = new Set([
    policy.primarySource,
    ...policy.possibleAdditionalSources,
  ]);
  const acceptsAllDeclared =
    allowedSources.length === declared.size &&
    [...declared].every((source) => allowedSources.includes(source));
  if (
    allowedSources.length === 0 ||
    !allowedSources.includes(policy.primarySource) ||
    allowedSources.some((source) => !declared.has(source)) ||
    (mode === "strict_primary_only" &&
      (allowedSources.length !== 1 ||
        allowedSources[0] !== policy.primarySource)) ||
    ((mode === "allow_declared_additional" || mode === "provider_default") &&
      !acceptsAllDeclared)
  ) {
    throw invalidRegistry();
  }
  return {
    mode,
    policyRevision,
    disclosureRevision,
    allowedSources: mode === "strict_primary_only"
      ? [policy.primarySource]
      : [policy.primarySource, ...policy.possibleAdditionalSources],
    acknowledgedAt: timestamp(value.acknowledgedAt),
  };
}

function parseLocal(value: Record<string, unknown>): LocalConnectionRecord {
  exactKeys(value, [
    "kind",
    "id",
    "providerId",
    "adapterId",
    "label",
    "baseUrl",
    "modelId",
    "createdAt",
    "updatedAt",
  ]);
  if (
    value.kind !== "local_openai_compatible" ||
    value.providerId !== "local-openai-compatible" ||
    value.adapterId !== "openai-chat-completions"
  ) {
    throw invalidRegistry();
  }
  const inputUrl = boundedString(value.baseUrl, 2_048);
  let baseUrl: string;
  try {
    baseUrl = normalizeLoopbackOpenAIBaseUrl(inputUrl);
  } catch (error) {
    throw invalidRegistry(error);
  }
  if (baseUrl !== inputUrl) throw invalidRegistry();
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (createdAt > updatedAt) throw invalidRegistry();
  return {
    kind: "local_openai_compatible",
    id: boundedString(value.id, 128, { trim: true, pattern: ID_PATTERN }),
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    label: boundedString(value.label, 256, { trim: true }),
    baseUrl,
    modelId: boundedString(value.modelId, 512, { trim: true }),
    createdAt,
    updatedAt,
  };
}

function parseDelegated(
  value: Record<string, unknown>,
): DelegatedConnectionRecord {
  exactKeys(value, [
    "kind",
    "id",
    "providerId",
    "adapterId",
    "label",
    "accountLabel",
    "organizationLabel",
    "modelId",
    "accountSubjectFingerprint",
    "policyRevision",
    "billingPolicy",
    "billingSelection",
    "verifiedAt",
    "createdAt",
    "updatedAt",
  ]);
  if (value.kind !== "delegated_agent") throw invalidRegistry();
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const verifiedAt = timestamp(value.verifiedAt);
  const billingPolicy = parseBillingPolicy(value.billingPolicy);
  const billingSelection = parseBillingSelection(
    value.billingSelection,
    billingPolicy,
  );
  if (
    createdAt > updatedAt ||
    verifiedAt < createdAt ||
    verifiedAt > updatedAt ||
    billingSelection.acknowledgedAt < createdAt ||
    billingSelection.acknowledgedAt > updatedAt
  ) {
    throw invalidRegistry();
  }
  const organizationLabel = value.organizationLabel === null
    ? null
    : boundedString(value.organizationLabel, 256, { trim: true });
  return {
    kind: "delegated_agent",
    id: boundedString(value.id, 128, { trim: true, pattern: ID_PATTERN }),
    providerId: boundedString(value.providerId, 128, {
      trim: true,
      pattern: ID_PATTERN,
    }),
    adapterId: boundedString(value.adapterId, 128, {
      trim: true,
      pattern: ID_PATTERN,
    }),
    label: boundedString(value.label, 256, { trim: true }),
    accountLabel: boundedString(value.accountLabel, 256, { trim: true }),
    organizationLabel,
    modelId: boundedString(value.modelId, 512, { trim: true }),
    accountSubjectFingerprint: boundedString(
      value.accountSubjectFingerprint,
      71,
      { trim: true, pattern: SHA256_FINGERPRINT_PATTERN },
    ),
    policyRevision: boundedString(value.policyRevision, 256, { trim: true }),
    billingPolicy,
    billingSelection,
    verifiedAt,
    createdAt,
    updatedAt,
  };
}

export function parseBrokeredModelProviderConnectionRecord(
  value: unknown,
): BrokeredModelProviderConnectionRecord {
  rejectSecretMaterial(value);
  if (!isRecord(value)) throw invalidRegistry();
  exactKeys(value, [
    "kind",
    "id",
    "providerId",
    "adapterId",
    "activationProfileId",
    "label",
    "modelId",
    "credentialIdentityFingerprint",
    "policyRevision",
    "billingPolicy",
    "billingSelection",
    "verifiedAt",
    "createdAt",
    "updatedAt",
  ]);
  if (value.kind !== "brokered_model_provider") {
    throw invalidRegistry();
  }
  const profile = brokeredProviderProfile(value);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const verifiedAt = timestamp(value.verifiedAt);
  const billingPolicy = parseBillingPolicy(value.billingPolicy);
  const billingSelection = parseBillingSelection(
    value.billingSelection,
    billingPolicy,
  );
  if (
    createdAt > updatedAt ||
    verifiedAt < createdAt ||
    verifiedAt > updatedAt ||
    billingSelection.acknowledgedAt < createdAt ||
    billingSelection.acknowledgedAt > updatedAt ||
    billingPolicy.primarySource !== "metered_api" ||
    billingPolicy.possibleAdditionalSources.length !== 0 ||
    billingPolicy.providerFallback !== "none" ||
    billingPolicy.availableSelections.length !== 1 ||
    billingPolicy.availableSelections[0] !== "strict_primary_only" ||
    billingSelection.mode !== "strict_primary_only" ||
    billingSelection.allowedSources.length !== 1 ||
    billingSelection.allowedSources[0] !== "metered_api"
  ) {
    throw invalidRegistry();
  }
  return {
    kind: "brokered_model_provider",
    id: boundedString(value.id, 36, {
      trim: true,
      pattern: BROKER_CONNECTION_ID_PATTERN,
    }),
    ...profile,
    label: boundedString(value.label, 256, { trim: true }),
    modelId: boundedUtf8String(value.modelId, 256, { trim: true }),
    credentialIdentityFingerprint: boundedString(
      value.credentialIdentityFingerprint,
      71,
      { trim: true, pattern: SHA256_FINGERPRINT_PATTERN },
    ),
    policyRevision: boundedString(value.policyRevision, 256, { trim: true }),
    billingPolicy,
    billingSelection,
    verifiedAt,
    createdAt,
    updatedAt,
  };
}

function brokeredProviderProfile(
  value: Record<string, unknown>,
): Pick<
  BrokeredModelProviderConnectionRecord,
  "providerId" | "adapterId" | "activationProfileId"
> {
  if (
    value.providerId === "openai-api" &&
    value.adapterId === "openai-responses" &&
    value.activationProfileId === "openai_api_v1"
  ) {
    return {
      providerId: "openai-api",
      adapterId: "openai-responses",
      activationProfileId: "openai_api_v1",
    };
  }
  if (
    value.providerId === "anthropic-api" &&
    value.adapterId === "anthropic-messages" &&
    value.activationProfileId === "anthropic_api_v1"
  ) {
    return {
      providerId: "anthropic-api",
      adapterId: "anthropic-messages",
      activationProfileId: "anthropic_api_v1",
    };
  }
  throw invalidRegistry();
}

function parseConnection(value: unknown): ConnectionRecord {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidRegistry();
  }
  if (value.kind === "local_openai_compatible") return parseLocal(value);
  if (value.kind === "delegated_agent") return parseDelegated(value);
  if (value.kind === "brokered_model_provider") {
    return parseBrokeredModelProviderConnectionRecord(value);
  }
  throw invalidRegistry();
}

export function parseRegistryDocument(
  value: unknown,
): ConnectionRegistryDocument {
  rejectSecretMaterial(value);
  if (!isRecord(value)) throw invalidRegistry();
  exactKeys(value, [
    "schemaVersion",
    "revision",
    "primaryConnectionId",
    "connections",
  ]);
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    (value.revision as number) > MAX_REVISION ||
    !Array.isArray(value.connections) ||
    value.connections.length > MAX_CONNECTIONS
  ) {
    throw invalidRegistry();
  }
  const connections = value.connections.map(parseConnection);
  const ids = new Set<string>();
  for (const connection of connections) {
    if (ids.has(connection.id)) throw invalidRegistry();
    ids.add(connection.id);
  }
  let primaryConnectionId: string | null;
  if (value.primaryConnectionId === null) {
    primaryConnectionId = null;
  } else {
    primaryConnectionId = boundedString(value.primaryConnectionId, 128, {
      trim: true,
      pattern: ID_PATTERN,
    });
    if (!ids.has(primaryConnectionId)) throw invalidRegistry();
  }
  return {
    schemaVersion: 1,
    revision: value.revision as number,
    primaryConnectionId,
    connections,
  };
}

export function parseLegacyLocalRecord(value: unknown): LocalConnectionRecord {
  rejectSecretMaterial(value);
  if (!isRecord(value)) throw invalidRegistry();
  exactKeys(value, [
    "schemaVersion",
    "kind",
    "id",
    "label",
    "baseUrl",
    "modelId",
    "createdAt",
    "updatedAt",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "local_openai_compatible") {
    throw invalidRegistry();
  }
  const inputUrl = boundedString(value.baseUrl, 2_048);
  let baseUrl: string;
  try {
    baseUrl = normalizeLoopbackOpenAIBaseUrl(inputUrl);
  } catch (error) {
    throw invalidRegistry(error);
  }
  return parseLocal({
    kind: "local_openai_compatible",
    id: value.id,
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    label: value.label,
    baseUrl,
    modelId: value.modelId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

function cloneConnection(connection: ConnectionRecord): ConnectionRecord {
  if (connection.kind === "local_openai_compatible") return { ...connection };
  return {
    ...connection,
    billingPolicy: {
      ...connection.billingPolicy,
      possibleAdditionalSources: [
        ...connection.billingPolicy.possibleAdditionalSources,
      ],
      availableSelections: [...connection.billingPolicy.availableSelections],
    },
    billingSelection: {
      ...connection.billingSelection,
      allowedSources: [...connection.billingSelection.allowedSources],
    },
  };
}

export function mutableRegistryDocument(
  document: ConnectionRegistryDocument,
): ConnectionRegistryDocument {
  return {
    schemaVersion: 1,
    revision: document.revision,
    primaryConnectionId: document.primaryConnectionId,
    connections: document.connections.map(cloneConnection),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function immutableRegistryDocument(
  document: ConnectionRegistryDocument,
): ConnectionRegistryDocument {
  return deepFreeze(mutableRegistryDocument(document));
}

export function emptyRegistryDocument(): ConnectionRegistryDocument {
  return {
    schemaVersion: 1,
    revision: 0,
    primaryConnectionId: null,
    connections: [],
  };
}

export function nextRegistryDocument(
  current: ConnectionRegistryDocument,
  proposed: unknown,
): ConnectionRegistryDocument {
  if (!isRecord(proposed)) throw invalidRegistry();
  return parseRegistryDocument({
    schemaVersion: 1,
    revision: current.revision + 1,
    primaryConnectionId: proposed.primaryConnectionId,
    connections: proposed.connections,
  });
}

export function serializeRegistryDocument(
  document: ConnectionRegistryDocument,
): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_REGISTRY_BYTES) throw invalidRegistry();
  return bytes;
}
