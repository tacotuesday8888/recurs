import { campaignName, context, resultRows, trialDetails, type Campaign } from "./evidence.js";

const capture = document.querySelector<HTMLImageElement>("#terminal-capture")!;
const guideResult = document.querySelector<HTMLElement>("#guide-result")!;
const views = {
  working: { file: "terminal-v19-working.svg", alt: "Recurs terminal showing active coding work and its agent floor" },
  diff: { file: "terminal-diff.svg", alt: "Actual Recurs diff review interface" },
  permission: { file: "terminal-permission.svg", alt: "Actual Recurs permission approval interface" },
};
type View = keyof typeof views;
function showView(view: View) {
  capture.src = `./assets/${views[view].file}`;
  capture.alt = views[view].alt;
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  });
}
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view as View));
});

const command = document.querySelector<HTMLInputElement>("#command")!;
const history: string[] = [];
let historyIndex = 0;
const commands: Record<string, { view?: View; message: string }> = {
  "/agents": { view: "working", message: "/agents opens your agent controls and activity in Recurs. This is a capture of the working terminal." },
  "/diff": { view: "diff", message: "/diff opens the code review interface in Recurs. This is an actual terminal capture." },
  "/permissions": { view: "permission", message: "/permissions manages your policy in Recurs. This capture shows a file-change approval prompt." },
  "/help": { message: "Explore /agents, /diff, or /permissions. This browser guide displays captures; it does not run commands or call a model." },
};
document.querySelector("#command-guide")!.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = command.value.trim();
  if (!value) return;
  history.push(value);
  if (history.length > 50) history.shift();
  historyIndex = history.length;
  const entry = commands[value];
  if (entry?.view) showView(entry.view);
  guideResult.textContent = entry?.message ?? "This guide supports /agents, /diff, /permissions, and /help. Run Recurs locally for the full CLI.";
  command.value = "";
});
command.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === "ArrowUp" ? -1 : 1)));
  command.value = history[historyIndex] ?? "";
});

const installCommand = document.querySelector<HTMLElement>("#install-command")!;
const installNote = document.querySelector<HTMLElement>("#install-note")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy-install")!;
const installCommands: Record<string, string> = { npm: "npm install --global recurs@alpha", bun: "bun install --global recurs@alpha", brew: "brew install tacotuesday8888/recurs/recurs" };
document.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((button) => {
  button.addEventListener("click", () => {
    const method = button.dataset.install!;
    installCommand.textContent = installCommands[method]!;
    copyButton.textContent = "Copy";
    document.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((other) => other.setAttribute("aria-pressed", String(button === other)));
    installNote.firstChild!.textContent = method === "bun" ? "Bun installs the package; Node.js 22.22+ runs Recurs. " : "Node.js 22.22+ · macOS or Linux. ";
  });
});
copyButton.addEventListener("click", () => {
  const status = document.querySelector<HTMLElement>("#copy-status")!;
  void navigator.clipboard?.writeText(installCommand.textContent!)
    .then(() => { status.textContent = "Installation command copied."; copyButton.textContent = "Copied"; })
    .catch(() => { status.textContent = "Copy unavailable. Select and copy the command above."; copyButton.textContent = "Select text"; });
  if (!navigator.clipboard) status.textContent = "Copy unavailable. Select and copy the command above.";
});

async function loadEvidence() {
  const select = document.querySelector<HTMLSelectElement>("#campaign")!;
  try {
    const response = await fetch("./summary.json");
    if (!response.ok) throw new Error("Evidence unavailable");
    const campaigns = await response.json() as Campaign[];
    select.addEventListener("change", () => {
      const campaign = campaigns.find((item) => item.id === select.value);
      if (!campaign) return;
      document.querySelector("#results-body")!.innerHTML = resultRows(campaign);
      document.querySelector("#campaign-context")!.textContent = context(campaign);
      document.querySelector("#trial-details")!.innerHTML = trialDetails(campaign);
      select.setAttribute("aria-label", `Explore a campaign: ${campaignName(campaign)}`);
    });
    select.disabled = false;
  } catch {
    select.disabled = true;
    document.querySelector("#campaign-context")!.append(" · Interactive data unavailable; the default result remains below.");
  }
}
void loadEvidence();
