import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createTerminalTheme,
  renderRecursHeader,
  renderRecursWordmark,
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

describe("terminal presentation", () => {
  it("renders the loop-and-return silhouette for a color-capable TTY", () => {
    const theme = createTerminalTheme(new TerminalOutput(), {
      environment: colorEnvironment,
    });

    const wordmark = renderRecursWordmark(theme);

    expect(theme.colorEnabled).toBe(true);
    expect(wordmark.split("\n")).toHaveLength(4);
    expect(wordmark).toContain("\u001b[38;5;33m");
    expect(wordmark).toContain("\u001b[38;5;121m");
    expect(wordmark).toContain("╭");
    expect(wordmark).toContain("↰");
    expect(wordmark).toContain("╲");
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

    const header = renderRecursHeader(theme, "Welcome to Recurs");

    expect(header.split("\n")).toHaveLength(5);
    expect(header.split("\n")[4]).toContain("Welcome to Recurs");
    expect(header).toContain("Welcome to Recurs");
  });
});
