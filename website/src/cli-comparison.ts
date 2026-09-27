import { escapeHtml } from "./evidence.js";

interface Sample { readonly wallMs: number; readonly peakRssBytes: number | null; readonly valid: boolean }
interface Workload { readonly samples: readonly Sample[] }
export interface CliComparison {
  readonly protocolSha256: string;
  readonly versions: Record<string, string>;
  readonly results: Record<string, Record<string, Workload>>;
}

const products = [
  { id: "recurs", name: "Recurs" },
  { id: "codex", name: "Codex CLI" },
  { id: "claude-code", name: "Claude Code" },
] as const;

/** Validate the committed record; the page never shows numbers it cannot trace. */
export function parseCliComparison(input: unknown): CliComparison {
  const data = input as CliComparison;
  if (typeof data?.protocolSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(data.protocolSha256)) throw new Error("Protocol hash required");
  for (const product of products) {
    const long = data.results?.[product.id]?.long;
    if (!long || long.samples.length === 0) throw new Error(`Missing long-answer samples for ${product.id}`);
    for (const sample of long.samples) {
      if (typeof sample.valid !== "boolean" || !Number.isFinite(sample.wallMs) || sample.wallMs < 0) throw new Error("Invalid sample");
    }
  }
  return data;
}

const median = (values: readonly number[]): number => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

/** Every valid long-answer run as a dot on one linear axis from zero, medians marked. */
export function renderCliComparison(input: unknown): string {
  const data = parseCliComparison(input);
  const rows = products.map((product) => {
    const samples = data.results[product.id]!.long!.samples.filter((sample) => sample.valid);
    return { ...product, samples, median: median(samples.map((sample) => sample.wallMs)) };
  });
  const maximum = Math.ceil(Math.max(...rows.flatMap((row) => row.samples.map((sample) => sample.wallMs))) / 100) * 100;
  const scale = (ms: number) => (ms / maximum * 100).toFixed(2);
  const ticks = Array.from({ length: maximum / 100 + 1 }, (_, index) => index * 100);
  const recurs = rows[0]!.median;
  const lead = rows.slice(1).map((row) => `${Math.round((1 - recurs / row.median) * 100)}% less time than ${row.name}`).join(" and ");
  return `<figure class="speed-chart" aria-labelledby="speed-title">
<figcaption><h3 id="speed-title">Finishing a long streamed answer</h3><p>Identical replies from one local model server, five runs each. Recurs took ${lead}.</p></figcaption>
<div class="speed-plot" role="img" aria-label="${escapeHtml(rows.map((row) => `${row.name}: median ${row.median} milliseconds`).join("; "))}">
${rows.map((row) => `<div class="speed-row${row.id === "recurs" ? " is-recurs" : ""}"><span class="speed-name">${row.name}</span><div class="speed-track">${ticks.map((tick) => `<span class="speed-grid" style="left:${scale(tick)}%"></span>`).join("")}${row.samples.map((sample) => `<span class="speed-dot" style="left:${scale(sample.wallMs)}%" title="${sample.wallMs} ms"></span>`).join("")}<span class="speed-median" style="left:${scale(row.median)}%"></span></div><span class="speed-value">${row.median} ms</span></div>`).join("\n")}
<div class="speed-row speed-axis" aria-hidden="true"><span></span><div class="speed-track">${ticks.map((tick) => `<span class="speed-tick" style="left:${scale(tick)}%">${tick}</span>`).join("")}</div><span class="speed-unit">ms</span></div>
</div>
<p class="fine">Dots are runs; the line is the median. One of three measured workloads, headless mode, macOS arm64. <a href="https://github.com/tacotuesday8888/recurs/tree/main/benchmarks/cli-resources">Protocol and every sample</a></p>
</figure>`;
}
