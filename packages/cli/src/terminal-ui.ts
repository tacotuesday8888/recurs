import { TerminalActivity } from "./terminal-activity.js";
import { renderTerminalOpening } from "./terminal-opening.js";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  Markdown,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  matchesKey,
  truncateToWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type EditorTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  isPinnedSessionState,
  type EventSink,
  type RecursEvent,
  type SessionListEntry,
  type AgentExecution,
} from "@recurs/core";
import {
  createHostInvocation,
  modelImagesByteLength,
  type ModelImageInput,
} from "@recurs/contracts";
import type { ApprovalResponse } from "@recurs/tools";
import path from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { Writable, type Readable } from "node:stream";

import type { CommandResult } from "./commands/types.js";
import { parseCommand } from "./commands/parser.js";
import { loadTerminalAppearance, saveTerminalAppearance, isTerminalThemeName, parseTerminalAppearance, TERMINAL_COLOR_ROLES, type TerminalAppearance } from "./terminal-appearance.js";
import { TerminalChoicePicker } from "./terminal-choice-picker.js";
import { TerminalThemePicker } from "./terminal-theme-picker.js";
import { ExecutionInspector } from "./terminal-execution-inspector.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { loadImageInputs } from "./image-input.js";
import { TextEventRenderer, renderCommandResult } from "./render.js";
import {
  interactiveImagePath,
  replApprovalResponse,
  stagedImagesText,
} from "./repl.js";
import { isCancellation, type RecursRuntime } from "./runtime.js";
import {
  attachOwnedTerminalProcess,
  type ProcessAttachmentHost,
} from "./terminal-attach.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import {
  createTerminalTheme,
  formatTerminalLabel,
  renderTerminalCanvas,
  wrapTerminalText,
  type TerminalTheme,
} from "./terminal-style.js";
import {
  TerminalUiState,
  renderCompanyHome,
  type TerminalCompanyNodeView,
  type TerminalAgentView,
} from "./terminal-ui-state.js";

export type InteractiveTerminal = Terminal;

export interface LaunchViewModel {
  readonly workspace: string;
  readonly currentSessionId: string | null;
  readonly sessions: readonly SessionListEntry[];
}

export interface LaunchActions {
  readonly openSession: (sessionId: string) => void;
  readonly newProject: () => void;
  readonly quit: () => void;
  readonly refresh: () => void;
}

export interface LaunchPresentation {
  readonly frame?: () => number;
  readonly rows?: () => number;
  readonly theme?: TerminalTheme;
}

export class LaunchComponent implements Component {
  #selectedIndex: number;

  constructor(
    private readonly model: LaunchViewModel,
    private readonly actions: LaunchActions,
    private readonly presentation: LaunchPresentation = {},
  ) {
    const current = model.sessions.findIndex((entry) =>
      entry.id === model.currentSessionId
    );
    this.#selectedIndex = current < 0 ? 0 : current;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const theme = this.presentation.theme;
    const line = (value: string): string => truncateToWidth(
      sanitizeTerminalText(value, { multiline: false }),
      safeWidth,
    );
    const terminalRows = this.presentation.rows?.() ?? 30;
    const opening = theme === undefined ? [] : renderTerminalOpening(safeWidth, Math.max(0, terminalRows - 13), theme, this.presentation.frame?.() ?? 0);
    const fixedRows = 11 + opening.length;
    const visibleSessions = Math.max(
      1,
      Math.floor((terminalRows - fixedRows) / 2),
    );
    const selection = Math.min(this.#selectedIndex, this.model.sessions.length);
    const sessionSelection = Math.min(selection, Math.max(0, this.model.sessions.length - 1));
    const windowStart = Math.min(
      Math.max(0, sessionSelection - visibleSessions + 1),
      Math.max(0, this.model.sessions.length - visibleSessions),
    );
    const visible = this.model.sessions.slice(
      windowStart,
      windowStart + visibleSessions,
    );
    const workspace = sanitizeTerminalText(this.model.workspace, {
      multiline: false,
    }).toUpperCase();
    const rows = [
      ...opening,
      theme?.accent(line(`RECURS / ${workspace} / PROJECTS`)) ??
        line(`RECURS / ${workspace} / PROJECTS`),
      theme?.muted("─".repeat(safeWidth)) ?? "─".repeat(safeWidth),
      theme?.strong(line(`Chats · ${this.model.sessions.length}`)) ??
        line(`Chats · ${this.model.sessions.length}`),
    ];
    for (const [offset, session] of visible.entries()) {
      const index = windowStart + offset;
      const updated = session.updatedAt.replace("T", " ").slice(0, 16);
      const label = session.id === this.model.currentSessionId
        ? "Current chat"
        : `Recent chat ${index + 1}`;
      rows.push(
        line(`${index === this.#selectedIndex ? ">" : " "} ${label}`),
        theme?.muted(line(`    ${session.model} · ${updated} UTC${
          session.id === this.model.currentSessionId ? " · CURRENT" : ""
        }`)) ?? line(`    ${session.model} · ${updated} UTC${
          session.id === this.model.currentSessionId ? " · CURRENT" : ""
        }`),
      );
    }
    const newProjectIndex = this.model.sessions.length;
    if (this.model.sessions.length === 0) rows.push(line("  No saved chats yet."));
    rows.push(
      "",
      theme?.strong(line(`${newProjectIndex === this.#selectedIndex ? ">" : " "} Start new chat`)) ??
        line(`${newProjectIndex === this.#selectedIndex ? ">" : " "} Start new chat`),
      theme?.muted(line(this.model.currentSessionId === null ? "    Connect a model and start coding; team setup is optional" : "    Keep this model and permissions; configure the team anytime")) ??
        line(this.model.currentSessionId === null ? "    Connect a model and start coding; team setup is optional" : "    Keep this model and permissions; configure the team anytime"),
      theme?.muted("─".repeat(safeWidth)) ?? "─".repeat(safeWidth),
      theme?.muted(line("enter open   arrows select   q quit")) ??
        line("enter open   arrows select   q quit"),
    );
    while (rows.length < terminalRows) rows.splice(rows.length - 2, 0, "");
    return rows;
  }

  handleInput(data: string): void {
    const count = this.model.sessions.length + 1;
    if (matchesKey(data, Key.enter)) {
      const session = this.model.sessions[this.#selectedIndex];
      if (session === undefined) this.actions.newProject();
      else this.actions.openSession(session.id);
      return;
    }
    if (data === "q" || matchesKey(data, Key.escape)) {
      this.actions.quit();
      return;
    }
    if (
      matchesKey(data, Key.up) || matchesKey(data, Key.left) ||
      matchesKey(data, Key.down) || matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab)
    ) {
      const backwards = matchesKey(data, Key.up) || matchesKey(data, Key.left);
      this.#selectedIndex = (this.#selectedIndex + (backwards ? -1 : 1) + count) % count;
      this.actions.refresh();
    }
  }
}

class TerminalCanvas extends Container {
  constructor(
    component: Component,
    private readonly rows: () => number,
    private readonly theme: TerminalTheme,
  ) {
    super();
    this.addChild(component);
  }

  override render(width: number): string[] {
    return [...renderTerminalCanvas(
      super.render(width),
      width,
      this.rows(),
      this.theme,
    )];
  }
}

export interface InteractiveOnboardingChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly recommended?: boolean;
}

export interface InteractiveOnboardingUi {
  readonly stdout: Writable;
  readonly stderr: Writable;
  selectChoice(
    message: string,
    choices: readonly InteractiveOnboardingChoice[],
    signal?: AbortSignal,
  ): Promise<string | null>;
  promptText(
    message: string,
    suggestion?: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  confirm(message: string, signal?: AbortSignal): Promise<boolean>;
  runExternal<T>(operation: () => Promise<T>): Promise<T>;
}

export interface CompanyHomeActions {
  readonly running?: () => boolean;
  readonly openChat: (node: TerminalCompanyNodeView) => void;
  readonly back?: () => void;
  readonly quit: () => void;
  readonly refresh?: () => void;
  readonly frame: () => number;
  readonly rows?: () => number;
  readonly theme?: TerminalTheme;
  readonly editor?: Editor;
}

export class CompanyHomeComponent implements Component {
  #selectedRoleIndex = 0;

  constructor(
    private readonly state: TerminalUiState,
    private readonly actions: CompanyHomeActions,
  ) {}

  invalidate(): void { this.actions.editor?.invalidate(); }

  render(width: number): string[] {
    const current = this.state.snapshot();
    const snapshot = this.actions.running?.() === true ? { ...current, company: current.company.map((node) => node.depth === 0 ? { ...node, status: "running" as const, detail: "Working · Ctrl+G conversation" } : node) } : current;
    this.#selectedRoleIndex = Math.min(
      this.#selectedRoleIndex,
      Math.max(0, snapshot.company.length - 1),
    );
    const terminalRows = this.actions.rows?.();
    const composerRows = this.actions.editor === undefined ? 0 : 4;
    const lines = [...renderCompanyHome(
      snapshot,
      width,
      this.actions.frame(),
      snapshot.company[this.#selectedRoleIndex]?.roleId,
      terminalRows === undefined ? undefined : Math.max(1, terminalRows - composerRows),
      true,
    )];
    if (this.actions.editor !== undefined) {
      const controls = lines.pop();
      lines.push(
        ...this.actions.editor.render(width),
        controls ?? "ENTER OPEN   ARROWS SELECT   CTRL+T TASKS   CTRL+Q QUIT",
      );
    }
    const theme = this.actions.theme;
    if (theme === undefined) return [...lines];
    let depth: 0 | 1 | 2 | 3 | null = null;
    return lines.map((line, index) => {
      if (line.length === 0) return line;
      if (index === 0) return theme.accent(line);
      if (index === 1) return theme.muted(line);
      if (index === 2) return theme.muted(line);
      if (index === 3) return theme.strong(line);
      const label = /^(0[0-3])\s/u.exec(line);
      if (label !== null) depth = Number.parseInt(label[1]!, 10) as 0 | 1 | 2 | 3;
      if (line.trimStart().startsWith("╰")) {
        depth = Math.min(3, (depth ?? -1) + 1) as 0 | 1 | 2 | 3;
      }
      if (line.startsWith("✳")) depth = null;
      if (line.startsWith("─")) {
        depth = null;
        return theme.muted(line);
      }
      return depth === null ? theme.accent(line) : theme.companyLayer(depth, line);
    });
  }

  handleInput(data: string): void {
    const editor = this.actions.editor;
    const draft = editor?.getText() ?? "";
    if (editor !== undefined && draft.length > 0) {
      if (matchesKey(data, Key.escape)) {
        editor.setText("");
        this.actions.refresh?.();
      } else {
        editor.handleInput(data);
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const node = this.state.snapshot().company[this.#selectedRoleIndex];
      if (node !== undefined) this.actions.openChat(node);
    } else if (data === "q" && editor === undefined) {
      this.actions.quit();
    } else if (matchesKey(data, Key.escape)) {
      (this.actions.back ?? this.actions.quit)();
    } else if (
      matchesKey(data, Key.up) || matchesKey(data, Key.down) ||
      matchesKey(data, Key.left) || matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab)
    ) {
      const count = this.state.snapshot().company.length;
      if (count === 0) return;
      const offset = matchesKey(data, Key.up) || matchesKey(data, Key.left)
        ? -1
        : 1;
      this.#selectedRoleIndex = (this.#selectedRoleIndex + offset + count) % count;
      this.actions.refresh?.();
    } else if (editor !== undefined) {
      editor.handleInput(data);
    }
  }
}

export interface TaskPanelActions {
  readonly openChat: (agent: TerminalAgentView) => void;
  readonly back: () => void;
  readonly refresh: () => void;
  readonly frame?: () => number;
  readonly theme?: TerminalTheme;
  readonly rows?: () => number;
}

export class TaskPanelComponent implements Component {
  #selectedExecutionId: string | null = null;

  constructor(
    private readonly state: TerminalUiState,
    private readonly actions: TaskPanelActions,
  ) {}

  invalidate(): void {}

  #ordered(): TerminalAgentView[] {
    const agents = this.state.snapshot().agents;
    const ids = new Set(agents.map((agent) => agent.executionId));
    const children = new Map<string, TerminalAgentView[]>();
    for (const agent of agents) {
      if (agent.parentExecutionId !== null) {
        const siblings = children.get(agent.parentExecutionId) ?? [];
        siblings.push(agent);
        children.set(agent.parentExecutionId, siblings);
      }
    }
    const ordered: TerminalAgentView[] = [];
    const visited = new Set<string>();
    const visit = (agent: TerminalAgentView): void => {
      if (visited.has(agent.executionId)) return;
      visited.add(agent.executionId);
      ordered.push(agent);
      children.get(agent.executionId)?.forEach(visit);
    };
    agents.filter((agent) => agent.parentExecutionId === null || !ids.has(agent.parentExecutionId)).forEach(visit);
    agents.forEach(visit);
    if (!ordered.some((agent) => agent.executionId === this.#selectedExecutionId)) {
      this.#selectedExecutionId = ordered[0]?.executionId ?? null;
    }
    return ordered;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const snapshot = this.state.snapshot();
    const agents = this.#ordered();
    const theme = this.actions.theme;
    const line = (value: string): string => truncateToWidth(sanitizeTerminalText(value, { multiline: false }), safeWidth);
    const title = line(`RECURS / ${(snapshot.session.workspace ?? "workspace").toUpperCase()} / TASKS`);
    const running = agents.filter((agent) => agent.status === "running").length;
    const unknown = agents.filter((agent) => agent.status === "unknown").length;
    const observedDepth = Math.max(0, ...agents.map((agent) => agent.depth));
    const count = line(`${agents.length} CHILD EXECUTIONS · ${running} running${unknown === 0 ? "" : ` · ${unknown} unknown`} · depth ${observedDepth}${snapshot.session.limits === undefined ? " observed" : `/${snapshot.session.limits.maxDepth} max`}`);
    const footer = line("ESC BACK   ENTER INSPECT   ARROWS SELECT   CTRL+T BACK");
    const height = Math.max(1, this.actions.rows?.() ?? agents.length * 2 + 8);
    const compact = height < 10;
    const header = compact ? [title, count] : [
      theme?.accent(title) ?? title,
      theme?.muted("─".repeat(safeWidth)) ?? "─".repeat(safeWidth),
      line("Actual execution history · parent conversation is depth 0"), count, "",
    ];
    const tail = compact ? [footer] : ["", "─".repeat(safeWidth), footer];
    const available = Math.max(0, height - header.length - tail.length);
    const rowSize = compact ? 1 : 2;
    const visibleCount = Math.floor(available / rowSize);
    const selectedIndex = Math.max(0, agents.findIndex((agent) => agent.executionId === this.#selectedExecutionId));
    const start = Math.min(Math.max(0, selectedIndex - visibleCount + 1), Math.max(0, agents.length - visibleCount));
    const rows = [...header];
    for (const agent of agents.slice(start, start + visibleCount)) {
      const selected = agent.executionId === this.#selectedExecutionId ? ">" : " ";
      const siblings = agents.filter((candidate) => candidate.parentExecutionId === agent.parentExecutionId);
      const branch = siblings.at(-1)?.executionId === agent.executionId ? "└─" : "├─";
      const mark = agent.status === "running" ? agent.detail?.startsWith("Waiting") ? "◇" : ["◐", "◓", "◑", "◒"][(this.actions.frame?.() ?? 0) % 4]! : agent.status === "completed" ? "✓" : agent.status === "failed" ? "!" : "·";
      const role = line(`${selected} ${mark} ${"  ".repeat(Math.min(6, Math.max(0, agent.depth - 1)))}${branch} ${agent.roleName}  ${agent.status.toUpperCase()} · depth ${agent.depth}`);
      rows.push(theme === undefined ? role : agent.status === "failed" ? theme.failure(role) : agent.status === "completed" ? theme.success(role) : agent.detail?.startsWith("Waiting") ? theme.warning(role) : theme.accent(role));
      if (!compact) {
        const route = agent.model === null ? "MODEL PENDING" : `${agent.model}${agent.effort === null ? "" : ` · ${agent.effort}`}`;
        const detail = line(`    ${route} · ${agent.detail ?? formatTerminalLabel(agent.departmentId)}`);
        rows.push(theme?.muted(detail) ?? detail);
      }
    }
    if (agents.length === 0 && available > 0) rows.push(line("No child executions recorded in this session."));
    while (rows.length < height - tail.length) rows.push("");
    return [...rows, ...tail].slice(-height);
  }

  handleInput(data: string): void {
    const agents = this.#ordered();
    const selectedIndex = Math.max(0, agents.findIndex((agent) => agent.executionId === this.#selectedExecutionId));
    if (matchesKey(data, Key.enter)) {
      const agent = agents[selectedIndex];
      if (agent !== undefined) this.actions.openChat(agent);
      return;
    }
    if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("t"))) { this.actions.back(); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.left) || matchesKey(data, Key.down) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      if (agents.length === 0) return;
      const backwards = matchesKey(data, Key.up) || matchesKey(data, Key.left);
      this.#selectedExecutionId = agents[(selectedIndex + (backwards ? -1 : 1) + agents.length) % agents.length]!.executionId;
      this.actions.refresh();
    }
  }
}

export interface RecursInteractiveShellOptions {
  readonly terminal?: InteractiveTerminal;
  readonly cwd: string;
  readonly animate?: boolean;
  readonly dataDirectory?: string;
  readonly colorEnabled?: boolean;
  readonly loadImages?: (
    paths: readonly string[],
    cwd: string,
  ) => Promise<readonly ModelImageInput[]>;
  readonly attachProcess?: ProcessAttachmentHost;
  readonly input?: Readable;
  readonly output?: Writable;
}

export type InteractiveShellExit =
  | { readonly type: "quit" }
  | { readonly type: "new_project" }
  | { readonly type: "resume_session"; readonly sessionId: string };

export interface InteractiveShellStartOptions {
  readonly launch?: boolean;
}

function isCommandResult(value: unknown): value is CommandResult {
  return typeof value === "object" && value !== null && "type" in value &&
    (value.type === "message" || value.type === "attach_process" ||
      value.type === "submit_prompt" || value.type === "submit_queued_prompt" ||
      value.type === "quit");
}

function selectedAnswer(answer: string, options: readonly string[]): string | null {
  const value = answer.trim();
  if (value.length === 0) return null;
  if (/^[1-9][0-9]*$/u.test(value)) {
    return options[Number.parseInt(value, 10) - 1] ?? value;
  }
  return value;
}

function ansi(code: string, enabled: boolean): (text: string) => string {
  return enabled
    ? (text) => `\u001b[${code}m${text}\u001b[0m`
    : (text) => text;
}

function terminalTitle(cwd: string): string {
  const safeCwd = sanitizeTerminalText(cwd, { multiline: false });
  return `Recurs · ${safeCwd.slice(0, 160)}`;
}

function terminalSafeAutocompleteItem(item: AutocompleteItem): boolean {
  return sanitizeTerminalText(item.value, { multiline: false }) === item.value &&
    sanitizeTerminalText(item.label, { multiline: false }) === item.label &&
    (item.description === undefined ||
      sanitizeTerminalText(item.description, { multiline: false }) ===
        item.description);
}

export class TerminalSafeAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters?: string[];

  constructor(private readonly delegate: AutocompleteProvider) {
    if (delegate.triggerCharacters !== undefined) {
      this.triggerCharacters = delegate.triggerCharacters;
    }
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { readonly signal: AbortSignal; readonly force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const suggestions = await this.delegate.getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    );
    if (suggestions === null) return null;
    const items = suggestions.items.filter(terminalSafeAutocompleteItem);
    return items.length === 0 ? null : { ...suggestions, items };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.delegate.applyCompletion(
      lines,
      cursorLine,
      cursorCol,
      item,
      prefix,
    );
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    return this.delegate.shouldTriggerFileCompletion?.(
      lines,
      cursorLine,
      cursorCol,
    ) ?? true;
  }
}

function editorTheme(colorEnabled: boolean, theme?: TerminalTheme): EditorTheme {
  const accent = theme?.accent ?? ansi("96", colorEnabled);
  const strong = theme?.strong ?? ansi("1", colorEnabled);
  const muted = theme?.muted ?? ansi("2", colorEnabled);
  return {
    borderColor: accent,
    selectList: {
      selectedPrefix: accent,
      selectedText: strong,
      description: muted,
      scrollInfo: muted,
      noMatch: muted,
    },
  };
}

export class TranscriptBuffer {
  static readonly maximumCharacters = 256 * 1024;
  #text = "";
  #listener: (() => void) | null = null;

  onChange(listener: (() => void) | null): void { this.#listener = listener; }

  append(value: string): void {
    this.#text += sanitizeTerminalText(value);
    if (this.#text.length > TranscriptBuffer.maximumCharacters) {
      this.#text = `… earlier output omitted …\n${this.#text.slice(
        this.#text.length - TranscriptBuffer.maximumCharacters,
      )}`;
    }
    this.#listener?.();
  }

  clear(): void { this.#text = ""; this.#listener?.(); }

  text(): string { return this.#text.trimEnd(); }
}

class OnboardingChoiceList implements Component {
  readonly #list: SelectList;
  readonly #choices: readonly InteractiveOnboardingChoice[];
  #selectedIndex: number;

  onSelect?: (id: string) => void;
  onCancel?: () => void;

  constructor(
    choices: readonly InteractiveOnboardingChoice[],
    theme: EditorTheme["selectList"],
  ) {
    this.#choices = choices;
    this.#selectedIndex = Math.max(0, choices.findIndex((choice) =>
      choice.recommended === true || /\(recommended\)/iu.test(choice.label)
    ));
    this.#list = new SelectList(
      choices.map((choice) => ({
        value: choice.id,
        label: sanitizeTerminalText(choice.label, { multiline: false }),
      })),
      Math.min(8, choices.length),
      theme,
    );
    this.#list.setSelectedIndex(this.#selectedIndex);
    this.#list.onSelectionChange = (item) => {
      this.#selectedIndex = Math.max(
        0,
        this.#choices.findIndex((choice) => choice.id === item.value),
      );
    };
    this.#list.onSelect = (item) => this.onSelect?.(item.value);
    this.#list.onCancel = () => this.onCancel?.();
  }

  invalidate(): void { this.#list.invalidate(); }

  render(width: number): string[] {
    const lines = this.#list.render(width);
    const selected = this.#choices[this.#selectedIndex];
    if (selected === undefined) return lines;
    const detailWidth = Math.max(1, width - 4);
    return [
      ...lines,
      "",
      ...wrapTerminalText(
        sanitizeTerminalText(selected.detail, { multiline: false }),
        detailWidth,
      ).map((line) => `  ${line}`),
    ];
  }

  handleInput(data: string): void { this.#list.handleInput(data); }
}

class OnboardingComponent extends Container {
  #scrollOffset = 0;
  readonly #header: Text;
  readonly #transcript = new Text();
  readonly #question = new Text();
  readonly #footer: Text;
  readonly #editor: Editor;
  #input: Component | null = null;
  #cancelActive: (() => void) | null = null;

  constructor(
    private readonly tui: TUI,
    buffer: TranscriptBuffer,
    private readonly colorEnabled: boolean,
    private readonly theme: TerminalTheme,
    private readonly rows: () => number,
    workspace: string,
    private readonly frame: () => number = () => 0,
  ) {
    super();
    const accent = theme.accent;
    const strong = theme.strong;
    const muted = theme.muted;
    this.#editor = new Editor(tui, editorTheme(colorEnabled, theme), { paddingX: 1 });
    this.#footer = new Text(
      muted("↑↓ choose · Enter continue · PgUp/PgDn review · Esc cancel"),
      1,
      0,
    );
    buffer.onChange(() => {
      this.#transcript.setText(styleOnboardingTranscript(
        buffer.text().replace(/^\n+/u, ""),
        this.theme,
      ));
      tui.requestRender();
    });
    this.#header = new Text(
      strong(accent(`RECURS / ${workspace.toUpperCase()} / SETUP`)),
      1,
      0,
    );
    this.addChild(this.#header);
    this.addChild(this.#transcript);
    this.addChild(this.#question);
    this.addChild(this.#footer);
  }

  override render(width: number): string[] {
    const header = this.#header.render(width);
    const transcript = this.#transcript.render(width);
    const question = this.#question.render(width);
    const input = this.#input?.render(width) ?? [];
    const footer = this.#footer.render(width);
    const fixed = header.length + question.length + input.length + footer.length;
    const available = Math.max(0, this.rows() - fixed);
    this.#scrollOffset = Math.min(this.#scrollOffset, Math.max(0, transcript.length - available));
    const end = transcript.length - this.#scrollOffset;
    const opening = renderTerminalOpening(width, Math.max(0, available - transcript.length), this.theme, this.frame());
    const body = available === 0 ? [] : [...opening, ...transcript.slice(Math.max(0, end - (available - opening.length)), end)];
    while (body.length < available) body.push("");
    return [...header, ...body, ...question, ...input, ...footer].slice(-Math.max(1, this.rows()));
  }

  scroll(data: string): boolean {
    if (matchesKey(data, Key.pageUp)) this.#scrollOffset += Math.max(1, this.rows() - 10);
    else if (matchesKey(data, Key.pageDown)) this.#scrollOffset = Math.max(0, this.#scrollOffset - Math.max(1, this.rows() - 10));
    else return false;
    this.tui.requestRender();
    return true;
  }

  askChoice(
    message: string,
    choices: readonly InteractiveOnboardingChoice[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted === true) {
      return Promise.reject(onboardingAbortError());
    }
    if (choices.length === 0) {
      return Promise.resolve(null);
    }
    this.#scrollOffset = 0;
    const list = new OnboardingChoiceList(
      choices,
      editorTheme(this.colorEnabled, this.theme).selectList,
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (this.#cancelActive === onAbort) this.#cancelActive = null;
        this.#idle();
        operation();
      };
      const onAbort = (): void => settle(() => reject(onboardingAbortError()));
      list.onSelect = (id) => settle(() => resolve(id));
      list.onCancel = onAbort;
      this.#question.setText(sanitizeTerminalText(message));
      this.#replaceInput(list);
      this.#cancelActive = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  }

  askText(
    message: string,
    suggestion?: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted === true) {
      return Promise.reject(onboardingAbortError());
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (this.#cancelActive === onAbort) this.#cancelActive = null;
        delete this.#editor.onSubmit;
        this.#idle();
        operation();
      };
      const onAbort = (): void => settle(() => reject(onboardingAbortError()));
      const safeSuggestion = suggestion === undefined
        ? undefined
        : sanitizeTerminalText(suggestion, { multiline: false });
      this.#question.setText([
        sanitizeTerminalText(message),
        ...(safeSuggestion === undefined ? [] : [`Default: ${safeSuggestion}`]),
      ].join("\n"));
      this.#editor.setText(safeSuggestion ?? "");
      this.#editor.onSubmit = (value) => {
        const expanded = value.trim();
        settle(() =>
          resolve(expanded.length === 0 ? safeSuggestion ?? null : expanded)
        );
      };
      this.#replaceInput(this.#editor);
      this.#cancelActive = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  }

  cancel(): boolean {
    if (this.#cancelActive === null) return false;
    this.#cancelActive();
    return true;
  }

  focus(): void {
    this.tui.setFocus(this.#input);
  }

  setWorking(): void {
    this.#question.setText("Finishing this step…");
    this.tui.requestRender();
  }

  #replaceInput(input: Component): void {
    if (this.#input !== null) this.removeChild(this.#input);
    this.#input = input;
    const footerIndex = this.children.indexOf(this.#footer);
    this.children.splice(Math.max(0, footerIndex), 0, input);
    this.tui.setFocus(input);
    this.tui.requestRender(true);
  }

  #idle(): void {
    if (this.#input !== null) this.removeChild(this.#input);
    this.#input = null;
    this.#question.setText("Finishing this step…");
    this.tui.setFocus(null);
    this.tui.requestRender(true);
  }
}

function onboardingAbortError(): DOMException {
  return new DOMException("Guided setup was cancelled", "AbortError");
}

function styleOnboardingTranscript(text: string, theme: TerminalTheme): string {
  // Keep the current step's complete evidence and proposal available for review.
  // Filtering this to status notices hides the configuration the user approves.
  const lines = text.split("\n");
  const stepIndex = lines.findLastIndex((line) => /^\d{2}\/\d{2}\s{2}/u.test(line));
  const connection = lines.map((line) => /^Verified — .* · ([^·]+)$/u.exec(line)?.[1]?.trim()).findLast((line) => line !== undefined);
  const current = lines.slice(Math.max(0, stepIndex)).filter((line) => !line.startsWith("Verified — "));
  if (connection !== undefined) current.splice(1, 0, `✓ Parent model connected · ${connection}`);
  return current.map((line) =>
    /^\d{2}\/\d{2}\s{2}/u.test(line) ? theme.accent(line) : line
  ).join("\n");
}

interface PendingQuestion {
  readonly label: string;
  readonly text: string;
  readonly options: readonly string[];
  readonly settle: (answer: string | null) => void;
}

function renderAttachedAgentHeader(
  roleName: string,
  route: string,
  status: string,
  _depth: 0 | 1 | 2 | 3,
  colorEnabled: boolean,
  theme?: TerminalTheme,
): string {
  return `${(theme?.strong ?? ansi("1", colorEnabled))(roleName)} · ${status}\n${(theme?.muted ?? ansi("2", colorEnabled))(route)}`;
}

export class ChatComponent extends Container {
  readonly editor: Editor;
  readonly #header: Text;
  readonly #transcript: Markdown;
  readonly #question = new Text();
  readonly #footer: Text;
  #empty = true;
  #scrollOffset = 0;
  #questionOffset = 0;
  #questionMaximumOffset = 0;
  readonly #updateHeader: () => void;
  #previousTranscriptRows = 0;
  #pending: PendingQuestion | null = null;
  readonly #questionQueue: PendingQuestion[] = [];
  #draftBeforeQuestion: string | null = null;
  onSubmit: ((value: string) => void) | null = null;

  constructor(
    tui: TUI,
    buffer: TranscriptBuffer,
    session: ReturnType<typeof runtimeSession>,
    commands: readonly string[],
    cwd: string,
    colorEnabled: boolean,
    private readonly rows: () => number,
    status?: () => ReturnType<typeof runtimeSession> & { running: boolean },
    private readonly theme?: TerminalTheme,
    private readonly presentation?: { activity: TerminalActivity; frame(): number; welcome?(width: number, height: number): string[] },
  ) {
    super();
    const accent = theme?.accent ?? ansi("96", colorEnabled);
    const muted = theme?.muted ?? ansi("2", colorEnabled);
    const strong = theme?.strong ?? ansi("1", colorEnabled);
    this.#transcript = new Markdown("", 1, 0, {
      heading: (text) => strong(accent(text)), link: accent, linkUrl: muted, code: theme?.code ?? accent,
      codeBlock: theme?.code ?? ((text) => text), codeBlockBorder: muted,
      highlightCode: (code, language) => code.split("\n").map((line) => {
        if (theme === undefined) return line;
        if (language === "diff" || language === "patch") {
          if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return theme.accent(line);
          if (line.startsWith("+")) return theme.success(line);
          if (line.startsWith("-")) return theme.failure(line);
        }
        return theme.code(line);
      }),
      quote: muted, quoteBorder: muted, hr: muted, listBullet: accent,
      bold: strong, italic: ansi("3", colorEnabled),
      strikethrough: ansi("9", colorEnabled), underline: ansi("4", colorEnabled),
    });
    this.#header = new Text(
      `${accent(`RECURS / ${path.basename(cwd).toUpperCase()} / CHAT`)}\n${
        renderAttachedAgentHeader(
          "Parent",
          `${session.model} · ${formatTerminalLabel(session.mode)} · ${
            formatTerminalLabel(session.permission)
          }`,
          "ready",
          0,
          colorEnabled,
          theme,
        )
      }`,
      1,
      0,
    );
    this.#updateHeader = () => {
      if (status === undefined) return;
      const current = status();
      this.#header.setText(`${accent(`RECURS / ${path.basename(cwd).toUpperCase()} / CHAT`)}\n${renderAttachedAgentHeader(
        "Parent", `${current.model} · ${formatTerminalLabel(current.mode)} · ${formatTerminalLabel(current.permission)}`,
        current.running ? "running" : "ready", ((this.presentation?.frame() ?? 0) % 4) as 0 | 1 | 2 | 3, colorEnabled, theme,
      )}`);
    };
    this.editor = new Editor(tui, editorTheme(colorEnabled, theme), { paddingX: 1 });
    this.editor.setAutocompleteProvider(new TerminalSafeAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [...new Set([...commands, "theme"])].map((name) => ({ name })),
        cwd,
      ),
    ));
    this.editor.onSubmit = (value) => {
      const expanded = value.trim();
      if (this.#pending !== null) {
        const pending = this.#pending;
        this.#pending = null;
        pending.settle(expanded.length === 0 ? null : expanded);
        this.#showNextQuestion();
        return;
      }
      if (expanded.length > 0) this.onSubmit?.(expanded);
    };
    this.#footer = new Text(
      muted("Enter send · Ctrl+G team · Ctrl+T tasks · F2 colors · F3 permissions · Esc home · Ctrl+Q quit"),
      1,
      0,
    );
    this.#empty = buffer.text().trim().length === 0;
    this.#transcript.setText(buffer.text());
    buffer.onChange(() => {
      this.#empty = buffer.text().trim().length === 0;
      this.#transcript.setText(buffer.text());
      tui.requestRender();
    });
    this.addChild(this.#header);
    this.addChild(this.#transcript);
    this.addChild(this.#question);
    this.addChild(this.editor);
    this.addChild(this.#footer);
  }

  override render(width: number): string[] {
    this.#updateHeader();
    this.#footer.setText((this.theme?.muted ?? ((text: string) => text))(width < 64
      ? "Ctrl+G team · /help · F3 permissions"
      : "Enter send · Ctrl+G team · Ctrl+T tasks · F2 colors · F3 permissions · Esc home · Ctrl+Q quit"));
    const header = this.#header.render(width);
    const fullQuestion = this.#question.render(width);
    const editor = this.editor.render(width);
    const footer = this.#footer.render(width);
    const questionSpace = Math.max(1, this.rows() - editor.length - footer.length - 1);
    this.#questionMaximumOffset = Math.max(0, fullQuestion.length - questionSpace);
    this.#questionOffset = Math.min(this.#questionOffset, this.#questionMaximumOffset);
    const question = this.#pending === null ? fullQuestion : fullQuestion.slice(this.#questionOffset, this.#questionOffset + questionSpace);
    const visibleHeader = this.#pending === null ? header : header.slice(0, 1);
    const fixed = visibleHeader.length + question.length + editor.length + footer.length;
    const activity = this.#pending === null && this.#scrollOffset === 0 && this.theme !== undefined
      ? this.presentation?.activity.render(width, Math.min(9, Math.max(0, this.rows() - fixed - 6)), this.presentation.frame(), this.theme) ?? [] : [];
    const available = Math.max(0, this.rows() - fixed - activity.length);
    const transcript = this.#transcript.render(width);
    if (this.#scrollOffset > 0) {
      this.#scrollOffset += Math.max(0, transcript.length - this.#previousTranscriptRows);
    }
    this.#previousTranscriptRows = transcript.length;
    this.#scrollOffset = Math.min(this.#scrollOffset, Math.max(0, transcript.length - available));
    const end = Math.max(0, transcript.length - this.#scrollOffset);
    const opening = this.#empty && this.#pending === null && this.editor.getText().length === 0 && this.theme !== undefined
      ? this.presentation?.welcome?.(width, available) ?? renderTerminalOpening(width, available, this.theme, this.presentation?.frame() ?? 0) : [];
    const body = opening.length > 0 ? opening : available === 0 ? [] : transcript.slice(Math.max(0, end - available), end);
    while (body.length < available) body.push("");
    const statusFooter = this.#pending !== null && this.#questionMaximumOffset > 0 ? [
      truncateToWidth(`Question ${this.#questionOffset + 1}-${this.#questionOffset + question.length}/${fullQuestion.length} · PgUp/PgDn review · Enter answer`, Math.max(1, width)),
    ] : this.#scrollOffset === 0 ? footer : [
      truncateToWidth(`↑ ${this.#scrollOffset} lines below · PgDn scroll · Ctrl+End latest`, Math.max(1, width)),
    ];
    // Keep input visible even when the terminal is shorter than the header.
    const rendered = [...visibleHeader, ...body, ...activity, ...question, ...editor, ...statusFooter];
    while (rendered.length < this.rows()) rendered.splice(visibleHeader.length, 0, "");
    return rendered.slice(-Math.max(1, this.rows()));
  }

  get hasQuestion(): boolean { return this.#pending !== null; }

  get showsOpening(): boolean { return this.#empty && this.#pending === null && this.editor.getText().length === 0; }

  refreshAppearance(): void { this.#transcript.invalidate(); this.editor.invalidate(); }

  scroll(data: string): boolean {
    if (this.#pending !== null) {
      const page = Math.max(1, this.rows() - 5);
      if (matchesKey(data, Key.pageUp)) this.#questionOffset = Math.max(0, this.#questionOffset - page);
      else if (matchesKey(data, Key.pageDown)) this.#questionOffset = Math.min(this.#questionMaximumOffset, this.#questionOffset + page);
      else return false;
      return true;
    }
    if (matchesKey(data, Key.pageUp)) this.#scrollOffset += Math.max(1, this.rows() - 8);
    else if (matchesKey(data, Key.pageDown)) this.#scrollOffset = Math.max(0, this.#scrollOffset - Math.max(1, this.rows() - 8));
    else if (matchesKey(data, Key.ctrl("end"))) this.#scrollOffset = 0;
    else return false;
    return true;
  }

  ask(
    text: string,
    options: readonly string[],
    signal?: AbortSignal,
    label = "INPUT REQUIRED",
  ): Promise<string | null> {
    if (signal?.aborted === true) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const question: PendingQuestion = {
        label,
        text,
        options,
        settle: (answer) => {
          if (settled) return;
          settled = true;
          if (signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          resolve(answer);
        },
      };
      const onAbort = (): void => this.#cancelQuestion(question);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#questionQueue.push(question);
      this.#showNextQuestion();
      if (signal?.aborted === true) onAbort();
    });
  }

  #cancelQuestion(question: PendingQuestion): void {
    if (this.#pending === question) {
      this.#pending = null;
      question.settle(null);
      this.#showNextQuestion();
      return;
    }
    const index = this.#questionQueue.indexOf(question);
    if (index < 0) return;
    this.#questionQueue.splice(index, 1);
    question.settle(null);
  }

  #showNextQuestion(): void {
    if (this.#pending !== null) return;
    this.#pending = this.#questionQueue.shift() ?? null;
    this.#questionOffset = 0;
    if (this.#pending === null) {
      this.#question.setText("");
      this.editor.setText(this.#draftBeforeQuestion ?? "");
      this.#draftBeforeQuestion = null;
    } else {
      this.#draftBeforeQuestion ??= this.editor.getText();
      this.#question.setText([
        `╭─ ${this.#pending.label}`,
        sanitizeTerminalText(this.#pending.text),
        ...this.#pending.options.map(
          (option, index) =>
            `  ${index + 1}. ${sanitizeTerminalText(option, { multiline: false })}`,
        ),
        "╰─ ENTER TO CONTINUE · ESC CANCEL",
      ].join("\n"));
      this.editor.setText("");
    }
    this.editor.invalidate();
  }

  cancelCurrentQuestion(): void {
    if (this.#pending !== null) this.#cancelQuestion(this.#pending);
  }

  cancelQuestions(): void {
    this.#pending?.settle(null);
    this.#pending = null;
    for (const question of this.#questionQueue.splice(0)) question.settle(null);
    this.#question.setText("");
  }

}

function runtimeSession(runtime: RecursRuntime): {
  readonly model: string;
  readonly mode: string;
  readonly permission: string;
  readonly limits?: AgentExecution["limits"];
} {
  const state = runtime.state;
  if (state.type !== "session") {
    return {
      model: "connect a parent model",
      mode: "setup",
      permission: state.permissionMode,
    };
  }
  const session = state.session;
  const operatingMode = isPinnedSessionState(session)
    ? session.agent.operatingMode.id
    : "single_agent";
  return {
    model: session.model,
    mode: session.executionMode === "plan" ? "plan" : operatingMode,
    permission: session.permissionMode,
    ...(isPinnedSessionState(session) ? { limits: session.agent.limits } : {}),
  };
}

export class RecursInteractiveShell {
  readonly #terminal: InteractiveTerminal;
  readonly #cwd: string;
  readonly #colorEnabled: boolean;
  readonly #theme: TerminalTheme;
  readonly #dataDirectory: string | undefined;
  #appearanceLoaded = false;
  #appearanceWarning: string | null = null;
  readonly #loadImages: NonNullable<RecursInteractiveShellOptions["loadImages"]>;
  readonly #attachProcess: ProcessAttachmentHost;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #pendingEvents: RecursEvent[] = [];
  readonly #transcript = new TranscriptBuffer();
  #transcriptSessionId: string | null = null;
  readonly #transcriptOutput: Writable;
  readonly #textEvents: TextEventRenderer;
  #state: TerminalUiState | null = null;
  #frame = 0;
  readonly #animate: boolean;
  readonly #activity = new TerminalActivity();

  readonly events: EventSink = {
    emit: async (event) => {
      if (event.sessionId === this.#transcriptSessionId) this.#activity.emit(event);
      await this.#textEvents.emit(event);
      if (this.#state === null) {
        this.#pendingEvents.push(event);
        return;
      }
      await this.#state.emit(event);
    },
  };

  constructor(options: RecursInteractiveShellOptions) {
    this.#animate = options.animate !== false && process.env.RECURS_REDUCED_MOTION !== "1";
    this.#terminal = options.terminal ?? new ProcessTerminal();
    this.#cwd = options.cwd;
    this.#dataDirectory = options.dataDirectory;
    this.#loadImages = options.loadImages ?? loadImageInputs;
    this.#attachProcess = options.attachProcess ?? attachOwnedTerminalProcess;
    this.#input = options.input ?? processStdin;
    this.#output = options.output ?? processStdout;
    this.#theme = createTerminalTheme(
      this.#output,
      options.colorEnabled === undefined
        ? options.terminal === undefined ? {} : { terminal: false }
        : { colorEnabled: options.colorEnabled },
    );
    if (process.env.RECURS_THEME === undefined) this.#theme.setAppearance({ version: 1, theme: "orange" });
    this.#colorEnabled = this.#theme.colorEnabled;
    this.#transcriptOutput = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#transcript.append(chunk.toString());
        callback();
      },
    });
    this.#textEvents = new TextEventRenderer(this.#transcriptOutput, {
      colorEnabled: false,
      interactionOutcomes: true,
    });
  }

  async #loadAppearance(): Promise<void> {
    if (this.#appearanceLoaded) return;
    this.#appearanceLoaded = true;
    if (this.#dataDirectory === undefined || process.env.RECURS_THEME !== undefined) return;
    try {
      const appearance = await loadTerminalAppearance(this.#dataDirectory);
      if (appearance !== null) this.#theme.setAppearance(appearance);
    } catch {
      this.#appearanceWarning = "Appearance could not be loaded; using terminal defaults. /theme can choose a replacement.";
    }
  }

  async onboard<T>(
    run: (
      ui: InteractiveOnboardingUi,
      signal?: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.#loadAppearance();
    const controller = new AbortController();
    const cancel = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(onboardingAbortError());
      }
    };
    const onExternalAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(signal?.reason ?? onboardingAbortError());
      }
    };
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (signal?.aborted === true) onExternalAbort();
    const buffer = new TranscriptBuffer();
    const output = new Writable({
      write: (chunk, _encoding, callback) => {
        buffer.append(chunk.toString());
        callback();
      },
    });
    Object.defineProperties(output, {
      columns: { get: () => this.#terminal.columns },
    });
    const tui = new TUI(this.#terminal);
    const component = new OnboardingComponent(
      tui,
      buffer,
      this.#colorEnabled,
      this.#theme,
      () => this.#terminal.rows,
      path.basename(this.#cwd),
      () => this.#frame,
    );
    let external = false;
    const ui: InteractiveOnboardingUi = {
      stdout: output,
      stderr: output,
      selectChoice: (message, choices, signal) =>
        component.askChoice(message, choices, signal),
      promptText: (message, suggestion, signal) =>
        component.askText(message, suggestion, signal),
      confirm: async (message, signal) =>
        await component.askChoice(message, Object.freeze([
          Object.freeze({
            id: "no",
            label: "Not now",
            detail: "leave this change unapproved",
          }),
          Object.freeze({
            id: "yes",
            label: "Continue",
            detail: "approve this exact step",
          }),
        ]), signal) === "yes",
      runExternal: async (operation) => {
        component.setWorking();
        external = true;
        tui.stop();
        try {
          return await operation();
        } finally {
          external = false;
          tui.start();
          component.focus();
          tui.requestRender(true);
        }
      },
    };
    tui.addChild(new TerminalCanvas(
      component,
      () => this.#terminal.rows,
      this.#theme,
    ));
    const removeCancellationListener = tui.addInputListener((data) => {
      if (component.scroll(data)) return { consume: true };
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c"))
      ) {
        component.cancel();
        cancel();
        return { consume: true };
      }
      return undefined;
    });
    this.#terminal.setTitle(terminalTitle(this.#cwd));
    tui.start();
    tui.requestRender(true);
    const animation = !this.#animate ? undefined : setInterval(() => {
      if (external) return;
      this.#frame += 1;
      tui.requestRender();
    }, 80);
    animation?.unref();
    try {
      return await run(ui, controller.signal);
    } finally {
      clearInterval(animation);
      signal?.removeEventListener("abort", onExternalAbort);
      removeCancellationListener();
      tui.stop();
    }
  }

  async start(
    runtime: RecursRuntime,
    options: InteractiveShellStartOptions = {},
  ): Promise<InteractiveShellExit> {
    await this.#loadAppearance();
    const openedSessionId = runtime.state.type === "session" ? runtime.state.session.id : null;
    if (openedSessionId !== this.#transcriptSessionId) {
      this.#transcript.clear();
      this.#activity.clear();
      this.#transcriptSessionId = openedSessionId;
    }
    const state = new TerminalUiState({
      ...runtimeSession(runtime),
      workspace: path.basename(this.#cwd),
    }, runtime.companyBlueprint);
    this.#state = state;
    let restoredRootNotice: string | null = null;
    if (typeof runtime.listExecutions === "function") {
      const executions = await runtime.listExecutions();
      state.restoreExecutions(executions);
      restoredRootNotice = executions.find((execution) => execution.parentExecutionId === null)?.detail ?? null;
    }
    for (const event of this.#pendingEvents.splice(0)) await state.emit(event);

    const tui = new TUI(this.#terminal);
    const mount = (component: Component, focus: Component | null): void => {
      tui.clear();
      tui.addChild(new TerminalCanvas(
        component,
        () => this.#terminal.rows,
        this.#theme,
      ));
      tui.setFocus(focus);
      tui.requestRender(true);
    };
    let finish!: (result: InteractiveShellExit) => void;
    const finished = new Promise<InteractiveShellExit>((resolve) => {
      finish = resolve;
    });
    const session = runtimeSession(runtime);
    if (this.#transcript.text().length === 0 && runtime.state.type === "session" && typeof runtime.inspectExecution === "function") {
      const detail = await runtime.inspectExecution(runtime.state.session.id);
      if (detail !== null) {
        for (const message of detail.messages) {
          this.#transcript.append(`\n${message.role === "user" ? "›" : message.role + ":"} ${message.content}\n`);
        }
      }
    }
    if (restoredRootNotice !== null) this.#transcript.append(`\nExecution history: ${restoredRootNotice}\n`);
    if (this.#appearanceWarning !== null) {
      this.#transcript.append(`\n${this.#appearanceWarning}\n`);
      this.#appearanceWarning = null;
    }
    const chat = new ChatComponent(
      tui,
      this.#transcript,
      session,
      runtime.commandNames(),
      this.#cwd,
      this.#colorEnabled,
      () => this.#terminal.rows,
      () => ({ ...runtimeSession(runtime), running: runtime.hasActiveRun }),
      this.#theme,
      { activity: this.#activity, frame: () => this.#frame, welcome: (width, height) => renderTerminalOpening(width, height, this.#theme, this.#frame) },
    );
    const companyEditor = new Editor(tui, editorTheme(this.#colorEnabled, this.#theme), {
      paddingX: 1,
    });
    companyEditor.setAutocompleteProvider(new TerminalSafeAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [...new Set([...runtime.commandNames(), "theme"])].map((name) => ({ name })),
        this.#cwd,
      ),
    ));
    let view: "launch" | "company" | "chat" | "tasks" | "inspect" | "appearance" | "selection" = "company";
    let attached = false;
    let viewBeforeTasks: "company" | "chat" = "company";
    const showChat = (): void => {
      if (view === "chat") return;
      view = "chat";
      mount(chat, chat.editor);
    };
    const showCompany = (): void => {
      if (view === "company") return;
      view = "company";
      mount(home, home);
    };
    const showLaunch = (): void => {
      view = "launch";
      mount(launch, launch);
    };
    const showTasks = (): void => {
      if (view === "launch") return;
      if (view !== "tasks" && view !== "inspect") {
        viewBeforeTasks = view === "chat" ? "chat" : "company";
      }
      view = "tasks";
      mount(tasks, tasks);
    };
    const hideTasks = (): void => {
      if (viewBeforeTasks === "chat") showChat();
      else showCompany();
    };
    let selectedExecutionId: string | null = null;
    let inspectionGeneration = 0;
    const loadInspection = async (): Promise<void> => {
      const id = selectedExecutionId;
      if (id === null) return;
      const generation = ++inspectionGeneration;
      try {
        const detail = await runtime.inspectExecution(id);
        if (generation === inspectionGeneration && selectedExecutionId === id) inspector.show(detail);
      } catch (error) {
        if (generation === inspectionGeneration) inspector.show(null, safeCliErrorMessage(error));
      }
      tui.requestRender();
    };
    const inspector = new ExecutionInspector({
      theme: this.#theme,
      rows: () => this.#terminal.rows,
      back: showTasks,
      refresh: () => tui.requestRender(),
      reload: () => { void loadInspection(); },
      cancel: (id) => {
        void runtime.cancelExecution(id).then(() => {
          if (selectedExecutionId === id) return loadInspection();
          return undefined;
        }).catch((error: unknown) => {
          if (selectedExecutionId === id) inspector.show(null, safeCliErrorMessage(error));
          tui.requestRender();
        });
      },
    });
    const showExecution = (agent: TerminalAgentView): void => {
      selectedExecutionId = agent.executionId;
      inspector.show(null, "Loading execution…");
      view = "inspect";
      mount(inspector, inspector);
      void loadInspection();
    };
    const showRole = (node: TerminalCompanyNodeView): void => {
      if (node.reportsToRoleId === null) { showChat(); return; }
      const agent = state.snapshot().agents.find((candidate) => candidate.executionId === node.representativeExecutionId);
      if (agent !== undefined) { showExecution(agent); return; }
      selectedExecutionId = null;
      inspector.show(null, `${node.roleName}: configured role; no execution has activated. Return to chat to give the parent instructions.`);
      view = "inspect";
      mount(inspector, inspector);
    };
    const home = new CompanyHomeComponent(state, {
      running: () => runtime.hasActiveRun,
      frame: () => this.#frame,
      openChat: showRole,
      back: showChat,
      quit: () => finish({ type: "quit" }),
      refresh: () => tui.requestRender(),
      theme: this.#theme,
      rows: () => this.#terminal.rows,
      editor: companyEditor,
    });
    const tasks = new TaskPanelComponent(state, {
      frame: () => this.#frame,
      openChat: showExecution,
      back: hideTasks,
      refresh: () => tui.requestRender(),
      theme: this.#theme,
      rows: () => this.#terminal.rows,
    });
    const supportsLaunch = options.launch !== false &&
      typeof runtime.listSessions === "function";
    const sessions = supportsLaunch ? await runtime.listSessions() : [];
    const runtimeState = runtime.state;
    const currentSessionId = runtimeState.type === "session"
      ? runtimeState.session.id
      : null;
    const launch = new LaunchComponent({
      workspace: path.basename(this.#cwd),
      currentSessionId,
      sessions,
    }, {
      openSession: (sessionId) => {
        if (sessionId === currentSessionId) {
          showChat();
        }
        else finish({ type: "resume_session", sessionId });
      },
      newProject: () => finish({ type: "new_project" }),
      quit: () => finish({ type: "quit" }),
      refresh: () => tui.requestRender(),
    }, {
      rows: () => this.#terminal.rows,
      theme: this.#theme,
      frame: () => this.#frame,
    });
    const themePreview: { cancel: (() => void) | null } = { cancel: null };
    let appearanceWrites = Promise.resolve();
    const persistAppearance = (input: TerminalAppearance | (() => TerminalAppearance)): Promise<void> => {
      const write = appearanceWrites.then(async () => {
        const appearance = typeof input === "function" ? input() : input;
        if (this.#dataDirectory !== undefined) await saveTerminalAppearance(this.#dataDirectory, appearance);
        this.#theme.setAppearance(appearance);
        chat.refreshAppearance();
        companyEditor.invalidate();
        tui.requestRender(true);
      });
      appearanceWrites = write.catch(() => {});
      return write;
    };
    const showAppearance = (): void => {
      const current = this.#theme.appearance;
      const previousView = view;
      const returnToPrevious = () => previousView === "company" ? showCompany() : showChat();
      const restore = () => {
        this.#theme.setAppearance(current);
        chat.refreshAppearance();
        companyEditor.invalidate();
        themePreview.cancel = null;
        returnToPrevious();
      };
      themePreview.cancel = restore;
      const picker = new TerminalThemePicker({
        theme: this.#theme, current, rows: () => this.#terminal.rows,
        preview: (appearance) => { this.#theme.setAppearance(appearance); tui.requestRender(true); },
        save: async (appearance) => {
          await persistAppearance(appearance);
          themePreview.cancel = null;
          returnToPrevious();
        },
        cancel: restore,
        refresh: () => tui.requestRender(true),
      });
      view = "appearance";
      mount(picker, picker);
    };
    const ask = async (
      question: string,
      options: readonly string[] = [],
      signal?: AbortSignal,
      label?: string,
    ): Promise<string | null> => {
      const returnToFloor = view === "company";
      showChat();
      tui.setFocus(chat.editor);
      const pending = chat.ask(question, options, signal, label);
      tui.requestRender(true);
      const answer = await pending;
      if (returnToFloor && !chat.hasQuestion) showCompany();
      tui.requestRender(true);
      return answer;
    };
    const selection: { cancel: (() => void) | null } = { cancel: null };
    runtime.setSelectionHandler?.((message, choices) => new Promise((resolve) => {
      let settled = false;
      const settle = (id: string | null) => {
        if (settled) return;
        settled = true;
        selection.cancel = null;
        showChat();
        resolve(id);
      };
      selection.cancel = () => settle(null);
      if (choices.length === 0) { settle(null); return; }
      const picker = new TerminalChoicePicker({
        message, choices, theme: this.#theme, rows: () => this.#terminal.rows,
        settle, refresh: () => tui.requestRender(true),
      });
      view = "selection";
      mount(picker, picker);
    }));
    runtime.setConfirmHandler(async (message) => {
      const answer = await ask(
        `${message} [y/N]`,
        [],
        runtime.currentSignal(),
        "APPROVAL REQUIRED",
      );
      return answer?.trim().toLowerCase() === "y" ||
        answer?.trim().toLowerCase() === "yes";
    });
    runtime.setApprovalHandler?.(async (intent): Promise<ApprovalResponse> => {
      const answer = await ask(
        `Allow ${intent.category} access to ${intent.resource}?`,
        ["yes — once", "always — this session", "deny"],
        runtime.currentSignal(),
        "PERMISSION REQUIRED",
      );
      if (answer === null) return "deny";
      if (/^[1-3]$/u.test(answer.trim())) {
        return (["allow_once", "allow_session", "deny"] as const)[
          Number.parseInt(answer.trim(), 10) - 1
        ]!;
      }
      return replApprovalResponse(answer);
    });
    runtime.setUserInputHandler?.(async (request, signal) =>
      selectedAnswer(
        await ask(request.question, request.options, signal, "AGENT QUESTION") ?? "",
        request.options,
      )
    );
    let stagedImages: readonly ModelImageInput[] = Object.freeze([]);
    let activeSubmissions = 0;
    const submissionTasks = new Set<Promise<void>>();
    const submit = async (input: string): Promise<void> => {
      if (activeSubmissions > 0 && !runtime.canAcceptLiveInput && parseCommand(input)?.name !== "theme") {
        this.#transcript.append(
          "\nWait for the active turn, cancel it with Ctrl+C, or enable a mode that accepts steering.\n",
        );
        tui.requestRender(true);
        return;
      }
      activeSubmissions += 1;
      this.#transcript.append(`\n› ${input}\n`);
      try {
        const parsed = parseCommand(input);
        if (parsed?.name === "theme") {
          const args = parsed.args.trim();
          if (args.length === 0) {
            if (runtime.hasActiveRun) throw new Error("Open the theme picker after the current turn, or apply /theme dark directly.");
            await appearanceWrites;
            showAppearance(); return;
          }
          if (isTerminalThemeName(args)) {
            await persistAppearance(() => ({ version: 1, theme: args, ...(this.#theme.appearance.design === undefined ? {} : { design: this.#theme.appearance.design }) }));
          } else if (args === "design r" || args === "design v19") {
            const design = args === "design v19" ? "v19" : "r";
            await persistAppearance(() => ({ ...this.#theme.appearance, design }));
            this.#transcript.append(`Design: ${design}\n`);
            if (design === "v19") showCompany(); else showChat();
          } else if (args.startsWith("color ")) {
            const [, role, value, ...extra] = args.split(/\s+/u);
            if (extra.length !== 0 || role === undefined || value === undefined) throw new Error("Use /theme color <role> #RRGGBB");
            await persistAppearance(() => parseTerminalAppearance({
              ...this.#theme.appearance, colors: { ...this.#theme.appearance.colors, [role]: value },
            }));
          } else {
            throw new Error(`Use /theme [orange|system|dark|light|contrast], or /theme color <${TERMINAL_COLOR_ROLES.join("|")}> #RRGGBB`);
          }
          this.#transcript.append(`Appearance: ${this.#theme.appearance.theme}${this.#dataDirectory === undefined ? " (this process)" : " (saved)"}.\n`);
          return;
        }
        if (parsed?.name === "image") {
          if (parsed.args.length === 0) {
            this.#transcript.append(stagedImagesText(stagedImages));
            return;
          }
          if (parsed.args.toLowerCase() === "clear") {
            stagedImages = Object.freeze([]);
            this.#transcript.append("Staged images cleared.\n");
            return;
          }
          if (runtime.hasActiveRun) {
            throw new Error(
              "Images can be staged only while the current agent turn is idle",
            );
          }
          const loaded = await this.#loadImages(
            [interactiveImagePath(parsed.args)],
            this.#cwd,
          );
          const combined = Object.freeze([...stagedImages, ...loaded]);
          if (modelImagesByteLength(combined) === null) {
            throw new Error(
              "Staged images exceed the four-image or five MiB total limit",
            );
          }
          stagedImages = combined;
          this.#transcript.append(stagedImagesText(stagedImages));
          return;
        }
        const images = parsed === null && !input.trimStart().startsWith("/") &&
            !runtime.hasActiveRun && stagedImages.length > 0
          ? stagedImages
          : undefined;
        if (images !== undefined) stagedImages = Object.freeze([]);
        const result = await runtime.submit(input, createHostInvocation({
          invocation: "repl",
          userPresent: true,
          remote: false,
          scripted: false,
          embedding: "cli",
        }), images === undefined ? {} : { images });
        if (runtime.state.type === "session" && runtime.state.session.id !== currentSessionId) {
          finish({ type: "resume_session", sessionId: runtime.state.session.id });
          return;
        }
        state.updateParentSession(runtimeSession(runtime));
        if (!isCommandResult(result)) return;
        if (result.type === "quit") {
          finish({ type: "quit" });
          return;
        }
        if (result.type === "attach_process") {
          attached = true;
          tui.stop();
          try {
            await this.#attachProcess(
              runtime,
              result.sessionId,
              this.#input,
              this.#output,
            );
          } finally {
            attached = false;
            tui.start();
            tui.setFocus(
              view === "chat"
                ? chat.editor
                : view === "launch"
                  ? launch
                  : view === "tasks" ? tasks : view === "inspect" ? inspector : home,
            );
            tui.requestRender(true);
          }
          return;
        }
        if (parsed?.name === "diff" && result.type === "message" && /^(diff --git |--- )/u.test(result.text)) {
          const fence = "`".repeat(Math.max(3, ...[...result.text.matchAll(/`+/gu)].map((match) => match[0].length + 1)));
          this.#transcript.append(`\n${fence}diff\n${result.text}\n${fence}\n`);
          return;
        }
        if (parsed?.name === "help" && result.type === "message") this.#transcript.append("\n/theme [orange|system|dark|light|contrast]  Preview or save terminal appearance\n/theme color <role> #RRGGBB         Customize a semantic color\n/theme design r|v19               Open chat or the agent floor (legacy alias)\nCtrl+G team/chat · Ctrl+T executions · Enter inspect · Esc back\nF2 colors · F3 permissions · PgUp/PgDn history · Ctrl+C cancel work · Ctrl+Q quit\n");
        await renderCommandResult(
          result,
          this.#transcriptOutput,
          this.#transcriptOutput,
        );
      } catch (error) {
        const message = isCancellation(error)
          ? "Cancelled"
          : `Error: ${safeCliErrorMessage(error)}`;
        this.#transcript.append(`\n${message}\n`);
      } finally {
        activeSubmissions -= 1;
        tui.requestRender();
      }
    };
    chat.onSubmit = (input) => {
      const task = submit(input);
      submissionTasks.add(task);
      void task.finally(() => submissionTasks.delete(task));
    };
    companyEditor.onSubmit = (input) => {
      const value = input.trim();
      if (value.length === 0) return;
      const task = submit(value).finally(() => { if (view === "company") showChat(); });
      submissionTasks.add(task);
      void task.finally(() => submissionTasks.delete(task));
    };
    tui.addInputListener((data) => {
      if (view === "selection") {
        if (matchesKey(data, Key.ctrl("q"))) { selection.cancel?.(); finish({ type: "quit" }); return { consume: true }; }
        if (matchesKey(data, Key.ctrl("g")) || matchesKey(data, Key.ctrl("t"))) return { consume: true };
        return undefined;
      }
      if (view === "appearance") {
        if (matchesKey(data, Key.ctrl("q"))) { themePreview.cancel?.(); finish({ type: "quit" }); return { consume: true }; }
        if (matchesKey(data, Key.ctrl("g")) || matchesKey(data, Key.ctrl("t"))) return { consume: true };
        return undefined;
      }
      if (chat.hasQuestion) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          chat.cancelCurrentQuestion();
          tui.requestRender(true);
          return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("g")) || matchesKey(data, Key.ctrl("t")) || matchesKey(data, Key.f2) || matchesKey(data, Key.f3)) return { consume: true };
      }
      if ((view === "chat" || view === "company") && matchesKey(data, Key.f3) && activeSubmissions === 0 && !runtime.hasActiveRun) {
        showChat();
        chat.onSubmit?.("/permissions");
        return { consume: true };
      }
      if ((view === "chat" || view === "company") && matchesKey(data, Key.f2) && activeSubmissions === 0 && !runtime.hasActiveRun) { showAppearance(); return { consume: true }; }
      if (view === "chat" && supportsLaunch && matchesKey(data, Key.escape) && chat.editor.getText().length === 0) {
        showLaunch();
        return { consume: true };
      }
      if (view === "chat" && chat.scroll(data)) {
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("q"))) {
        finish({ type: "quit" });
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("t"))) {
        if (view === "tasks") hideTasks();
        else showTasks();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("g"))) {
        if (view === "launch") return undefined;
        if (view === "company") showChat();
        else showCompany();
        return { consume: true };
      }
      if (view !== "inspect" && matchesKey(data, Key.ctrl("c")) && runtime.cancel()) {
        return { consume: true };
      }
      return undefined;
    });
    if (!supportsLaunch) {
      view = "chat";
      mount(chat, chat.editor);
    } else {
      view = "launch";
      mount(launch, launch);
    }
    state.onChange(() => tui.requestRender());
    this.#terminal.setTitle(terminalTitle(this.#cwd));
    tui.start();
    tui.requestRender(true);
    const animation = !this.#animate ? undefined : setInterval(() => {
      this.#frame += 1;
      if (!attached && (view === "launch" || view === "chat" && (chat.showsOpening || runtime.hasActiveRun) || (view === "company" || view === "tasks") && (runtime.hasActiveRun || state.snapshot().agents.some((agent) => agent.status === "running")))) tui.requestRender();
    }, 80);
    animation?.unref();
    let completedExit: InteractiveShellExit | null = null;
    try {
      completedExit = await finished;
      return completedExit;
    } finally {
      clearInterval(animation);
      await appearanceWrites;
      themePreview.cancel?.();
      selection.cancel?.();
      runtime.setSelectionHandler?.(null);
      state.onChange(null);
      chat.cancelQuestions();
      tui.stop();
      runtime.cancel();
      await Promise.allSettled([...submissionTasks]);
      if (completedExit?.type !== "new_project" || runtime.state.type !== "session") await runtime.close?.();
    }
  }
}

export function createRecursInteractiveShell(
  options: Omit<RecursInteractiveShellOptions, "terminal"> = {
    cwd: process.cwd(),
  },
): RecursInteractiveShell {
  return new RecursInteractiveShell(options);
}
