import { createHash, timingSafeEqual } from "node:crypto";

import type {
  BillingSelection,
  RunAuthorization,
  SessionBackendPin,
  TrustedRunContext,
} from "@recurs/contracts";

export type BackendAuthorizationErrorCode =
  | "authorization_invalid"
  | "authorization_mismatch"
  | "authorization_expired";

const messages: Readonly<Record<BackendAuthorizationErrorCode, string>> = {
  authorization_invalid: "The backend authorization is invalid",
  authorization_mismatch: "The backend authorization does not match this operation",
  authorization_expired: "The backend authorization has expired",
};

export class BackendAuthorizationError extends Error {
  constructor(readonly code: BackendAuthorizationErrorCode) {
    super(messages[code]);
    this.name = "BackendAuthorizationError";
  }
}

export interface RunAuthorizationBinding {
  readonly id: string;
  readonly operation: RunAuthorization["operation"];
  readonly sessionId: string;
  readonly operationId: string;
  readonly turnId: string | null;
  readonly pin: SessionBackendPin;
  readonly connectionRevision: number;
  readonly policyRevision: string;
  readonly context: TrustedRunContext;
  readonly maxRequests: number;
  readonly expiresAt: string;
}

function invalid(): never {
  throw new BackendAuthorizationError("authorization_invalid");
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) {
    return invalid();
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalid();
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object") {
    return invalid();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => {
    const item = record[key];
    if (item === undefined) {
      return invalid();
    }
    return `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`;
  }).join(",")}}`;
}

function digest(domain: string, value: unknown): string {
  const hash = createHash("sha256");
  hash.update("recurs\0");
  hash.update(domain);
  hash.update("\0v1\0");
  hash.update(canonicalJson(value));
  return `sha256:${hash.digest("hex")}`;
}

export function createBackendFingerprint(pin: SessionBackendPin): string {
  return digest("session-backend-pin", {
    schemaVersion: 1,
    pin,
  });
}

export function createBillingSelectionDigest(
  billingSelection: BillingSelection,
): string {
  return digest("billing-selection", {
    schemaVersion: 1,
    billingSelection,
  });
}

export function createContextDigest(context: TrustedRunContext): string {
  return digest("trusted-run-context", {
    schemaVersion: 1,
    context,
  });
}

function nonEmpty(value: string): boolean {
  return value.length > 0 && value === value.trim();
}

function canonicalFuture(value: string, now: Date): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value &&
    milliseconds > now.getTime();
}

function validateBinding(input: RunAuthorizationBinding, now: Date): void {
  if (
    !Number.isFinite(now.getTime()) ||
    !nonEmpty(input.id) ||
    !nonEmpty(input.sessionId) ||
    !nonEmpty(input.operationId) ||
    !nonEmpty(input.policyRevision) ||
    input.policyRevision !== input.pin.policyRevisionAtCreation ||
    !Number.isSafeInteger(input.connectionRevision) ||
    input.connectionRevision < 0 ||
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests <= 0 ||
    !canonicalFuture(input.expiresAt, now) ||
    (input.operation === "run"
      ? input.turnId === null || !nonEmpty(input.turnId)
      : input.turnId !== null)
  ) {
    invalid();
  }
}

export function bindRunAuthorization(
  input: RunAuthorizationBinding,
  now: Date = new Date(),
): RunAuthorization {
  validateBinding(input, now);
  return Object.freeze({
    kind: "run",
    id: input.id,
    operation: input.operation,
    sessionId: input.sessionId,
    operationId: input.operationId,
    turnId: input.turnId,
    connectionId: input.pin.connectionId,
    modelId: input.pin.modelId,
    backendFingerprint: createBackendFingerprint(input.pin),
    connectionRevision: input.connectionRevision,
    policyRevision: input.policyRevision,
    billingMode: input.pin.billingSelectionAtCreation.mode,
    billingSelectionDigest: createBillingSelectionDigest(
      input.pin.billingSelectionAtCreation,
    ),
    contextDigest: createContextDigest(input.context),
    maxRequests: input.maxRequests,
    expiresAt: input.expiresAt,
  });
}

function equalCanonical(left: unknown, right: unknown): boolean {
  const leftBytes = Buffer.from(canonicalJson(left));
  const rightBytes = Buffer.from(canonicalJson(right));
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

export function verifyRunAuthorization(
  authorization: RunAuthorization,
  binding: RunAuthorizationBinding,
  now: Date = new Date(),
): RunAuthorization {
  let expected: RunAuthorization;
  try {
    expected = bindRunAuthorization(binding, now);
  } catch (error) {
    if (
      error instanceof BackendAuthorizationError &&
      Date.parse(binding.expiresAt) <= now.getTime()
    ) {
      throw new BackendAuthorizationError("authorization_expired");
    }
    throw error;
  }
  if (!canonicalFuture(authorization.expiresAt, now)) {
    throw new BackendAuthorizationError("authorization_expired");
  }
  if (!equalCanonical(authorization, expected)) {
    throw new BackendAuthorizationError("authorization_mismatch");
  }
  return authorization;
}
