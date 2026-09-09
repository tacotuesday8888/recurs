import { deriveTrustedRunContext } from "@recurs/contracts";

import type { AgentSkillCatalog, AgentSkillSource } from "../agent-skills.js";
import { message, type Command } from "./types.js";

function canManageSkills(command: Parameters<Command["execute"]>[1]): boolean {
  try {
    const invocation = deriveTrustedRunContext(command.invocation);
    return invocation.presence === "present" && invocation.location === "local" &&
      invocation.automation === "manual" &&
      (invocation.embedding === "cli" || invocation.embedding === "desktop");
  } catch {
    return false;
  }
}

const USAGE = "/skills [list|inspect NAME|use NAME [task]|add PATH|install SOURCE|enable NAME|disable NAME|remove NAME|refresh|enable-project|disable-project] [--scope user|project]";

function parseArguments(input: string): { tokens: string[]; scope?: AgentSkillSource } {
  const tokens: string[] = [];
  let token = "";
  const text = input.trim();
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      const start = index;
      let closed = false;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === "\\") { index += 1; continue; }
        if (text[index] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error("Close the quote around the path or argument");
      token += JSON.parse(text.slice(start, index + 1)) as string;
    } else if (character === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) throw new Error("Close the quote around the path or argument");
      token += text.slice(index + 1, end);
      index = end;
    } else if (/\s/u.test(character)) {
      if (token) tokens.push(token);
      token = "";
    } else token += character;
  }
  if (token) tokens.push(token);
  const index = tokens.indexOf("--scope");
  if (index < 0) return { tokens };
  const scope = tokens[index + 1];
  if ((scope !== "user" && scope !== "project") || tokens.lastIndexOf("--scope") !== index) {
    throw new Error("--scope must be user or project and appear only once");
  }
  tokens.splice(index, 2);
  return { tokens, scope };
}

function renderSkills(catalog: AgentSkillCatalog): string {
  const snapshot = catalog.snapshot();
  const lines = snapshot.skills.length === 0
    ? ["No Agent Skills found. Add a local bundle with /skills add PATH."]
    : snapshot.skills.map((skill) =>
        `${skill.enabled ? "enabled " : "disabled"}  ${skill.name}  ${skill.description}  (${skill.source}: ${skill.location})`
      );
  lines.push("Precedence: trusted project > user; .recurs > .agents within each scope. Use --scope to select a duplicate name.");
  if (snapshot.skills.some((skill) => skill.source === "project")) {
    lines.push(
      snapshot.projectSkillsEnabled
        ? "Project skills are trusted for this Recurs process."
        : "Project skills are disabled. Run /skills enable-project in the local interactive CLI to trust them for this process.",
    );
  }
  if (snapshot.warnings.length > 0) lines.push("Warnings:", ...snapshot.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}

export function createSkillsCommand(catalog: AgentSkillCatalog): Command {
  return {
    name: "skills",
    description: "Add, install, inspect, invoke, enable, disable, or remove Agent Skills",
    usage: USAGE,
    async execute(args, context) {
      try {
        const { tokens, scope } = parseArguments(args);
        const action = (tokens.shift() ?? "list").toLowerCase();
        if (action === "list" && tokens.length === 0) return message(renderSkills(catalog));
        if (action === "inspect" && tokens.length === 1) {
          const skill = await catalog.inspect(tokens[0]!, scope);
          return message([
            `${skill.name} (${skill.source}, ${skill.enabled ? "enabled" : "disabled"})`,
            skill.description, `Source: ${skill.location}`,
            ...skill.diagnostics, `Resources: ${skill.resources.join(", ") || "none"}`,
            "Instructions:", skill.instructions,
          ].join("\n"));
        }
        if (action === "use" && tokens.length > 0) {
          const name = tokens.shift()!;
          const skill = await catalog.inspect(name, scope);
          if (!skill.enabled) return message(`Skill ${name} is disabled or shadowed. Enable it and, for project skills, trust the project first.`, "error");
          return { type: "submit_prompt", prompt: `Use the ${JSON.stringify(name)} Agent Skill. Load it with activate_skill before following its instructions.\n${tokens.join(" ")}` };
        }
        if (action === "disable-project" && tokens.length === 0) {
          catalog.setProjectEnabled(false);
          return message("Project skills are disabled for this Recurs process");
        }
        if (!canManageSkills(context)) {
          return message("Skill changes require a local, user-present interactive CLI or desktop session", "error");
        }
        if (action === "enable-project" && tokens.length === 0) {
          if (!catalog.hasProjectSkills) return message("No project Agent Skills were found", "warning");
          if (!(await context.confirm("Trust this workspace's project Agent Skills for the current Recurs process? Skill instructions can influence model behavior."))) {
            return message("Project skills remain disabled", "warning");
          }
          catalog.setProjectEnabled(true);
          return message(`Project skills enabled\n${renderSkills(catalog)}`);
        }
        if (action === "refresh" && tokens.length === 0) {
          await catalog.refresh();
          catalog.setProjectEnabled(false);
          return message(`Skills reloaded; project trust reset.\n${renderSkills(catalog)}`);
        }
        if ((action === "enable" || action === "disable") && tokens.length === 1) {
          await catalog.setEnabled(tokens[0]!, action === "enable", scope);
          return message(`Skill preference saved.\n${renderSkills(catalog)}`);
        }
        if (action === "remove" && tokens.length === 1) {
          const archived = await catalog.remove(tokens[0]!, scope);
          return message(`Skill removed from discovery; its files are preserved at ${archived}`);
        }
        if (action === "add" && tokens.length === 1) {
          const name = await catalog.add(tokens[0]!, scope ?? "user");
          return message(`Added ${name} to ${scope ?? "user"} scope. No scripts were executed.\n${renderSkills(catalog)}`);
        }
        if (action === "install" && tokens.length === 1) {
          const name = await catalog.install(tokens[0]!, scope ?? "user");
          return message(`Installed ${name} from the explicitly selected source. Direct HTTPS installs SKILL.md only; github:OWNER/REPO@REF:PATH installs the complete bounded bundle.\n${renderSkills(catalog)}`);
        }
        return message(USAGE, "error");
      } catch (error) {
        return message(error instanceof Error ? error.message : "Skill operation failed", "error");
      }
    },
  };
}
