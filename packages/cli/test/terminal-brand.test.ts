import {
  resetCapabilitiesCache,
  setCapabilities,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { RecursBrandComponent } from "../src/terminal-brand.js";
import { createTerminalTheme } from "../src/terminal-style.js";

afterEach(() => resetCapabilitiesCache());

describe("RecursBrandComponent", () => {
  it("uses the shipped GitHub wordmark in image-capable terminals", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const component = new RecursBrandComponent(createTerminalTheme(process.stdout, {
      colorEnabled: true,
    }));

    const rows = component.render(100);

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join("\n")).toContain("\u001b_G");
  });

  it("keeps a terminal-native Recurs wordmark when images are unavailable", () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const component = new RecursBrandComponent(createTerminalTheme(process.stdout, {
      colorEnabled: false,
    }));

    const rows = component.render(80);

    expect(rows).toHaveLength(7);
    expect(rows.join("\n")).toContain("████");
    expect(rows.every((row) => !row.includes("[Image"))).toBe(true);
  });
});
