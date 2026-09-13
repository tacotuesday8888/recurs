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
  verification: { status: string; checks: { id: string; status: string }[] };
  review: { finalVerdict: string | null };
}
export interface Campaign {
  id: string; date: string; scenario: string; harnessRevision: string;
  plannedSlots: number; recordedTrials: number; settledSlots: number; complete: boolean; repetitions: number;
  evidenceKind: string; sourceRevision: string; sourceState: string; artifactSha256: string | null;
  arms: Arm[]; trials: Trial[];
}
export const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/gu,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const number = (value: number | null) => value === null ? "Unknown" : value.toLocaleString("en-US");
export const armName = (id: string) => ({ "single-strong": "Single agent", "company-auto": "Mixed-model team", "company-strong": "Same-model team" })[id] ?? id;
export const campaignName = (campaign: Campaign) => `${campaign.date} · ${campaign.scenario} · ${campaign.complete ? "complete" : "interrupted"} · ${campaign.arms.every((arm) => arm.parentMatched) ? "matched parent" : "unmatched parents"}`;
export function context(campaign: Campaign) {
  return `${campaign.evidenceKind === "model_backed" ? "Foreground probe" : "Historical"} · ${campaign.harnessRevision.replace("recurs_0_1_0-", "")} · ${campaign.recordedTrials}/${campaign.plannedSlots} trial records · ${campaign.settledSlots}/${campaign.plannedSlots} slots settled · ${campaign.complete ? `${campaign.repetitions} ${campaign.repetitions === 1 ? "repetition" : "repetitions"} per arm` : "Incomplete campaign; missing trials are not passes"}`;
}
export function resultRows(campaign: Campaign) {
  return campaign.arms.map((arm) => `
    <tr>
      <td>${escapeHtml(armName(arm.id))}</td>
      <td class="result-pass">${arm.passed} / ${arm.planned}</td>
      <td>${arm.medianWallClockMs === null ? "Unknown" : `${(arm.medianWallClockMs / 1000).toFixed(1)} s`}</td>
      <td>${number(arm.inputTokens)}</td>
      <td>${number(arm.outputTokens)}</td>
      <td>${arm.reportedCostUsd === null ? "Unknown" : `$${arm.reportedCostUsd.toFixed(4)}`}</td>
    </tr>`).join("");
}

function renderTrial(trial: Trial) {
  const checks = trial.verification.checks.map((check) =>
    `${escapeHtml(check.id)}: ${escapeHtml(check.status)}`
  ).join(" · ");
  return `<li>
    Trial ${trial.repetition}: ${escapeHtml(trial.executionStatus)} ·
    verifier ${escapeHtml(trial.verification.status)} ·
    ${(trial.wallClockMs / 1000).toFixed(1)} s ·
    review ${escapeHtml(trial.review.finalVerdict ?? "not activated")}<br>${checks}
  </li>`;
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
      ${arm.repairAttempts} repair attempts · ${arm.falseApprovals} false approvals</p>
    <ul class="trial-list">${trials.filter((trial) => trial.armId === arm.id).map(renderTrial).join("")}</ul>
  </section>`;
}

export function trialDetails(campaign: Campaign) {
  const provenance = `<p class="fine">Source: ${escapeHtml(campaign.sourceRevision)} · ${escapeHtml(campaign.sourceState)}${campaign.artifactSha256 ? `<br>Executed bundle SHA-256: ${escapeHtml(campaign.artifactSha256)}` : ""}</p>`;
  return provenance + `<p class="fine">Confirmation requests count harness callbacks, including preapproved intents;
    they are not a count of human interventions. User-input requests are recorded separately.
    Missing trial slots have no measured time or usage; conservative settlement charges are not measurements.</p>` +
    campaign.arms.map((arm) => renderArm(arm, campaign.trials)).join("");
}
