import { campaignName, context, resultRows, pairedRows, trialDetails, type Campaign } from "./evidence.js";

const capture = document.querySelector<HTMLImageElement>("#terminal-capture")!;
const views = {
  working: { file: "terminal-patch.svg", alt: "Recurs terminal with collapsed progress, clickable activity and a boxed composer" },
  diff: { file: "terminal-diff.svg", alt: "Actual Recurs diff review interface" },
  permission: { file: "terminal-permission.svg", alt: "Actual Recurs permission approval interface" },
};
type View = keyof typeof views;
const recording = document.querySelector<HTMLVideoElement>("#workflow-recording")!;
const recordingControl = document.querySelector<HTMLButtonElement>("#recording-control")!;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let selectedView: View = "working";
recording.muted = true;
recordingControl.hidden = false;
function showPoster() {
  recording.pause();
  recording.hidden = true;
  capture.hidden = false;
}
async function playRecording() {
  if (selectedView !== "working") return;
  if (recording.ended) recording.currentTime = 0;
  recording.hidden = false;
  capture.hidden = true;
  try { await recording.play(); }
  catch { showPoster(); recordingControl.textContent = "Play recording"; }
}
recording.addEventListener("play", () => { recordingControl.textContent = "Pause recording"; });
recording.addEventListener("pause", () => { recordingControl.textContent = "Resume recording"; });
recording.addEventListener("ended", () => { showPoster(); recordingControl.textContent = "Replay recording"; });
recording.addEventListener("error", () => { showPoster(); recordingControl.textContent = "Recording unavailable"; recordingControl.disabled = true; });
recordingControl.addEventListener("click", () => {
  if (recording.paused) void playRecording(); else recording.pause();
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) { showPoster(); recordingControl.textContent = "Play recording"; }
});
if (!reducedMotion.matches) void playRecording();
let viewRevision = 0;
function showView(view: View, pointerInitiated = false) {
  if (view === selectedView) return;
  selectedView = view;
  showPoster();
  recordingControl.hidden = view !== "working";
  recordingControl.textContent = "Play recording";
  const revision = ++viewRevision;
  capture.getAnimations().forEach((animation) => animation.cancel());
  capture.src = `./assets/${views[view].file}`;
  capture.alt = views[view].alt;
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  });
  if (pointerInitiated && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    void capture.decode().then(() => {
      if (revision !== viewRevision) return;
      capture.animate([{ opacity: 0.65 }, { opacity: 1 }], { duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    }).catch(() => {});
  }
}
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
  button.addEventListener("click", (event) => showView(button.dataset.view as View, event.detail > 0));
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
      document.querySelector("#paired-body")!.innerHTML = pairedRows(campaign);
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
