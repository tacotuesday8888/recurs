const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const INVALID_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const encoder = new TextEncoder();

export function contractRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function contractExact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function invalidText(value: string): boolean {
  if (INVALID_TEXT.test(value)) return true;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 8 || code === 11 || code === 12 ||
      (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}

export function contractText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length === 0 ||
    encoder.encode(value).byteLength > maximum || invalidText(value)) {
    throw new TypeError(`${label} must be valid bounded text`);
  }
  return value;
}

export function contractOptionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  return value === null ? null : contractText(value, label, maximum);
}

export function contractId(value: unknown, label: string): string {
  const parsed = contractText(value, label, 128);
  if (!SAFE_ID.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

export function contractTimestamp(value: unknown, label: string): string {
  const parsed = contractText(value, label, 64);
  const date = new Date(parsed);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== parsed) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return parsed;
}

export function contractInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value as number;
}

export function contractNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_VALUE,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) ||
    value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded finite number`);
  }
  return value;
}

export function contractEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

export function contractTextArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumBytes: number,
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems ||
    (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} is invalid`);
  }
  const parsed = value.map((item) =>
    contractText(item, label, maximumBytes)
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${label} must be unique`);
  }
  return parsed;
}

export function contractIds(
  value: unknown,
  label: string,
  maximumItems: number,
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems ||
    (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} is invalid`);
  }
  const parsed = value.map((item) => contractId(item, label));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${label} must be unique`);
  }
  return parsed;
}

export function contractDeepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) contractDeepFreeze(child);
  return Object.freeze(value);
}
