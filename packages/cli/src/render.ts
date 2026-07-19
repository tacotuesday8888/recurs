import { once } from "node:events";
import type { Writable } from "node:stream";

import type { EventSink, RecursEvent } from "@recurs/core";
import { getAgentProfilePolicy } from "@recurs/contracts";

import type { CommandResult } from "./commands/types.js";

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

export class TextEventRenderer implements EventSink {
  #textLineOpen = false;

  constructor(private readonly output: Writable) {}

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
        await this.#status(`→ ${event.call.name}`);
        break;
      case "tool_failed":
        await this.#status(`✗ tool failed: ${event.error.message}`);
        break;
      case "permission_requested":
        await this.#status(
          `Permission requested: ${event.intent.category} ${event.intent.resource}`,
        );
        break;
      case "warning":
        await this.#status(`Warning: ${event.message}`);
        break;
      case "retry_scheduled":
        await this.#status(
          `Retry ${event.attempt} scheduled in ${event.delayMs}ms`,
        );
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
        await this.#status(`Changed: ${event.paths.join(", ")}`);
        break;
      case "verification_recorded":
        await this.#status(`Verified: ${event.evidence.join("; ")}`);
        break;
      case "agent_started":
        await this.#status(
          `↳ ${getAgentProfilePolicy(event.profileId).displayName} child: ${event.description}`,
        );
        break;
      case "agent_batch_started":
        await this.#status(
          `⇉ Agent batch ${event.batchId}: ${event.taskCount} tasks, up to ${event.maxConcurrentChildren} concurrent`,
        );
        break;
      case "agent_batch_completed":
        await this.#status(
          `✓ Agent batch ${event.batchId} completed: ${event.counts.completed}/${event.counts.total}`,
        );
        break;
      case "agent_batch_failed":
        await this.#status(
          `✗ Agent batch ${event.batchId} ${event.partial ? "partially completed" : "failed"}: ${event.counts.completed} completed, ${event.counts.failed} failed${event.failure === undefined ? "" : ` — ${event.failure.message}`}`,
        );
        break;
      case "agent_batch_cancelled":
        await this.#status(
          `✗ Agent batch ${event.batchId} cancelled: ${event.counts.completed} completed, ${event.counts.cancelled} cancelled`,
        );
        break;
      case "agent_team_started":
        await this.#status(
          `⇶ Team ${event.teamId}: ${event.implementerCount} Implement worker${event.implementerCount === 1 ? "" : "s"} (${event.qualityStandard})`,
        );
        break;
      case "agent_team_patch_captured":
        await this.#status(
          `↳ Team ${event.teamId} worker ${event.teamIndex} captured ${event.paths.length} file${event.paths.length === 1 ? "" : "s"}`,
        );
        break;
      case "agent_team_patches_integrated":
        await this.#status(
          `⇢ Team ${event.teamId} integrated ${event.artifactIds.length} patch${event.artifactIds.length === 1 ? "" : "es"} across ${event.changedFiles.length} file${event.changedFiles.length === 1 ? "" : "s"}`,
        );
        break;
      case "agent_team_review_recorded":
        await this.#status(event.status === "completed"
          ? `✓ Team ${event.teamId} review ${event.reviewIndex}: ${event.verdict ?? "unverified"}${event.summary === undefined ? "" : ` — ${event.summary}`}`
          : `✗ Team ${event.teamId} review ${event.reviewIndex}: ${event.status}${event.failure === undefined ? "" : ` — ${event.failure.message}`}`);
        break;
      case "agent_team_completed":
        await this.#status(
          `✓ Team ${event.teamId} ${event.status}: ${event.changedFiles.length} changed file${event.changedFiles.length === 1 ? "" : "s"}`,
        );
        break;
      case "agent_team_failed":
        await this.#status(
          `✗ Team ${event.teamId} failed during ${event.phase}${event.partial ? " with workspace state requiring inspection" : ""}: ${event.failure.message}`,
        );
        break;
      case "agent_team_cancelled":
        await this.#status(
          `✗ Team ${event.teamId} cancelled during ${event.phase}${event.partial ? " after integration" : ""}: ${event.reason}`,
        );
        break;
      case "agent_completed":
        await this.#status(
          `✓ ${getAgentProfilePolicy(event.profileId).displayName} child completed: ${event.childAgentId} (${event.workflow.childrenStarted}/${event.workflow.maxChildren} this run)${event.costLimitExceeded ? " — reported-cost ceiling exceeded" : ""}`,
        );
        break;
      case "agent_failed":
        await this.#status(
          `✗ ${getAgentProfilePolicy(event.profileId).displayName} child failed: ${event.failure.safeMessage}`,
        );
        break;
      case "agent_cancelled":
        await this.#status(
          `✗ ${getAgentProfilePolicy(event.profileId).displayName} child cancelled: ${event.reason}`,
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
  await writeOutput(output, `${result.text}\n`);
}
