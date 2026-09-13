import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { highlightTerminalCode } from "../src/terminal-code.js";
import { parseTerminalDiff, TerminalDiffViewer } from "../src/terminal-diff.js";
import { TerminalActivity } from "../src/terminal-activity.js";
import { createTerminalTheme } from "../src/terminal-style.js";

const theme = createTerminalTheme(process.stdout, { colorEnabled: true, appearance: { version: 1, theme: "orange" } });
const plain = (rows: readonly string[]) => stripVTControlCharacters(rows.join("\n"));
const patch = "diff --git a/parser.ts b/parser.ts\n--- a/parser.ts\n+++ b/parser.ts\n@@ -1,2 +1,3 @@\n-oldValue\n+newValue\n+anotherValue\n context\n";

describe("terminal code review", () => {
  it("colors TypeScript tokens without changing source text", () => {
    const code = '// comment\nconst answer = "hello";\nreturn 42;';
    const colored = highlightTerminalCode(code, "ts", theme);
    expect(plain(colored)).toBe(code);
    expect(colored.join("\n")).toContain(theme.accent("const"));
    expect(colored.join("\n")).toContain(theme.success('"hello"'));
    expect(colored.join("\n")).toContain(theme.warning("42"));
    expect(colored.join("\n")).toContain(theme.muted("// comment"));
    expect(plain(highlightTerminalCode(code, "unknown", theme))).toBe(code);
  });
  it("cycles review modes with both legacy and extended-protocol Tab", () => {
    const viewer = new TerminalDiffViewer(patch, { theme, rows: () => 20, back() {}, refresh() {} });
    viewer.handleInput("\t");
    expect(plain(viewer.render(100))).toContain("Changes · Split");
    viewer.handleInput("\u001b[9u");
    expect(plain(viewer.render(100))).toContain("Changes · Original excerpt");
  });
  it("counts header-like content as changes and preserves both line numbers", () => {
    const lines = parseTerminalDiff("--- a/file\n+++ b/file\n@@ -10,2 +20,2 @@\n--- old\n+++ new\n context\n");
    expect(lines.find((line) => line.kind === "remove")).toMatchObject({ oldLine: 10, text: "--- old" });
    expect(lines.find((line) => line.kind === "add")).toMatchObject({ newLine: 20, text: "+++ new" });
    expect(lines.find((line) => line.kind === "context")).toMatchObject({ oldLine: 11, newLine: 21 });
  });
  it("switches original, updated, and split excerpts without changing the snapshot", () => {
    const back = vi.fn();
    const viewer = new TerminalDiffViewer(patch, { theme, rows: () => 24, back, refresh() {} });
    expect(plain(viewer.render(100))).toContain("+2 −1");
    viewer.handleInput("3");
    expect(plain(viewer.render(100))).toContain("oldValue");
    expect(plain(viewer.render(100))).not.toContain("newValue");
    viewer.handleInput("4");
    expect(plain(viewer.render(100))).toContain("newValue");
    expect(plain(viewer.render(100))).not.toContain("oldValue");
    viewer.handleInput("2");
    expect(plain(viewer.render(100))).toContain("│");
    expect(plain(viewer.render(40))).toContain("showing unified");
    viewer.handleInput("\u001b");
    expect(back).toHaveBeenCalledOnce();
  });
  it("keeps every mode bounded after scrolling long Unicode diffs and resizing", () => {
    let height = 24;
    const viewer = new TerminalDiffViewer(patch.repeat(200), { theme, rows: () => height, back() {}, refresh() {} });
    for (const mode of ["1", "2", "3", "4"]) for (const rows of [1, 2, 4, 12, 24]) for (const width of [1, 20, 40, 90, 160]) {
      height = rows; viewer.handleInput(mode);
      viewer.render(width); viewer.handleInput("\u001b[6~"); viewer.handleInput("\u001b[C");
      const rendered = viewer.render(width);
      expect(rendered.length).toBeLessThanOrEqual(height);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
  it("reports phases and elapsed time without assuming thinking or applied changes", () => {
    let now = 1000;
    const activity = new TerminalActivity(() => now);
    const base = { sessionId: "root", at: "2026-09-12T00:00:00Z", turnId: "turn" };
    activity.emit({ ...base, type: "turn_started", prompt: "fix" });
    expect(plain(activity.render(100, 9, 0, theme))).toContain("Waiting for model");
    now += 5000;
    activity.emit({ ...base, type: "model_reasoning_delta", text: "reported reasoning" });
    expect(plain(activity.render(100, 9, 0, theme))).toContain("Thinking · 5s");
    activity.emit({ ...base, type: "tool_started", call: { id: "patch", name: "apply_patch", arguments: { patch } } });
    expect(plain(activity.render(100, 9, 0, theme))).not.toContain("+2");
    activity.emit({ ...base, type: "tool_completed", callId: "patch", result: { output: "Applied" } });
    expect(plain(activity.render(100, 2, 0, theme))).toContain("+2 −1");
    activity.emit({ ...base, type: "turn_cancelled" });
    now += 10000;
    expect(plain(activity.render(100, 9, 0, theme))).toContain("Cancelled · 5s");
  });
});

it("navigates a multi-file diff without mixing file selection and mode keys", () => {
  const viewer = new TerminalDiffViewer(patch + patch.replaceAll("parser.ts", "second.ts"), { theme, rows: () => 9, back() {}, refresh() {} });
  viewer.render(100);
  viewer.handleInput("f");
  expect(plain(viewer.render(100))).toContain("Changed files · 2");
  viewer.handleInput("\u001b[B");
  viewer.handleInput("\r");
  const rendered = plain(viewer.render(100));
  expect(rendered).toContain("second.ts");
  expect(rendered).not.toContain("parser.ts");
});
