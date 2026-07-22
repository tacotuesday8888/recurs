import { deriveTrustedRunContext } from "@recurs/contracts";
import {
  isPinnedSessionState,
  type PinnedSessionState,
  type SequencedCompanyState,
} from "@recurs/core";
import type {
  CompanyAmendmentV1,
  CompanyBlueprintBindingV2,
  CompanyBlueprintV2,
  CompanyGoalRunV1,
  CompanyToolBundleId,
} from "@recurs/contracts";

import {
  diffCompanyBlueprints,
  renderCompanyBlueprintYaml,
} from "../company-blueprint-yaml.js";
import {
  companyToolReadinessCounts,
  renderCompanyToolReadiness,
} from "../company-tool-readiness.js";
import { CompanyCapabilityAuthorityError } from "../company-capability-authority.js";
import {
  renderCompanyGoalRun,
  renderCompanyOperations,
} from "../company-operating-view.js";
import {
  message,
  type Command,
  type CommandContext,
  type CommandDependencies,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const USAGE = "/company [blueprint|readiness|capabilities|bind <bundle> <skill|mcp> <id>|unbind <binding-id>|operations|run <run-id>|activity|knowledge|amendments|amendment <id>|approve-amendment <id>|reject-amendment <id>]";

class CompanyCommandPolicyError extends Error {}

function oneLine(value: string, maximum = 180): string {
  const normalized = [...value].map((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point >= 127 && point <= 159 ? " " : character;
  }).join("").replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1)}…`;
}

async function authority(
  context: CommandContext,
  dependencies: NonNullable<CommandDependencies["company"]>,
  signal: AbortSignal,
): Promise<{
  readonly session: PinnedSessionState;
  readonly blueprint: CompanyBlueprintV2;
  readonly binding: CompanyBlueprintBindingV2;
}> {
  const session = context.session;
  if (!isPinnedSessionState(session) || session.agent.role !== "parent") {
    throw new CompanyCommandPolicyError("No approved V2 company is active");
  }
  const binding = session.agent.company;
  if (binding?.blueprintVersion !== 2) {
    throw new CompanyCommandPolicyError("No approved V2 company is active");
  }
  const blueprint = await dependencies.blueprints.load(binding.blueprintId, signal);
  if (blueprint.state !== "approved" || blueprint.revision !==
      binding.blueprintRevision || blueprint.authorityAnchors.rootRoleId !==
      binding.roleId || blueprint.authority.operatingModeId !==
      session.agent.operatingMode.id || blueprint.authority.permissionMode !==
      session.permissionMode) {
    throw new CompanyCommandPolicyError("The active company authority is stale");
  }
  return { session, blueprint, binding };
}

function companyRuns(
  values: readonly SequencedCompanyState<CompanyGoalRunV1>[],
  session: PinnedSessionState,
  blueprint: CompanyBlueprintV2,
): readonly CompanyGoalRunV1[] {
  return values.map((value) => value.state).filter((run) =>
    run.parentSessionId === session.id &&
    run.company.blueprintId === blueprint.id &&
    run.company.blueprintRevision === blueprint.revision
  ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function statusText(
  blueprint: CompanyBlueprintV2,
  runs: readonly CompanyGoalRunV1[],
  readiness = companyToolReadinessCounts(blueprint),
): string {
  const active = runs.filter((run) =>
    run.status === "created" || run.status === "running" ||
    run.status === "waiting_for_approval" || run.status === "interrupted"
  ).length;
  return [
    `Company: ${blueprint.companyId}`,
    `Blueprint: ${blueprint.id} (revision ${blueprint.revision})`,
    `Design: ${blueprint.designMode}`,
    `Onboarding: ${blueprint.provenance.depth}`,
    `Mode: ${blueprint.authority.operatingModeId}`,
    `Departments: ${blueprint.departments.length}`,
    `Roles: ${blueprint.roles.length}`,
    `Tool bundles: ${readiness.ready} ready, ${readiness.missing} missing`,
    `Goal runs: ${runs.length} total, ${active} active or interrupted`,
  ].join("\n");
}

function activityText(
  blueprint: CompanyBlueprintV2,
  runs: readonly CompanyGoalRunV1[],
): string {
  if (runs.length === 0) return "No company goal activity exists for this session";
  const roles = new Map(blueprint.roles.map((role) => [role.id, role.displayName]));
  return runs.slice(0, 20).flatMap((run) => [
    `${run.status} | ${run.id} | ${oneLine(run.objective)} | ${run.updatedAt}`,
    ...run.plan.assignments.map((assignment) =>
      `  ${assignment.status} | ${roles.get(assignment.roleId) ?? assignment.roleId} | ${assignment.id}`
    ),
  ]).join("\n");
}

function amendmentsText(amendments: readonly CompanyAmendmentV1[]): string {
  if (amendments.length === 0) return "No company amendments exist";
  return [...amendments].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  ).slice(0, 50).map((amendment) => [
    amendment.state,
    amendment.id,
    `base r${amendment.baseBlueprintRevision}`,
    oneLine(amendment.reason),
  ].join(" | ")).join("\n");
}

function exactDecision(args: string): {
  readonly action: "approve" | "reject";
  readonly amendmentId: string;
} | null {
  const match = /^(approve-amendment|reject-amendment)\s+(\S+)$/u.exec(args);
  if (match === null || !SAFE_ID.test(match[2]!)) return null;
  return {
    action: match[1] === "approve-amendment" ? "approve" : "reject",
    amendmentId: match[2]!,
  };
}

function exactAmendment(args: string): string | null {
  const match = /^amendment\s+(\S+)$/u.exec(args);
  return match !== null && SAFE_ID.test(match[1]!) ? match[1]! : null;
}

function exactRun(args: string): string | null {
  const match = /^run\s+(\S+)$/u.exec(args);
  return match !== null && SAFE_ID.test(match[1]!) ? match[1]! : null;
}

function exactCapabilityMutation(args: string):
  | {
      readonly action: "bind";
      readonly bundleId: CompanyToolBundleId;
      readonly type: "agent_skill" | "mcp_server";
      readonly sourceId: string;
    }
  | { readonly action: "unbind"; readonly bindingId: string }
  | null {
  const unbind = /^unbind\s+(\S+)$/u.exec(args);
  if (unbind !== null && SAFE_ID.test(unbind[1]!)) {
    return { action: "unbind", bindingId: unbind[1]! };
  }
  const bind = /^bind\s+(\S+)\s+(skill|mcp)\s+(\S+)$/u.exec(args);
  const bundles = new Set<string>([
    "project_context_v1", "source_control_v1", "architecture_v1",
    "implementation_v1", "quality_v1", "security_v1", "release_v1",
  ]);
  if (bind === null || !bundles.has(bind[1]!) || !SAFE_ID.test(bind[3]!)) {
    return null;
  }
  return {
    action: "bind",
    bundleId: bind[1] as CompanyToolBundleId,
    type: bind[2] === "skill" ? "agent_skill" : "mcp_server",
    sourceId: bind[3]!,
  };
}

function localManual(context: CommandContext): boolean {
  const invocation = deriveTrustedRunContext(context.invocation);
  return invocation.invocation === "repl" && invocation.presence === "present" &&
    invocation.location === "local" && invocation.automation === "manual";
}

function amendmentText(
  amendment: CompanyAmendmentV1,
  base: CompanyBlueprintV2,
): string {
  const changes = diffCompanyBlueprints(base, amendment.proposedBlueprint)
    .slice(0, 100);
  return [
    `Amendment: ${amendment.id}`,
    `State: ${amendment.state}`,
    `Base: ${amendment.baseBlueprintId} (revision ${amendment.baseBlueprintRevision})`,
    `Proposed: ${amendment.proposedBlueprint.id} (revision ${amendment.proposedBlueprint.revision})`,
    `Reason: ${oneLine(amendment.reason, 500)}`,
    ...(amendment.decisionReason === null
      ? []
      : [`Decision: ${oneLine(amendment.decisionReason, 500)}`]),
    "Changes:",
    ...(changes.length === 0 ? ["  No structural changes"] : changes.map((change) =>
      `  - ${oneLine(change, 500)}`
    )),
  ].join("\n");
}

export function createCompanyCommand(dependencies: CommandDependencies): Command {
  const company = dependencies.company!;
  const signal = () => dependencies.signal?.() ?? new AbortController().signal;
  return {
    name: "company",
    description: "Inspect the active company and review controlled amendments",
    usage: USAGE,
    async execute(args, context) {
      const currentSignal = signal();
      let active;
      try {
        active = await authority(context, company, currentSignal);
      } catch (error) {
        if (error instanceof CompanyCommandPolicyError) {
          return message(error.message, "error");
        }
        throw error;
      }
      const action = args.trim();
      const capabilitySet = company.capabilities?.bindings(active.blueprint) ?? null;
      const capabilityCatalogs = {
        ...(dependencies.skills === undefined
          ? {}
          : { skills: dependencies.skills.snapshot() }),
        ...(dependencies.mcp === undefined
          ? {}
          : { mcp: dependencies.mcp.snapshot() }),
      };
      if (action === "" || action === "status") {
        return message(statusText(
          active.blueprint,
          companyRuns(await company.goals.list(currentSignal), active.session, active.blueprint),
          companyToolReadinessCounts(
            active.blueprint,
            capabilityCatalogs,
            capabilitySet,
          ),
        ));
      }
      if (action === "blueprint") {
        return message(renderCompanyBlueprintYaml(active.blueprint));
      }
      if (action === "readiness") {
        return message(renderCompanyToolReadiness(
          active.blueprint,
          capabilityCatalogs,
          capabilitySet,
        ));
      }
      if (action === "capabilities") {
        return message(renderCompanyToolReadiness(
          active.blueprint,
          capabilityCatalogs,
          capabilitySet,
        ));
      }
      if (action === "activity") {
        return message(activityText(
          active.blueprint,
          companyRuns(await company.goals.list(currentSignal), active.session, active.blueprint),
        ));
      }
      if (action === "operations") {
        return message(renderCompanyOperations(
          active.blueprint,
          companyRuns(
            await company.goals.list(currentSignal),
            active.session,
            active.blueprint,
          ),
        ));
      }
      const runId = exactRun(action);
      if (runId !== null) {
        const run = companyRuns(
          await company.goals.list(currentSignal),
          active.session,
          active.blueprint,
        ).find((candidate) => candidate.id === runId);
        return run === undefined
          ? message(`Company goal run not found: ${runId}`, "error")
          : message(renderCompanyGoalRun(active.blueprint, run));
      }
      if (action === "knowledge") {
        const knowledge = await company.knowledge.latest(
          active.blueprint.companyId,
          currentSignal,
        );
        return message(knowledge === null || knowledge.entries.length === 0
          ? "No attributable company knowledge exists"
          : knowledge.entries.slice(-50).map((entry) => [
              entry.kind,
              entry.confidence,
              oneLine(entry.statement),
              `${entry.source.type}:${entry.source.id}`,
            ].join(" | ")).join("\n"));
      }
      if (action === "amendments") {
        return message(amendmentsText(await company.amendments.list(
          active.blueprint.companyId,
          currentSignal,
        )));
      }
      const amendmentId = exactAmendment(action);
      if (amendmentId !== null) {
        const amendment = (await company.amendments.list(
          active.blueprint.companyId,
          currentSignal,
        )).find((candidate) => candidate.id === amendmentId);
        if (amendment === undefined) {
          return message(`Company amendment not found: ${amendmentId}`, "error");
        }
        const base = await company.blueprints.load(
          amendment.baseBlueprintId,
          currentSignal,
        );
        if (base.companyId !== active.blueprint.companyId ||
          base.id !== amendment.baseBlueprintId ||
          base.revision !== amendment.baseBlueprintRevision ||
          base.state !== "approved") {
          return message("Company amendment history is invalid", "error");
        }
        return message(amendmentText(amendment, base));
      }
      const capabilityMutation = exactCapabilityMutation(action);
      if (capabilityMutation !== null) {
        if (company.capabilities === undefined) {
          return message("Company capability approval is unavailable", "error");
        }
        if (!localManual(context)) {
          return message(
            "Company capability changes require a local, manual, user-present CLI session",
            "error",
          );
        }
        const description = capabilityMutation.action === "bind"
          ? `Bind ${capabilityMutation.type}:${capabilityMutation.sourceId} to ${capabilityMutation.bundleId}`
          : `Remove company capability binding ${capabilityMutation.bindingId}`;
        if (!await context.confirm(
          `${description}? This does not install, trust, or widen the role's existing permissions.`,
        )) {
          return message("Company capabilities were left unchanged", "warning");
        }
        try {
          const set = capabilityMutation.action === "bind"
            ? await company.capabilities.bind({
                blueprint: active.blueprint,
                bundleId: capabilityMutation.bundleId,
                type: capabilityMutation.type,
                sourceId: capabilityMutation.sourceId,
                at: context.now(),
                signal: currentSignal,
              })
            : await company.capabilities.unbind({
                blueprint: active.blueprint,
                bindingId: capabilityMutation.bindingId,
                at: context.now(),
                signal: currentSignal,
              });
          return message(
            `Company capability bindings updated to revision ${set.revision}`,
          );
        } catch (error) {
          if (error instanceof CompanyCapabilityAuthorityError) {
            return message(error.message, "error");
          }
          throw error;
        }
      }
      const decision = exactDecision(action);
      if (decision === null) return message(`Usage: ${USAGE}`, "error");
      if (company.decisions === undefined) {
        return message("Company amendment decisions are unavailable", "error");
      }
      if (!localManual(context)) {
        return message(
          "Company amendment decisions require a local, manual, user-present CLI session",
          "error",
        );
      }
      const amendment = (await company.amendments.list(
        active.blueprint.companyId,
        currentSignal,
      )).find((candidate) => candidate.id === decision.amendmentId);
      if (amendment === undefined) {
        return message(
          `Company amendment not found: ${decision.amendmentId}`,
          "error",
        );
      }
      if (amendment.baseBlueprintId !== active.binding.blueprintId ||
        amendment.baseBlueprintRevision !== active.binding.blueprintRevision) {
        return message(
          "The amendment does not target this session's immutable company revision",
          "error",
        );
      }
      const verb = decision.action === "approve" ? "Approve" : "Reject";
      const changes = diffCompanyBlueprints(
        active.blueprint,
        amendment.proposedBlueprint,
      ).slice(0, 10).map((change) => oneLine(change)).join("; ") ||
        "no structural changes";
      if (!await context.confirm(
        `${verb} company amendment ${decision.amendmentId} for future goals? Reason: ${oneLine(amendment.reason, 500)} Changes: ${changes}`,
      )) {
        return message("Company amendment was left unchanged", "warning");
      }
      const input = {
        amendmentId: decision.amendmentId,
        company: active.binding,
        at: context.now(),
        decisionReason: decision.action === "approve"
          ? "Approved through the local /company command"
          : "Rejected through the local /company command",
        signal: currentSignal,
      };
      if (decision.action === "approve") {
        const approved = await company.decisions.approve(input);
        return message(
          `Approved ${approved.amendment.id}; blueprint ${approved.blueprint.id} revision ${approved.blueprint.revision} applies to future goals`,
        );
      }
      const rejected = await company.decisions.reject(input);
      return message(`Rejected ${rejected.amendment.id}; the company is unchanged`);
    },
  };
}
