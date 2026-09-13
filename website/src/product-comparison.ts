import { escapeHtml } from "./evidence.js";

export const productTaskIds = ["shipment_quote", "incremental_build_repair", "release_window_regressions"] as const;
const armIds = ["codex-cli", "company-auto"] as const;
type TaskId = typeof productTaskIds[number];
type ArmId = typeof armIds[number];
type CheckStatus = "passed" | "failed" | "not_run";
type ExecutionStatus = "completed" | "failed" | "timed_out" | "cancelled" | "not_started";
interface Route { role: string; modelId: string; reasoningEffort: string | null }
export interface ProductAttempt {
  scenarioId: TaskId;
  armId: ArmId;
  repetition: 1 | 2;
  executionStatus: ExecutionStatus;
  verificationStatus: CheckStatus;
  workspaceIntegrity: CheckStatus;
  sourceReview: CheckStatus;
  validity: "valid" | "invalid";
  note: string;
  elapsedMs: number | null;
  usage: {
    coverage: "complete" | "partial" | "none";
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
  };
}
export interface ProductComparison {
  version: 1;
  kind: "audited-product-comparison";
  sourceRevision: string;
  auditedAt: string;
  auditHref: string;
  protocolHref: string;
  configurations: { id: ArmId; routes: Route[] }[];
  tokenAccounting: { comparable: boolean; note: string };
  attempts: ProductAttempt[];
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected comparison object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) throw new Error("Unexpected comparison fields");
  return result;
}
function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > 2000 || (!allowEmpty && !value.trim())) throw new Error(`Invalid ${label}`);
  return value;
}
function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`Invalid ${label}`);
  return value as T;
}
function measurement(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}
function link(value: unknown): string {
  const href = string(value, "audit link");
  // A fixed local artifact path or an HTTPS source; never script/data/protocol-relative URLs.
  if (!/^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(href) && !/^https:\/\//u.test(href)) throw new Error("Unsafe comparison link");
  if (href.startsWith("https://")) {
    const parsed = new URL(href);
    if (parsed.hostname !== "github.com" || !parsed.pathname.startsWith("/tacotuesday8888/recurs/") || parsed.username || parsed.password) throw new Error("Expected public repository link");
  } else if (href.split("/").includes("..")) throw new Error("Unsafe comparison link");
  return href;
}

/** Public export boundary. Missing slots and missing counters are never inferred. */
export function parseProductComparison(input: unknown): ProductComparison {
  const data = object(input, ["version", "kind", "sourceRevision", "auditedAt", "auditHref", "protocolHref", "configurations", "tokenAccounting", "attempts"]);
  if (data.version !== 1 || data.kind !== "audited-product-comparison") throw new Error("Audited product comparison required");
  const sourceRevision = string(data.sourceRevision, "source revision");
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) throw new Error("Full source revision required");
  const auditedAt = string(data.auditedAt, "audit time");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(auditedAt) || !Number.isFinite(Date.parse(auditedAt))) throw new Error("Invalid audit time");
  if (!Array.isArray(data.configurations) || data.configurations.length !== 2) throw new Error("Two configurations required");
  const configurations = data.configurations.map(raw => {
    const config = object(raw, ["id", "routes"]);
    const id = member(config.id, armIds, "configuration");
    if (!Array.isArray(config.routes) || !config.routes.length || config.routes.length > 8) throw new Error("Routes required");
    const routes = config.routes.map(rawRoute => {
      const route = object(rawRoute, ["role", "modelId", "reasoningEffort"]);
      return { role: member(route.role, ["parent", "implement", "review", "repair"], "route role"), modelId: string(route.modelId, "model"), reasoningEffort: route.reasoningEffort === null ? null : string(route.reasoningEffort, "effort") };
    });
    if (new Set(routes.map(route => route.role)).size !== routes.length || !routes.some(route => route.role === "parent")) throw new Error("Unique routes with a parent required");
    return { id, routes };
  });
  if (new Set(configurations.map(config => config.id)).size !== 2) throw new Error("Duplicate configuration");
  const accounting = object(data.tokenAccounting, ["comparable", "note"]);
  if (typeof accounting.comparable !== "boolean") throw new Error("Explicit token accounting audit required");
  const tokenAccounting = { comparable: accounting.comparable, note: string(accounting.note, "token accounting note") };
  if (!Array.isArray(data.attempts) || data.attempts.length !== 12) throw new Error("All twelve declared slots required");
  const attempts = data.attempts.map(raw => {
    const attempt = object(raw, ["scenarioId", "armId", "repetition", "executionStatus", "verificationStatus", "workspaceIntegrity", "sourceReview", "validity", "note", "elapsedMs", "usage"]);
    const scenarioId = member(attempt.scenarioId, productTaskIds, "task");
    const armId = member(attempt.armId, armIds, "arm");
    if (attempt.repetition !== 1 && attempt.repetition !== 2) throw new Error("Invalid repetition");
    const repetition: 1 | 2 = attempt.repetition;
    const executionStatus = member(attempt.executionStatus, ["completed", "failed", "timed_out", "cancelled", "not_started"], "execution status");
    const verificationStatus = member(attempt.verificationStatus, ["passed", "failed", "not_run"], "verification");
    const workspaceIntegrity = member(attempt.workspaceIntegrity, ["passed", "failed", "not_run"], "workspace integrity");
    const sourceReview = member(attempt.sourceReview, ["passed", "failed", "not_run"], "source review");
    const validity = member(attempt.validity, ["valid", "invalid"], "validity");
    const note = string(attempt.note, "attempt note", true);
    const elapsedMs = measurement(attempt.elapsedMs, "elapsed time");
    const rawUsage = object(attempt.usage, ["coverage", "inputTokens", "cachedInputTokens", "outputTokens"]);
    const usage = {
      coverage: member(rawUsage.coverage, ["complete", "partial", "none"], "usage coverage"),
      inputTokens: measurement(rawUsage.inputTokens, "input tokens"),
      cachedInputTokens: measurement(rawUsage.cachedInputTokens, "cached tokens"),
      outputTokens: measurement(rawUsage.outputTokens, "output tokens"),
    };
    if (usage.cachedInputTokens !== null && (usage.inputTokens === null || usage.cachedInputTokens > usage.inputTokens)) throw new Error("Invalid cached token accounting");
    const counters = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens];
    if (usage.coverage === "complete" && (usage.inputTokens === null || usage.outputTokens === null)) throw new Error("Complete usage requires input and output counters");
    if (usage.coverage === "none" && counters.some(value => value !== null)) throw new Error("Absent usage must remain null");
    if (executionStatus === "not_started" && (elapsedMs !== null || counters.some(value => value !== null) || verificationStatus !== "not_run" || workspaceIntegrity !== "not_run" || sourceReview !== "not_run")) throw new Error("Unstarted slot has measurements or checks");
    if (validity === "invalid" && !note.trim()) throw new Error("Invalid attempts require an explanation");
    return { scenarioId, armId, repetition, executionStatus, verificationStatus, workspaceIntegrity, sourceReview, validity, note, elapsedMs, usage };
  });
  const slots = attempts.map(attempt => `${attempt.scenarioId}/${attempt.armId}/${attempt.repetition}`);
  if (new Set(slots).size !== 12) throw new Error("Duplicate or missing declared slot");
  return { version: 1, kind: "audited-product-comparison", sourceRevision, auditedAt, auditHref: link(data.auditHref), protocolHref: link(data.protocolHref), configurations, tokenAccounting, attempts };
}

const taskCopy: Record<TaskId, { title: string; description: string }> = {
  shipment_quote: { title: "Add shipment quotes", description: "Connect cart validation, discounts and parcel rates across four modules." },
  incremental_build_repair: { title: "Fix rebuild planning", description: "Repair change detection and dependency tracking so the right modules rebuild." },
  release_window_regressions: { title: "Detect seeded regressions", description: "Write a checker that accepts a working scheduler and rejects three deliberately introduced behavior changes." },
};
const armName = (id: ArmId) => id === "codex-cli" ? "Codex CLI" : "Recurs team";
const format = (value: number) => new Intl.NumberFormat("en-US").format(value);
const count = (value: number) => `<span class="count-value"><span class="sr-only">${format(value)}</span><span aria-hidden="true" data-count-to="${value}">${format(value)}</span></span>`;
export function productAttemptCompleted(attempt: ProductAttempt): boolean {
  return attempt.validity === "valid" && attempt.executionStatus === "completed" && attempt.verificationStatus === "passed" && attempt.workspaceIntegrity === "passed" && attempt.sourceReview === "passed";
}
function outcome(attempt: ProductAttempt): string {
  if (attempt.validity === "invalid") return "Invalid comparison";
  if (attempt.executionStatus === "not_started") return "Not started";
  if (attempt.executionStatus === "timed_out") return "Timed out";
  if (attempt.executionStatus === "cancelled") return "Cancelled";
  if (attempt.executionStatus === "failed") return "Run failed";
  if (productAttemptCompleted(attempt)) return "Finished";
  if (attempt.workspaceIntegrity === "failed") return "Workspace checks failed";
  if (attempt.verificationStatus === "failed") return "Task checks failed";
  if (attempt.sourceReview === "failed") return "Source review failed";
  return "Checks not complete";
}
function duration(attempt: ProductAttempt): string {
  if (attempt.elapsedMs === null) return attempt.executionStatus === "not_started" ? "Not started" : "Not recorded";
  const seconds = attempt.elapsedMs / 1000;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(seconds)} seconds`;
}
function comparableTokens(data: ProductComparison): boolean {
  return data.tokenAccounting.comparable && data.attempts.every(attempt => attempt.executionStatus !== "not_started" && attempt.validity === "valid" && attempt.usage.coverage === "complete");
}
function model(route: Route): string {
  const name = ({ "gpt-5.6-luna": "Luna", "gpt-5.6-terra": "Terra" } as Record<string, string>)[route.modelId] ?? route.modelId;
  return `${name} (${route.reasoningEffort ?? "unspecified effort"})`;
}

/** No data means no section. Only audited exports enter the live build. */
export function renderProductComparison(input?: unknown): string {
  if (input === undefined) return "";
  const data = parseProductComparison(input);
  const tokens = comparableTokens(data);
  const rows = productTaskIds.map(id => {
    const task = taskCopy[id];
    const attempts = data.attempts.filter(attempt => attempt.scenarioId === id);
    const finished = armIds.map(arm => attempts.filter(attempt => attempt.armId === arm && productAttemptCompleted(attempt)).length);
    const completion = `<tr class="completion-row"><th scope="row">Tasks finished</th>${finished.map(value => `<td>${count(value)}<span class="count-total"> / 2</span></td>`).join("")}</tr>`;
    const times = [1, 2].map(repetition => `<tr><th scope="row">Attempt ${repetition}</th>${armIds.map(arm => {
      const attempt = attempts.find(item => item.armId === arm && item.repetition === repetition)!;
      return `<td><span class="product-duration">${duration(attempt)}</span><small class="product-outcome">${outcome(attempt)}</small></td>`;
    }).join("")}</tr>`).join("");
    const invalid = attempts.filter(attempt => attempt.validity === "invalid").length;
    const details = [1, 2].flatMap(repetition => armIds.map(arm => {
      const attempt = attempts.find(item => item.armId === arm && item.repetition === repetition)!;
      const checkLabel = (status: CheckStatus) => status === "not_run" ? "not run" : status;
      return `<li><p><strong>${armName(arm)}, attempt ${repetition}: ${outcome(attempt)}</strong> — ${duration(attempt)}</p><p>Task checks ${checkLabel(attempt.verificationStatus)}; workspace checks ${checkLabel(attempt.workspaceIntegrity)}; source review ${checkLabel(attempt.sourceReview)}.</p>${attempt.note ? `<p>${escapeHtml(attempt.note)}</p>` : ""}${tokens ? `<p>Input tokens: ${format(attempt.usage.inputTokens!)} (${attempt.usage.cachedInputTokens === null ? "cached portion unknown" : `${format(attempt.usage.cachedInputTokens)} cached`}). Output tokens: ${format(attempt.usage.outputTokens!)}.</p>` : ""}</li>`;
    })).join("");
    return `<article class="task-result product-task" data-scroll-reveal data-product-task="${id}"><div class="task-story"><h3>${task.title}</h3><p>${task.description}</p>${invalid ? `<p class="product-validity">${invalid} invalid comparison ${invalid === 1 ? "slot" : "slots"}; see the attempt details.</p>` : ""}</div><div class="product-measures"><table class="task-comparison"><caption class="sr-only">${task.title}: Codex CLI and Recurs team, two attempts each</caption><thead><tr><th scope="col"><span class="sr-only">Measure</span></th><th scope="col">Codex CLI</th><th scope="col">Recurs team</th></tr></thead><tbody>${completion}${times}</tbody></table><details class="product-attempts"><summary>Attempt details</summary><ol>${details}</ol></details></div></article>`;
  }).join("\n");
  const configs = armIds.map(id => {
    const config = data.configurations.find(item => item.id === id)!;
    const roleNames: Record<string, string> = { parent: "lead", implement: "implementation", review: "review", repair: "repair" };
    return `<li><strong>${armName(id)}:</strong> ${config.routes.map(route => `${escapeHtml(model(route))} for ${roleNames[route.role]}`).join("; ")}.</li>`;
  }).join("");
  return `<section class="evidence-section product-comparison" id="product-comparison" aria-labelledby="product-comparison-title"><div class="wrap"><div class="evidence-heading"><h2 id="product-comparison-title">Codex CLI and Recurs, on three new tasks</h2><a class="text-link" href="${escapeHtml(data.auditHref)}">Read the audit</a></div><p class="evidence-intro">Two attempts per product and task, with a five-minute limit each. Both use the Codex subscription. These are small, authored Node projects.</p><details class="product-configuration"><summary>Models and comparison setup</summary><ul>${configs}</ul><p>These are configured routes; the audit records which workers actually ran. Native Codex tools, including delegation, remained available. The comparison includes differences in models, tools and coordination.</p></details><div class="task-results">${rows}</div><p class="result-definitions">Finished requires completed execution, passing task and workspace checks, and passing source review. A timed-out run with passing files is still shown as timed out. Every declared attempt is retained.</p><p class="evidence-limits">Times include setup, execution and grading before artifact retention. The scheduler task measures three seeded regressions, not general bug finding. Two attempts per task do not establish a general success rate. Dollar cost is unavailable.</p><p class="product-token-note">${tokens ? "Provider-reported input includes cached tokens; cached tokens are not added again. Per-attempt counters are in the details." : "Token totals are not shown as a comparison because equivalent, complete coverage has not been established for every attempt."} ${escapeHtml(data.tokenAccounting.note)}</p><div class="evidence-links"><a href="${escapeHtml(data.protocolHref)}">Frozen protocol</a><a href="${escapeHtml(data.auditHref)}">Complete audit and records</a></div></div></section>`;
}
