import { createFoundationCommands } from "./commands/foundation.js";
import { createGoalCommand } from "./commands/goal.js";
import { createPermissionsCommand } from "./commands/permissions.js";
import { createPlanCommand } from "./commands/plan.js";
import { createRepositoryCommands } from "./commands/repository.js";
import { CommandRegistry } from "./commands/registry.js";
import { createSessionCommands } from "./commands/session.js";
import type { CommandDependencies } from "./commands/types.js";

export * from "./commands/foundation.js";
export * from "./commands/goal.js";
export * from "./commands/parser.js";
export * from "./commands/permissions.js";
export * from "./commands/plan.js";
export * from "./commands/registry.js";
export * from "./commands/repository.js";
export * from "./commands/session.js";
export * from "./commands/types.js";

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
  ]);
}
