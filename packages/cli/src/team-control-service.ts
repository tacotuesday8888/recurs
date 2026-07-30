import {
  effectiveTeamControlPolicy,
  parseTeamControlPolicyV1,
  recommendedTeamControlPolicy,
  validateTeamControlPolicyAgainstMode,
  type CompanyBlueprintV2,
  type EffectiveTeamControlPolicyV1,
  type OperatingModeId,
  type TeamControlPolicyV1,
} from "@recurs/contracts";
import type { FileTeamControlPolicyStore } from "@recurs/core";

export type TeamControlChanges = Partial<Pick<
  TeamControlPolicyV1,
  | "topology"
  | "maxActiveAgents"
  | "maxConcurrentAgents"
  | "maxDelegationDepth"
  | "escalation"
  | "independentReview"
  | "maxRepairRounds"
  | "maxRequests"
  | "maxReportedCostUsd"
>>;

export interface TeamControlSnapshot {
  readonly source: "recommended" | "saved";
  readonly compatible: boolean;
  readonly selected: TeamControlPolicyV1;
  readonly hardCeiling: TeamControlPolicyV1;
  readonly effective: EffectiveTeamControlPolicyV1 | null;
}

export class TeamControlService {
  constructor(private readonly store: Pick<
    FileTeamControlPolicyStore,
    "latest" | "publish"
  >) {}

  async inspect(input: {
    readonly workspace: string;
    readonly operatingModeId: OperatingModeId;
    readonly blueprint: CompanyBlueprintV2 | null;
    readonly signal?: AbortSignal;
  }): Promise<TeamControlSnapshot> {
    const saved = await this.store.latest(input.workspace, input.signal);
    const hardCeiling = recommendedTeamControlPolicy(input.operatingModeId);
    const selected = saved ?? hardCeiling;
    let compatible = true;
    try {
      validateTeamControlPolicyAgainstMode(selected, input.operatingModeId);
    } catch {
      compatible = false;
    }
    return Object.freeze({
      source: saved === null ? "recommended" : "saved",
      compatible,
      selected,
      hardCeiling,
      effective: compatible && input.blueprint !== null
        ? effectiveTeamControlPolicy(selected, input.blueprint)
        : null,
    });
  }

  async configure(input: {
    readonly workspace: string;
    readonly operatingModeId: OperatingModeId;
    readonly changes: TeamControlChanges;
    readonly signal?: AbortSignal;
  }): Promise<TeamControlPolicyV1> {
    const current = await this.store.latest(input.workspace, input.signal);
    const revision = (current?.revision ?? 0) + 1;
    const base = current?.operatingModeId === input.operatingModeId
      ? current
      : recommendedTeamControlPolicy(input.operatingModeId, revision);
    const policy = parseTeamControlPolicyV1({
      ...base,
      ...input.changes,
      revision,
      operatingModeId: input.operatingModeId,
      operatingModeVersion:
        recommendedTeamControlPolicy(input.operatingModeId).operatingModeVersion,
    });
    validateTeamControlPolicyAgainstMode(policy, input.operatingModeId);
    await this.store.publish(
      input.workspace,
      policy,
      current?.revision ?? null,
      input.signal,
    );
    return policy;
  }

  async ensureRecommended(
    workspace: string,
    operatingModeId: OperatingModeId,
    signal?: AbortSignal,
  ): Promise<TeamControlPolicyV1> {
    const current = await this.store.latest(workspace, signal);
    if (current?.operatingModeId === operatingModeId) return current;
    const policy = recommendedTeamControlPolicy(
      operatingModeId,
      (current?.revision ?? 0) + 1,
    );
    await this.store.publish(
      workspace,
      policy,
      current?.revision ?? null,
      signal,
    );
    return policy;
  }

  reset(
    workspace: string,
    operatingModeId: OperatingModeId,
    signal?: AbortSignal,
  ): Promise<TeamControlPolicyV1> {
    return this.configure({
      workspace,
      operatingModeId,
      changes: {},
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
