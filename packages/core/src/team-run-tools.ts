import type { JsonValue, ToolDefinition } from "@recurs/contracts";
import {
  ToolError,
  type Tool,
  type ToolResult,
} from "@recurs/tools";

import {
  TEAM_APPLY_PERMISSION,
  type TeamRunSupervisor,
  type TeamRunSnapshot,
} from "./team-run-supervisor.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_REASON = 512;

type TeamRunControls = Pick<
  TeamRunSupervisor,
  "status" | "wait" | "cancel" | "resume" | "apply"
>;

interface IdInput {
  readonly id: string;
}

interface WaitInput extends IdInput {
  readonly timeoutMs: number;
}

interface CancelInput extends IdInput {
  readonly reason: string;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolError("invalid_input", "Team control input is invalid");
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new ToolError("invalid_input", "Team control input has unexpected fields");
  }
  return record;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    throw new ToolError("invalid_input", "Team run ID is invalid");
  }
  return value;
}

function parseId(input: unknown): IdInput {
  const record = exactRecord(input, ["id"]);
  return Object.freeze({ id: id(record.id) });
}

function parseWait(input: unknown): WaitInput {
  const record = exactRecord(input, ["id", "timeoutMs"]);
  if (!Number.isSafeInteger(record.timeoutMs) ||
    (record.timeoutMs as number) < 0 || (record.timeoutMs as number) > 30_000) {
    throw new ToolError("invalid_input", "timeoutMs must be between 0 and 30000");
  }
  return Object.freeze({ id: id(record.id), timeoutMs: record.timeoutMs as number });
}

function parseCancel(input: unknown): CancelInput {
  const record = exactRecord(input, ["id", "reason"]);
  if (typeof record.reason !== "string" || record.reason.trim().length === 0 ||
    record.reason.length > MAX_REASON || [...record.reason].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })) {
    throw new ToolError("invalid_input", "Cancellation reason is invalid");
  }
  return Object.freeze({ id: id(record.id), reason: record.reason.trim() });
}

function safeOutput(snapshot: TeamRunSnapshot): string {
  const phase = snapshot.phase === null ? "none" : snapshot.phase;
  return [
    `Team run: ${snapshot.id}`,
    `Status: ${snapshot.status}`,
    `Phase: ${phase} (round ${snapshot.round})`,
    `Children: ${snapshot.childrenFinished}/${snapshot.childrenReserved} finished`,
    `Cost coverage: ${snapshot.costCoverage}`,
  ].join("\n");
}

function result(
  snapshot: TeamRunSnapshot,
  extra: Record<string, unknown> = {},
): ToolResult {
  return {
    output: safeOutput(snapshot),
    metadata: { snapshot, ...extra },
  };
}

function definition(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object" as const,
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
}

export function createTeamRunTools(
  controls: TeamRunControls,
): readonly Tool<IdInput | WaitInput | CancelInput>[] {
  const status: Tool<IdInput> = {
    definition: definition(
      "team_status",
      "Inspect one Recurs team run owned by the current parent session.",
      { id: { type: "string" } },
    ),
    executionClass: "in_process",
    mutating: false,
    parse: parseId,
    permissions: () => [],
    async execute(input, context) {
      return result(await controls.status(context.sessionId, input.id));
    },
  };
  const wait: Tool<WaitInput> = {
    definition: definition(
      "wait_team",
      "Wait up to 30 seconds for one owned Recurs team run to settle or become ready.",
      {
        id: { type: "string" },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30_000 },
      },
    ),
    executionClass: "in_process",
    mutating: false,
    parse: parseWait,
    permissions: () => [],
    async execute(input, context) {
      const waited = await controls.wait(
        context.sessionId,
        input.id,
        input.timeoutMs,
        context.signal,
      );
      return result(waited.snapshot, { timedOut: waited.timedOut });
    },
  };
  const cancel: Tool<CancelInput> = {
    definition: definition(
      "cancel_team",
      "Request durable cancellation for one owned Recurs team run.",
      { id: { type: "string" }, reason: { type: "string" } },
    ),
    executionClass: "in_process",
    mutating: false,
    parse: parseCancel,
    permissions: () => [],
    async execute(input, context) {
      const cancelled = await controls.cancel(
        context.sessionId,
        input.id,
        input.reason,
      );
      return result(cancelled.snapshot, { result: cancelled.result });
    },
  };
  const resume: Tool<IdInput> = {
    definition: definition(
      "resume_team",
      "Resume one safely interrupted background Recurs team under fresh authorization.",
      { id: { type: "string" } },
    ),
    executionClass: "in_process",
    mutating: true,
    checkpointOwnership: "self_managed",
    parse: parseId,
    permissions: () => [{
      category: "write",
      resource: "team run resume",
      risk: "elevated",
    }],
    async execute(input, context) {
      const resumed = await controls.resume(context.sessionId, input.id, context);
      return result(resumed.snapshot, { result: resumed.result });
    },
  };
  const apply: Tool<IdInput> = {
    definition: definition(
      "apply_team",
      "Explicitly apply one reviewed background team candidate to the current parent.",
      { id: { type: "string" } },
    ),
    executionClass: "in_process",
    mutating: true,
    checkpointOwnership: "self_managed",
    parse: parseId,
    permissions: () => [TEAM_APPLY_PERMISSION],
    async execute(input, context) {
      const applied = await controls.apply(context.sessionId, input.id, context);
      return {
        output: applied.output,
        metadata: applied.metadata,
      };
    },
  };
  return Object.freeze([status, wait, cancel, resume, apply]);
}
