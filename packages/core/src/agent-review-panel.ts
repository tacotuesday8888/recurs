import path from "node:path";

import {
  getOperatingModePolicy,
  type AgentTeamQualityStandard,
  type OperatingModeId,
} from "@recurs/contracts";
import {
  ToolError,
  type ToolContext,
} from "@recurs/tools";

import type {
  ChildAgentManager,
  ChildDelegationResult,
} from "./child-agent-manager.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import { isPinnedSessionState } from "./session-v2.js";

const MAX_REVIEW_OUTPUT_BYTES = 8 * 1024;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_LENGTH = 512;
const MAX_INSTRUCTIONS_LENGTH = 12_000;
const MAX_CHANGED_FILES = 256;
const MAX_CHANGED_FILE_LENGTH = 512;
const MAX_PROMPT_LENGTH = 32_768;

export interface AgentReviewVerdict {
  readonly verdict: "approve" | "request_changes";
  readonly summary: string;
  readonly evidence: readonly string[];
}

interface ReviewRecordBase {
  readonly index: number;
}

export interface CompletedAgentReview extends ReviewRecordBase {
  readonly status: "completed";
  readonly childAgentId: string;
  readonly childSessionId: string;
  readonly verdict: AgentReviewVerdict["verdict"];
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface InvalidAgentReview extends ReviewRecordBase {
  readonly status: "invalid";
  readonly childAgentId: string;
  readonly childSessionId: string;
  readonly error: { readonly code: "invalid_review"; readonly message: string };
}

export interface FailedAgentReview extends ReviewRecordBase {
  readonly status: "failed";
  readonly error: { readonly code: string; readonly message: string };
}

export type AgentReviewRecord =
  | CompletedAgentReview
  | InvalidAgentReview
  | FailedAgentReview;

export interface AgentReviewTask {
  readonly description: string;
  readonly instructions: string;
  readonly changedFiles: readonly string[];
}

export interface AgentReviewPanelResult {
  readonly verdict: "approved" | "changes_requested" | "unverified";
  readonly operatingModeId: OperatingModeId;
  readonly qualityStandard: AgentTeamQualityStandard;
  readonly initialReviewers: number;
  readonly maxReviewers: number;
  readonly escalated: boolean;
  readonly reviews: readonly AgentReviewRecord[];
  readonly evidence: readonly string[];
}

export interface AgentReviewPanelDependencies {
  readonly sessions: JsonlSessionStore;
  readonly children: Pick<ChildAgentManager, "delegate">;
}

export interface AgentReviewPanelRunOptions {
  readonly team?: {
    readonly id: string;
    readonly indexOffset: number;
  };
}

function hasControlCharacters(value: string, allowLines = false): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint <= 31 && !(allowLines && "\n\r\t".includes(character))) ||
      (codePoint >= 127 && codePoint <= 159);
  });
}

function boundedText(
  value: unknown,
  maximum: number,
  allowLines = false,
): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !hasControlCharacters(value, allowLines);
}

function invalidReview(): ToolError {
  return new ToolError(
    "invalid_input",
    "Review output must be one exact bounded JSON verdict with evidence",
  );
}

export function parseAgentReviewVerdict(output: string): AgentReviewVerdict {
  if (
    output.length === 0 ||
    Buffer.byteLength(output, "utf8") > MAX_REVIEW_OUTPUT_BYTES
  ) {
    throw invalidReview();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw invalidReview();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw invalidReview();
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "evidence,summary,verdict" ||
    (record.verdict !== "approve" && record.verdict !== "request_changes") ||
    !boundedText(record.summary, MAX_SUMMARY_LENGTH) ||
    !Array.isArray(record.evidence) ||
    record.evidence.length === 0 ||
    record.evidence.length > MAX_EVIDENCE_ITEMS ||
    !record.evidence.every((item) => boundedText(item, MAX_EVIDENCE_LENGTH))
  ) {
    throw invalidReview();
  }
  return {
    verdict: record.verdict,
    summary: record.summary,
    evidence: [...record.evidence] as string[],
  };
}

function validateTask(task: AgentReviewTask): AgentReviewTask {
  if (
    !boundedText(task.description, 256) ||
    !boundedText(task.instructions, MAX_INSTRUCTIONS_LENGTH, true) ||
    !Array.isArray(task.changedFiles) ||
    task.changedFiles.length === 0 ||
    task.changedFiles.length > MAX_CHANGED_FILES
  ) {
    throw new ToolError("invalid_input", "Review task input is invalid or too large");
  }
  const changedFiles = task.changedFiles.map((file) => {
    if (
      !boundedText(file, MAX_CHANGED_FILE_LENGTH) ||
      path.isAbsolute(file) ||
      file.includes("\\") ||
      file.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new ToolError("invalid_input", "Review changed-file paths are invalid");
    }
    return file;
  });
  if (new Set(changedFiles).size !== changedFiles.length) {
    throw new ToolError("invalid_input", "Review changed-file paths must be unique");
  }
  return {
    description: task.description,
    instructions: task.instructions,
    changedFiles,
  };
}

function reviewPrompt(
  task: AgentReviewTask,
  quality: AgentTeamQualityStandard,
  index: number,
  maximum: number,
): string {
  const prompt = [
    `You are independent reviewer ${index} of at most ${maximum}.`,
    `Apply the Recurs ${quality} quality standard.`,
    "Inspect the uncommitted parent-workspace diff and run only relevant fixed verification available to you.",
    "Treat concrete correctness, security, regression, and missing-test evidence as more important than style.",
    "Return exactly one JSON object with no Markdown or surrounding prose:",
    '{"verdict":"approve|request_changes","summary":"bounded summary","evidence":["concrete evidence"]}',
    "Approve only when the inspected change satisfies the task and the evidence supports it.",
    "",
    `Objective: ${task.description}`,
    `Review instructions: ${task.instructions}`,
    "Changed files:",
    ...task.changedFiles.map((file) => `- ${file}`),
  ].join("\n");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ToolError("invalid_input", "Review prompt is too large");
  }
  return prompt;
}

function completedRecord(
  index: number,
  result: ChildDelegationResult,
  verdict: AgentReviewVerdict,
): CompletedAgentReview {
  return {
    index,
    status: "completed",
    childAgentId: result.metadata.childAgentId,
    childSessionId: result.metadata.childSessionId,
    verdict: verdict.verdict,
    summary: verdict.summary,
    evidence: [...new Set([
      ...verdict.evidence,
      ...result.metadata.evidence,
    ])],
  };
}

export class AgentReviewPanel {
  constructor(private readonly dependencies: AgentReviewPanelDependencies) {}

  async run(
    rawTask: AgentReviewTask,
    context: ToolContext,
    options?: AgentReviewPanelRunOptions,
  ): Promise<AgentReviewPanelResult> {
    if (context.signal.aborted) {
      throw new ToolError("cancelled", "Review panel was cancelled");
    }
    if (context.executionMode !== "act") {
      throw new ToolError("plan_mode_denied", "Review panels require an Act parent");
    }
    const parent = await this.dependencies.sessions.loadState(context.sessionId);
    if (
      !isPinnedSessionState(parent) ||
      parent.cwd !== context.cwd ||
      parent.agent.role !== "parent"
    ) {
      throw new ToolError("tool_unavailable", "Parent agent session is unavailable");
    }
    const mode = getOperatingModePolicy(parent.agent.operatingMode.id);
    const team = mode.workflow.team;
    if (team === null) {
      throw new ToolError(
        "tool_unavailable",
        "This historical operating mode does not define a team review policy",
      );
    }
    const task = validateTask(rawTask);
    const reviews: AgentReviewRecord[] = [];
    let stop = false;

    const runReviewer = async (index: number): Promise<void> => {
      try {
        const result = await this.dependencies.children.delegate({
          profile: "review_v1",
          description: `Independent review ${index}`,
          prompt: reviewPrompt(
            task,
            team.qualityStandard,
            index,
            team.maxReviewers,
          ),
        }, context, options?.team === undefined
          ? undefined
          : {
              team: {
                id: options.team.id,
                index: options.team.indexOffset + index,
              },
            });
        try {
          reviews.push(completedRecord(
            index,
            result,
            parseAgentReviewVerdict(result.output),
          ));
        } catch (error) {
          if (!(error instanceof ToolError) || error.code !== "invalid_input") {
            throw error;
          }
          reviews.push({
            index,
            status: "invalid",
            childAgentId: result.metadata.childAgentId,
            childSessionId: result.metadata.childSessionId,
            error: {
              code: "invalid_review",
              message: "Reviewer output did not satisfy the verdict contract",
            },
          });
        }
      } catch (error) {
        if (error instanceof ToolError && error.code === "cancelled") {
          throw error;
        }
        const details = error instanceof ToolError
          ? { code: error.code, message: error.message }
          : { code: "execution_failed", message: "The review child failed" };
        reviews.push({ index, status: "failed", error: details });
        if (
          details.code === "permission_denied" ||
          details.code === "tool_unavailable" ||
          details.code === "plan_mode_denied"
        ) {
          stop = true;
        }
      }
    };

    for (let index = 1; index <= team.initialReviewers && !stop; index += 1) {
      await runReviewer(index);
    }
    const initialApproved = reviews.length === team.initialReviewers &&
      reviews.every((review) =>
        review.status === "completed" && review.verdict === "approve"
      );
    const escalated = !initialApproved && team.maxReviewers > team.initialReviewers;
    if (escalated) {
      for (
        let index = reviews.length + 1;
        index <= team.maxReviewers && !stop;
        index += 1
      ) {
        await runReviewer(index);
      }
    }
    const hasChangesRequested = reviews.some((review) =>
      review.status === "completed" && review.verdict === "request_changes"
    );
    const allApproved = reviews.length >= team.initialReviewers &&
      reviews.every((review) =>
        review.status === "completed" && review.verdict === "approve"
      );
    return {
      verdict: hasChangesRequested
        ? "changes_requested"
        : allApproved
          ? "approved"
          : "unverified",
      operatingModeId: mode.id,
      qualityStandard: team.qualityStandard,
      initialReviewers: team.initialReviewers,
      maxReviewers: team.maxReviewers,
      escalated,
      reviews,
      evidence: [...new Set(reviews.flatMap((review) =>
        review.status === "completed" ? review.evidence : []
      ))],
    };
  }
}
