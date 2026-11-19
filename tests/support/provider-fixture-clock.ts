import { onTestFinished, vi } from "vitest";

/** Evaluate a historical provider fixture at its recorded date. IO timers stay real. */
export function useProviderFixtureClock(at: string): void {
  const now = Date.parse(at);
  if (!Number.isFinite(now)) throw new Error("Expected an ISO date for the provider fixture");
  if (vi.isFakeTimers()) {
    vi.setSystemTime(now);
    return;
  }
  vi.useFakeTimers({ toFake: ["Date"], now, shouldAdvanceTime: true });
  onTestFinished(() => { vi.useRealTimers(); });
}
