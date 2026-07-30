import assert from "node:assert/strict";
import test from "node:test";

import { parseSingleNpmPackReport } from "./npm-pack-report.mjs";

const report = Object.freeze({
  name: "recurs",
  version: "0.1.0-alpha.2",
  filename: "recurs-0.1.0-alpha.2.tgz",
});

test("accepts the npm 11 single-package array report", () => {
  assert.deepEqual(
    parseSingleNpmPackReport(JSON.stringify([report])),
    report,
  );
});

test("accepts the npm 12 single-package keyed report", () => {
  assert.deepEqual(
    parseSingleNpmPackReport(JSON.stringify({ recurs: report })),
    report,
  );
});

test("rejects malformed, empty, ambiguous, and mismatched reports", () => {
  for (const value of [
    "not-json",
    "null",
    "[]",
    "{}",
    JSON.stringify([report, report]),
    JSON.stringify({ recurs: report, other: report }),
    JSON.stringify({ other: report }),
  ]) {
    assert.throws(
      () => parseSingleNpmPackReport(value),
      /npm pack must return one package report/u,
    );
  }
});
