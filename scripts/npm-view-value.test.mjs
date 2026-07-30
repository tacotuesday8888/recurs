import assert from "node:assert/strict";
import test from "node:test";

import { parseSingleNpmViewString } from "./npm-view-value.mjs";

test("accepts npm 11 and npm 12 single-value JSON output", () => {
  assert.equal(parseSingleNpmViewString('"sha512-value"'), "sha512-value");
  assert.equal(parseSingleNpmViewString('["sha512-value"]'), "sha512-value");
});

test("rejects missing, multiple, and non-string npm view values", () => {
  for (const value of ["", "null", "[]", '["one","two"]', "{}", "[1]"]) {
    assert.throws(() => parseSingleNpmViewString(value), /one string value/u);
  }
});
