import { describe, expect, it } from "vitest";

import {
  CompanyStateStoreError,
  type CompanyStateStoreErrorCode,
} from "@recurs/core";

import { safeCliErrorMessage } from "../src/error-rendering.js";

describe("safeCliErrorMessage", () => {
  it.each<readonly [CompanyStateStoreErrorCode, string]>([
    ["invalid_id", "Private Recurs state uses an invalid identifier."],
    ["not_found", "Private Recurs state was not found."],
    [
      "conflict",
      "Private Recurs state changed concurrently. Reload and retry.",
    ],
    [
      "sequence_conflict",
      "Private Recurs state changed concurrently. Reload and retry.",
    ],
    [
      "corrupt",
      "Private Recurs state is unsafe or corrupt. Check RECURS_HOME safety and integrity before retrying.",
    ],
  ])("renders a fixed public message for %s company-state failures", (
    code,
    expected,
  ) => {
    const message = safeCliErrorMessage(new CompanyStateStoreError(
      code,
      "private store detail at /Users/private/.recurs/company-secret",
      { cause: new Error("private cause") },
    ));

    expect(message).toBe(expected);
    expect(message).not.toMatch(/Users|company-secret|private cause/u);
  });

  it("keeps unknown exceptions behind a diagnostic id", () => {
    expect(safeCliErrorMessage(
      new Error("private unknown failure"),
      "00000000-0000-4000-8000-000000000001",
    )).toBe(
      "Unexpected failure (diagnostic 00000000-0000-4000-8000-000000000001)",
    );
  });
});
