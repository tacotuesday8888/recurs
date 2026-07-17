import { once } from "node:events";
import type { Writable } from "node:stream";

import type { EventSink, RecursEvent } from "@recurs/core";

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
        await this.#status(`↳ child: ${event.description}`);
        break;
      case "agent_completed":
        await this.#status(`✓ child completed: ${event.childAgentId}`);
        break;
      case "agent_failed":
        await this.#status(`✗ child failed: ${event.failure.safeMessage}`);
        break;
      case "agent_cancelled":
        await this.#status(`✗ child cancelled: ${event.reason}`);
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
