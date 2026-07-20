import { deriveTrustedRunContext } from "@recurs/contracts";
import { isPinnedSessionState } from "@recurs/core";

import {
  message,
  type Command,
  type CommandDependencies,
  type ModelSelectionOption,
} from "./types.js";

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function localManualInvocation(
  invocation: Parameters<Command["execute"]>[1]["invocation"],
): boolean {
  try {
    const trusted = deriveTrustedRunContext(invocation);
    return trusted.presence === "present" && trusted.location === "local" &&
      trusted.automation === "manual" &&
      (trusted.embedding === "cli" || trusted.embedding === "desktop");
  } catch {
    return false;
  }
}

function currentConnectionId(
  session: Parameters<Command["execute"]>[1]["session"],
): string | null {
  return isPinnedSessionState(session)
    ? session.backend.pin.connectionId
    : null;
}

function renderOption(
  option: ModelSelectionOption,
  activeConnectionId: string | null,
): string {
  const flags = [
    option.connectionId === activeConnectionId ? "active" : null,
    option.primary ? "primary" : null,
  ].filter((flag): flag is string => flag !== null);
  return [
    option.connectionId,
    `${option.label} · ${option.providerId}/${option.modelId}`,
    `${option.execution} · billing: ${option.billingSources.join(", ")}`,
    ...(flags.length === 0 ? [] : [`[${flags.join(", ")}]`]),
  ].join("  ");
}

function currentSummary(
  session: Parameters<Command["execute"]>[1]["session"],
): string {
  return isPinnedSessionState(session)
    ? `Current: ${session.backend.pin.providerId}/${session.model}  ${session.backend.pin.connectionId}`
    : "Current: no active model session";
}

export function createModelCommand(dependencies: CommandDependencies): Command {
  return {
    name: "model",
    description: "List saved models or start a fresh pinned session",
    usage: "/model [connection-id]",
    async execute(args, context) {
      const requested = args.trim();
      if (requested.length > 0 && !CONNECTION_ID.test(requested)) {
        return message("/model requires one exact saved connection id", "error");
      }
      if (dependencies.models === undefined) {
        return message([
          currentSummary(context.session),
          "Saved model switching is unavailable for this injected or ephemeral connection",
        ].join("\n"), requested.length === 0 ? "info" : "error");
      }

      const signal = dependencies.signal?.() ?? new AbortController().signal;
      let options: readonly ModelSelectionOption[];
      try {
        options = await dependencies.models.list(signal);
      } catch {
        return message("Saved model connections could not be loaded", "error");
      }
      if (requested.length === 0) {
        return options.length === 0
          ? message([
              currentSummary(context.session),
              "No saved model connections. Use /provider to connect one.",
            ].join("\n"), "warning")
          : message([
              currentSummary(context.session),
              "Saved model connections:",
              ...options.map((option) =>
                renderOption(option, currentConnectionId(context.session))
              ),
              "Use /model <exact-connection-id> to start a fresh pinned session.",
            ].join("\n"));
      }
      if (!localManualInvocation(context.invocation)) {
        return message(
          "Model switching requires a local, user-present, manual terminal",
          "error",
        );
      }
      const selected = options.find((option) =>
        option.connectionId === requested
      );
      if (selected === undefined) {
        return message("Saved model connection not found", "error");
      }
      if (!await context.confirm([
        `Start a fresh session with ${selected.providerId}/${selected.modelId}?`,
        `Connection: ${selected.connectionId}`,
        `Billing: ${selected.billingSources.join(", ")}`,
        "The current session and primary connection will remain unchanged.",
      ].join("\n"))) {
        return message("Model unchanged", "warning");
      }

      const created = await dependencies.models.create({
        expected: selected,
        current: context.session,
        at: context.now(),
        signal,
      });
      switch (created.status) {
        case "created":
          context.session = created.session;
          return message([
            `Started session ${created.session.id}`,
            `Model: ${created.session.backend.pin.providerId}/${created.session.model}`,
            `Connection: ${created.session.backend.pin.connectionId}`,
            "The previous session remains available through /resume.",
          ].join("\n"));
        case "unchanged":
          return message("That exact model connection is already active", "warning");
        case "not_found":
          return message("Saved model connection no longer exists", "error");
        case "changed":
          return message(
            "Saved model connection changed while it was selected; run /model again",
            "error",
          );
        case "unavailable":
          return message(
            "Saved model connection is not ready; verify its local server, credential environment variable, or delegated login",
            "error",
          );
        case "cancelled":
          return message("Model switch cancelled", "warning");
        case "failed":
          return message("A fresh model session could not be created", "error");
      }
    },
  };
}
