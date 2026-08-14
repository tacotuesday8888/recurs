import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
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
    const fixedRows = 11;
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
      theme?.accent(line(`R↘ RECURS / ${workspace} / PROJECTS`)) ??
        line(`R↘ RECURS / ${workspace} / PROJECTS`),
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
      theme?.strong(line(`${newProjectIndex === this.#selectedIndex ? ">" : " "} Start new project`)) ??
        line(`${newProjectIndex === this.#selectedIndex ? ">" : " "} Start new project`),
      theme?.muted(line("    Connect a model, choose authority, and form your company")) ??
        line("    Connect a model, choose authority, and form your company"),
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
    const snapshot = this.state.snapshot();
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
  readonly openChat: (node: TerminalCompanyNodeView) => void;
  readonly back: () => void;
  readonly refresh: () => void;
  readonly theme?: TerminalTheme;
  readonly rows?: () => number;
}

export class TaskPanelComponent implements Component {
  #selectedIndex = 0;

  constructor(
    private readonly state: TerminalUiState,
    private readonly actions: TaskPanelActions,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const snapshot = this.state.snapshot();
    const theme = this.actions.theme;
    const line = (value: string): string => truncateToWidth(
      sanitizeTerminalText(value, { multiline: false }),
      safeWidth,
    );
    this.#selectedIndex = Math.min(
      this.#selectedIndex,
      Math.max(0, snapshot.agents.length - 1),
    );
    const workspace = (snapshot.session.workspace ?? "workspace").toUpperCase();
    const rows = [
      theme?.accent(line(`R↘ RECURS / ${workspace} / TASKS`)) ??
        line(`R↘ RECURS / ${workspace} / TASKS`),
      theme?.muted("─".repeat(safeWidth)) ?? "─".repeat(safeWidth),
      theme?.strong(line(snapshot.goal === null
        ? "NO ACTIVE COMPANY GOAL"
        : snapshot.goal.objective.toUpperCase())) ??
        line(snapshot.goal === null
          ? "NO ACTIVE COMPANY GOAL"
          : snapshot.goal.objective.toUpperCase()),
      theme?.muted(line(`ACTIVATED ASSIGNMENTS · ${snapshot.agents.length}`)) ??
        line(`ACTIVATED ASSIGNMENTS · ${snapshot.agents.length}`),
      "",
    ];
    const terminalRows = this.actions.rows?.();
    const visibleCount = terminalRows === undefined
      ? snapshot.agents.length
      : Math.max(1, Math.floor((terminalRows - 8) / 2));
    const windowStart = Math.min(
      Math.max(0, this.#selectedIndex - visibleCount + 1),
      Math.max(0, snapshot.agents.length - visibleCount),
    );
    const visibleAgents = snapshot.agents.slice(
      windowStart,
      windowStart + visibleCount,
    );
    for (const [offset, agent] of visibleAgents.entries()) {
      const index = windowStart + offset;
      const selected = index === this.#selectedIndex ? ">" : " ";
      const status = agent.status.toUpperCase();
      const route = agent.model === null
        ? "MODEL PENDING"
        : `${agent.model}${agent.effort === null ? "" : ` · ${agent.effort}`}`;
      const role = line(`${selected} ${agent.roleName.toUpperCase()}  ${status}`);
      const detail = line(`    ${route} · ${
        agent.detail ?? formatTerminalLabel(agent.departmentId)
      }`);
      rows.push(
        theme?.companyLayer(Math.min(3, agent.depth) as 0 | 1 | 2 | 3, role) ?? role,
        theme?.muted(detail) ?? detail,
      );
    }
    if (snapshot.agents.length === 0) {
      rows.push(line("  No assignments have activated for this goal."));
    }
    rows.push(
      "",
      theme?.muted("─".repeat(safeWidth)) ?? "─".repeat(safeWidth),
      theme?.muted(line("ENTER OPEN   ARROWS SELECT   CTRL+T OR ESC BACK")) ??
        line("ENTER OPEN   ARROWS SELECT   CTRL+T OR ESC BACK"),
    );
    if (terminalRows !== undefined) {
      while (rows.length < terminalRows) rows.splice(rows.length - 2, 0, "");
    }
    return rows;
  }

  handleInput(data: string): void {
    const snapshot = this.state.snapshot();
    if (matchesKey(data, Key.enter)) {
      const agent = snapshot.agents[this.#selectedIndex];
      const node = agent === undefined
        ? undefined
        : snapshot.company.find((candidate) => candidate.roleId === agent.roleId);
      if (node !== undefined) this.actions.openChat(node);
      return;
    }
    if (
      data === "q" || matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("t"))
    ) {
      this.actions.back();
      return;
    }
    if (
      matchesKey(data, Key.up) || matchesKey(data, Key.left) ||
      matchesKey(data, Key.down) || matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab)
    ) {
      if (snapshot.agents.length === 0) return;
      const backwards = matchesKey(data, Key.up) || matchesKey(data, Key.left);
      this.#selectedIndex = (this.#selectedIndex +
        (backwards ? -1 : 1) + snapshot.agents.length) % snapshot.agents.length;
      this.actions.refresh();
    }
  }
}

export interface RecursInteractiveShellOptions {
  readonly terminal?: InteractiveTerminal;
  readonly cwd: string;
  readonly animate?: boolean;
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

function editorTheme(colorEnabled: boolean): EditorTheme {
  const accent = ansi("96", colorEnabled);
  const strong = ansi("1", colorEnabled);
  const muted = ansi("2", colorEnabled);
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

class TranscriptBuffer {
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
  ) {
    super();
    const accent = ansi("96", colorEnabled);
    const strong = ansi("1", colorEnabled);
    const muted = ansi("2", colorEnabled);
    this.#editor = new Editor(tui, editorTheme(colorEnabled), { paddingX: 1 });
    this.#footer = new Text(
      muted("↑↓ choose · Enter continue · Esc cancel · Ctrl+C cancel"),
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
      `${strong(accent(`R↘ RECURS / ${workspace.toUpperCase()} / SETUP`))}\n${
        muted("Connect a model, choose boundaries, then form your company.")
      }`,
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
    const body = available === 0 ? [] : transcript.slice(-available);
    while (body.length < available) body.push("");
    return [...header, ...body, ...question, ...input, ...footer];
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
    const list = new OnboardingChoiceList(
      choices,
      editorTheme(this.colorEnabled).selectList,
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

function styleOnboardingTranscript(
  text: string,
  theme: TerminalTheme,
): string {
  const lines = text.split("\n");
  const currentStep = lines.findLast((line) =>
    /^\d{2}\/\d{2}\s{2}/u.test(line)
  );
  const latestNotice = lines.map((line): string | undefined => {
    const verified = /^Verified — .* · ([^·]+)$/u.exec(line);
    if (verified !== null) {
      return `✓ Parent model connected · ${verified[1]!.trim()}`;
    }
    return /^(Error|Warning):/u.test(line) ||
        /^(Setup|Company setup|Full Access)/u.test(line)
      ? line
      : undefined;
  }).findLast((line) => line !== undefined);
  const visible = [currentStep, latestNotice].filter(
    (line): line is string => line !== undefined,
  );
  return visible.map((line) =>
    /^\d{2}\/\d{2}\s{2}/u.test(line) ? theme.accent(line) : line
  ).join("\n");
}

interface PendingQuestion {
  readonly label: string;
  readonly text: string;
  readonly options: readonly string[];
  readonly settle: (answer: string | null) => void;
}

function chatMascot(depth: 0 | 1 | 2 | 3): readonly string[] {
  if (depth === 0) {
    return Object.freeze(["   ▄██▄", " ▄██████▄", "◀██▄██▄██", "  ▀████▀"]);
  }
  if (depth === 1) return Object.freeze(["  ▄██▄", "◀████▌", " ▀██▀", " ▀  ▀"]);
  if (depth === 2) return Object.freeze([" ▄██▄", "◀███▌", "  ▀ ▀"]);
  return Object.freeze(["▄██▄", "▀  ▀"]);
}

function renderAttachedAgentHeader(
  roleName: string,
  route: string,
  status: string,
  depth: 0 | 1 | 2 | 3,
  colorEnabled: boolean,
): string {
  const accent = ansi("96", colorEnabled);
  const strong = ansi("1", colorEnabled);
  const muted = ansi("2", colorEnabled);
  const pet = chatMascot(depth);
  const details = [
    strong(roleName.toUpperCase()),
    muted(route),
    muted(`${status.toUpperCase()} · ATTACHED · GOAL SCOPE PRESERVED`),
  ];
  return pet.map((row, index) =>
    `${accent(row.padEnd(13))}${details[index] ?? ""}`
  ).join("\n");
}

class ChatComponent extends Container {
  readonly editor: Editor;
  readonly #header: Text;
  readonly #transcript = new Text();
  readonly #question = new Text();
  readonly #footer: Text;
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
    private readonly colorEnabled: boolean,
    private readonly rows: () => number,
  ) {
    super();
    const accent = ansi("96", colorEnabled);
    const muted = ansi("2", colorEnabled);
    this.#header = new Text(
      `${accent(`R↘ RECURS / ${path.basename(cwd).toUpperCase()} / CHAT`)}\n${
        renderAttachedAgentHeader(
          "Parent",
          `${session.model} · ${formatTerminalLabel(session.mode)} · ${
            formatTerminalLabel(session.permission)
          }`,
          "ready",
          0,
          colorEnabled,
        )
      }`,
      1,
      0,
    );
    this.editor = new Editor(tui, editorTheme(colorEnabled), { paddingX: 1 });
    this.editor.setAutocompleteProvider(new TerminalSafeAutocompleteProvider(
      new CombinedAutocompleteProvider(
        commands.map((name) => ({ name })),
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
      muted("recurs ›  ENTER SEND · SHIFT+ENTER NEWLINE · CTRL+G COMPANY · CTRL+C CANCEL"),
      1,
      0,
    );
    buffer.onChange(() => {
      this.#transcript.setText(accent(buffer.text()));
      tui.requestRender();
    });
    this.addChild(this.#header);
    this.addChild(this.#transcript);
    this.addChild(this.#question);
    this.addChild(this.editor);
    this.addChild(this.#footer);
  }

  override render(width: number): string[] {
    const header = this.#header.render(width);
    const question = this.#question.render(width);
    const editor = this.editor.render(width);
    const footer = this.#footer.render(width);
    const fixed = header.length + question.length + editor.length + footer.length;
    const available = Math.max(0, this.rows() - fixed);
    const transcript = this.#transcript.render(width);
    const body = available === 0 ? [] : transcript.slice(-available);
    while (body.length < available) body.push("");
    return [...header, ...body, ...question, ...editor, ...footer];
  }

  setCompanyFocus(node: TerminalCompanyNodeView): void {
    const route = node.model === null
      ? "model route not activated"
      : `${node.model}${node.effort === null ? "" : ` · ${node.effort}`}`;
    this.#header.setText(
      `R↘ RECURS / CHAT / ${node.roleName.toUpperCase()}\n${
        renderAttachedAgentHeader(
          node.roleName,
          route,
          node.status,
          node.depth,
          this.colorEnabled,
        )
      }`,
    );
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
        "╰─ ENTER TO CONTINUE",
      ].join("\n"));
      this.editor.setText("");
    }
    this.editor.invalidate();
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
    mode: operatingMode,
    permission: session.permissionMode,
  };
}

export class RecursInteractiveShell {
  readonly #terminal: InteractiveTerminal;
  readonly #cwd: string;
  readonly #animate: boolean;
  readonly #colorEnabled: boolean;
  readonly #theme: TerminalTheme;
  readonly #loadImages: NonNullable<RecursInteractiveShellOptions["loadImages"]>;
  readonly #attachProcess: ProcessAttachmentHost;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #pendingEvents: RecursEvent[] = [];
  readonly #transcript = new TranscriptBuffer();
  readonly #transcriptOutput: Writable;
  readonly #textEvents: TextEventRenderer;
  #state: TerminalUiState | null = null;
  #frame = 0;

  readonly events: EventSink = {
    emit: async (event) => {
      await this.#textEvents.emit(event);
      if (this.#state === null) {
        this.#pendingEvents.push(event);
        return;
      }
      await this.#state.emit(event);
    },
  };

  constructor(options: RecursInteractiveShellOptions) {
    this.#terminal = options.terminal ?? new ProcessTerminal();
    this.#cwd = options.cwd;
    this.#animate = options.animate ?? true;
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

  async onboard<T>(
    run: (
      ui: InteractiveOnboardingUi,
      signal?: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
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
    );
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
        tui.stop();
        try {
          return await operation();
        } finally {
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
    try {
      return await run(ui, controller.signal);
    } finally {
      signal?.removeEventListener("abort", onExternalAbort);
      removeCancellationListener();
      tui.stop();
    }
  }

  async start(
    runtime: RecursRuntime,
    options: InteractiveShellStartOptions = {},
  ): Promise<InteractiveShellExit> {
    const state = new TerminalUiState({
      ...runtimeSession(runtime),
      workspace: path.basename(this.#cwd),
    }, runtime.companyBlueprint);
    this.#state = state;
    for (const event of this.#pendingEvents.splice(0)) await state.emit(event);

    const tui = new TUI(this.#terminal);
    const companyAvailable = runtime.companyBlueprint !== null;
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
    const chat = new ChatComponent(
      tui,
      this.#transcript,
      session,
      runtime.commandNames(),
      this.#cwd,
      this.#colorEnabled,
      () => this.#terminal.rows,
    );
    const companyEditor = new Editor(tui, editorTheme(this.#colorEnabled), {
      paddingX: 1,
    });
    companyEditor.setAutocompleteProvider(new TerminalSafeAutocompleteProvider(
      new CombinedAutocompleteProvider(
        runtime.commandNames().map((name) => ({ name })),
        this.#cwd,
      ),
    ));
    let view: "launch" | "company" | "chat" | "tasks" = "company";
    let viewBeforeTasks: "company" | "chat" = "company";
    const showChat = (node?: TerminalCompanyNodeView): void => {
      if (node !== undefined) chat.setCompanyFocus(node);
      if (view === "chat") return;
      view = "chat";
      mount(chat, chat.editor);
    };
    const showCompany = (): void => {
      if (!companyAvailable) {
        showChat();
        return;
      }
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
      if (view !== "tasks") {
        viewBeforeTasks = view === "chat" ? "chat" : "company";
      }
      view = "tasks";
      mount(tasks, tasks);
    };
    const hideTasks = (): void => {
      if (viewBeforeTasks === "chat") showChat();
      else showCompany();
    };
    const home = new CompanyHomeComponent(state, {
      frame: () => this.#frame,
      openChat: showChat,
      ...(options.launch === false ? {} : { back: showLaunch }),
      quit: () => finish({ type: "quit" }),
      refresh: () => tui.requestRender(),
      theme: this.#theme,
      rows: () => this.#terminal.rows,
      editor: companyEditor,
    });
    const tasks = new TaskPanelComponent(state, {
      openChat: showChat,
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
          if (companyAvailable) showCompany();
          else showChat();
        }
        else finish({ type: "resume_session", sessionId });
      },
      newProject: () => finish({ type: "new_project" }),
      quit: () => finish({ type: "quit" }),
      refresh: () => tui.requestRender(),
    }, {
      rows: () => this.#terminal.rows,
      theme: this.#theme,
    });
    const ask = async (
      question: string,
      options: readonly string[] = [],
      signal?: AbortSignal,
      label?: string,
    ): Promise<string | null> => {
      showChat();
      tui.setFocus(chat.editor);
      const pending = chat.ask(question, options, signal, label);
      tui.requestRender(true);
      const answer = await pending;
      tui.requestRender(true);
      return answer;
    };
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
      if (activeSubmissions > 0 && !runtime.canAcceptLiveInput) {
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
        if (!isCommandResult(result)) return;
        if (result.type === "quit") {
          finish({ type: "quit" });
          return;
        }
        if (result.type === "attach_process") {
          tui.stop();
          try {
            await this.#attachProcess(
              runtime,
              result.sessionId,
              this.#input,
              this.#output,
            );
          } finally {
            tui.start();
            tui.setFocus(
              view === "chat"
                ? chat.editor
                : view === "launch"
                  ? launch
                  : view === "tasks" ? tasks : home,
            );
            tui.requestRender(true);
          }
          return;
        }
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
      showChat();
      const task = submit(value);
      submissionTasks.add(task);
      void task.finally(() => submissionTasks.delete(task));
    };
    tui.addInputListener((data) => {
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
        if (!companyAvailable || view === "company") showChat();
        else showCompany();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("c")) && runtime.cancel()) {
        return { consume: true };
      }
      return undefined;
    });
    if (!supportsLaunch) {
      if (companyAvailable) mount(home, home);
      else {
        view = "chat";
        mount(chat, chat.editor);
      }
    } else {
      view = "launch";
      mount(launch, launch);
    }
    state.onChange(() => tui.requestRender());
    this.#terminal.setTitle(terminalTitle(this.#cwd));
    tui.start();
    tui.requestRender(true);
    const animation = this.#animate
      ? setInterval(() => {
          this.#frame = (this.#frame + 1) % 2;
          tui.requestRender();
        }, 650)
      : undefined;
    try {
      return await finished;
    } finally {
      if (animation !== undefined) clearInterval(animation);
      state.onChange(null);
      chat.cancelQuestions();
      tui.stop();
      runtime.cancel();
      await runtime.close?.();
      await Promise.allSettled([...submissionTasks]);
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
