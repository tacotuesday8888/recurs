import { NON_SECRET_POLICY } from "./generated/non-secret-policy.js";

const forbiddenKeys = new Set<string>(
  NON_SECRET_POLICY.forbiddenNormalizedKeys,
);
const tokenSuffix = /^[A-Za-z0-9_-]$/u;
const jwtSegment = /^[A-Za-z0-9_-]+$/u;
const asciiHex = /^[A-Fa-f0-9]+$/u;
const mixedEntropyAlphabet = /^[A-Za-z0-9_+/=-]+$/u;
const whitespace = new Set<number>(
  NON_SECRET_POLICY.valueRules.authorization.whitespaceCodePoints,
);

export function normalizeNonSecretKey(value: string): string {
  return value
    .normalize(NON_SECRET_POLICY.keyNormalization.unicodeForm)
    .replace(/[^a-zA-Z0-9]/gu, "")
    .toLowerCase();
}

export function isForbiddenNonSecretKey(value: string): boolean {
  return forbiddenKeys.has(normalizeNonSecretKey(value));
}

function hasPrivateKeyMarker(value: string): boolean {
  const rule = NON_SECRET_POLICY.valueRules.privateKeyMarker;
  let searchFrom = 0;
  while (searchFrom <= value.length) {
    const begin = value.indexOf(rule.begin, searchFrom);
    if (begin === -1) return false;
    const contentStart = begin + rule.begin.length;
    if (value.startsWith(rule.suffix, contentStart)) return true;
    let labelEnd = contentStart;
    while (/[A-Z]/u.test(value[labelEnd] ?? "")) labelEnd += 1;
    if (
      labelEnd > contentStart &&
      value.startsWith(rule.labelSeparator, labelEnd) &&
      value.startsWith(
        rule.suffix,
        labelEnd + rule.labelSeparator.length,
      )
    ) {
      return true;
    }
    searchFrom = begin + 1;
  }
  return false;
}

function hasPrefixedToken(value: string): boolean {
  const rule = NON_SECRET_POLICY.valueRules.prefixedToken;
  for (const prefix of rule.prefixes) {
    let searchFrom = 0;
    while (searchFrom <= value.length) {
      const start = value.indexOf(prefix, searchFrom);
      if (start === -1) break;
      let length = 0;
      for (
        let index = start + prefix.length;
        index < value.length && tokenSuffix.test(value[index] ?? "");
        index += 1
      ) {
        length += 1;
      }
      if (length >= rule.minimumSuffixLength) return true;
      searchFrom = start + 1;
    }
  }
  return false;
}

function isJwt(value: string): boolean {
  const rule = NON_SECRET_POLICY.valueRules.jwt;
  const segments = value.split(".");
  if (segments.length !== rule.segmentCount) return false;
  const [first = "", second = "", third = ""] = segments;
  return (
    first.startsWith(rule.firstSegmentPrefix) &&
    first.length - rule.firstSegmentPrefix.length >=
      rule.minimumFirstRemainderLength &&
    second.length >= rule.minimumOtherSegmentLength &&
    third.length >= rule.minimumOtherSegmentLength &&
    jwtSegment.test(first.slice(rule.firstSegmentPrefix.length)) &&
    jwtSegment.test(second) &&
    jwtSegment.test(third)
  );
}

function isAuthorization(value: string): boolean {
  const scalars = [...value];
  const separator = scalars.findIndex((character) =>
    whitespace.has(character.codePointAt(0) ?? -1)
  );
  if (separator <= 0) return false;
  const scheme = scalars.slice(0, separator).join("");
  if (
    !NON_SECRET_POLICY.valueRules.authorization.schemes.some(
      (candidate) => candidate.toLowerCase() === scheme.toLowerCase(),
    )
  ) {
    return false;
  }
  let payloadStart = separator;
  while (
    payloadStart < scalars.length &&
    whitespace.has(scalars[payloadStart]?.codePointAt(0) ?? -1)
  ) {
    payloadStart += 1;
  }
  const payload = scalars.slice(payloadStart);
  return (
    payload.length >=
      NON_SECRET_POLICY.valueRules.authorization.minimumPayloadLength &&
    payload.every(
      (character) => !whitespace.has(character.codePointAt(0) ?? -1),
    )
  );
}

export function looksLikeSecretValue(value: string): boolean {
  if (hasPrivateKeyMarker(value) || hasPrefixedToken(value) || isJwt(value)) {
    return true;
  }
  if (isAuthorization(value)) return true;
  if (
    value.length >= NON_SECRET_POLICY.valueRules.longHex.minimumLength &&
    asciiHex.test(value)
  ) {
    return true;
  }
  return (
    value.length >= NON_SECRET_POLICY.valueRules.mixedEntropy.minimumLength &&
    mixedEntropyAlphabet.test(value) &&
    /[a-z]/u.test(value) &&
    /[A-Z]/u.test(value) &&
    /\d/u.test(value) &&
    new Set(value).size >=
      NON_SECRET_POLICY.valueRules.mixedEntropy.minimumDistinctCharacters
  );
}
