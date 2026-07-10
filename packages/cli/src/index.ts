import { createFoundationCommands } from "./commands/foundation.js";
import { createGoalCommand } from "./commands/goal.js";
import { createPermissionsCommand } from "./commands/permissions.js";
import { createPlanCommand } from "./commands/plan.js";
import { CommandRegistry } from "./commands/registry.js";

export * from "./commands/foundation.js";
export * from "./commands/goal.js";
export * from "./commands/parser.js";
export * from "./commands/permissions.js";
export * from "./commands/plan.js";
export * from "./commands/registry.js";
export * from "./commands/types.js";

export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry([
    ...createFoundationCommands(),
    createGoalCommand(),
    createPlanCommand(),
    createPermissionsCommand(),
  ]);
}
