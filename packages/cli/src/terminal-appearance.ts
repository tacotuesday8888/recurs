import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { readPrivateUserConfiguration } from "./private-user-config.js";

export const TERMINAL_THEMES = ["system", "dark", "light", "contrast", "orange"] as const;
export type TerminalThemeName = typeof TERMINAL_THEMES[number];
export const TERMINAL_COLOR_ROLES = [
  "background", "foreground", "accent", "muted", "success", "warning", "failure", "code",
] as const;
export type TerminalColorRole = typeof TERMINAL_COLOR_ROLES[number];
export interface TerminalAppearance {
  readonly version: 1;
  readonly theme: TerminalThemeName;
  readonly design?: "r" | "v19";
  readonly colors?: Partial<Readonly<Record<TerminalColorRole, string>>>;
}

export function isTerminalThemeName(value: string): value is TerminalThemeName {
  return TERMINAL_THEMES.some((name) => name === value);
}

export function parseTerminalAppearance(value: unknown): TerminalAppearance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Appearance must be an object with version 1 and a theme.");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.theme !== "string" || !isTerminalThemeName(input.theme) ||
      Object.keys(input).some((key) => !["version", "theme", "colors", "design"].includes(key))) {
    throw new Error("Choose a theme: system, dark, light, contrast, or orange.");
  }
  if (input.design !== undefined && input.design !== "r" && input.design !== "v19") throw new Error("Choose a design: r or v19.");
  const base: TerminalAppearance = { version: 1 as const, theme: input.theme, ...(input.design === undefined ? {} : { design: input.design }) };
  if (input.colors === undefined) return Object.freeze(base);
  if (typeof input.colors !== "object" || input.colors === null || Array.isArray(input.colors)) {
    throw new Error("Theme colors must map color roles to #RRGGBB values.");
  }
  const colors: Partial<Record<TerminalColorRole, string>> = {};
  for (const [key, color] of Object.entries(input.colors)) {
    if (!TERMINAL_COLOR_ROLES.some((role) => role === key) || typeof color !== "string" || !/^#[0-9a-f]{6}$/iu.test(color)) {
      throw new Error("Theme colors accept only known roles and #RRGGBB values.");
    }
    colors[key as TerminalColorRole] = color.toLowerCase();
  }
  return Object.freeze({ ...base, colors: Object.freeze(colors) });
}

export async function loadTerminalAppearance(dataDirectory: string): Promise<TerminalAppearance | null> {
  const canonical = await realpath(dataDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (canonical === null) return null;
  const text = await readPrivateUserConfiguration({
    dataDirectory: canonical, filename: "appearance.json", label: "Terminal appearance", maximumBytes: 4096,
  });
  return text === null ? null : parseTerminalAppearance(JSON.parse(text));
}

/** Appearance is user-owned data, never executable theme code or project policy. */
export async function saveTerminalAppearance(dataDirectory: string, input: TerminalAppearance): Promise<void> {
  const appearance = parseTerminalAppearance(input);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const root = await realpath(dataDirectory);
  const directory = path.join(root, "config");
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink() || await realpath(directory) !== directory ||
      (process.platform !== "win32" && (details.mode & 0o077) !== 0) ||
      (process.getuid !== undefined && details.uid !== process.getuid())) {
    throw new Error("Terminal appearance directory must be private and owned by you.");
  }
  // Reject unsafe existing files instead of silently replacing user configuration.
  const existing = await lstat(path.join(directory, "appearance.json")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 ||
      (process.platform !== "win32" && (existing.mode & 0o077) !== 0) ||
      (process.getuid !== undefined && existing.uid !== process.getuid()))) {
    throw new Error("Terminal appearance must be a private, owned, single-link regular file.");
  }
  const temporary = path.join(directory, `.appearance-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(appearance, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, path.join(directory, "appearance.json"));
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
