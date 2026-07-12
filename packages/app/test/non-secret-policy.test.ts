import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NON_SECRET_POLICY } from "../src/generated/non-secret-policy.js";
import {
  isForbiddenNonSecretKey,
  looksLikeSecretValue,
} from "../src/non-secret-policy.js";

interface PolicyCase {
  readonly name: string;
  readonly value: string;
  readonly forbidden: boolean;
}

interface PolicyCases {
  readonly schemaVersion: 1;
  readonly keyCases: readonly PolicyCase[];
  readonly valueCases: readonly PolicyCase[];
}

const canonicalUrl = new URL(
  "../../../tests/fixtures/non-secret-policy-cases.json",
  import.meta.url,
);
const swiftUrl = new URL(
  "../../../native/macos/Tests/RecursBrokerCoreTests/Fixtures/non-secret-policy-cases.json",
  import.meta.url,
);

async function cases(): Promise<PolicyCases> {
  return JSON.parse(await readFile(canonicalUrl, "utf8")) as PolicyCases;
}

describe("shared non-secret policy", () => {
  it("keeps the Swift behavioral cases byte-identical", async () => {
    const [canonical, swift] = await Promise.all([
      readFile(canonicalUrl),
      readFile(swiftUrl),
    ]);
    expect(swift.equals(canonical)).toBe(true);
    expect(fileURLToPath(swiftUrl)).toContain(
      "RecursBrokerCoreTests/Fixtures/non-secret-policy-cases.json",
    );
  });

  it("applies every key and value boundary from the shared cases", async () => {
    const fixture = await cases();
    expect(fixture.schemaVersion).toBe(1);
    for (const testCase of fixture.keyCases) {
      expect(
        isForbiddenNonSecretKey(testCase.value),
        testCase.name,
      ).toBe(testCase.forbidden);
    }
    for (const testCase of fixture.valueCases) {
      expect(
        looksLikeSecretValue(testCase.value),
        testCase.name,
      ).toBe(testCase.forbidden);
    }
  });

  it("applies every generated key, token prefix, and whitespace scalar", () => {
    for (const key of NON_SECRET_POLICY.forbiddenNormalizedKeys) {
      expect(isForbiddenNonSecretKey(key), key).toBe(true);
    }
    for (const prefix of NON_SECRET_POLICY.valueRules.prefixedToken.prefixes) {
      expect(
        looksLikeSecretValue(`${prefix}${"A".repeat(16)}`),
        prefix,
      ).toBe(true);
    }
    for (const codePoint of NON_SECRET_POLICY.valueRules.authorization
      .whitespaceCodePoints) {
      expect(
        looksLikeSecretValue(
          `Bearer${String.fromCodePoint(codePoint)}abcdefghijkl`,
        ),
        `U+${codePoint.toString(16)}`,
      ).toBe(true);
    }
  });
});
