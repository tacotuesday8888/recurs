import { Markdown, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./terminal-text.js";

const fenceOpening = /^ {0,3}(`{3,}|~{3,})/u;

/** The fence a line opens, or null. Matches the transcript's collapse rules. */
function openedFence(line: string): string | null {
  return fenceOpening.exec(line)?.[1] ?? null;
}

function closesFence(line: string, fence: string): boolean {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  let run = 0;
  while (line[index + run] === fence[0]) run += 1;
  return run >= fence.length && line.slice(index + run).trim() === "";
}

/**
 * The fence still open at `end`, scanning complete lines from `start`, which
 * must be outside a fence.
 */
function fenceAt(text: string, start: number, end: number): { readonly fence: string; readonly line: string } | null {
  let open: { fence: string; line: string } | null = null;
  let lineStart = start;
  while (lineStart < end) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 || newline > end ? end : newline;
    const line = text.slice(lineStart, lineEnd);
    if (open === null) {
      const fence = openedFence(line);
      if (fence !== null) open = { fence, line };
    } else if (closesFence(line, open.fence)) {
      open = null;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return open;
}

/**
 * The in-memory conversation shown by the terminal. The durable session log
 * keeps the complete history; this view keeps a bounded recent tail.
 */
export class TranscriptBuffer {
  static readonly maximumCharacters = 256 * 1024;
  // Dropping history copies the retained tail, so drop a larger slice at once
  // instead of copying on every streamed chunk.
  static readonly trimmingSlack = 32 * 1024;
  #text = "";
  #trimmed: string | null = "";
  #listener: (() => void) | null = null;

  onChange(listener: (() => void) | null): void { this.#listener = listener; }

  append(value: string): void {
    const sanitized = sanitizeTerminalText(value);
    if (sanitized.length === 0) return;
    this.#text += sanitized;
    if (this.#text.length > TranscriptBuffer.maximumCharacters) {
      this.#text = retainRecentTranscript(
        this.#text,
        TranscriptBuffer.maximumCharacters - TranscriptBuffer.trimmingSlack,
      );
    }
    this.#trimmed = null;
    this.#listener?.();
  }

  clear(): void { this.#text = ""; this.#trimmed = ""; this.#listener?.(); }

  text(): string { return this.#trimmed ??= this.#text.trimEnd(); }
}

const omittedNotice = "… earlier output omitted …\n";

/**
 * Keep about `keep` recent characters, starting at a line boundary. A cut
 * inside a fenced code block reopens that fence so its closing marker is not
 * misread as a new block that swallows the remaining conversation.
 */
function retainRecentTranscript(text: string, keep: number): string {
  let start = text.length - keep;
  const newline = text.indexOf("\n", start - 1);
  if (newline !== -1 && newline - start < 1024) start = newline + 1;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  const open = fenceAt(text, 0, start);
  const reopened = open === null ? "" : `${open.line.trim().slice(0, 80)}\n`;
  return `${omittedNotice}${reopened}${text.slice(start)}`;
}

/** Collapse complete and streaming fenced code without changing the stored transcript. */
export function collapseTerminalCode(text: string): string {
  let fence: string | null = null;
  const lines: string[] = [];
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const line = newline === -1 ? text.slice(lineStart) : text.slice(lineStart, newline);
    if (fence === null) {
      fence = openedFence(line);
      lines.push(fence === null ? line : "▸ Code · Ctrl+O expand");
    } else if (closesFence(line, fence)) {
      fence = null;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return lines.join("\n");
}

const promptMarker = "› ";

/**
 * Offsets where a new conversation turn starts: a prompt line after a blank
 * line, outside fenced code. Earlier offsets are kept when text was appended.
 */
function turnBoundaries(text: string, previous: readonly number[]): number[] {
  const boundaries = previous.length === 0 ? [0] : [...previous];
  let lineStart = boundaries.at(-1)!;
  let fence: string | null = null;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (fence === null) {
      const segmentStart = boundaries.at(-1)!;
      if (
        lineStart > segmentStart &&
        text.startsWith(promptMarker, lineStart) &&
        text.charCodeAt(lineStart - 2) === 10 &&
        text.slice(segmentStart, lineStart).trim() !== ""
      ) {
        boundaries.push(lineStart);
      } else {
        fence = openedFence(text.slice(lineStart, lineEnd));
      }
    } else if (closesFence(text.slice(lineStart, lineEnd), fence)) {
      fence = null;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return boundaries;
}

// V8 substrings can share their whole parent string. Copy retained turn text
// so a settled turn does not keep every earlier transcript version alive.
function detached(text: string): string {
  return ` ${text}`.slice(1);
}

interface TranscriptSegment {
  readonly raw: string;
  readonly markdown: Markdown;
}

/**
 * Render the transcript as one Markdown document per turn. Streaming output
 * then parses and wraps only the changing turn; settled turns reuse their
 * cached lines. Details mode renders the stored text uncollapsed.
 */
export class TranscriptView implements Component {
  #raw = "";
  #expanded = false;
  #details = "";
  #boundaries: number[] = [];
  #segments: TranscriptSegment[] = [];
  #detailsSegment: Markdown | null = null;
  #lines: { readonly width: number; readonly lines: string[] } | null = null;

  constructor(
    private readonly paddingX: number,
    private readonly theme: MarkdownTheme,
  ) {}

  update(raw: string, expanded: boolean, details: string): void {
    if (raw === this.#raw && expanded === this.#expanded && (!expanded || details === this.#details)) return;
    this.#lines = null;
    const expansionChanged = expanded !== this.#expanded;
    if (raw !== this.#raw || expansionChanged) {
      const appended = !expansionChanged && this.#boundaries.length > 0 && raw.startsWith(this.#raw);
      this.#boundaries = raw.length === 0 ? [] : turnBoundaries(raw, appended ? this.#boundaries : []);
      const previous = expansionChanged ? [] : this.#segments;
      let byText: Map<string, TranscriptSegment> | undefined;
      this.#segments = this.#boundaries.map((start, index) => {
        const segmentRaw = raw.slice(start, this.#boundaries[index + 1] ?? raw.length);
        const same = previous[index];
        if (same !== undefined && same.raw === segmentRaw) return same;
        byText ??= new Map(previous.map((segment) => [segment.raw, segment]));
        const reused = byText.get(segmentRaw);
        if (reused !== undefined) return reused;
        const copy = detached(segmentRaw);
        return { raw: copy, markdown: new Markdown(expanded ? copy : collapseTerminalCode(copy), this.paddingX, 0, this.theme) };
      });
    }
    this.#raw = raw;
    this.#expanded = expanded;
    this.#details = expanded ? details : "";
    // A leading blank line separates the details from the conversation.
    const detailsText = this.#details === "" ? null : raw === "" ? this.#details : `\n\n${this.#details}`;
    if (detailsText === null) this.#detailsSegment = null;
    else if (this.#detailsSegment === null) this.#detailsSegment = new Markdown(detailsText, this.paddingX, 0, this.theme);
    else this.#detailsSegment.setText(detailsText);
  }

  render(width: number): string[] {
    if (this.#lines?.width === width) return this.#lines.lines;
    const lines: string[] = [];
    for (const segment of this.#segments) for (const line of segment.markdown.render(width)) lines.push(line);
    if (this.#detailsSegment !== null) for (const line of this.#detailsSegment.render(width)) lines.push(line);
    this.#lines = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.#lines = null;
    for (const segment of this.#segments) segment.markdown.invalidate();
    this.#detailsSegment?.invalidate();
  }
}
