import type { RecursRuntime } from "../src/runtime.js";
import type { HostInvocation, ModelImageInput } from "@recurs/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  visibleWidth,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";

import {
  CompanyHomeComponent,
  RecursInteractiveShell,
  TerminalSafeAutocompleteProvider,
  type InteractiveTerminal,
} from "../src/terminal-ui.js";
import { TerminalUiState } from "../src/terminal-ui-state.js";

class TestTerminal implements InteractiveTerminal {
  readonly kittyProtocolActive = false;
  input: ((data: string) => void) | null = null;
  output = "";
  readonly writes: string[] = [];
  starts = 0;
  stops = 0;
  title = "";

  constructor(
    readonly columns = 80,
    readonly rows = 30,
  ) {}

  start(onInput: (data: string) => void): void {
    this.starts += 1;
    this.input = onInput;
  }
  stop(): void {
    this.stops += 1;
    this.input = null;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(title: string): void { this.title = title; }
  setProgress(): void {}
}

describe("CompanyHomeComponent", () => {
  it("opens chat with Enter and quits with q without selection chrome", () => {
    const openChat = vi.fn();
    const quit = vi.fn();
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });
    const component = new CompanyHomeComponent(state, {
      openChat,
      quit,
      frame: () => 0,
    });

    const view = component.render(80).join("\n");
    expect(view).toContain("RECURS / COMPANY");
    expect(view).not.toContain("┌");
    component.handleInput("\r");
    component.handleInput("q");

    expect(openChat).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("moves a subtle inspector between activated agents", async () => {
    const refresh = vi.fn();
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });
    await state.emit({
      type: "company_assignment_started",
      goalRunId: "goal-1",
      assignmentId: "implement-1",
      parentAssignmentId: null,
      childAgentId: "child-1",
      departmentId: "engineering",
      roleId: "implement",
      roleName: "Implement",
      task: "Build the change",
      occurredAt: "2026-08-06T00:00:00.000Z",
    });
    await state.emit({
      type: "company_assignment_started",
      goalRunId: "goal-1",
      assignmentId: "review-1",
      parentAssignmentId: null,
      childAgentId: "child-2",
      departmentId: "quality",
      roleId: "review",
      roleName: "Review",
      task: "Review the change",
      occurredAt: "2026-08-06T00:00:01.000Z",
    });
    await state.emit({
      type: "agent_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:02.000Z",
      parentAgentId: "parent-agent",
      childAgentId: "child-1",
      childSessionId: "session-1",
      taskId: "task-1",
      description: "Build the change",
      operatingModeId: "balanced_v6",
      profileId: "implement_v2",
      modelId: "implement-model",
      reasoningEffort: "medium",
      backendStrategy: "role_candidate",
      backendReason: "eligible_role_candidate",
    });
    await state.emit({
      type: "agent_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:03.000Z",
      parentAgentId: "parent-agent",
      childAgentId: "child-2",
      childSessionId: "session-2",
      taskId: "task-2",
      description: "Review the change",
      operatingModeId: "balanced_v6",
      profileId: "review_v2",
      modelId: "review-model",
      reasoningEffort: "medium",
      backendStrategy: "role_candidate",
      backendReason: "eligible_role_candidate",
    });
    const component = new CompanyHomeComponent(state, {
      openChat() {},
      quit() {},
      refresh,
      frame: () => 0,
    });

    expect(component.render(100).join("\n"))
      .toContain("ENGINEERING · RUNNING");
    component.handleInput("\u001b[B");
    const moved = component.render(100).join("\n");

    expect(moved).toContain("QUALITY · RUNNING");
    expect(moved).not.toContain("┌");
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("TerminalSafeAutocompleteProvider", () => {
  it("drops suggestions whose rendered or inserted text contains terminal controls", async () => {
    const delegate = {
      async getSuggestions() {
        return {
          prefix: "@",
          items: [
            { value: "safe.ts", label: "safe.ts" },
            { value: "unsafe\u001b.ts", label: "unsafe.ts" },
            { value: "other.ts", label: "other\u0007.ts" },
          ],
        };
      },
      applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
        return { lines, cursorLine, cursorCol };
      },
    } satisfies AutocompleteProvider;
    const provider = new TerminalSafeAutocompleteProvider(delegate);

    const result = await provider.getSuggestions(["@"], 0, 1, {
      signal: new AbortController().signal,
    });

    expect(result?.items).toEqual([{ value: "safe.ts", label: "safe.ts" }]);
  });
});

describe("RecursInteractiveShell", () => {
  it("cancels an onboarding operation while the surface is working", async () => {
    const terminal = new TestTerminal();
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      colorEnabled: false,
    });
    const onboarding = shell.onboard(async (_ui, signal) => {
      if (signal === undefined) throw new Error("missing onboarding signal");
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return "unreachable";
    });
    const rejected = expect(onboarding).rejects.toMatchObject({
      name: "AbortError",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\u0003");

    await rejected;
    expect(terminal.input).toBeNull();
  });

  it.each([
    ["choice", "\u001b"],
    ["text", "\u0003"],
  ] as const)("cancels an onboarding %s prompt from the keyboard", async (
    prompt,
    key,
  ) => {
    const terminal = new TestTerminal();
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      colorEnabled: false,
    });
    const onboarding = shell.onboard(async (ui) => {
      const choice = await ui.selectChoice("Choose a provider", [{
        id: "codex",
        label: "Codex",
        detail: "Use the saved subscription",
      }]);
      if (prompt === "choice") return choice;
      return await ui.promptText("Name the company", "Platform");
    });
    const rejected = expect(onboarding).rejects.toMatchObject({
      name: "AbortError",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    if (prompt === "text") {
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(terminal.output).toContain("Name the company");
    }
    terminal.input?.(key);

    await rejected;
    expect(terminal.input).toBeNull();
  });

  it.each([36, 120])(
    "keeps long onboarding content within a %d-column terminal",
    async (columns) => {
      const terminal = new TestTerminal(columns, 30);
      const shell = new RecursInteractiveShell({
        terminal,
        cwd: "/workspace",
        animate: false,
        colorEnabled: false,
      });
      const long = "company formation context ".repeat(12);
      const onboarding = shell.onboard(async (ui) => {
        ui.stdout.write(`${long}\n`);
        return await ui.selectChoice(`Choose ${long}`, [{
          id: "recommended",
          label: `Recommended ${long}`,
          detail: `Why ${long}`,
        }]);
      });
      const rejected = expect(onboarding).rejects.toMatchObject({
        name: "AbortError",
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      const widths = terminal.writes.flatMap((write) =>
        write.split("\u001b[?2026h").join("")
          .split("\u001b[?2026l").join("")
          .split(/\r?\n/u)
          .map((line) => visibleWidth(line))
      );
      expect(Math.max(...widths)).toBeLessThanOrEqual(columns);
      terminal.input?.("\u001b");
      await rejected;
    },
  );

  it("runs guided setup choices and text in the same terminal surface", async () => {
    const terminal = new TestTerminal();
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      colorEnabled: true,
    });
    let suspended = false;

    const onboarding = shell.onboard(async (ui) => {
      ui.stdout.write("Welcome to the guided company setup.\n");
      const connection = await ui.selectChoice("Choose a parent model", [
        {
          id: "saved",
          label: "Use saved Codex",
          detail: "vendor-owned authentication\u001b]0;unsafe\u0007",
        },
        {
          id: "local",
          label: "Use local model",
          detail: "local compute",
        },
      ]);
      const team = await ui.promptText("Name this team", "Platform");
      const confirmed = await ui.confirm("Approve this company?");
      const external = await ui.runExternal(async () => {
        suspended = terminal.input === null;
        return "ready";
      });
      return { connection, team, confirmed, external };
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.output).toContain("RECURS / SETUP");
    expect(terminal.output).toContain("Use saved Codex");
    expect(terminal.output).toContain("vendor-owned authentication");
    expect(terminal.output).not.toContain("\u001b]0;unsafe\u0007");
    expect(terminal.output).not.toContain("[38;5;");
    terminal.input?.("\r");

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.output).toContain("Name this team");
    expect(terminal.output).toContain("Platform");
    terminal.input?.("\r");

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.output).toContain("Approve this company?");
    terminal.input?.("\u001b[B");
    terminal.input?.("\r");

    await expect(onboarding).resolves.toEqual({
      connection: "saved",
      team: "Platform",
      confirmed: true,
      external: "ready",
    });
    expect(suspended).toBe(true);
    expect(terminal.starts).toBe(2);
    expect(terminal.stops).toBe(2);
    expect(terminal.input).toBeNull();
  });

  it("applies TUI color without exposing nested ANSI fragments", async () => {
    const terminal = new TestTerminal();
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      colorEnabled: true,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    await shell.events.emit({
      type: "warning",
      sessionId: "session-1",
      at: "2026-08-06T00:00:00.000Z",
      message: "Context is nearly full",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.output).toContain("Warning: Context is nearly full");
    expect(terminal.output).not.toContain("[33mWarning");

    terminal.input?.("\u001b[200~/quit\u001b[201~");
    terminal.input?.("\r");
    await running;
  });

  it("starts on the company view and closes runtime truthfully", async () => {
    const terminal = new TestTerminal();
    let closed = 0;
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async submit(input: string) {
        return input === "/quit"
          ? { type: "quit" as const }
          : { type: "message" as const, level: "info" as const, text: "ok" };
      },
      async close() { closed += 1; },
      commandNames() { return ["goal", "quit"]; },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.output).toContain("RECURS / COMPANY");
    terminal.input?.("q");
    await running;

    expect(closed).toBe(1);
    expect(terminal.input).toBeNull();
  });

  it("strips terminal control sequences from the workspace title", async () => {
    const terminal = new TestTerminal();
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace/unsafe\u0007\u001b]0;injected",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("q");
    await running;

    expect(terminal.title).toBe("Recurs · /workspace/unsafe]0;injected");
    expect([...terminal.title].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })).toBe(true);
  });

  it("moves from company to chat and submits through the same runtime", async () => {
    const terminal = new TestTerminal();
    const submitted: string[] = [];
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["goal", "quit"]; },
      async submit(input: string) {
        submitted.push(input);
        return input === "/quit"
          ? { type: "quit" as const }
          : { type: "message" as const, level: "info" as const, text: "ok" };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.output).toContain("RECURS / CHAT");
    expect(terminal.output).toContain("recurs ›");

    terminal.input?.("\u001b[200~/quit\u001b[201~");
    terminal.input?.("\r");
    await running;
    expect(submitted).toEqual(["/quit"]);
  });

  it("removes terminal controls from rendered runtime text", async () => {
    const terminal = new TestTerminal();
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit(input: string) {
        return input === "/quit"
          ? { type: "quit" as const }
          : {
              type: "message" as const,
              level: "info" as const,
              text: "safe\u001b]0;injected\u0007",
            };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    for (const line of ["render text", "/quit"]) {
      terminal.input?.(`\u001b[200~${line}\u001b[201~`);
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await running;

    expect(terminal.output).not.toContain("safe\u001b]0;injected\u0007");
    expect(terminal.output).toContain("safe]0;injected");
  });

  it("stages images locally and attaches them to exactly the next prompt", async () => {
    const terminal = new TestTerminal();
    const submissions: Array<{
      readonly input: string;
      readonly images?: readonly ModelImageInput[];
    }> = [];
    const image = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      hasActiveRun: false,
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit(
        input: string,
        _invocation: HostInvocation,
        options: { readonly images?: readonly ModelImageInput[] } = {},
      ) {
        submissions.push({ input, ...options });
        return input === "/quit"
          ? { type: "quit" as const }
          : { type: "message" as const, level: "info" as const, text: "ok" };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      async loadImages(paths, cwd) {
        expect(paths).toEqual(["screen.png"]);
        expect(cwd).toBe("/workspace");
        return [image];
      },
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    for (const line of [
      "/image screen.png",
      "Inspect this screen",
      "Continue",
      "/quit",
    ]) {
      terminal.input?.(`\u001b[200~${line}\u001b[201~`);
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await running;

    expect(submissions).toEqual([
      { input: "Inspect this screen", images: [image] },
      { input: "Continue" },
      { input: "/quit" },
    ]);
    expect(terminal.output).toContain("Images staged for the next prompt: 1/4");
  });

  it("restores the TUI around an owned process attachment", async () => {
    const terminal = new TestTerminal();
    const attachments: string[] = [];
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["attach", "quit"]; },
      async submit(input: string) {
        return input === "/attach"
          ? { type: "attach_process" as const, sessionId: "process-1" }
          : { type: "quit" as const };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      async attachProcess(_runtime, sessionId) {
        attachments.push(sessionId);
      },
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    terminal.input?.("\u001b[200~/attach\u001b[201~");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\u001b[200~/quit\u001b[201~");
    terminal.input?.("\r");
    await running;

    expect(attachments).toEqual(["process-1"]);
    expect(terminal.starts).toBe(2);
    expect(terminal.stops).toBe(2);
  });

  it("restores terminal input when process attachment fails", async () => {
    const terminal = new TestTerminal();
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["attach", "quit"]; },
      async submit(input: string) {
        return input === "/attach"
          ? { type: "attach_process" as const, sessionId: "process-1" }
          : { type: "quit" as const };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      async attachProcess() {
        throw new Error("attachment failed");
      },
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    terminal.input?.("\u001b[200~/attach\u001b[201~");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(terminal.starts).toBe(2);
    expect(terminal.input).not.toBeNull();
    terminal.input?.("\u001b[200~/quit\u001b[201~");
    terminal.input?.("\r");
    await running;
    expect(terminal.output).toContain("Error: Unexpected failure");
  });

  it("renders runtime questions in chat and returns the entered decision", async () => {
    const terminal = new TestTerminal();
    let confirm: ((message: string) => Promise<boolean>) | null = null;
    let allowed: boolean | null = null;
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler(handler: (message: string) => Promise<boolean>) {
        confirm = handler;
      },
      setApprovalHandler() {},
      setUserInputHandler() {},
      currentSignal() { return new AbortController().signal; },
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit(input: string) {
        if (input === "ask") {
          allowed = await confirm!("Apply the reviewed change?");
          return { type: "message" as const, level: "info" as const, text: "decided" };
        }
        return { type: "quit" as const };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    terminal.input?.("\u001b[200~ask\u001b[201~");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.output).toContain("Apply the reviewed change? [y/N]");
    terminal.input?.("yes");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\u001b[200~/quit\u001b[201~");
    terminal.input?.("\r");
    await running;

    expect(allowed).toBe(true);
  });

  it("does not overlap turns when the runtime cannot accept live input", async () => {
    const terminal = new TestTerminal();
    const submitted: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      canAcceptLiveInput: false,
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit(input: string) {
        submitted.push(input);
        if (input === "first") await blocked;
        return input === "/quit"
          ? { type: "quit" as const }
          : { type: "message" as const, level: "info" as const, text: "ok" };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    for (const line of ["first", "second"]) {
      terminal.input?.(`\u001b[200~${line}\u001b[201~`);
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(submitted).toEqual(["first"]);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\u001b[200~/quit\u001b[201~");
    terminal.input?.("\r");
    await running;

    expect(terminal.output).toContain("Wait for the active turn");
  });

  it("queues concurrent runtime questions instead of dropping agent decisions", async () => {
    const terminal = new TestTerminal();
    let confirm: ((message: string) => Promise<boolean>) | null = null;
    let decisions: readonly boolean[] | null = null;
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler(handler: (message: string) => Promise<boolean>) {
        confirm = handler;
      },
      setApprovalHandler() {},
      setUserInputHandler() {},
      currentSignal() { return new AbortController().signal; },
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit(input: string) {
        if (input === "ask twice") {
          decisions = await Promise.all([
            confirm!("Approve implementation?"),
            confirm!("Approve review?"),
          ]);
          return { type: "message" as const, level: "info" as const, text: "decided" };
        }
        return { type: "quit" as const };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    terminal.input?.("\u001b[200~ask twice\u001b[201~");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("yes");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const showedSecond = terminal.output.includes("Approve review? [y/N]");
    if (showedSecond) {
      terminal.input?.("no");
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
      terminal.input?.("\u001b[200~/quit\u001b[201~");
      terminal.input?.("\r");
    } else {
      terminal.input?.("\u0007");
      terminal.input?.("q");
    }
    await running;

    expect(showedSecond).toBe(true);
    expect(decisions).toEqual([true, false]);
  });

  it("removes an unanswered runtime question when its turn is cancelled", async () => {
    const terminal = new TestTerminal();
    const controller = new AbortController();
    let askUser:
      | ((request: { question: string; options: readonly string[] }, signal: AbortSignal) => Promise<string | null>)
      | null = null;
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler(handler: typeof askUser) { askUser = handler; },
      cancel() {
        controller.abort();
        return true;
      },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const answer = askUser!(
      { question: "Which path?", options: ["A", "B"] },
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.output).toContain("Which path?");
    terminal.input?.("\u0003");

    await expect(answer).resolves.toBeNull();
    terminal.input?.("\u0007");
    terminal.input?.("q");
    await running;
  });

  it("restores an unfinished draft after a runtime question", async () => {
    const terminal = new TestTerminal();
    let confirm: ((message: string) => Promise<boolean>) | null = null;
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      setConfirmHandler(handler: (message: string) => Promise<boolean>) {
        confirm = handler;
      },
      setApprovalHandler() {},
      setUserInputHandler() {},
      currentSignal() { return new AbortController().signal; },
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
      async submit() {
        throw new Error("the draft must not be submitted");
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.input?.("\r");
    terminal.input?.("unfinished draft");
    const decision = confirm!("Apply the reviewed change?");
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.output = "";
    terminal.input?.("yes");
    terminal.input?.("\r");
    await expect(decision).resolves.toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(terminal.output).toContain("unfinished draft");
    terminal.input?.("\u0007");
    terminal.input?.("q");
    await running;
  });
});
