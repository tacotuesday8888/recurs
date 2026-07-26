import type {
  AgentRuntime,
  AgentRuntimeEvent,
  ProviderUsage,
} from "@recurs/contracts";
import type {
  ModelProvider,
  ProviderEvent,
  ProviderRequest,
} from "@recurs/providers";

import type { RecursEvent } from "./events.js";
import type {
  CompanyBenchmarkExecutionAllowance,
  CompanyBenchmarkProviderRequest,
} from "./company-benchmark-runner.js";

export type CompanyBenchmarkObservedRole =
  | "parent"
  | "implement"
  | "review"
  | "repair";

export interface CompanyBenchmarkRequestObservation {
  readonly role: CompanyBenchmarkObservedRole;
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly status: "completed" | "failed" | "cancelled";
  readonly usage: ProviderUsage | null;
}

export interface CompanyBenchmarkAttemptObservation {
  readonly role: CompanyBenchmarkObservedRole;
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly status: "completed" | "failed" | "cancelled";
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
}

export interface CompanyBenchmarkInterventionObservation {
  readonly externalConfirmationRequests: number;
  readonly userInputRequests: number;
  readonly automaticApprovals: number;
  readonly automaticDenials: number;
}

export interface CompanyBenchmarkRecorderSnapshot {
  readonly requests: readonly CompanyBenchmarkRequestObservation[];
  readonly attempts: readonly CompanyBenchmarkAttemptObservation[];
  readonly interventions: CompanyBenchmarkInterventionObservation;
}

interface MutableAttempt {
  readonly role: CompanyBenchmarkObservedRole;
  readonly sessionId: string;
  readonly startedAtMs: number;
  completedAtMs: number | null;
  status: "running" | "completed" | "failed" | "cancelled";
  changedFiles: readonly string[];
  evidence: readonly string[];
}

interface BenchmarkRequestSettlement {
  readonly reservation: CompanyBenchmarkProviderRequest;
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly status: "completed" | "failed" | "cancelled";
  readonly usage: ProviderUsage | null;
}

function addUsage(
  current: ProviderUsage | null,
  next: ProviderUsage,
): ProviderUsage {
  const optional = (
    key: "cachedInputTokens" | "cacheWriteInputTokens" | "reasoningTokens",
  ) => current?.[key] === undefined && next[key] === undefined
    ? undefined
    : (current?.[key] ?? 0) + (next[key] ?? 0);
  const costUsd = current?.costUsd === undefined && next.costUsd === undefined
    ? undefined
    : (current?.costUsd ?? 0) + (next.costUsd ?? 0);
  const cachedInputTokens = optional("cachedInputTokens");
  const cacheWriteInputTokens = optional("cacheWriteInputTokens");
  const reasoningTokens = optional("reasoningTokens");
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function eventUsage(event: ProviderEvent | AgentRuntimeEvent): ProviderUsage | null {
  if (event.type !== "usage") return null;
  if ("usage" in event) return event.usage;
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: event.cachedInputTokens }),
    ...(event.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: event.cacheWriteInputTokens }),
    ...(event.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: event.reasoningTokens }),
    ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
  };
}

function roleForProfile(
  profileId: Extract<RecursEvent, { type: "agent_started" }>["profileId"],
): CompanyBenchmarkObservedRole | null {
  if (profileId === "implement_v1" || profileId === "implement_v2") {
    return "implement";
  }
  if (profileId === "review_v1" || profileId === "review_v2") return "review";
  if (profileId === "repair_v1") return "repair";
  return null;
}

function terminalStatus(
  event: Extract<
    RecursEvent,
    { type: "agent_completed" | "agent_failed" | "agent_cancelled" }
  >,
): "completed" | "failed" | "cancelled" {
  return event.type === "agent_completed"
    ? "completed"
    : event.type === "agent_failed" ? "failed" : "cancelled";
}

function eventTime(at: string, fallback: number): number {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Records only bounded execution metadata. Prompts, model text, tool payloads,
 * environment values, and approval prose are intentionally excluded.
 */
export class CompanyBenchmarkExecutionRecorder {
  readonly #allowance: CompanyBenchmarkExecutionAllowance;
  readonly #maximumReportedCostPerRequestUsd: number;
  readonly #nowMs: () => number;
  readonly #sessionRoles = new Map<string, CompanyBenchmarkObservedRole>();
  readonly #attempts = new Map<string, MutableAttempt>();
  readonly #requests: CompanyBenchmarkRequestObservation[] = [];
  #externalConfirmationRequests = 0;
  #userInputRequests = 0;
  #automaticApprovals = 0;
  #automaticDenials = 0;

  constructor(input: {
    readonly allowance: CompanyBenchmarkExecutionAllowance;
    readonly maximumReportedCostPerRequestUsd: number;
    readonly nowMs?: () => number;
  }) {
    if (!Number.isFinite(input.maximumReportedCostPerRequestUsd) ||
      input.maximumReportedCostPerRequestUsd < 0 ||
      input.maximumReportedCostPerRequestUsd >
        input.allowance.reportedCostAllowanceUsd) {
      throw new TypeError(
        "Company benchmark per-request reported-cost ceiling is invalid",
      );
    }
    this.#allowance = input.allowance;
    this.#maximumReportedCostPerRequestUsd =
      input.maximumReportedCostPerRequestUsd;
    this.#nowMs = input.nowMs ?? Date.now;
  }

  registerParent(sessionId: string, startedAtMs: number): void {
    if (this.#sessionRoles.has(sessionId)) {
      throw new TypeError("Company benchmark parent session is duplicated");
    }
    this.#sessionRoles.set(sessionId, "parent");
    this.#attempts.set(sessionId, {
      role: "parent",
      sessionId,
      startedAtMs,
      completedAtMs: null,
      status: "running",
      changedFiles: [],
      evidence: [],
    });
  }

  finishParent(input: {
    readonly completedAtMs: number;
    readonly status: "completed" | "failed" | "cancelled";
    readonly changedFiles: readonly string[];
    readonly evidence: readonly string[];
  }): void {
    const parent = [...this.#attempts.values()].find(
      (attempt) => attempt.role === "parent",
    );
    if (parent === undefined || parent.status !== "running") {
      throw new TypeError("Company benchmark parent attempt is unavailable");
    }
    parent.completedAtMs = input.completedAtMs;
    parent.status = input.status;
    parent.changedFiles = Object.freeze([...new Set(input.changedFiles)].sort());
    parent.evidence = Object.freeze([...input.evidence]);
  }

  observe(event: RecursEvent): void {
    if (event.type === "agent_started") {
      const role = roleForProfile(event.profileId);
      if (role === null) return;
      if (this.#sessionRoles.has(event.childSessionId)) {
        throw new TypeError("Company benchmark child session is duplicated");
      }
      this.#sessionRoles.set(event.childSessionId, role);
      this.#attempts.set(event.childSessionId, {
        role,
        sessionId: event.childSessionId,
        startedAtMs: eventTime(event.at, this.#nowMs()),
        completedAtMs: null,
        status: "running",
        changedFiles: [],
        evidence: [],
      });
      return;
    }
    if (
      event.type === "agent_completed" ||
      event.type === "agent_failed" ||
      event.type === "agent_cancelled"
    ) {
      const attempt = this.#attempts.get(event.childSessionId);
      if (attempt === undefined || attempt.status !== "running") return;
      attempt.completedAtMs = eventTime(event.at, this.#nowMs());
      attempt.status = terminalStatus(event);
      if (event.type === "agent_completed") {
        attempt.changedFiles = Object.freeze(
          [...new Set(event.changedFiles)].sort(),
        );
        attempt.evidence = Object.freeze([...event.evidence]);
      }
      return;
    }
    if (event.type === "permission_requested") {
      this.#externalConfirmationRequests += 1;
      return;
    }
    if (event.type === "permission_resolved" &&
      event.decision === "allowed_by_policy") {
      this.#automaticApprovals += 1;
      return;
    }
    if (event.type === "tool_denied") {
      this.#automaticDenials += 1;
      return;
    }
    if (event.type === "tool_requested" &&
      event.call.name === "request_user_input") {
      this.#userInputRequests += 1;
    }
  }

  #role(sessionId: string): CompanyBenchmarkObservedRole {
    const role = this.#sessionRoles.get(sessionId);
    if (role === undefined) {
      throw new TypeError(
        "Company benchmark provider request has no activated role",
      );
    }
    return role;
  }

  #reserve(): CompanyBenchmarkProviderRequest {
    return this.#allowance.beforeProviderRequest(
      this.#maximumReportedCostPerRequestUsd,
    );
  }

  #settle(input: BenchmarkRequestSettlement): void {
    const completedAtMs = this.#nowMs();
    this.#allowance.afterProviderResponse(
      input.reservation,
      input.usage?.costUsd ?? null,
    );
    this.#requests.push(Object.freeze({
      role: this.#role(input.sessionId),
      sessionId: input.sessionId,
      startedAtMs: input.startedAtMs,
      completedAtMs,
      status: input.status,
      usage: input.usage,
    }));
  }

  wrapProvider(provider: ModelProvider): ModelProvider {
    const reserve = () => this.#reserve();
    const nowMs = () => this.#nowMs();
    const settle = (input: BenchmarkRequestSettlement) =>
      this.#settle(input);
    return {
      id: provider.id,
      ...(provider.inputModalities === undefined
        ? {}
        : { inputModalities: provider.inputModalities }),
      ...(provider.harnessProfile === undefined
        ? {}
        : { harnessProfile: provider.harnessProfile }),
      async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
        const sessionId = request.directContext?.authorization.sessionId;
        if (sessionId === undefined) {
          throw new TypeError(
            "Company benchmark direct request lacks authorization",
          );
        }
        const reservation = reserve();
        const startedAtMs = nowMs();
        let usage: ProviderUsage | null = null;
        let status: "completed" | "failed" | "cancelled" = "failed";
        try {
          for await (const event of provider.stream(request)) {
            const next = eventUsage(event);
            if (next !== null) usage = addUsage(usage, next);
            yield event;
          }
          status = request.signal.aborted ? "cancelled" : "completed";
        } catch (error) {
          status = request.signal.aborted ? "cancelled" : "failed";
          throw error;
        } finally {
          settle({
            reservation,
            sessionId,
            startedAtMs,
            status,
            usage,
          });
        }
      },
      ...(provider.close === undefined
        ? {}
        : { close: () => provider.close!() }),
    };
  }

  wrapRuntime(runtime: AgentRuntime): AgentRuntime {
    const reserve = () => this.#reserve();
    const nowMs = () => this.#nowMs();
    const settle = (input: BenchmarkRequestSettlement) =>
      this.#settle(input);
    return {
      adapterId: runtime.adapterId,
      connectionId: runtime.connectionId,
      capabilities: runtime.capabilities,
      capabilityProfileRevision: runtime.capabilityProfileRevision,
      async *run(request, host): AsyncIterable<AgentRuntimeEvent> {
        const reservation = reserve();
        const startedAtMs = nowMs();
        let usage: ProviderUsage | null = null;
        let status: "completed" | "failed" | "cancelled" = "failed";
        try {
          for await (const event of runtime.run(request, host)) {
            const next = eventUsage(event);
            if (next !== null) usage = addUsage(usage, next);
            yield event;
          }
          status = request.signal.aborted ? "cancelled" : "completed";
        } catch (error) {
          status = request.signal.aborted ? "cancelled" : "failed";
          throw error;
        } finally {
          settle({
            reservation,
            sessionId: request.sessionId,
            startedAtMs,
            status,
            usage,
          });
        }
      },
      async reconcile(input) {
        const reservation = reserve();
        const startedAtMs = nowMs();
        let status: "completed" | "failed" | "cancelled" = "failed";
        try {
          const result = await runtime.reconcile(input);
          status = input.signal.aborted ? "cancelled" : "completed";
          return result;
        } catch (error) {
          status = input.signal.aborted ? "cancelled" : "failed";
          throw error;
        } finally {
          settle({
            reservation,
            sessionId: input.continuation.recursSessionId,
            startedAtMs,
            status,
            usage: null,
          });
        }
      },
    };
  }

  snapshot(completedAtMs: number): CompanyBenchmarkRecorderSnapshot {
    const attempts = [...this.#attempts.values()].map((attempt) => {
      const status = attempt.status === "running" ? "failed" : attempt.status;
      return Object.freeze({
        role: attempt.role,
        sessionId: attempt.sessionId,
        startedAtMs: attempt.startedAtMs,
        completedAtMs: attempt.completedAtMs ?? completedAtMs,
        status,
        changedFiles: attempt.changedFiles,
        evidence: attempt.evidence,
      });
    });
    return Object.freeze({
      requests: Object.freeze([...this.#requests]),
      attempts: Object.freeze(attempts),
      interventions: Object.freeze({
        externalConfirmationRequests: this.#externalConfirmationRequests,
        userInputRequests: this.#userInputRequests,
        automaticApprovals: this.#automaticApprovals,
        automaticDenials: this.#automaticDenials,
      }),
    });
  }
}
