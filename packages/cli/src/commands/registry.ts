import { parseCommand } from "./parser.js";
import {
  message,
  type Command,
  type CommandContext,
  type CommandResult,
  type ParsedCommand,
} from "./types.js";

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #canonical = new Map<string, Command>();

  constructor(commands: readonly Command[] = []) {
    for (const command of commands) {
      this.register(command);
    }
  }

  register(command: Command): void {
    const names = [command.name, ...(command.aliases ?? [])].map((name) =>
      name.toLowerCase(),
    );
    for (const name of names) {
      if (this.#commands.has(name)) {
        throw new Error(`Slash command is already registered: /${name}`);
      }
    }
    for (const name of names) {
      this.#commands.set(name, command);
    }
    this.#canonical.set(command.name, command);
  }

  list(): Command[] {
    return [...this.#canonical.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async execute(
    input: string | ParsedCommand,
    context: CommandContext,
  ): Promise<CommandResult> {
    const parsed = typeof input === "string" ? parseCommand(input) : input;
    if (parsed === null) {
      return message("Invalid slash command", "error");
    }
    const command = this.#commands.get(parsed.name);
    if (command === undefined) {
      return message(`Unknown command: /${parsed.name}`, "error");
    }
    try {
      return await command.execute(parsed.args, context);
    } catch (error) {
      return message(
        error instanceof Error ? error.message : "Command failed",
        "error",
      );
    }
  }
}
