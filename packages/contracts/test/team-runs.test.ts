import { describe, expectTypeOf, it } from "vitest";

import type {
  TeamReviewFinding,
  TeamRunAllocation,
  TeamRunBackendRoute,
  TeamRunDescriptor,
  TeamRunNonApprovedTerminalStatus,
  TeamRunPhase,
  TeamRunRequest,
  TeamRunStatus,
  TeamRunTerminalStatus,
} from "../src/index.js";

describe("team run contracts", () => {
  it("exports complete frozen descriptor, request, allocation, and route shapes", () => {
    expectTypeOf<TeamRunDescriptor>().toMatchTypeOf<{
      readonly id: string;
      readonly version: 1;
      readonly request: TeamRunRequest;
      readonly allocation: TeamRunAllocation;
      readonly routes: readonly TeamRunBackendRoute[];
    }>();
    expectTypeOf<TeamReviewFinding["path"]>().toEqualTypeOf<string | "*">();
  });

  it("keeps phases and terminal classifications exact", () => {
    expectTypeOf<TeamRunPhase>().toEqualTypeOf<
      "implement" | "stage" | "review" | "repair" | "apply"
    >();
    expectTypeOf<TeamRunStatus>().toEqualTypeOf<
      | "created" | "running" | "ready_to_apply" | "applying"
      | "approved" | "changes_requested" | "unverified"
      | "failed" | "cancelled" | "interrupted"
    >();
    expectTypeOf<TeamRunTerminalStatus>().toEqualTypeOf<
      "approved" | "changes_requested" | "unverified" | "failed" | "cancelled"
    >();
    expectTypeOf<TeamRunNonApprovedTerminalStatus>().toEqualTypeOf<
      "changes_requested" | "unverified" | "failed" | "cancelled"
    >();
  });
});
