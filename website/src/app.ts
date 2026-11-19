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

function enableCopy(button: HTMLButtonElement, source: HTMLElement, status: HTMLElement) {
  const label = button.textContent;
  let revision = 0;
  button.hidden = false;
  button.addEventListener("click", async () => {
    const current = ++revision;
    const value = source.textContent ?? "";
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      if (current !== revision) return;
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      let copied = false;
      try { copied = document.execCommand("copy"); } catch { /* Manual copy below. */ }
      if (!copied) {
        button.textContent = "Selected";
        status.textContent = "Text selected. Use your device’s Copy command.";
        status.classList.remove("sr-only");
        return;
      }
    }
    if (current !== revision) return;
    button.textContent = "Copied";
    status.classList.add("sr-only");
    status.textContent = "Copied to clipboard.";
  });
  return () => {
    revision++;
    button.textContent = label;
    status.textContent = "";
  };
}

const installCommand = document.querySelector<HTMLElement>("#install-command")!;
const installNote = document.querySelector<HTMLElement>("#install-note")!;
const resetInstallCopy = enableCopy(
  document.querySelector<HTMLButtonElement>("#copy-install")!,
  installCommand,
  document.querySelector<HTMLElement>("#copy-status")!,
);
const installCommands: Record<string, string> = {
  npm: "npm install --global recurs@alpha",
  bun: "bun install --global recurs@alpha",
  brew: "brew install tacotuesday8888/recurs/recurs",
};
const installMethods = document.querySelector<HTMLElement>(".install-methods")!;
installMethods.hidden = false;
const methodButtons = installMethods.querySelectorAll<HTMLButtonElement>("[data-install]");
methodButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const method = button.dataset.install!;
    installCommand.textContent = installCommands[method];
    resetInstallCopy();
    methodButtons.forEach((other) => other.setAttribute("aria-pressed", String(button === other)));
    installNote.textContent = method === "bun"
      ? "Bun installs Recurs. Node.js 22.22+ runs it on macOS or Linux."
      : "Node.js 22.22+ on macOS or Linux.";
  });
});

document.querySelectorAll<HTMLDetailsElement>(".starter-prompts details").forEach((task) => {
  const reset = enableCopy(
    task.querySelector<HTMLButtonElement>("button")!,
    task.querySelector<HTMLElement>("code")!,
    task.querySelector<HTMLElement>('[role="status"]')!,
  );
  task.addEventListener("toggle", () => { if (!task.open) reset(); });
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
