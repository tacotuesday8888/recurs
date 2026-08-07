document.documentElement.classList.add("has-js");

const copyButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-copy]")];
const copyStatus = document.querySelector(".copy-status");

async function copyCommand(button: HTMLButtonElement) {
  const command = button.dataset.copy;
  if (!command) return;

  let copied: boolean;
  try {
    await navigator.clipboard.writeText(command);
    copied = true;
  } catch {
    let field: HTMLTextAreaElement | undefined;
    try {
      field = document.createElement("textarea");
      field.value = command;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      field?.remove();
    }
  }

  const previous = button.textContent;
  button.textContent = copied ? "Copied" : "Copy failed";
  if (copyStatus) {
    const label = button.getAttribute("aria-label") ?? "Command";
    copyStatus.textContent = copied ? `${label} copied.` : `${label} could not be copied. Select the command manually.`;
  }
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1800);
}

copyButtons.forEach((button) => {
  button.addEventListener("click", () => void copyCommand(button));
});

const agentButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-agent]")];
const selectedName = document.querySelector("[data-selected-name]");
const selectedRole = document.querySelector("[data-selected-role]");

agentButtons.forEach((button) => {
  button.addEventListener("click", () => {
    agentButtons.forEach((agent) => {
      const selected = agent === button;
      agent.classList.toggle("is-selected", selected);
      agent.setAttribute("aria-pressed", String(selected));
    });
    if (selectedName) selectedName.textContent = button.dataset.agent ?? "Agent";
    if (selectedRole) selectedRole.textContent = button.dataset.role ?? "";
  });
});

const stage = document.querySelector<HTMLElement>("[data-product-stage]");
const companyView = document.querySelector<HTMLElement>("[data-company-view]");
const terminalView = document.querySelector<HTMLElement>("[data-terminal-view]");
const enterButton = document.querySelector<HTMLButtonElement>("[data-enter-company]");
const backButton = document.querySelector<HTMLButtonElement>("[data-back-to-map]");

function setCompanyView(view: "company" | "terminal", { focus = true } = {}) {
  const entering = view === "terminal";
  if (!companyView || !terminalView || !stage) return;
  stage.dataset.view = entering ? "terminal" : "company";
  companyView.hidden = entering;
  terminalView.hidden = !entering;
  if (enterButton) enterButton.textContent = entering ? "In company" : "Enter company ↗";
  if (focus) {
    const focusTarget = entering ? terminalView : enterButton;
    focusTarget?.focus({ preventScroll: true });
  }
}

enterButton?.addEventListener("click", () => {
  setCompanyView("terminal");
  history.replaceState(null, "", "#company");
});

backButton?.addEventListener("click", () => {
  setCompanyView("company");
  history.replaceState(null, "", "#top");
});

if (location.hash === "#company") setCompanyView("terminal", { focus: false });

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduceMotion && "IntersectionObserver" in window) {
  const revealTargets = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
  document.documentElement.classList.add("js-enhanced");
  revealTargets.forEach((target) => target.classList.add("reveal-pending"));

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.remove("reveal-pending");
      revealObserver.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.12 });

  revealTargets.forEach((target) => revealObserver.observe(target));
}
