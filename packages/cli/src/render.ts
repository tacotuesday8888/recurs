import { once } from "node:events";
import type { Writable } from "node:stream";

import type { EventSink, RecursEvent } from "@recurs/core";
import {
  getAgentProfilePolicy,
  type ModelReasoningEffort,
  type ProviderUsage,
} from "@recurs/contracts";

import type { CommandResult } from "./commands/types.js";
import {
  createTerminalTheme,
  type TerminalTheme,
  type TerminalThemeOptions,
} from "./terminal-style.js";

export async function writeOutput(
  output: Writable,
  text: string,
): Promise<void> {
  if (!output.write(text)) {
    await once(output, "drain");
  }
}

export class JsonlEventRenderer implements EventSink {
  constructor(private readonly output: Writable) {}

  readonly emit = async (event: RecursEvent): Promise<void> => {
    await writeOutput(this.output, `${JSON.stringify(event)}\n`);
  };
}

function modelLabel(
  modelId: string,
  effort: ModelReasoningEffort | null,
): string {
  return effort === null ? modelId : `${modelId} · ${effort}`;
}

function usageLabel(usage: ProviderUsage | null): string {
  if (usage === null) return "usage unavailable";
  const details = [
    `${usage.inputTokens} in`,
    `${usage.outputTokens} out`,
    ...(usage.cachedInputTokens === undefined
      ? []
      : [`${usage.cachedInputTokens} cached`]),
    ...(usage.reasoningTokens === undefined
      ? []
      : [`${usage.reasoningTokens} reasoning`]),
    ...(usage.costUsd === undefined
      ? []
      : [`$${usage.costUsd.toFixed(4)} reported`]),
  ];
  return details.join(" / ");
}

export class TextEventRenderer implements EventSink {
  #textLineOpen = false;
  readonly #theme: TerminalTheme;

  constructor(
    private readonly output: Writable,
    options: TerminalThemeOptions = {},
  ) {
    this.#theme = createTerminalTheme(output, options);
  }

  async #status(text: string): Promise<void> {
    const prefix = this.#textLineOpen ? "\n" : "";
    this.#textLineOpen = false;
    await writeOutput(this.output, `${prefix}${text}\n`);
  }

  readonly emit = async (event: RecursEvent): Promise<void> => {
    switch (event.type) {
      case "model_text_delta":
        this.#textLineOpen = true;
        await writeOutput(this.output, event.text);
        break;
      case "tool_started":
        await this.#status(this.#theme.accent(`→ ${event.call.name}`));
        break;
      case "tool_failed":
        await this.#status(
          this.#theme.failure(`✗ tool failed: ${event.error.message}`),
        );
        break;
      case "permission_requested":
        await this.#status(
          this.#theme.warning(
            `Permission requested: ${event.intent.category} ${event.intent.resource}`,
          ),
        );
        break;
      case "warning":
        await this.#status(this.#theme.warning(`Warning: ${event.message}`));
        break;
      case "retry_scheduled":
        await this.#status(
          this.#theme.warning(
            `Retry ${event.attempt} scheduled in ${event.delayMs}ms`,
          ),
        );
        break;
      case "provider_transport_fallback":
        await this.#status(
          this.#theme.warning(
            `Provider transport changed: ${event.from} → ${event.to}`,
          ),
        );
        break;
      case "turn_steered":
        await this.#status(this.#theme.accent("↪ Steering applied"));
        break;
      case "prompt_queued":
        await this.#status(this.#theme.accent("⇥ Next turn queued"));
        break;
      case "prompt_queue_cleared":
        await this.#status("Queued turns cleared");
        break;
      case "turn_completed":
      case "turn_cancelled":
      case "turn_failed":
        if (this.#textLineOpen) {
          this.#textLineOpen = false;
          await writeOutput(this.output, "\n");
        }
        break;
      case "files_changed":
        await this.#status(
          this.#theme.success(`Changed: ${event.paths.join(", ")}`),
        );
        break;
      case "verification_recorded":
        await this.#status(
          this.#theme.success(`Verified: ${event.evidence.join("; ")}`),
        );
        break;
      case "company_blueprint_activated":
        await this.#status(
          this.#theme.success(
            `Company ${event.blueprintId} activated: ${event.roleCount} approved role${event.roleCount === 1 ? "" : "s"}`,
          ),
        );
        break;
      case "company_blueprint_v2_activated":
        await this.#status(
          this.#theme.success(
            `Company activated: ${event.departmentCount} department${event.departmentCount === 1 ? "" : "s"} · ${event.roleCount} approved role${event.roleCount === 1 ? "" : "s"}`,
          ),
        );
        break;
      case "company_goal_started":
        await this.#status(
          this.#theme.accent(
            `⇶ Company goal ${event.goalRunId}: ${event.assignmentCount} assignment${event.assignmentCount === 1 ? "" : "s"} · ${event.operatingModeId}`,
          ),
        );
        break;
      case "company_assignment_started":
        await this.#status(
          this.#theme.accent(
            `↳ Activated ${event.roleName} · ${getAgentProfilePolicy(event.profileId).displayName}`,
          ),
        );
        break;
      case "company_handoff_completed":
        await this.#status(
          this.#theme.success(
            `✓ Company handoff ${event.assignmentId} · ${usageLabel(event.usage)}`,
          ),
        );
        break;
      case "company_handoff_failed":
      case "company_handoff_cancelled":
        await this.#status(
          this.#theme.failure(
            `✗ Company handoff ${event.assignmentId} ${event.status}: ${event.reason}`,
          ),
        );
        break;
      case "company_goal_completed":
        await this.#status(
          this.#theme.success(
            `✓ Company goal completed · ${event.workflow.requestsUsed}/${event.workflow.maxRequests} requests · $${event.workflow.reportedCostUsd.toFixed(4)}/$${event.workflow.maxReportedCostUsd.toFixed(4)} reported`,
          ),
        );
        break;
      case "company_goal_failed":
      case "company_goal_cancelled":
      case "company_goal_interrupted":
        await this.#status(
          this.#theme.failure(
            `✗ Company goal ${event.status}${event.reason === undefined ? "" : `: ${event.reason}`}`,
          ),
        );
        break;
      case "agent_team_activity":
        if (
          event.activity === "child_reserved" &&
          event.role !== undefined &&
          event.modelId !== undefined
        ) {
          await this.#status(
            this.#theme.accent(
              `↳ Activated ${event.role}${event.index === undefined ? "" : ` ${event.index}`} · ${modelLabel(event.modelId, event.reasoningEffort ?? null)}`,
            ),
          );
        } else if (
          event.activity === "child_finished" &&
          event.role !== undefined
        ) {
          await this.#status(
            this.#theme.success(
              `✓ ${event.role}${event.index === undefined ? "" : ` ${event.index}`} finished · ${event.counts.requestsUsed}/${event.counts.requestsReserved} requests`,
            ),
          );
        }
        break;
      case "agent_started":
        await this.#status(
          this.#theme.accent(
            `↳ ${getAgentProfilePolicy(event.profileId).displayName} child · ${modelLabel(event.modelId, event.reasoningEffort)}: ${event.description}`,
          ),
        );
        break;
      case "agent_batch_started":
        await this.#status(
          this.#theme.accent(
            `⇉ Agent batch ${event.batchId}: ${event.taskCount} tasks, up to ${event.maxConcurrentChildren} concurrent`,
          ),
        );
        break;
      case "agent_batch_completed":
        await this.#status(
          this.#theme.success(
            `✓ Agent batch ${event.batchId} completed: ${event.counts.completed}/${event.counts.total}`,
          ),
        );
        break;
      case "agent_batch_failed":
        await this.#status(
          this.#theme.failure(
            `✗ Agent batch ${event.batchId} ${event.partial ? "partially completed" : "failed"}: ${event.counts.completed} completed, ${event.counts.failed} failed${event.failure === undefined ? "" : ` — ${event.failure.message}`}`,
          ),
        );
        break;
      case "agent_batch_cancelled":
        await this.#status(
          this.#theme.failure(
            `✗ Agent batch ${event.batchId} cancelled: ${event.counts.completed} completed, ${event.counts.cancelled} cancelled`,
          ),
        );
        break;
      case "agent_team_started":
        await this.#status(
          this.#theme.accent(
            `⇶ Team ${event.teamId}: ${event.implementerCount} Implement worker${event.implementerCount === 1 ? "" : "s"} (${event.qualityStandard})`,
          ),
        );
        break;
      case "agent_team_patch_captured":
        await this.#status(
          this.#theme.accent(
            `↳ Team ${event.teamId} worker ${event.teamIndex} captured ${event.paths.length} file${event.paths.length === 1 ? "" : "s"}`,
          ),
        );
        break;
      case "agent_team_patches_integrated":
        await this.#status(
          this.#theme.accent(
            `⇢ Team ${event.teamId} integrated ${event.artifactIds.length} patch${event.artifactIds.length === 1 ? "" : "es"} across ${event.changedFiles.length} file${event.changedFiles.length === 1 ? "" : "s"}`,
          ),
        );
        break;
      case "agent_team_review_recorded":
        await this.#status(event.status === "completed"
          ? this.#theme.success(
            `✓ Team ${event.teamId} review ${event.reviewIndex}: ${event.verdict ?? "unverified"}${event.summary === undefined ? "" : ` — ${event.summary}`}`,
          )
          : this.#theme.failure(
            `✗ Team ${event.teamId} review ${event.reviewIndex}: ${event.status}${event.failure === undefined ? "" : ` — ${event.failure.message}`}`,
          ));
        break;
      case "agent_team_completed":
        await this.#status(
          this.#theme.success(
            `✓ Team ${event.teamId} ${event.status}: ${event.changedFiles.length} changed file${event.changedFiles.length === 1 ? "" : "s"} · ${event.workflow.requestsUsed}/${event.workflow.maxRequests} requests`,
          ),
        );
        break;
      case "agent_team_failed":
        await this.#status(
          this.#theme.failure(
            `✗ Team ${event.teamId} failed during ${event.phase}${event.partial ? " with workspace state requiring inspection" : ""}: ${event.failure.message}`,
          ),
        );
        break;
      case "agent_team_cancelled":
        await this.#status(
          this.#theme.failure(
            `✗ Team ${event.teamId} cancelled during ${event.phase}${event.partial ? " after integration" : ""}: ${event.reason}`,
          ),
        );
        break;
      case "agent_completed":
        await this.#status(
          this.#theme.success(
            `✓ ${getAgentProfilePolicy(event.profileId).displayName} child completed: ${event.childAgentId} · ${usageLabel(event.usage)} (${event.workflow.childrenStarted}/${event.workflow.maxChildren} this run)${event.costLimitExceeded ? " — reported-cost ceiling exceeded" : ""}`,
          ),
        );
        break;
      case "agent_failed":
        await this.#status(
          this.#theme.failure(
            `✗ ${getAgentProfilePolicy(event.profileId).displayName} child failed: ${event.failure.safeMessage}`,
          ),
        );
        break;
      case "agent_cancelled":
        await this.#status(
          this.#theme.failure(
            `✗ ${getAgentProfilePolicy(event.profileId).displayName} child cancelled: ${event.reason}`,
          ),
        );
        break;
      case "session_created":
      case "turn_started":
      case "model_reasoning_delta":
      case "model_completed":
      case "tool_requested":
      case "tool_completed":
      case "tool_denied":
      case "permission_resolved":
      case "goal_updated":
      case "mode_updated":
      case "agent_policy_updated":
        break;
    }
  };
}

export async function renderCommandResult(
  result: CommandResult,
  stdout: Writable,
  stderr: Writable,
): Promise<void> {
  if (result.type !== "message") {
    return;
  }
  const output = result.level === "error" ? stderr : stdout;
  const theme = createTerminalTheme(output);
  const text = result.level === "error"
    ? theme.failure(result.text)
    : result.level === "warning"
      ? theme.warning(result.text)
      : result.text;
  await writeOutput(output, `${text}\n`);
}
