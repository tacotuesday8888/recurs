/** Decorative motion only: native scroll position and input events are untouched. */
export function installPageMotion(onPause: () => void) {
  const root = document.documentElement;
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  const toggle = document.querySelector<HTMLButtonElement>("#motion-toggle")!;
  const progress = document.querySelector<HTMLElement>(".scroll-progress span")!;
  const ornament = document.querySelector<HTMLElement>(".brand-drift")!;
  let paused = false;
  try { paused = sessionStorage.getItem("recurs-motion-paused") === "true"; } catch { /* Storage can be unavailable in private contexts. */ }
  let keyboard = false;
  let frame = 0;
  let lastTime = 0;
  let current = 0;
  let scrollRange = 1;
  const reveals = new Set<Animation>();
  const enabled = () => !paused && !preference.matches && !document.hidden;
  const target = () => Math.max(0, Math.min(1, scrollY / scrollRange));
  const paint = () => {
    progress.style.transform = `scaleX(${current})`;
    ornament.style.transform = `rotate(${current * 1080}deg)`;
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    for (const animation of reveals) animation.cancel();
    reveals.clear();
  };
  const animate = (now: number) => {
    frame = 0;
    if (!enabled()) return;
    const elapsed = lastTime === 0 ? 16 : Math.min(48, now - lastTime);
    lastTime = now;
    const destination = target();
    current += (destination - current) * (1 - Math.exp(-elapsed / 110));
    if (Math.abs(destination - current) < 0.0005) current = destination;
    paint();
    if (current !== destination) frame = requestAnimationFrame(animate);
    else lastTime = 0;
  };
  const update = () => {
    if (!enabled()) return;
    if (keyboard) { stop(); current = target(); paint(); }
    else if (frame === 0) frame = requestAnimationFrame(animate);
  };
  const measure = () => { scrollRange = Math.max(1, document.documentElement.scrollHeight - innerHeight); update(); };
  const sync = () => {
    stop();
    root.classList.toggle("motion-enabled", enabled());
    toggle.hidden = false;
    toggle.disabled = preference.matches;
    toggle.textContent = preference.matches ? "Motion off" : paused ? "Resume motion" : "Pause motion";
    toggle.setAttribute("aria-pressed", String(paused || preference.matches));
    if (enabled()) { current = target(); paint(); }
    else { progress.style.transform = "scaleX(0)"; ornament.style.transform = "none"; onPause(); }
  };
  toggle.addEventListener("click", () => {
    paused = !paused;
    try { sessionStorage.setItem("recurs-motion-paused", String(paused)); } catch { /* Motion controls still work without storage. */ }
    sync();
  });
  preference.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  // Read-only, passive listeners. The rAF loop interpolates decoration; it is not scroll throttling.
  document.addEventListener("scroll", update, { passive: true });
  document.addEventListener("wheel", () => { keyboard = false; }, { passive: true });
  document.addEventListener("touchstart", () => { keyboard = false; }, { passive: true });
  document.addEventListener("keydown", () => { keyboard = true; update(); });
  document.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest('a[href^="#"]')) { keyboard = true; update(); }
  });
  addEventListener("resize", measure, { passive: true });
  addEventListener("pageshow", () => { measure(); current = target(); if (enabled()) paint(); });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(measure).observe(document.body);
  if (typeof IntersectionObserver !== "undefined") {
    new IntersectionObserver(([entry]) => {
      root.classList.toggle("brand-in-view", entry?.isIntersecting ?? false);
    }).observe(ornament);
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (!enabled() || keyboard) continue;
        const animation = entry.target.animate([
          { opacity: 0.65, transform: "translateY(12px)" },
          { opacity: 1, transform: "translateY(0)" },
        ], { duration: 480, easing: "cubic-bezier(0.16,1,0.3,1)" });
        reveals.add(animation);
        void animation.finished.then(() => reveals.delete(animation)).catch(() => {});
      }
    }, { threshold: 0.4 });
    document.querySelectorAll("[data-scroll-reveal]").forEach(element => observer.observe(element));
  }
  measure();
  sync();
}
