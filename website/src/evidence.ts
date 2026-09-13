export interface Route { role: string; modelId: string; reasoningEffort: string | null }
export interface Arm {
  id: string; routes: Route[]; parentMatched: boolean; planned: number; recorded: number;
  passed: number; medianWallClockMs: number | null; requests: number;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  reportedCostUsd: number | null; confirmationRequests: number; userInputRequests: number;
  falseApprovals: number; repairAttempts: number;
}
export interface Trial {
  armId: string; repetition: number; executionStatus: string; wallClockMs: number;
  verification: { status: string; workspaceIntegrity: string; checks: { id: string; status: string }[] };
  review: { finalVerdict: string | null };
  usage: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; requestsUsed: number; tokenCoverage: string; costCoverage: string; reportedCostUsd: number | null };
  roles: { role: string; attempts: number; wallClockMs: number; attemptLatenciesMs: number[]; usage: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null } }[];
  failures: { stage: string; code: string }[];
}
export interface Campaign {
  id: string; date: string; scenario: string; scenarioVersion: number; harnessRevision: string; launchProtocolRevision: string;
  plannedSlots: number; recordedTrials: number; settledSlots: number; complete: boolean; repetitions: number;
  evidenceKind: string; sourceRevision: string; sourceState: string; artifactSha256: string | null;
  arms: Arm[]; trials: Trial[];
  unattemptedSlots: number | null; unsettledReservations: number | null;
}
export const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/gu,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const number = (value: number | null) => value === null ? "Unknown" : value.toLocaleString("en-US");
export const armName = (id: string) => ({ "single-strong": "Single agent", "company-auto": "Mixed-model team", "company-strong": "Same-model team" })[id] ?? id;
const scenarioNames: Record<string, string> = {
  options_precedence: "Small change: option precedence",
  queue_cancellation: "Coupled fix: queue cancellation",
  workspace_maintenance: "Independent work: workspace utilities",
  retry_after: "Earlier probe: retry-after parser",
  alias_registry: "Historical: alias registry",
  layered_config: "Historical: layered config",
};
const invalidSetup = (campaign: Campaign) => campaign.scenario === "workspace_maintenance" && campaign.scenarioVersion === 1;
const setupNote = "Invalid team setup: three workers requested, two permitted. Both team attempts stopped before workers started; these times do not measure team efficiency.";
export const campaignName = (campaign: Campaign) => `${scenarioNames[campaign.scenario] ?? campaign.scenario} (${campaign.date}, ${invalidSetup(campaign) ? "invalid team setup" : campaign.complete ? "complete" : "incomplete"})`;
export function context(campaign: Campaign) {
  const workload = ({
    options_precedence: "A single-module option-precedence fix; mandatory review is an intentional overhead control.",
    queue_cancellation: "A two-module async queue repair covering cancellation, rejected tasks and concurrency slots.",
    workspace_maintenance: "Three independently scoped utility fixes, with an immutable integration module and combined review.",
  } as Record<string, string>)[campaign.scenario] ?? "";
  const missing = campaign.unattemptedSlots ? ` ${campaign.unattemptedSlots} slots were never attempted.` : "";
  const unsettled = campaign.unsettledReservations ? ` ${campaign.unsettledReservations} reserved slots have no final settlement.` : "";
  const protocol = campaign.launchProtocolRevision === "company-benchmark-parent-only-v2"
    ? "Parent-only baseline enforced; mandatory independent review for the team."
    : "Earlier protocol: baseline delegation was available, not structurally disabled.";
  return `${workload ? `${workload} ` : ""}${campaign.recordedTrials}/${campaign.plannedSlots} trial records; ${campaign.settledSlots}/${campaign.plannedSlots} slots settled. ${campaign.complete ? `${campaign.repetitions} ${campaign.repetitions === 1 ? "repetition" : "repetitions"} per arm.` : "Incomplete campaign; missing trials are not passes."} ${protocol}${invalidSetup(campaign) ? ` ${setupNote}` : ""}${missing}${unsettled}`;
}
function uncached(input: number | null, cached: number | null): number | null {
  return input === null || cached === null || cached > input ? null : input - cached;
}
export function pilotOverview(campaigns: Campaign[]) {
  const pilot = campaigns.filter((campaign) => campaign.launchProtocolRevision === "company-benchmark-parent-only-v2");
  if (pilot.length === 0) return "";
  const rows = pilot.map((campaign) => `<tr><th scope="row">${escapeHtml(scenarioNames[campaign.scenario] ?? campaign.scenario)}</th>${campaign.arms.slice(0, 2).map((arm) => `<td data-label="${escapeHtml(armName(arm.id))}"><strong>${invalidSetup(campaign) && arm.id === "company-auto" ? "2 invalid setups" : `${arm.passed} / ${arm.planned} verified`}</strong><small>${invalidSetup(campaign) && arm.id === "company-auto" ? "Workers never started" : arm.medianWallClockMs === null ? "Unknown time" : `${(arm.medianWallClockMs / 1000).toFixed(1)} s median`}<br>${number(arm.inputTokens)} input tokens</small></td>`).join("")}</tr>`).join("");
  return `<div class="table-scroll pilot-overview" tabindex="0" role="region" aria-label="All task-fit pilot results"><table><caption>All predeclared tasks</caption><thead><tr><th>Task</th><th>Single agent</th><th>Mixed-model team</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
export function pairedRows(campaign: Campaign) {
  return Array.from({ length: campaign.repetitions }, (_, index) => index + 1).flatMap((repetition) =>
    campaign.arms.map((arm) => {
      const trial = campaign.trials.find((item) => item.armId === arm.id && item.repetition === repetition);
      return `<tr><td data-label="Repetition">${repetition}</td><td data-label="Configuration">${escapeHtml(armName(arm.id))}</td><td data-label="Outcome">${trial ? `${invalidSetup(campaign) && arm.id === "company-auto" ? "Invalid setup" : escapeHtml(trial.executionStatus)}<small>Verifier: ${escapeHtml(trial.verification.status)}</small>` : "Missing trial"}</td><td data-label="Time">${trial ? `${(trial.wallClockMs / 1000).toFixed(1)} s` : "Unknown"}</td><td data-label="Uncached input">${trial ? number(uncached(trial.usage.inputTokens, trial.usage.cachedInputTokens)) : "Unknown"}</td><td data-label="Cached input">${trial ? number(trial.usage.cachedInputTokens) : "Unknown"}</td><td data-label="Output">${trial ? number(trial.usage.outputTokens) : "Unknown"}</td></tr>`;
    })
  ).join("");
}
export function resultRows(campaign: Campaign) {
  return campaign.arms.map((arm) => `
    <tr>
      <td>${escapeHtml(armName(arm.id))}</td>
      <td class="result-pass" data-label="Verified"><span>${arm.passed} / ${arm.planned}${invalidSetup(campaign) && arm.id === "company-auto" ? "<small>Invalid setup × 2</small>" : ""}</span></td>
      <td data-label="Median time"><span>${arm.medianWallClockMs === null ? "Unknown" : `${(arm.medianWallClockMs / 1000).toFixed(1)} s`}</span></td>
      <td data-label="Input tokens"><span>${number(arm.inputTokens)}<small>${number(arm.cachedInputTokens)} cached</small></span></td>
      <td data-label="Output tokens"><span>${number(arm.outputTokens)}</span></td>
      <td data-label="Reported cost"><span>${arm.reportedCostUsd === null ? "Unknown" : `$${arm.reportedCostUsd.toFixed(4)}`}</span></td>
    </tr>`).join("");
}

function renderTrial(trial: Trial) {
  const checks = trial.verification.checks.map((check) =>
    `${escapeHtml(check.id)}: ${escapeHtml(check.status)}`
  ).join(" · ");
  const diagnostics = trial.roles.map((role) => {
    const attemptMs = role.attemptLatenciesMs.reduce((total, value) => total + value, 0);
    const overlap = role.role === "implement" && attemptMs > role.wallClockMs
      ? "; implementation invocations overlapped in time" : "";
    return `${escapeHtml(role.role)}: ${role.attempts} invocations, ${number(role.usage.inputTokens)} input (${number(role.usage.cachedInputTokens)} cached), ${number(role.usage.outputTokens)} output${overlap}`;
  }).join("<br>");
  const failures = trial.failures.map((failure) => `${escapeHtml(failure.stage)}: ${escapeHtml(failure.code)}`).join(", ");
  return `<li>
    Trial ${trial.repetition}: ${escapeHtml(trial.executionStatus)} ·
    verifier ${escapeHtml(trial.verification.status)} ·
    ${(trial.wallClockMs / 1000).toFixed(1)} s ·
    review ${escapeHtml(trial.review.finalVerdict ?? "not activated")}<br>${checks}
  <p>${diagnostics}${failures ? `<br>Failures: ${failures}` : ""}</p></li>`;
}

function renderArm(arm: Arm, trials: Trial[]) {
  const routes = arm.routes.map((route) =>
    `${escapeHtml(route.role)}: ${escapeHtml(route.modelId)} / ${escapeHtml(route.reasoningEffort ?? "unspecified")}`
  ).join("<br>");
  return `<section class="trial-detail">
    <h3>${escapeHtml(armName(arm.id))} · ${arm.parentMatched ? "same parent as baseline" : "different parent from baseline"}</h3>
    <p>${routes}</p>
    <p>${arm.requests} recorded requests · ${number(arm.cachedInputTokens)} cached input tokens<br>
      ${arm.confirmationRequests} confirmation callbacks · ${arm.userInputRequests} user-input requests ·
      ${arm.repairAttempts} repair attempts · ${arm.falseApprovals} approvals without verified completion</p>
    <ul class="trial-list">${trials.filter((trial) => trial.armId === arm.id).map(renderTrial).join("")}</ul>
  </section>`;
}

export function trialDetails(campaign: Campaign) {
  const provenance = `<p class="fine">Source: ${escapeHtml(campaign.sourceRevision)} · ${escapeHtml(campaign.sourceState)}${campaign.artifactSha256 ? `<br>Executed bundle SHA-256: ${escapeHtml(campaign.artifactSha256)}` : ""}</p>`;
  return provenance + `<p class="fine">Terminal media comes from the installed CLI walkthrough with a deterministic local provider (<a href="./assets/terminal-workflow.json">capture provenance</a>);
    the benchmark records describe separate model-backed trials.</p><p class="fine">Confirmation requests count harness callbacks, including preapproved intents;
    they are not a count of human interventions. User-input requests are recorded separately.
    Recorded requests count Recurs runtime invocations, not every internal vendor model/tool turn.
    Parent latency includes delegated work; parent and child times must not be added.
    Overlap means implementation runtime intervals overlapped, not proven simultaneous model compute.
    Missing trial slots have no measured time or usage; conservative settlement charges are not measurements.</p>` +
    campaign.arms.map((arm) => renderArm(arm, campaign.trials)).join("");
}
