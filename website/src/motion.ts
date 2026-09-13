import { terminalLetterSvg } from "./letter.js";

/** Native scroll is untouched. Results animate once when they enter the viewport. */
export function installPageMotion(onPause: () => void) {
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim();
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  const toggle = document.querySelector<HTMLButtonElement>("#motion-toggle")!;
  const ornament = document.querySelector<HTMLElement>(".brand-drift")!;
  const letter = ornament.querySelector<SVGElement>("svg")!;
  let idleFrame = 0;
  let spinTimer = 0;
  let brandInView = typeof IntersectionObserver === "undefined";
  let paused = false;
  try { paused = sessionStorage.getItem("recurs-motion-paused") === "true"; } catch { /* Controls work without storage. */ }
  let keyboard = Boolean(location.hash);
  let countFrame = 0;
  const reveals = new Set<Animation>();
  const counts = new Map<HTMLElement, { target: number; final: string; started: number }>();
  const number = new Intl.NumberFormat("en-US");
  const enabled = () => !paused && !preference.matches && !document.hidden;
  const renderLetter = () => {
    const phase = enabled() ? idleFrame : 0;
    letter.innerHTML = terminalLetterSvg(phase);
    letter.dataset.frame = String(phase);
  };
  const syncSpin = () => {
    clearInterval(spinTimer);
    spinTimer = 0;
    if (enabled() && brandInView) {
      renderLetter();
      // Same independent 80 ms cadence and 3D projection as the terminal.
      spinTimer = window.setInterval(() => { idleFrame += 1; renderLetter(); }, 80);
    }
  };
  const settle = () => {
    cancelAnimationFrame(countFrame);
    countFrame = 0;
    for (const [element, value] of counts) element.textContent = value.final;
    counts.clear();
    for (const animation of reveals) animation.cancel();
    reveals.clear();
  };
  const tick = (now: number) => {
    countFrame = 0;
    if (!enabled() || keyboard) { settle(); return; }
    for (const [element, value] of counts) {
      const progress = Math.min(1, Math.max(0, (now - value.started) / 650));
      element.textContent = progress === 1 ? value.final : number.format(Math.floor(value.target * (1 - (1 - progress) ** 3)));
      if (progress === 1) counts.delete(element);
    }
    if (counts.size) countFrame = requestAnimationFrame(tick);
  };
  const enter = (element: Element) => {
    if (!enabled() || keyboard) return;
    // Never hide content in CSS: no-JS, deep links, and interrupted effects keep final content.
    const animation = element.animate([{ opacity: .55, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }], {
      duration: 260, easing,
    });
    reveals.add(animation);
    void animation.finished.then(() => reveals.delete(animation)).catch(() => {});
    const started = performance.now();
    element.querySelectorAll<HTMLElement>("[data-count-to]").forEach(counter => {
      const target = Number(counter.dataset.countTo);
      if (!Number.isFinite(target) || target <= 0) return;
      counts.set(counter, { target, final: counter.textContent ?? number.format(target), started });
      counter.textContent = "0";
    });
    if (counts.size && countFrame === 0) countFrame = requestAnimationFrame(tick);
  };
  const sync = () => {
    settle();
    toggle.hidden = false;
    toggle.disabled = preference.matches;
    toggle.textContent = preference.matches ? "Animation off (system)" : paused ? "Animation off" : "Animation on";
    toggle.setAttribute("aria-label", preference.matches ? "Animation disabled by system preference" : paused ? "Turn animation on" : "Turn animation off");
    toggle.setAttribute("aria-pressed", String(paused || preference.matches));
    if (!enabled()) { renderLetter(); onPause(); }
    syncSpin();
  };
  toggle.addEventListener("click", () => {
    paused = !paused;
    try { sessionStorage.setItem("recurs-motion-paused", String(paused)); } catch { /* Controls work without storage. */ }
    sync();
  });
  preference.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  document.addEventListener("wheel", () => { keyboard = false; }, { passive: true });
  document.addEventListener("touchstart", () => { keyboard = false; }, { passive: true });
  document.addEventListener("pointerdown", () => { keyboard = false; }, { passive: true });
  document.addEventListener("keydown", () => { keyboard = true; settle(); });
  document.addEventListener("click", event => {
    if ((event.target as HTMLElement).closest('a[href^="#"]')) { keyboard = true; settle(); }
  });
  if (typeof IntersectionObserver !== "undefined") {
    new IntersectionObserver(([entry]) => { brandInView = entry?.isIntersecting ?? false; syncSpin(); }).observe(ornament);
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        enter(entry.target);
      }
    }, { threshold: .3 });
    document.querySelectorAll("[data-scroll-reveal]").forEach(element => observer.observe(element));
  }
  sync();
}
