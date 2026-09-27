import { installPageMotion } from "./motion.js";
const capture = document.querySelector<HTMLImageElement>("#terminal-capture")!;
const recording = document.querySelector<HTMLVideoElement>("#workflow-recording")!;
const recordingControl = document.querySelector<HTMLButtonElement>("#recording-control")!;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
recording.muted = true;
recordingControl.hidden = false;
function showPoster() {
  recording.pause();
  recording.hidden = true;
  capture.hidden = false;
}
async function playRecording() {
  if (recording.ended) recording.currentTime = 0;
  recording.hidden = false;
  capture.hidden = true;
  try { await recording.play(); }
  catch { showPoster(); recordingControl.textContent = "Play demo"; }
}
recording.addEventListener("play", () => { recordingControl.textContent = "Pause demo"; });
recording.addEventListener("pause", () => { recordingControl.textContent = "Resume demo"; });
recording.addEventListener("ended", () => { showPoster(); recordingControl.textContent = "Replay demo"; });
recording.addEventListener("error", () => { showPoster(); recordingControl.textContent = "Demo unavailable"; recordingControl.disabled = true; });
recordingControl.addEventListener("click", () => {
  if (recording.paused) void playRecording(); else recording.pause();
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) { showPoster(); recordingControl.textContent = "Play demo"; }
});
// Start the recorded demo only when requested; the hero R is the sole automatic motion.
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
function selectCommand(): void {
  const range = document.createRange();
  range.selectNodeContents(installCommand);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
copyButton.addEventListener("click", () => {
  const status = document.querySelector<HTMLElement>("#copy-status")!;
  const copied = () => { status.textContent = "Installation command copied."; copyButton.textContent = "Copied"; };
  // Without clipboard access, select the command and try the legacy copy path.
  const fallback = () => {
    selectCommand();
    let legacy = false;
    try { legacy = document.execCommand("copy"); } catch { /* Unsupported. */ }
    if (legacy) { copied(); return; }
    status.textContent = "Command selected. Press Command-C or Ctrl+C to copy it.";
    copyButton.textContent = "Selected";
  };
  if (navigator.clipboard === undefined) { fallback(); return; }
  void navigator.clipboard.writeText(installCommand.textContent!).then(copied, fallback);
});

installPageMotion(() => { showPoster(); recordingControl.textContent = "Play demo"; });

document.querySelectorAll<HTMLButtonElement>("[data-inspect-task]").forEach(button => {
  button.addEventListener("click", () => {
    const evidence = document.querySelector<HTMLDetailsElement>(".product-evidence-details");
    const task = document.querySelector<HTMLElement>(`[data-product-task="${button.dataset.inspectTask}"]`);
    const attempts = task?.querySelector<HTMLDetailsElement>(".product-attempts");
    if (!evidence || !task || !attempts) return;
    evidence.open = true;
    attempts.open = true;
    const result = document.getElementById(button.getAttribute("aria-controls") ?? "");
    const target = result ?? attempts.querySelector("summary");
    target?.focus({ preventScroll: true });
    (result ?? task).scrollIntoView({ block: "start", behavior: "instant" });
  });
});
