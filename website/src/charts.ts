import { armName, escapeHtml, type Campaign } from "./evidence.js";

export const chartMetrics = {
  runtime: "Runtime",
  correctness: "Verified completion",
  tokens: "Token use",
  overhead: "Review and repair",
  cost: "Reported dollar cost",
} as const;
export type ChartMetric = keyof typeof chartMetrics;
type Segment = { label: string; value: number; kind: string };
export interface Observation {
  arm: string; repetition: number; value: number | null; label: string;
  outcome: string; setupInvalid: boolean; segments: Segment[];
}
const format = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 3 });
export const chartCampaigns = (campaigns: Campaign[]) => campaigns.filter(campaign => campaign.launchProtocolRevision === "company-benchmark-parent-only-v2");
export const chartTaskName = (campaign: Campaign) => ({ options_precedence: "Option precedence", queue_cancellation: "Queue cancellation", workspace_maintenance: `Workspace utilities (v${campaign.scenarioVersion})` })[campaign.scenario] ?? campaign.scenario;
export function observations(campaign: Campaign, metric: ChartMetric): Observation[] {
  return campaign.arms.flatMap(arm => Array.from({ length: campaign.repetitions }, (_, index) => {
    const repetition = index + 1;
    const trial = campaign.trials.find(item => item.armId === arm.id && item.repetition === repetition);
    const setupInvalid = campaign.scenario === "workspace_maintenance" && campaign.scenarioVersion === 1 && arm.id === "company-auto";
    const passed = trial?.executionStatus === "completed" && trial.verification.status === "passed" && trial.verification.workspaceIntegrity === "passed";
    const outcome = !trial ? "Missing trial" : setupInvalid ? "Invalid setup; workers never started" : passed ? "Verified completion" : `No verified completion (${trial.executionStatus})`;
    let value: number | null = null;
    let segments: Segment[] = [];
    if (trial) {
      if (metric === "runtime") value = trial.wallClockMs / 1000;
      if (metric === "correctness") value = passed ? 1 : 0;
      if (metric === "cost" && trial.usage.costCoverage === "complete") value = trial.usage.reportedCostUsd;
      if (metric === "tokens") {
        const { inputTokens: input, cachedInputTokens: cached, outputTokens: output, tokenCoverage } = trial.usage;
        if (tokenCoverage === "complete" && input !== null && cached !== null && output !== null && cached >= 0 && cached <= input) {
          segments = [{ label: "Uncached input", value: input - cached, kind: "input" }, { label: "Cached input", value: cached, kind: "cached" }, { label: "Output", value: output, kind: "output" }];
          value = input + output;
        }
      }
      if (metric === "overhead") {
        segments = ["review", "repair"].map(role => ({ label: role === "review" ? "Review" : "Repair", value: trial.roles.find(item => item.role === role)?.attempts ?? 0, kind: role }));
        value = segments.reduce((total, part) => total + part.value, 0);
      }
    }
    const label = value === null ? "Unknown" : metric === "runtime" ? `${format(value)} s` : metric === "correctness" ? (passed ? "Passed" : setupInvalid ? "Invalid setup" : "Not passed") : metric === "cost" ? `$${value.toFixed(4)}` : `${format(value)} ${metric === "tokens" ? "tokens" : "invocations"}`;
    return { arm: arm.id, repetition, value, label, outcome, setupInvalid, segments };
  }));
}

const definitions: Record<ChartMetric, string> = {
  runtime: "Wall-clock seconds for each whole trial, including failed attempts. Parent and child time are never added. Shorter means less elapsed time, not better code.",
  correctness: "Each trial passes only when execution completes and the external behavior and workspace checks pass. A model review approval alone is not a pass.",
  tokens: "Reported tokens per trial: uncached input + cached input + output. Cached input is already included in input totals. Token amounts do not establish dollar cost.",
  overhead: "Review and repair runtime invocations per trial. These counts do not measure internal vendor turns or human effort; they show the additional checking and rework.",
  cost: "Actual provider-reported dollars per trial, only when cost coverage is complete. Subscription token use is not a price or a savings estimate.",
};

export function renderChart(campaign: Campaign, metric: ChartMetric): string {
  const points = observations(campaign, metric);
  const unavailable = points.every(point => point.value === null);
  const scalePoints = points.filter(point => !point.setupInvalid && point.value !== null);
  const max = metric === "correctness" ? 1 : Math.max(1, ...scalePoints.map(point => point.value!));
  const unit = metric === "runtime" ? "seconds" : metric === "tokens" ? "tokens" : metric === "overhead" ? "invocations" : metric === "cost" ? "USD" : "verified trial";
  const legend = metric === "tokens" ? [{ label: "Uncached input", kind: "input" }, { label: "Cached input", kind: "cached" }, { label: "Output", kind: "output" }] : metric === "overhead" ? [{ label: "Review", kind: "review" }, { label: "Repair", kind: "repair" }] : [];
  const rows = campaign.arms.map(arm => `<div class="chart-arm"><h4>${escapeHtml(armName(arm.id))}</h4>${points.filter(point => point.arm === arm.id).map((point, index) => {
    const detail = `${armName(point.arm)}, trial ${point.repetition}: ${point.label}. ${point.outcome}.${point.segments.length ? ` ${point.segments.map(part => `${part.label}: ${format(part.value)}`).join("; ")}.` : ""}`;
    const parts = point.segments.length ? point.segments : [{ label: chartMetrics[metric], value: point.value ?? 0, kind: arm.id === "single-strong" ? "baseline" : "team" }];
    const mark = point.value === null || point.setupInvalid ? "" : parts.map(part => `<span class="chart-part ${part.kind}" style="width:${part.value / max * 100}%"></span>`).join("");
    const id = `chart-tip-${escapeHtml(arm.id)}-${index}`;
    return `<button type="button" class="chart-point${point.setupInvalid ? " chart-invalid" : ""}" data-chart-detail="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}" aria-describedby="${id}"><span class="chart-trial">Trial ${point.repetition}</span><span class="chart-track" aria-hidden="true">${mark}</span><span class="chart-value">${escapeHtml(point.label)}${point.setupInvalid && metric !== "correctness" ? "<small>setup only</small>" : ""}</span><span class="chart-tooltip" id="${id}" role="tooltip"><span class="chart-tooltip-text">${escapeHtml(detail)}</span></span></button>`;
  }).join("")}</div>`).join("");
  return `<div class="chart-heading"><h3>${chartMetrics[metric]}</h3><span>${campaign.repetitions} trials per arm</span></div><p class="chart-definition">${definitions[metric]}</p>${unavailable ? `<p class="chart-unavailable">${metric === "cost" ? "The provider did not report dollar cost for this campaign." : "This metric is unavailable for this campaign."}</p>` : `<div class="chart-axis" aria-hidden="true"><span>0</span><span>${format(max)} ${unit}</span></div>`}${unavailable ? "" : rows}${!unavailable && legend.length ? `<div class="chart-legend">${legend.map(item => `<span><i class="${item.kind}" aria-hidden="true"></i>${item.label}</span>`).join("")}</div>` : ""}${points.some(point => point.setupInvalid) ? '<p class="chart-warning">The original team setup exceeded its worker cap. Its measured usage and time remain visible, but these attempts are excluded from the comparison scale.</p>' : ""}<p class="chart-inspection" id="chart-inspection" role="status">${unavailable ? "No measured values are plotted." : "Select or focus a trial to inspect its outcome. Two trials cannot establish a reliable ranking."}</p>`;
}
