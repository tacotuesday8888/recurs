import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTerminalAppearance, parseTerminalAppearance, saveTerminalAppearance } from "../src/terminal-appearance.js";
import { createTerminalTheme, renderTerminalCanvas } from "../src/terminal-style.js";
import { TerminalThemePicker } from "../src/terminal-theme-picker.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(path.join(tmpdir(), "recurs-appearance-test-")); directories.push(directory); return directory; }
const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

describe("terminal appearance", () => {
  it("persists validated semantic colors independently of sessions", async () => {
    const root = await temporary();
    const value = parseTerminalAppearance({ version: 1, theme: "light", colors: { accent: "#AABBCC" } });
    await saveTerminalAppearance(root, value);
    expect(await loadTerminalAppearance(root)).toEqual({ version: 1, theme: "light", colors: { accent: "#aabbcc" } });
    if (process.platform !== "win32") expect((await stat(path.join(root, "config", "appearance.json"))).mode & 0o777).toBe(0o600);
  });
  it("rejects executable or terminal-control color values", () => {
    for (const colors of [{ accent: "\u001b[2J" }, { accent: "red" }, { foreground: "#fff" }, { script: "#ffffff" }]) {
      expect(() => parseTerminalAppearance({ version: 1, theme: "dark", colors })).toThrow();
    }
    expect(() => parseTerminalAppearance({ version: 1, theme: "dark", command: "run" })).toThrow();
  });
  it("does not follow configuration symlinks or overwrite their targets", async () => {
    const root = await temporary();
    await mkdir(path.join(root, "config"), { mode: 0o700 });
    const target = path.join(root, "target.json");
    await writeFile(target, "preserve", { mode: 0o600 });
    await symlink(target, path.join(root, "config", "appearance.json"));
    await expect(saveTerminalAppearance(root, { version: 1, theme: "dark" })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("preserve");
  });
  it.each(["{", ""])("allows explicit replacement of malformed but safely owned appearance data (%j)", async (contents) => {
    const root = await temporary();
    await mkdir(path.join(root, "config"), { mode: 0o700 });
    await writeFile(path.join(root, "config", "appearance.json"), contents, { mode: 0o600 });
    await expect(loadTerminalAppearance(root)).rejects.toThrow();
    await saveTerminalAppearance(root, { version: 1, theme: "system" });
    expect((await loadTerminalAppearance(root))?.theme).toBe("system");
  });
  it("honors NO_COLOR even with custom backgrounds and keeps semantic labels", () => {
    const theme = createTerminalTheme(output, { terminal: true, environment: { NO_COLOR: "", TERM: "xterm-256color" }, appearance: { version: 1, theme: "contrast" } });
    expect(renderTerminalCanvas([theme.failure("Error")], 30, 10, theme)).toEqual(["Error"]);
    expect(theme.code("const value = 1")).toBe("const value = 1");
  });
  it("restores each background after nested style resets and uses new colors live", () => {
    const theme = createTerminalTheme(output, { colorEnabled: true, appearance: { version: 1, theme: "light" } });
    const line = theme.frame(`${theme.accent("Recurs")} body`);
    expect(line).toContain("\u001b[48;2;255;255;255m");
    expect(line).toContain("\u001b[0m\u001b[48;2;255;255;255m");
    const before = theme.accent("text");
    theme.setAppearance({ version: 1, theme: "dark" });
    expect(theme.accent("text")).not.toBe(before);
  });
  it("previews without saving, restores on Escape, and keeps tiny selection visible", () => {
    const theme = createTerminalTheme(output, { colorEnabled: false });
    const current = theme.appearance;
    let saves = 0;
    const picker = new TerminalThemePicker({ theme, current, rows: () => 5, refresh() {}, preview: (value) => theme.setAppearance(value), save: async () => { saves++; }, cancel: () => theme.setAppearance(current) });
    picker.handleInput("\u001b[A");
    expect(theme.appearance.theme).toBe("orange");
    expect(picker.render(32).join("\n")).toContain("› orange");
    expect(picker.render(80).at(-1)).toContain("Esc cancel");
    expect(picker.render(32)).toHaveLength(5);
    picker.handleInput("\u001b");
    expect(theme.appearance).toEqual(current);
    expect(saves).toBe(0);
  });
  it("keeps custom colors when reselecting and saving the current theme", async () => {
    const root = await temporary();
    const current = parseTerminalAppearance({ version: 1, theme: "dark", colors: { accent: "#abcdef", code: "#fedcba" } });
    const theme = createTerminalTheme(output, { colorEnabled: false, appearance: current });
    const save = vi.fn(async (value) => saveTerminalAppearance(root, value));
    const picker = new TerminalThemePicker({ theme, current, rows: () => 6, refresh() {},
      preview: (value) => theme.setAppearance(value), save, cancel() {},
    });
    picker.handleInput("\u001b[B");
    expect(theme.appearance.theme).toBe("light");
    picker.handleInput("\u001b[A");
    expect(theme.appearance).toEqual(current);
    picker.handleInput("\r");
    await vi.waitFor(async () => expect(await loadTerminalAppearance(root)).toEqual(current));
    expect(save).toHaveBeenCalledWith(current);
  });

  it.each([2, 3, 5, 9, 10, 11])("shows async save failure and allows cancellation at %i rows", async (rows) => {
    const theme = createTerminalTheme(output, { colorEnabled: false });
    const cancel = vi.fn();
    const picker = new TerminalThemePicker({ theme, current: theme.appearance, rows: () => rows,
      refresh() {}, preview() {}, cancel,
      async save() { throw new Error("private filesystem details must not be shown"); },
    });
    picker.handleInput("\r");
    await vi.waitFor(() => expect(picker.render(40).join("\n")).toContain("Save failed"));
    expect(picker.render(40).join("\n")).not.toContain("private filesystem details");
    expect(picker.render(40).length).toBeLessThanOrEqual(rows);
    picker.handleInput("\u001b");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses hard-linked configuration without changing either copy", async () => {
    const root = await temporary();
    await mkdir(path.join(root, "config"), { mode: 0o700 });
    const target = path.join(root, "original.json");
    const file = path.join(root, "config", "appearance.json");
    await writeFile(target, '{"version":1,"theme":"dark"}', { mode: 0o600 });
    await link(target, file);
    await expect(loadTerminalAppearance(root)).rejects.toThrow();
    await expect(saveTerminalAppearance(root, { version: 1, theme: "light" })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe('{"version":1,"theme":"dark"}');
  });

  it.skipIf(process.platform === "win32")("refuses writable-by-others appearance directories", async () => {
    const root = await temporary();
    await saveTerminalAppearance(root, { version: 1, theme: "dark" });
    await chmod(path.join(root, "config"), 0o777);
    await expect(loadTerminalAppearance(root)).rejects.toThrow();
    await expect(saveTerminalAppearance(root, { version: 1, theme: "light" })).rejects.toThrow();
  });

});
