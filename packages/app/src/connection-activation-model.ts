import {
  invalidRegistry,
  isRecord,
  parseBrokeredModelProviderConnectionRecord,
  parseCanonicalTimestamp,
  type BrokeredModelProviderConnectionRecord,
} from "./connection-registry-model.js";

export const MAX_CONNECTION_ACTIVATION_BYTES = 64 * 1024;

export interface PendingConnectionActivation {
  readonly connection: BrokeredModelProviderConnectionRecord;
  readonly stagedAt: string;
}

export interface ConnectionActivationDocument {
  readonly schemaVersion: 1;
  readonly activation: PendingConnectionActivation | null;
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

export function parseConnectionActivationDocument(
  value: unknown,
): ConnectionActivationDocument {
  if (!isRecord(value)) throw invalidRegistry();
  exactKeys(value, ["schemaVersion", "activation"]);
  if (value.schemaVersion !== 1) throw invalidRegistry();
  if (value.activation === null) return emptyConnectionActivationDocument();
  if (!isRecord(value.activation)) throw invalidRegistry();
  exactKeys(value.activation, ["connection", "stagedAt"]);
  return {
    schemaVersion: 1,
    activation: {
      connection: parseBrokeredModelProviderConnectionRecord(
        value.activation.connection,
      ),
      stagedAt: parseCanonicalTimestamp(value.activation.stagedAt),
    },
  };
}

export function emptyConnectionActivationDocument(): ConnectionActivationDocument {
  return { schemaVersion: 1, activation: null };
}

export function immutableConnectionActivationDocument(
  document: ConnectionActivationDocument,
): ConnectionActivationDocument {
  return deepFreeze(structuredClone(document));
}

export function serializeConnectionActivationDocument(
  document: ConnectionActivationDocument,
): Buffer {
  const canonical = parseConnectionActivationDocument(document);
  const bytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_CONNECTION_ACTIVATION_BYTES) throw invalidRegistry();
  return bytes;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
