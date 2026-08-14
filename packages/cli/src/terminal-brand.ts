import {
  getCellDimensions,
  Image,
  getCapabilities,
  type Component,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";

import {
  renderRecursBrandRows,
  type TerminalTheme,
} from "./terminal-style.js";

const WORDMARK_FILE = "recurs-wordmark.png";
const WORDMARK_SOURCE_FILE = "recurs-wordmark-terminal.png";
const WORDMARK_MAX_WIDTH = 72;
const WORDMARK_MAX_HEIGHT = 9;
const WORDMARK_WIDTH_PX = 600;
const WORDMARK_HEIGHT_PX = 199;

let wordmarkBase64: string | null | undefined;

function loadWordmark(): string | null {
  if (wordmarkBase64 !== undefined) return wordmarkBase64;
  const candidates = [
    new URL(`../../../docs/assets/${WORDMARK_SOURCE_FILE}`, import.meta.url),
    new URL(`./${WORDMARK_FILE}`, import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      wordmarkBase64 = readFileSync(candidate).toString("base64");
      return wordmarkBase64;
    } catch {
      // Source builds and installed packages place the reviewed asset differently.
    }
  }
  wordmarkBase64 = null;
  return null;
}

export class RecursBrandComponent implements Component {
  readonly #image: Image | null;

  constructor(
    private readonly theme: TerminalTheme,
    private readonly centered = true,
  ) {
    const base64 = getCapabilities().images === null ? null : loadWordmark();
    this.#image = base64 === null
      ? null
      : new Image(base64, "image/png", {
          fallbackColor: theme.muted,
        }, {
          filename: WORDMARK_FILE,
          maxWidthCells: WORDMARK_MAX_WIDTH,
          maxHeightCells: WORDMARK_MAX_HEIGHT,
        }, {
          widthPx: WORDMARK_WIDTH_PX,
          heightPx: WORDMARK_HEIGHT_PX,
        });
  }

  invalidate(): void {
    this.#image?.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.#image !== null) {
      const rows = this.#image.render(safeWidth);
      if (!this.centered) return rows;
      const maximumWidth = Math.min(
        WORDMARK_MAX_WIDTH,
        Math.max(1, safeWidth - 2),
      );
      const cells = getCellDimensions();
      const scale = Math.min(
        (maximumWidth * cells.widthPx) / WORDMARK_WIDTH_PX,
        (WORDMARK_MAX_HEIGHT * cells.heightPx) / WORDMARK_HEIGHT_PX,
      );
      const imageWidth = Math.max(
        1,
        Math.floor((WORDMARK_WIDTH_PX * scale) / cells.widthPx),
      );
      const padding = " ".repeat(Math.max(0, Math.floor((safeWidth - imageWidth) / 2)));
      return rows.map((row) => row.length === 0 ? row : `${padding}${row}`);
    }
    return renderRecursBrandRows(safeWidth).map((row, index) => {
      const value = row.trimEnd();
      const padding = this.centered
        ? " ".repeat(Math.max(
            0,
            Math.floor((safeWidth - Array.from(value).length) / 2),
          ))
        : "";
      return `${padding}${this.theme.brand(value, index)}`;
    });
  }

  handleInput(): void {}
}
