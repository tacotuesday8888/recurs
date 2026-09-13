import {
  resetCapabilitiesCache,
  visibleWidth,
  setCapabilities,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { RECURS_PALETTE } from "../src/generated/recurs-brand.js";
import { RecursBrandComponent } from "../src/terminal-brand.js";
import { createTerminalTheme } from "../src/terminal-style.js";

afterEach(() => resetCapabilitiesCache());

describe("RecursBrandComponent", () => {
  it("uses native theme-aware lettering even in image-capable terminals", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const component = new RecursBrandComponent(createTerminalTheme(process.stdout, {
      colorEnabled: true,
    }));

    const rows = component.render(100);

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join("\n")).not.toContain("\u001b_G");
    expect(rows.join("\n")).toContain("█▀▄");
  });

  it("keeps a terminal-native Recurs wordmark when images are unavailable", () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const component = new RecursBrandComponent(createTerminalTheme(process.stdout, {
      colorEnabled: false,
    }));

    const rows = component.render(80);

    expect(rows).toHaveLength(3);
    expect(rows.join("\n")).toContain("█▀▄");
    expect(rows.every((row) => !row.includes("[Image"))).toBe(true);
  });
  it.each([1, 4, 12, 22, 23, 24, 80])("fits native lettering into %i columns", (width) => {
    const component = new RecursBrandComponent(createTerminalTheme(process.stdout, { colorEnabled: false }));
    expect(component.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
  });
});

it("maps the orange terminal preset to the shared brand palette", () => {
  const theme = createTerminalTheme(process.stdout, { colorEnabled: true, appearance: { version: 1, theme: "orange" } });
  const rgb = (hex: string, background = false) => `\u001b[${background ? 48 : 38};2;${[1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(";")}m`;
  expect(theme.frame("R")).toBe(`${rgb(RECURS_PALETTE.background, true)}${rgb(RECURS_PALETTE.foreground)}R\u001b[0m`);
  for (const [render, color] of [[theme.accent, RECURS_PALETTE.orange], [theme.muted, RECURS_PALETTE.muted], [theme.code, RECURS_PALETTE.highlight]] as const) {
    expect(render("R")).toBe(`${rgb(color)}R\u001b[0m`);
  }
});
