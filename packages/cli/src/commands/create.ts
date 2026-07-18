import { createAgentsCommand } from "./agents.js";
import { createFoundationCommands } from "./foundation.js";
import { createGoalCommand } from "./goal.js";
import { createPermissionsCommand } from "./permissions.js";
import { createPlanCommand } from "./plan.js";
import { createRepositoryCommands } from "./repository.js";
import { CommandRegistry } from "./registry.js";
import { createSessionCommands } from "./session.js";
import type { CommandDependencies } from "./types.js";

export function createCommandRegistry(
  dependencies: CommandDependencies = {},
): CommandRegistry {
  return new CommandRegistry([
    ...createFoundationCommands(),
    ...createSessionCommands(dependencies),
    ...createRepositoryCommands(dependencies),
    createGoalCommand(),
    createPlanCommand(),
    createPermissionsCommand(),
    createAgentsCommand(dependencies),
  ]);
}
