import { deriveTrustedRunContext } from "@recurs/contracts";

import type { AgentSkillCatalog } from "../agent-skills.js";
import { message, type Command } from "./types.js";

function canTrustProjectSkills(command: Parameters<Command["execute"]>[1]): boolean {
  try {
    const invocation = deriveTrustedRunContext(command.invocation);
    return invocation.presence === "present" && invocation.location === "local" &&
      invocation.automation === "manual" &&
      (invocation.embedding === "cli" || invocation.embedding === "desktop");
  } catch {
    return false;
  }
}

function renderSkills(catalog: AgentSkillCatalog): string {
  const snapshot = catalog.snapshot();
  const lines = snapshot.skills.length === 0
    ? ["No Agent Skills found."]
    : snapshot.skills.map((skill) =>
        `${skill.enabled ? "enabled " : "disabled"}  ${skill.name}  ${skill.description}  (${skill.location})`
      );
  if (snapshot.skills.some((skill) => skill.source === "project")) {
    lines.push(
      snapshot.projectSkillsEnabled
        ? "Project skills are trusted for this Recurs process."
        : "Project skills are disabled. Run /skills enable-project in the local interactive CLI to trust them for this process.",
    );
  }
  if (snapshot.warnings.length > 0) {
    lines.push("Warnings:", ...snapshot.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

export function createSkillsCommand(catalog: AgentSkillCatalog): Command {
  return {
    name: "skills",
    description: "Inspect Agent Skills or trust project skills for this process",
    usage: "/skills [enable-project|disable-project]",
    async execute(args, context) {
      const action = args.trim().toLowerCase();
      if (action.length === 0 || action === "list") {
        return message(renderSkills(catalog));
      }
      if (action === "disable-project") {
        catalog.setProjectEnabled(false);
        return message("Project skills are disabled for this Recurs process");
      }
      if (action !== "enable-project") {
        return message(
          "Usage: /skills [enable-project|disable-project]",
          "error",
        );
      }
      if (!catalog.hasProjectSkills) {
        return message("No project Agent Skills were found", "warning");
      }
      if (!canTrustProjectSkills(context)) {
        return message(
          "Project skills can only be trusted from a local, user-present interactive CLI or desktop session",
          "error",
        );
      }
      if (!(await context.confirm(
        "Trust this workspace's project Agent Skills for the current Recurs process? Skill instructions can influence model behavior.",
      ))) {
        return message("Project skills remain disabled", "warning");
      }
      catalog.setProjectEnabled(true);
      return message(`Project skills enabled\n${renderSkills(catalog)}`);
    },
  };
}
