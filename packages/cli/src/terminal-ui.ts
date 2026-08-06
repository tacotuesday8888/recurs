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
} from "@recurs/core";
import {
  createHostInvocation,
  modelImagesByteLength,
  type ModelImageInput,
} from "@recurs/contracts";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { Writable, type Readable } from "node:stream";

import type { ApprovalResponse } from "@recurs/tools";

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
  TerminalUiState,
  renderCompanyHome,
} from "./terminal-ui-state.js";

export type InteractiveTerminal = Terminal;

export interface InteractiveOnboardingChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
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
  readonly openChat: () => void;
  readonly quit: () => void;
  readonly refresh?: () => void;
  readonly frame: () => number;
  readonly style?: (text: string) => string;
}

export class CompanyHomeComponent implements Component {
  #selectedAgentIndex = 0;

  constructor(
    private readonly state: TerminalUiState,
    private readonly actions: CompanyHomeActions,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const snapshot = this.state.snapshot();
    this.#selectedAgentIndex = Math.min(
      this.#selectedAgentIndex,
      Math.max(0, snapshot.agents.length - 1),
    );
    const lines = renderCompanyHome(
      snapshot,
      width,
      this.actions.frame(),
      snapshot.agents[this.#selectedAgentIndex]?.assignmentId,
    );
    const style = this.actions.style ?? ((text: string) => text);
    return lines.map((line) => line.length === 0 ? line : style(line));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.actions.openChat();
    } else if (data === "q" || matchesKey(data, Key.escape)) {
      this.actions.quit();
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const count = this.state.snapshot().agents.length;
      if (count === 0) return;
      const offset = matchesKey(data, Key.up) ? -1 : 1;
      this.#selectedAgentIndex = (this.#selectedAgentIndex + offset + count) % count;
      this.actions.refresh?.();
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

class OnboardingComponent extends Container {
  readonly #question = new Text();
  readonly #footer: Text;
  readonly #editor: Editor;
  #input: Component | null = null;
  #cancelActive: (() => void) | null = null;

  constructor(
    private readonly tui: TUI,
    buffer: TranscriptBuffer,
    private readonly colorEnabled: boolean,
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
    const transcript = new Text();
    buffer.onChange(() => {
      transcript.setText(accent(buffer.text().replace(/^\n+/u, "")));
      tui.requestRender();
    });
    this.addChild(new Text(
      `${strong(accent("RECURS / SETUP"))}  ${muted("form your coding company")}`,
      1,
      0,
    ));
    this.addChild(transcript);
    this.addChild(this.#question);
    this.addChild(this.#footer);
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
    const list = new SelectList(
      choices.map((choice) => ({
        value: choice.id,
        label: sanitizeTerminalText(choice.label, { multiline: false }),
        description: sanitizeTerminalText(choice.detail, { multiline: false }),
      })),
      Math.min(8, choices.length),
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
      list.onSelect = (item) => settle(() => resolve(item.value));
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
    this.#question.setText("Working…");
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
    this.#question.setText("Working…");
    this.tui.setFocus(null);
    this.tui.requestRender(true);
  }
}

function onboardingAbortError(): DOMException {
  return new DOMException("Guided setup was cancelled", "AbortError");
}

interface PendingQuestion {
  readonly text: string;
  readonly options: readonly string[];
  readonly settle: (answer: string | null) => void;
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
    colorEnabled: boolean,
  ) {
    super();
    const accent = ansi("96", colorEnabled);
    const muted = ansi("2", colorEnabled);
    this.#header = new Text(
      `${accent("RECURS / CHAT")}  ${muted(`${session.mode} · ${session.model} · ${session.permission}`)}`,
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
      muted("recurs ›  Enter send · Shift+Enter newline · Ctrl+G company · Ctrl+C cancel"),
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

  ask(
    text: string,
    options: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted === true) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const question: PendingQuestion = {
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
        sanitizeTerminalText(this.#pending.text),
        ...this.#pending.options.map(
          (option, index) =>
            `  ${index + 1}. ${sanitizeTerminalText(option, { multiline: false })}`,
        ),
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
    this.#colorEnabled = options.colorEnabled ??
      options.terminal === undefined;
    this.#loadImages = options.loadImages ?? loadImageInputs;
    this.#attachProcess = options.attachProcess ?? attachOwnedTerminalProcess;
    this.#input = options.input ?? processStdin;
    this.#output = options.output ?? processStdout;
    this.#transcriptOutput = new Writable({
      write: (chunk, _encoding, callback) => {
        this.#transcript.append(chunk.toString());
        callback();
      },
    });
    this.#textEvents = new TextEventRenderer(this.#transcriptOutput, {
      colorEnabled: false,
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
    tui.addChild(component);
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

  async start(runtime: RecursRuntime): Promise<void> {
    const state = new TerminalUiState(runtimeSession(runtime));
    this.#state = state;
    for (const event of this.#pendingEvents.splice(0)) await state.emit(event);

    const tui = new TUI(this.#terminal);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const session = runtimeSession(runtime);
    const chat = new ChatComponent(
      tui,
      this.#transcript,
      session,
      runtime.commandNames(),
      this.#cwd,
      this.#colorEnabled,
    );
    let view: "company" | "chat" = "company";
    const showChat = (): void => {
      if (view === "chat") return;
      view = "chat";
      tui.clear();
      tui.addChild(chat);
      tui.setFocus(chat.editor);
      tui.requestRender(true);
    };
    const showCompany = (): void => {
      if (view === "company") return;
      view = "company";
      tui.clear();
      tui.addChild(home);
      tui.setFocus(home);
      tui.requestRender(true);
    };
    const home = new CompanyHomeComponent(state, {
      frame: () => this.#frame,
      openChat: showChat,
      quit: finish,
      refresh: () => tui.requestRender(),
      style: ansi("96", this.#colorEnabled),
    });
    const ask = async (
      question: string,
      options: readonly string[] = [],
      signal?: AbortSignal,
    ): Promise<string | null> => {
      showChat();
      tui.setFocus(chat.editor);
      const pending = chat.ask(question, options, signal);
      tui.requestRender(true);
      const answer = await pending;
      tui.requestRender(true);
      return answer;
    };
    runtime.setConfirmHandler(async (message) => {
      const answer = await ask(`${message} [y/N]`, [], runtime.currentSignal());
      return answer?.trim().toLowerCase() === "y" ||
        answer?.trim().toLowerCase() === "yes";
    });
    runtime.setApprovalHandler?.(async (intent): Promise<ApprovalResponse> => {
      const answer = await ask(
        `Allow ${intent.category} access to ${intent.resource}?`,
        ["yes — once", "always — this session", "deny"],
        runtime.currentSignal(),
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
        await ask(request.question, request.options, signal) ?? "",
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
          finish();
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
            tui.setFocus(view === "chat" ? chat.editor : home);
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
    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("g"))) {
        if (view === "company") showChat();
        else showCompany();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("c")) && runtime.cancel()) {
        return { consume: true };
      }
      return undefined;
    });
    tui.addChild(home);
    tui.setFocus(home);
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
      await finished;
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
