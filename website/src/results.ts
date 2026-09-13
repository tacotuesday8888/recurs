import { type Campaign } from "./evidence.js";

const tasks = [
  { scenario: "options_precedence", version: 1, title: "A small code change", description: "Make command-line options override saved settings.", finding: "Both setups finished both attempts. The team took longer." },
  { scenario: "queue_cancellation", version: 1, title: "A bug fix across two files", description: "Keep a work queue running correctly when tasks fail or get cancelled.", finding: "The single agent finished both attempts. The team failed the checks twice." },
  { scenario: "workspace_maintenance", version: 2, title: "Three related utility fixes", description: "Fix file paths, environment settings, and sensitive-text masking together.", finding: "The team finished both attempts. The single agent finished one." },
];

function count(value: number): string {
  const final = new Intl.NumberFormat("en-US").format(value);
  return `<span class="count-value"><span class="sr-only">${final}</span><span aria-hidden="true" data-count-to="${value}">${final}</span></span>`;
}
export function taskResults(campaigns: Campaign[]): string {
  return tasks.map(task => {
    const campaign = campaigns.find(item => item.scenario === task.scenario && item.scenarioVersion === task.version && item.launchProtocolRevision === "company-benchmark-parent-only-v2");
    if (!campaign) throw new Error(`Missing public task result: ${task.scenario} v${task.version}`);
    const arms = ["single-strong", "company-auto"].map(id => {
      const arm = campaign.arms.find(item => item.id === id);
      if (!arm) throw new Error(`Missing configuration: ${id}`);
      return arm;
    });
    const row = (label: string, values: string[], className = "") => `<tr class="${className}"><th scope="row">${label}</th>${values.map(value => `<td>${value}</td>`).join("")}</tr>`;
    return `<article class="task-result" data-scroll-reveal data-task="${task.scenario}">
      <div class="task-story"><h3>${task.title}</h3><p>${task.description}</p><p class="task-finding">${task.finding}</p></div>
      <table class="task-comparison"><caption class="sr-only">${task.title}: single agent and team inside Recurs</caption>
        <thead><tr><th scope="col"><span class="sr-only">Measure</span></th><th scope="col">Single agent</th><th scope="col">Team</th></tr></thead>
        <tbody>
          ${row("Tasks finished", arms.map(arm => `${count(arm.passed)}<span class="count-total"> / ${arm.planned}</span>`), "completion-row")}
          ${row("Typical time", arms.map(arm => arm.medianWallClockMs === null ? "Not recorded" : `${count(Math.round(arm.medianWallClockMs / 1000))}<span class="metric-unit"> seconds</span>`))}
        </tbody>
      </table>
    </article>`;
  }).join("\n");
}
