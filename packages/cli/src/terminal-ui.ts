import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  ProcessTerminal,
  Text,
  TUI,
  matchesKey,
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

interface PendingQuestion {
  readonly text: string;
  readonly options: readonly string[];
  readonly resolve: (answer: string | null) => void;
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
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      commands.map((name) => ({ name })),
      cwd,
    ));
    this.editor.onSubmit = (value) => {
      const expanded = value.trim();
      if (this.#pending !== null) {
        const pending = this.#pending;
        this.#pending = null;
        pending.resolve(expanded.length === 0 ? null : expanded);
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

  ask(text: string, options: readonly string[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.#questionQueue.push({ text, options, resolve });
      this.#showNextQuestion();
    });
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
    this.#pending?.resolve(null);
    this.#pending = null;
    for (const question of this.#questionQueue.splice(0)) question.resolve(null);
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
      colorEnabled: this.#colorEnabled,
    });
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
    ): Promise<string | null> => {
      showChat();
      tui.setFocus(chat.editor);
      const pending = chat.ask(question, options);
      tui.requestRender(true);
      const answer = await pending;
      tui.requestRender(true);
      return answer;
    };
    runtime.setConfirmHandler(async (message) => {
      const answer = await ask(`${message} [y/N]`);
      return answer?.trim().toLowerCase() === "y" ||
        answer?.trim().toLowerCase() === "yes";
    });
    runtime.setApprovalHandler?.(async (intent): Promise<ApprovalResponse> => {
      const answer = await ask(
        `Allow ${intent.category} access to ${intent.resource}?`,
        ["yes — once", "always — this session", "deny"],
      );
      if (answer === null) return "deny";
      if (/^[1-3]$/u.test(answer.trim())) {
        return (["allow_once", "allow_session", "deny"] as const)[
          Number.parseInt(answer.trim(), 10) - 1
        ]!;
      }
      return replApprovalResponse(answer);
    });
    runtime.setUserInputHandler?.(async (request) =>
      selectedAnswer(
        await ask(request.question, request.options) ?? "",
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
          await this.#attachProcess(
            runtime,
            result.sessionId,
            this.#input,
            this.#output,
          );
          tui.start();
          tui.setFocus(view === "chat" ? chat.editor : home);
          tui.requestRender(true);
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
