import { stripVTControlCharacters } from "node:util";
import type { SessionListEntry } from "@recurs/core";
import type { CommandSelectionOption } from "./commands/types.js";
import { sanitizeTerminalText } from "./terminal-text.js";

let dateFormatter: Intl.DateTimeFormat | undefined;

function plainText(value: string): string {
  return sanitizeTerminalText(stripVTControlCharacters(value), { multiline: false }).replace(/\p{Bidi_Control}/gu, "").replace(/[\p{Zl}\p{Zp}]/gu, " ");
}

/** A saved title, else the first prompt, so untitled chats stay distinguishable. */
export function chatLabel(session: SessionListEntry, currentSessionId: string | null, index: number): string {
  const label = session.title ?? session.preview;
  return (label && plainText(label)) || (session.id === currentSessionId ? "Current chat" : `Recent chat ${index + 1}`);
}

/** Local date and time; the stored value stays UTC. */
export function chatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16);
  dateFormatter ??= new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return dateFormatter.format(date);
}

export function chatChoice(entry: SessionListEntry, currentId: string | null, index: number): CommandSelectionOption {
  const label = chatLabel(entry, currentId, index);
  const preview = entry.preview && plainText(entry.preview);
  const details = [plainText(entry.model), plainText(chatTime(entry.updatedAt)), `ID ${plainText(entry.id)}`];
  if (preview && preview !== label) details.push(preview);
  return {
    id: entry.id,
    label: `${entry.pinned ? "★ " : ""}${label}${entry.archived ? " · archived" : ""}`,
    detail: details.join(" · "),
    current: entry.id === currentId,
  };
}
