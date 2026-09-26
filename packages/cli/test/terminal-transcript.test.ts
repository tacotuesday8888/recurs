import { describe, expect, it, vi } from "vitest";
import { Markdown, TUI, type MarkdownTheme, type Terminal } from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "../src/terminal-text.js";
import {
  TranscriptBuffer,
  TranscriptView,
  collapseTerminalCode,
} from "../src/terminal-transcript.js";
import { ChatComponent } from "../src/terminal-ui.js";

// Previous implementations, kept as oracles for the faster versions.
function referenceSanitize(text: string, multiline = true): string {
  return [...text].flatMap((character) => {
    if (character === "\n") return multiline ? [character] : [];
    if (character === "\t") return multiline ? ["  "] : [];
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f) ? [character] : [];
  }).join("");
}

function referenceCollapse(text: string): string {
  let fence: string | null = null;
  return text.split("\n").flatMap((line) => {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence === null) {
      if (!opening) return [line];
      fence = opening[1]!;
      return ["▸ Code · Ctrl+O expand"];
    }
    if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`, "u").test(line)) fence = null;
    return [];
  }).join("\n");
}

const theme: MarkdownTheme = {
  heading: (text) => `#${text}`, link: (text) => text, linkUrl: (text) => text,
  code: (text) => `\`${text}\``, codeBlock: (text) => text, codeBlockBorder: (text) => text,
  quote: (text) => text, quoteBorder: (text) => text, hr: (text) => text,
  listBullet: (text) => text, bold: (text) => `*${text}*`, italic: (text) => text,
  strikethrough: (text) => text, underline: (text) => text,
};

function wholeDocument(raw: string, expanded = false, details = ""): string[] {
  const text = expanded ? [raw, details].filter(Boolean).join("\n\n") : collapseTerminalCode(raw);
  return new Markdown(text, 1, 0, theme).render(72);
}

const turns = [
  "\n› Review parser.ts\n",
  "## Parser review\n\nThe parser splits comma-separated entries.\n\n- whitespace\n- empty entries\n  continued item\n\n1. first\n2. second\n\n",
  "\n› show code\n",
  "Here is the fix:\n\n```ts\nexport const parse = (input: string) =>\n  input.split(\",\");\n\n› not a prompt inside code\n```\n\nDone.\n\n",
  "\n› table please\n",
  "| a | b |\n| - | - |\n| 1 | 2 |\n\n> quoted **text**\n\n---\n\nAfter the rule.\n\n",
  "\n› unfinished code\n",
  "Streaming:\n\n~~~js\nconst open = true;\n",
];

describe("terminal transcript", () => {
  it("sanitizes exactly like code-point filtering", () => {
    const samples: string[] = [];
    for (let codePoint = 0; codePoint < 0x3000; codePoint += 1) samples.push(String.fromCodePoint(codePoint));
    samples.push("🙂", "界面", "\ud800", "\udc00x", "a\tb\nc\r\u001b[31mred\u001b[0m\u009b2J", "  ﻿");
    const text = samples.join("");
    expect(sanitizeTerminalText(text)).toBe(referenceSanitize(text));
    expect(sanitizeTerminalText(text, { multiline: false })).toBe(referenceSanitize(text, false));
    for (const sample of samples) {
      expect(sanitizeTerminalText(sample)).toBe(referenceSanitize(sample));
      expect(sanitizeTerminalText(sample, { multiline: false })).toBe(referenceSanitize(sample, false));
    }
  });

  it("collapses code exactly as before", () => {
    const lines = ["prose", "```", "```ts", "````", "   ```js title", "    ```not a fence", "~~~", "~~~~ info", "``", "code();", "```  ", "~~~~", "", " ```", "`````"];
    let seed = 7;
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    for (let sample = 0; sample < 2_000; sample += 1) {
      const text = Array.from({ length: 1 + Math.floor(random() * 12) }, () => lines[Math.floor(random() * lines.length)]).join("\n");
      expect(collapseTerminalCode(text)).toBe(referenceCollapse(text));
    }
    expect(collapseTerminalCode(turns.join(""))).toBe(referenceCollapse(turns.join("")));
  });

  it("drops old output in amortized steps from a line boundary", () => {
    const buffer = new TranscriptBuffer();
    const cuts: number[] = [];
    let previous = "";
    for (let index = 0; index < 4_000; index += 1) {
      buffer.append(`line ${index}: ${"x".repeat(90)}\n`);
      const text = buffer.text();
      expect(text.length).toBeLessThanOrEqual(TranscriptBuffer.maximumCharacters);
      if (!text.startsWith(previous.slice(0, 40))) cuts.push(index);
      previous = text;
    }
    // One copy per slack-sized batch of output, not one per appended chunk.
    expect(cuts.length).toBeLessThan(4_000 * 100 / TranscriptBuffer.trimmingSlack + 2);
    const [notice, first] = buffer.text().split("\n");
    expect(notice).toBe("… earlier output omitted …");
    expect(first).toMatch(/^line \d+: x+$/u);
    expect(buffer.text()).toContain("line 3999:");
    expect(buffer.text()).toBe(buffer.text());
  });

  it("reopens a fenced block that the retained tail starts inside", () => {
    const buffer = new TranscriptBuffer();
    buffer.append("Intro\n\n```python title\n");
    buffer.append(Array.from({ length: 30_000 }, (_, index) => `print(${index})\n`).join(""));
    buffer.append("```\n\nAfter the code.\n");
    const text = buffer.text();
    expect(text.startsWith("… earlier output omitted …\n```python title\nprint(")).toBe(true);
    expect(collapseTerminalCode(text)).toBe("… earlier output omitted …\n▸ Code · Ctrl+O expand\n\nAfter the code.");
  });

  it("renders turns separately exactly like one document while streaming", () => {
    const raw = turns.join("");
    const view = new TranscriptView(1, theme);
    let streamed = "";
    for (const piece of raw.match(/[\s\S]{1,7}/gu) ?? []) {
      streamed += piece;
      const current = streamed.trimEnd();
      view.update(current, false, "");
      expect(view.render(72)).toEqual(wholeDocument(current));
    }
    const complete = `${raw}~~~\n\nFinished.`;
    view.update(complete, true, "## Details\n\nRead parser.ts");
    expect(view.render(72)).toEqual(wholeDocument(complete, true, "## Details\n\nRead parser.ts"));
    view.update(complete, false, "");
    expect(view.render(40)).toEqual(new Markdown(collapseTerminalCode(complete), 1, 0, theme).render(40));
  });

  it("keeps expanded details outside a code block that is still streaming", () => {
    const view = new TranscriptView(1, theme);
    view.update(turns.join("").trimEnd(), true, "## Details\n\nRead parser.ts");
    const lines = view.render(72).map((line) => line.trimEnd());
    expect(lines).toContain(" #*Details*");
    expect(lines.at(-1)).toBe(" Read parser.ts");
  });

  it("reuses settled turns when earlier output is dropped", () => {
    const view = new TranscriptView(1, theme);
    const history = Array.from({ length: 30 }, (_, index) => `\n› turn ${index}\n\nReply ${index} with **bold** text.\n`).join("");
    view.update(history.trimEnd(), false, "");
    const before = view.render(72);
    // Markdown renders tokens only on a cache miss.
    const tokens = vi.spyOn(Markdown.prototype as unknown as { renderToken(): string[] }, "renderToken");
    const cut = history.indexOf("\n› turn 3\n");
    const shifted = `… earlier output omitted …\n${history.slice(cut)}`.trimEnd();
    view.update(shifted, false, "");
    const after = view.render(72);
    // Only the first, truncated turn is parsed again.
    expect(tokens.mock.calls.length).toBeLessThanOrEqual(4);
    tokens.mockRestore();
    expect(after).toEqual(wholeDocument(shifted));
    expect(before.length).toBeGreaterThan(after.length);
  });

  it("defers transcript processing from streamed chunks to the next frame", () => {
    const terminal = { columns: 60, rows: 12, write() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
    const buffer = new TranscriptBuffer();
    const chat = new ChatComponent(new TUI(terminal), buffer, { model: "model", mode: "balanced", permission: "ask_always" }, [], "/tmp", false, () => terminal.rows);
    chat.render(60);
    const update = vi.spyOn(TranscriptView.prototype, "update");
    for (let index = 0; index < 500; index += 1) buffer.append(`chunk ${index} `);
    expect(update).not.toHaveBeenCalled();
    expect(chat.render(60).join("\n")).toContain("chunk 499");
    expect(update).toHaveBeenCalledTimes(1);
    update.mockRestore();
  });
});
