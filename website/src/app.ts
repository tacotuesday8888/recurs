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
copyButton.addEventListener("click", () => {
  const status = document.querySelector<HTMLElement>("#copy-status")!;
  void navigator.clipboard?.writeText(installCommand.textContent!)
    .then(() => { status.textContent = "Installation command copied."; copyButton.textContent = "Copied"; })
    .catch(() => { status.textContent = "Copy unavailable. Select and copy the command above."; copyButton.textContent = "Select text"; });
  if (!navigator.clipboard) status.textContent = "Copy unavailable. Select and copy the command above.";
});

installPageMotion(() => { showPoster(); recordingControl.textContent = "Play demo"; });
