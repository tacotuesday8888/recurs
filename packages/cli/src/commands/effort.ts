import { deriveTrustedRunContext, type ModelReasoningEffort } from "@recurs/contracts";
import { isPinnedSessionState } from "@recurs/core";
import { effortLabel } from "../terminal-effort.js";
import { message, type Command, type CommandDependencies } from "./types.js";

export function createEffortCommand(dependencies: CommandDependencies): Command {
  return {
    name: "effort", description: "Choose thinking effort", usage: "/effort [level]",
    async execute(args, context) {
      const invocation = deriveTrustedRunContext(context.invocation);
      if (invocation.presence !== "present" || invocation.location !== "local" || invocation.automation !== "manual" || !["cli", "desktop"].includes(invocation.embedding)) return message("Change effort in an interactive terminal", "error");
      const service = dependencies.models;
      if (!service?.efforts || !isPinnedSessionState(context.session)) return message("This connection does not expose effort selection. Use /model to choose a saved configuration.", "warning");
      const signal = dependencies.signal?.() ?? new AbortController().signal;
      const connectionId = context.session.backend.pin.connectionId;
      const current = context.session.backend.pin.reasoningEffortAtCreation;
      const supported = await service.efforts(connectionId, signal);
      if (!supported.length) return message("This connection does not expose effort selection. Use /model to choose a saved configuration.", "warning");
      let selected = args.trim();
      if (!selected && context.selectChoice) {
        const choice = await context.selectChoice("Thinking effort", supported.map((effort) => ({ id: effort, label: effortLabel(effort), current: effort === current, detail: `${context.session.model} · switching starts a new chat` })));
        if (choice === null) return message("Effort unchanged");
        selected = choice;
      }
      if (!selected) return message(`Thinking: ${current ?? "default"}\nAvailable: ${supported.join(", ")}\nUse /effort <level>`);
      if (!supported.includes(selected as ModelReasoningEffort)) return message(`Available efforts: ${supported.join(", ")}`, "error");
      if (selected === current) return message(`Thinking: ${selected}`);
      const expected = (await service.list(signal)).find((option) => option.connectionId === connectionId);
      if (!expected) return message("Connection no longer available", "error");
      if (!await context.confirm(`Start a new chat with ${context.session.model} · ${selected}? Your current chat is saved.`)) return message("Effort unchanged");
      const result = await service.create({ expected, reasoningEffort: selected as ModelReasoningEffort, current: context.session, at: context.now(), signal });
      if (result.status === "created") { context.session = result.session; return message(`Thinking: ${selected}`); }
      if (result.status === "unchanged") return message(`Thinking: ${selected}`);
      return message(`Could not change effort (${result.status}). Try /effort again.`, "error");
    },
  };
}
