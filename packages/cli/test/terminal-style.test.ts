import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createTerminalTheme,
  renderChoiceList,
  renderOperatingMode,
  renderRecursHeader,
  renderRecursWordmark,
  renderSetupStep,
  wrapTerminalText,
} from "../src/terminal-style.js";

class TerminalOutput extends Writable {
  readonly isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

const colorEnvironment = Object.freeze({ TERM: "xterm-256color" });
const ansi256Pattern = new RegExp(
  String.raw`\u001B\[38;5;(\d+)m`,
  "gu",
);

describe("terminal presentation", () => {
  it("renders the full pixel wordmark for a wide color-capable TTY", () => {
    const theme = createTerminalTheme(new TerminalOutput(), {
      environment: colorEnvironment,
    });

    const wordmark = renderRecursWordmark(theme, { columns: 80 });
    const plain = wordmark.replaceAll(ansi256Pattern, "").replaceAll(
      "\u001b[0m",
      "",
    );

    expect(theme.colorEnabled).toBe(true);
    const rows = plain.split("\n");
    expect(rows.map((row) => row.trim())).toEqual([
      "████   █████   ████  █   █  ████   ████",
      "█   █  █      █      █   █  █   █  █",
      "█   █  █      █      █   █  █   █  █",
      "████   ████   █      █   █  ████    ███",
      "█ █    █      █      █   █  █ █        █",
      "█  █   █      █      █   █  █  █       █",
      "█   █  █████   ████   ███   █   █  ████",
    ]);
    expect(rows.map((row) => row.indexOf("█"))).toEqual([
      23, 22, 21, 20, 19, 18, 17,
    ]);
    expect(wordmark).toContain("\u001b[38;5;33m");
    expect(wordmark).toContain("\u001b[38;5;118m");
  });

  it("keeps the returning-loop mark when the terminal is narrow", () => {
    const theme = createTerminalTheme(new TerminalOutput(), {
      environment: colorEnvironment,
    });

    const wordmark = renderRecursWordmark(theme, { columns: 32 });

    expect(wordmark.split("\n")).toHaveLength(4);
    expect(wordmark).toContain("◀");
    expect(wordmark.match(/█/g)?.length).toBeGreaterThan(4);
    expect(wordmark.match(/▀/g)?.length).toBeGreaterThan(3);
    const plain = wordmark.replaceAll(ansi256Pattern, "").replaceAll(
      "\u001b[0m",
      "",
    );
    expect(plain.split("\n").map((row) => row.search(/[▗█▜◀]/u)))
      .toEqual([14, 13, 12, 11]);
  });

  it.each([
    ["non-TTY output", new Writable({ write(_chunk, _encoding, done) { done(); } }), colorEnvironment],
    ["NO_COLOR", new TerminalOutput(), { TERM: "xterm-256color", NO_COLOR: "1" }],
    ["CLICOLOR=0", new TerminalOutput(), { TERM: "xterm-256color", CLICOLOR: "0" }],
    ["a dumb terminal", new TerminalOutput(), { TERM: "dumb" }],
  ])("keeps %s plain and escape-free", (_name, output, environment) => {
    const theme = createTerminalTheme(output, { environment });

    expect(theme.colorEnabled).toBe(false);
    expect(theme.accent("Recurs")).toBe("Recurs");
    expect(renderRecursWordmark(theme)).toBe("");
  });

  it("keeps semantic labels intact when color is enabled", () => {
    const theme = createTerminalTheme(new TerminalOutput(), {
      environment: colorEnvironment,
    });

    expect(theme.success("✓ Verified")).toContain("✓ Verified");
    expect(theme.warning("Warning: retrying")).toContain("Warning: retrying");
    expect(theme.failure("Error: unavailable")).toContain("Error: unavailable");
  });

  it("stacks the readable title beneath the compact mark", () => {
    const theme = createTerminalTheme(new TerminalOutput(), {
      environment: colorEnvironment,
    });

    const header = renderRecursHeader(theme, "Welcome to Recurs", {
      columns: 80,
    });

    expect(header.split("\n")).toHaveLength(8);
    expect(header.split("\n")[7]).toContain("Welcome to Recurs");
    expect(header).toContain("Welcome to Recurs");
  });

  it("gives Max an explicit seven-color identity without making color the label", () => {
    const theme = createTerminalTheme(new TerminalOutput(), {
      environment: colorEnvironment,
    });

    const rendered = renderOperatingMode(theme, "max_v6", "Max");

    expect(rendered).toContain("M");
    expect(rendered).toContain("A");
    expect(rendered).toContain("X");
    expect(new Set(
      [...rendered.matchAll(ansi256Pattern)]
        .map((match) => match[1]),
    ).size).toBeGreaterThanOrEqual(3);
  });

  it("keeps Max and setup progress readable without color", () => {
    const theme = createTerminalTheme(new TerminalOutput(), {
      environment: { TERM: "xterm-256color", NO_COLOR: "1" },
    });

    expect(renderOperatingMode(theme, "max_v6", "Max")).toBe("MAX");
    expect(renderSetupStep(theme, 1, 6, "Parent model"))
      .toBe("01/06  PARENT MODEL");
  });

  it("wraps copy to a narrow terminal without breaking words", () => {
    expect(
      wrapTerminalText(
        "The best coding model is a team. You control the team.",
        23,
      ),
    ).toEqual([
      "The best coding model",
      "is a team. You control",
      "the team.",
    ]);
  });

  it("bounds long model identifiers that cannot wrap at spaces", () => {
    const lines = wrapTerminalText("PARENT model-with-a-very-long-id", 12);

    expect(lines.every((line) => Array.from(line).length <= 12)).toBe(true);
    expect(lines.join("")).toContain("model-with-a-very-long-id");
  });

  it("renders setup choices with scannable numeric anchors", () => {
    const theme = createTerminalTheme(new TerminalOutput(), {
      environment: { TERM: "xterm-256color", NO_COLOR: "1" },
    });

    expect(renderChoiceList(theme, [
      { label: "Approved for Me", detail: "ask before consequential actions" },
      { label: "Ask Always", detail: "confirm every command" },
    ])).toBe([
      "  01  Approved for Me",
      "      ask before consequential actions",
      "  02  Ask Always",
      "      confirm every command",
    ].join("\n"));
  });
});
