import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = path.join(root, "policy/non-secret-policy.v1.json");
const outputs = [
  path.join(root, "packages/app/src/generated/non-secret-policy.ts"),
  path.join(
    root,
    "native/macos/Sources/RecursBrokerCore/GeneratedNonSecretPolicy.swift",
  ),
];

function fail(message) {
  throw new Error(`Invalid non-secret policy: ${message}`);
}

function exactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has unexpected fields`);
  }
}

function string(value, expected, label) {
  if (typeof value !== "string" || value !== expected) fail(label);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 4096) fail(label);
}

function stringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    fail(label);
  }
}

function sortedUniqueStrings(value, label) {
  stringArray(value, label);
  if ([...value].sort().join("\0") !== value.join("\0")) {
    fail(`${label} must be sorted`);
  }
}

function validate(policy) {
  exactKeys(
    policy,
    [
      "schemaVersion",
      "keyNormalization",
      "forbiddenNormalizedKeys",
      "valueRules",
    ],
    "root",
  );
  if (policy.schemaVersion !== 1) fail("schemaVersion");
  exactKeys(
    policy.keyNormalization,
    ["unicodeForm", "retain", "case"],
    "keyNormalization",
  );
  string(policy.keyNormalization.unicodeForm, "NFKC", "unicodeForm");
  string(
    policy.keyNormalization.retain,
    "ascii_alphanumeric",
    "key retain rule",
  );
  string(policy.keyNormalization.case, "lower_ascii", "key case rule");
  sortedUniqueStrings(
    policy.forbiddenNormalizedKeys,
    "forbiddenNormalizedKeys",
  );

  const rules = policy.valueRules;
  exactKeys(
    rules,
    [
      "privateKeyMarker",
      "prefixedToken",
      "jwt",
      "authorization",
      "longHex",
      "mixedEntropy",
    ],
    "valueRules",
  );
  if (
    typeof rules.privateKeyMarker.begin !== "string" ||
    rules.privateKeyMarker.begin.length === 0 ||
    typeof rules.privateKeyMarker.suffix !== "string" ||
    rules.privateKeyMarker.suffix.length === 0
  ) {
    fail("private-key markers");
  }
  exactKeys(
    rules.privateKeyMarker,
    ["begin", "suffix", "optionalLabelAlphabet", "labelSeparator"],
    "privateKeyMarker",
  );
  string(
    rules.privateKeyMarker.optionalLabelAlphabet,
    "ascii_uppercase",
    "private-key alphabet",
  );
  string(rules.privateKeyMarker.labelSeparator, " ", "private-key separator");

  exactKeys(
    rules.prefixedToken,
    ["match", "prefixes", "suffixAlphabet", "minimumSuffixLength"],
    "prefixedToken",
  );
  string(rules.prefixedToken.match, "substring", "prefix match");
  sortedUniqueStrings(rules.prefixedToken.prefixes, "token prefixes");
  string(
    rules.prefixedToken.suffixAlphabet,
    "ascii_alphanumeric_underscore_hyphen",
    "token alphabet",
  );
  positiveInteger(rules.prefixedToken.minimumSuffixLength, "token minimum");

  exactKeys(
    rules.jwt,
    [
      "match",
      "firstSegmentPrefix",
      "segmentAlphabet",
      "minimumFirstRemainderLength",
      "minimumOtherSegmentLength",
      "segmentCount",
    ],
    "jwt",
  );
  string(rules.jwt.match, "whole", "JWT match");
  if (
    typeof rules.jwt.firstSegmentPrefix !== "string" ||
    rules.jwt.firstSegmentPrefix.length === 0
  ) {
    fail("JWT first prefix");
  }
  string(
    rules.jwt.segmentAlphabet,
    "ascii_alphanumeric_underscore_hyphen",
    "JWT alphabet",
  );
  positiveInteger(rules.jwt.minimumFirstRemainderLength, "JWT first minimum");
  positiveInteger(rules.jwt.minimumOtherSegmentLength, "JWT segment minimum");
  if (rules.jwt.segmentCount !== 3) fail("JWT segment count");

  exactKeys(
    rules.authorization,
    [
      "match",
      "schemes",
      "minimumPayloadLength",
      "lengthUnit",
      "whitespaceCodePoints",
    ],
    "authorization",
  );
  string(
    rules.authorization.match,
    "whole_ascii_case_insensitive",
    "authorization match",
  );
  sortedUniqueStrings(
    rules.authorization.schemes,
    "authorization schemes",
  );
  positiveInteger(
    rules.authorization.minimumPayloadLength,
    "authorization minimum",
  );
  string(
    rules.authorization.lengthUnit,
    "unicode_scalar",
    "authorization length unit",
  );
  if (
    !Array.isArray(rules.authorization.whitespaceCodePoints) ||
    rules.authorization.whitespaceCodePoints.length === 0 ||
    rules.authorization.whitespaceCodePoints.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > 0x10ffff,
    ) ||
    new Set(rules.authorization.whitespaceCodePoints).size !==
      rules.authorization.whitespaceCodePoints.length ||
    [...rules.authorization.whitespaceCodePoints].sort((left, right) => left - right)
      .some((value, index) => value !== rules.authorization.whitespaceCodePoints[index])
  ) {
    fail("authorization whitespace set");
  }

  exactKeys(rules.longHex, ["match", "alphabet", "minimumLength"], "longHex");
  string(rules.longHex.match, "whole", "hex match");
  string(rules.longHex.alphabet, "ascii_hex", "hex alphabet");
  positiveInteger(rules.longHex.minimumLength, "hex minimum");

  exactKeys(
    rules.mixedEntropy,
    [
      "match",
      "alphabet",
      "minimumLength",
      "minimumDistinctCharacters",
      "requiredClasses",
    ],
    "mixedEntropy",
  );
  string(rules.mixedEntropy.match, "whole", "entropy match");
  string(
    rules.mixedEntropy.alphabet,
    "ascii_alphanumeric_underscore_plus_slash_equals_hyphen",
    "entropy alphabet",
  );
  positiveInteger(rules.mixedEntropy.minimumLength, "entropy minimum");
  positiveInteger(
    rules.mixedEntropy.minimumDistinctCharacters,
    "entropy distinct minimum",
  );
  stringArray(rules.mixedEntropy.requiredClasses, "entropy classes");
  if (
    rules.mixedEntropy.requiredClasses.join(",") !==
    "ascii_lowercase,ascii_uppercase,ascii_digit"
  ) {
    fail("entropy required classes");
  }
  return policy;
}

function swiftString(value) {
  return JSON.stringify(value);
}

function swiftArray(values, render = swiftString) {
  return values.map((value) => `    ${render(value)},`).join("\n");
}

function typescript(policy) {
  return `// Generated by scripts/generate-non-secret-policy.mjs. Do not edit.\n\nexport const NON_SECRET_POLICY = ${JSON.stringify(policy, null, 2)} as const;\n`;
}

function swift(policy) {
  const rules = policy.valueRules;
  return `// Generated by scripts/generate-non-secret-policy.mjs. Do not edit.\n\npackage enum GeneratedNonSecretPolicy {\n  package static let forbiddenNormalizedKeys: Set<String> = [\n${swiftArray(policy.forbiddenNormalizedKeys)}\n  ]\n\n  package static let privateKeyBegin = ${swiftString(rules.privateKeyMarker.begin)}\n  package static let privateKeySuffix = ${swiftString(rules.privateKeyMarker.suffix)}\n  package static let privateKeyLabelSeparator = ${swiftString(rules.privateKeyMarker.labelSeparator)}\n\n  package static let tokenPrefixes = [\n${swiftArray(rules.prefixedToken.prefixes)}\n  ]\n  package static let tokenMinimumSuffixLength = ${rules.prefixedToken.minimumSuffixLength}\n\n  package static let jwtFirstSegmentPrefix = ${swiftString(rules.jwt.firstSegmentPrefix)}\n  package static let jwtMinimumFirstRemainderLength = ${rules.jwt.minimumFirstRemainderLength}\n  package static let jwtMinimumOtherSegmentLength = ${rules.jwt.minimumOtherSegmentLength}\n  package static let jwtSegmentCount = ${rules.jwt.segmentCount}\n\n  package static let authorizationSchemes = [\n${swiftArray(rules.authorization.schemes)}\n  ]\n  package static let authorizationMinimumPayloadLength = ${rules.authorization.minimumPayloadLength}\n  package static let authorizationWhitespaceCodePoints: Set<UInt32> = [\n${swiftArray(rules.authorization.whitespaceCodePoints, String)}\n  ]\n\n  package static let longHexMinimumLength = ${rules.longHex.minimumLength}\n  package static let mixedEntropyMinimumLength = ${rules.mixedEntropy.minimumLength}\n  package static let mixedEntropyMinimumDistinctCharacters = ${rules.mixedEntropy.minimumDistinctCharacters}\n}\n`;
}

const policy = validate(JSON.parse(await readFile(policyPath, "utf8")));
const generated = [typescript(policy), swift(policy)];
const check = process.argv.slice(2).includes("--check");

for (let index = 0; index < outputs.length; index += 1) {
  const output = outputs[index];
  const expected = generated[index];
  if (check) {
    let actual;
    try {
      actual = await readFile(output, "utf8");
    } catch {
      actual = undefined;
    }
    if (actual !== expected) {
      process.stderr.write(
        `${path.relative(root, output)} is not generated from ${path.relative(root, policyPath)}\n`,
      );
      process.exitCode = 1;
    }
  } else {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, expected, "utf8");
  }
}
