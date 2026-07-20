import { createAgentsCommand } from "./agents.js";
import { createFoundationCommands } from "./foundation.js";
import { createGoalCommand } from "./goal.js";
import { createPermissionsCommand } from "./permissions.js";
import { createPlanCommand } from "./plan.js";
import { createProcessCommand } from "./process.js";
import { createRepositoryCommands } from "./repository.js";
import { CommandRegistry } from "./registry.js";
import { createSessionCommands } from "./session.js";
import { createSkillsCommand } from "./skills.js";
import { createMcpCommand } from "./mcp.js";
import { createModelCommand } from "./model.js";
import type { CommandDependencies } from "./types.js";

export function createCommandRegistry(
  dependencies: CommandDependencies = {},
): CommandRegistry {
  return new CommandRegistry([
    ...createFoundationCommands(),
    ...createSessionCommands(dependencies),
    createModelCommand(dependencies),
    ...createRepositoryCommands(dependencies),
    createGoalCommand(),
    createPlanCommand(),
    createPermissionsCommand(),
    createProcessCommand(dependencies),
    createAgentsCommand(dependencies),
    ...(dependencies.skills === undefined
      ? []
      : [createSkillsCommand(dependencies.skills)]),
    ...(dependencies.mcp === undefined
      ? []
      : [createMcpCommand(dependencies.mcp)]),
  ]);
}
