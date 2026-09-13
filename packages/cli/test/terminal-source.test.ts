import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { TerminalSourceViewer } from "../src/terminal-source.js";
import { createTerminalTheme } from "../src/terminal-style.js";
import { effortBadge } from "../src/terminal-effort.js";
const theme = createTerminalTheme(process.stdout, { colorEnabled: true, appearance: { version: 1, theme: "orange" } });
it("preserves source, line numbers, and bounds across scrolling and resize", () => {
  let height = 12;
  const back = vi.fn(), browse = vi.fn();
  const viewer = new TerminalSourceViewer({ path: "source.ts", content: Array.from({ length: 200 }, (_, i) => `const value${i} = "界";`).join("\n"), startLine: 30, totalLines: 400 }, { theme, rows: () => height, back, browse, refresh() {} });
  expect(stripVTControlCharacters(viewer.render(80).join("\n"))).toContain('30  const value0 = "界";');
  for (const width of [1, 2, 20, 80, 120]) for (height of [1, 2, 3, 12]) {
    viewer.render(width); viewer.handleInput("\u001b[6~"); viewer.handleInput("\u001b[C");
    const lines = viewer.render(width);
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  viewer.handleInput("f"); expect(browse).toHaveBeenCalledOnce();
  viewer.handleInput("\u001b"); expect(back).toHaveBeenCalledOnce();
});
it("animates only the high-effort ornament and leaves unknown effort absent", () => {
  expect(effortBadge(undefined, theme)).toBe("");
  expect(effortBadge("low", theme, 0)).toBe(effortBadge("low", theme, 3));
  expect(effortBadge("max", theme, 0)).not.toBe(effortBadge("max", theme, 3));
});
