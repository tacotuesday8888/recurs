import { renderTerminalOpeningArt } from "./terminal-opening-art.js";

/** SVG text cells from the terminal's exact extruded R, cropped to the letter. */
export function terminalLetterSvg(frame = 0): string {
  return renderTerminalOpeningArt(64, 20, frame).map((row, y) => {
    let output = "", run = "", start = 0, role = 0;
    const emit = () => {
      if (run.trim()) output += `<text x="${start * 6}" y="${y * 10 + 9}" class="r-light-${role}" xml:space="preserve">${run.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</text>`;
    };
    row.slice(17, 47).forEach(({ ch, light }, x) => {
      const next = light > 0.77 ? 2 : light > 0.36 ? 1 : 0;
      if (next !== role) { emit(); run = ""; start = x; role = next; }
      run += ch;
    });
    emit();
    return output;
  }).join("");
}
