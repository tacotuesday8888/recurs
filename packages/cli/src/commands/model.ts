import { deriveTrustedRunContext } from "@recurs/contracts";
import { isPinnedSessionState } from "@recurs/core";

import {
  message,
  type Command,
  type CommandDependencies,
  type ModelSelectionOption,
} from "./types.js";

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function renderLineup(
  lineup: readonly {
    readonly role: string;
    readonly modelId: string;
    readonly reasoningEffort: string | null;
  }[],
): string[] {
  return lineup.map((route) =>
    `${route.role.padEnd(9)} ${route.modelId}${
      route.reasoningEffort === null ? "" : ` · ${route.reasoningEffort}`
    }`
  );
}

async function executeAuto(
  args: string,
  dependencies: CommandDependencies,
  context: Parameters<Command["execute"]>[1],
): Promise<ReturnType<typeof message>> {
  const service = dependencies.modelTeams;
  if (service === undefined) {
    return message("Models Auto is unavailable for this runtime", "error");
  }
  if (!localManualInvocation(context.invocation)) {
    return message(
      "Models Auto requires a local, user-present, manual terminal",
      "error",
    );
  }
  const signal = dependencies.signal?.() ?? new AbortController().signal;
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const action = tokens[0] ?? "select";
  try {
    if (action === "status") {
      if (tokens.length !== 1) {
        return message("/model auto status takes no other arguments", "error");
      }
      const status = await service.status(signal);
      return status.selection === null
        ? message([
            "Models: Custom",
            "No evaluated model-team selection exists yet.",
            "Use /model auto evaluate <company-goal-run-id> after a real completed company goal.",
          ].join("\n"), "warning")
        : message([
            `Models: ${status.mode === "auto" ? "Auto" : "Custom"}`,
            ...renderLineup(status.selection.lineup),
            `Evidence: ${status.selection.evidenceIds.length} evaluated run(s)`,
            `Why: ${status.selection.rationale}`,
          ].join("\n"));
    }
    if (action === "evaluate") {
      const runId = tokens[1];
      if (
        tokens.length !== 2 ||
        runId === undefined ||
        !CONNECTION_ID.test(runId)
      ) {
        return message(
          "/model auto evaluate requires one exact company-goal run id",
          "error",
        );
      }
      const evaluation = await service.evaluate(runId, signal);
      return message([
        `Recorded model-team evidence ${evaluation.id}`,
        `Company goal: ${evaluation.companyGoalRunId}`,
        `Status: ${evaluation.report.status}`,
        ...renderLineup(evaluation.lineup),
        evaluation.report.status === "passed" ||
            evaluation.report.status === "partial"
          ? "Run /model auto to select the strongest eligible recorded lineup."
          : "This run is recorded for inspection but is not eligible for Auto.",
      ].join("\n"), evaluation.report.status === "failed" ? "warning" : "info");
    }
    if (action !== "select" || tokens.length > 1) {
      return message(
        "Usage: /model auto [status|evaluate <company-goal-run-id>]",
        "error",
      );
    }
    const status = await service.status(signal);
    if (status.mode === "auto" && status.selection !== null) {
      return message([
        "Models: Auto",
        ...renderLineup(status.selection.lineup),
        `Evidence: ${status.selection.evidenceIds.length} evaluated run(s)`,
        `Why: ${status.selection.rationale}`,
      ].join("\n"));
    }
    if (!await context.confirm(
      "Activate the strongest eligible model lineup from recorded company-goal evaluations for future sessions?",
    )) {
      return message("Models remain Custom", "warning");
    }
    const selection = await service.select(signal);
    return message([
      "Models: Auto",
      ...renderLineup(selection.lineup),
      `Evidence: ${selection.evidenceIds.length} evaluated run(s)`,
      `Why: ${selection.rationale}`,
      "The selected parent and specialist routes apply to future sessions and goals.",
    ].join("\n"));
  } catch (error) {
    return message(
      error instanceof Error ? error.message : "Models Auto failed safely",
      "error",
    );
  }
}

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
    `${option.execution} · billing: ${option.billingSources.join(", ")}${
      option.reasoningEffort === undefined
        ? ""
        : ` · effort: ${option.reasoningEffort}`
    }`,
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
    usage: "/model [connection-id|auto [status|evaluate <company-goal-run-id>]]",
    async execute(args, context) {
      const requested = args.trim();
      if (requested === "auto" || requested.startsWith("auto ")) {
        return await executeAuto(
          requested.slice("auto".length).trim(),
          dependencies,
          context,
        );
      }
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
        ...(selected.reasoningEffort === undefined
          ? []
          : [`Reasoning effort: ${selected.reasoningEffort}`]),
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
