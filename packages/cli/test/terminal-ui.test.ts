import { createTerminalTheme } from "../src/terminal-style.js";
import * as terminalOpening from "../src/terminal-opening.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecursRuntime } from "../src/runtime.js";
import { createCommandRegistry } from "../src/commands/create.js";
import { AgentLoop, JsonlSessionStore, createRootAgentDescriptor, isPinnedSessionState } from "@recurs/core";
import { ScriptedProvider } from "@recurs/providers";
import { ToolRegistry } from "@recurs/tools";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";
import type { HostInvocation, ModelImageInput } from "@recurs/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  visibleWidth,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";

import {
  CompanyHomeComponent,
  LaunchComponent,
  RecursInteractiveShell,
  TaskPanelComponent,
  TerminalSafeAutocompleteProvider,
  type InteractiveTerminal,
} from "../src/terminal-ui.js";
import { TerminalUiState } from "../src/terminal-ui-state.js";
import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";

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
  it("opens chat, returns to projects with Escape, and quits with q", () => {
    const openChat = vi.fn();
    const back = vi.fn();
    const quit = vi.fn();
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });
    const component = new CompanyHomeComponent(state, {
      openChat,
      back,
      quit,
      frame: () => 0,
    });

    const view = component.render(80).join("\n");
    expect(view).toContain("Recurs · workspace · Team");
    expect(view).not.toContain("┌");
    component.handleInput("\r");
    component.handleInput("\u001b");
    component.handleInput("q");

    expect(openChat).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
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
      .toContain("Parent · ready");
    component.handleInput("\u001b[B");
    expect(component.render(100).join("\n"))
      .toContain("> Implement");
    component.handleInput("\u001b[B");
    const moved = component.render(100).join("\n");

    expect(moved).toContain("> Review");
    expect(moved).not.toContain("┌");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("navigates the complete onboarding-defined roster and opens the selected role", () => {
    const openChat = vi.fn();
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    }, companyBlueprintV2Fixture());
    const component = new CompanyHomeComponent(state, {
      openChat,
      quit() {},
      frame: () => 0,
    });

    expect(component.render(110).join("\n")).toContain("> Orchestrator");
    component.handleInput("\u001b[B");
    expect(component.render(110).join("\n")).toContain("> Independent Reviewer");
    component.handleInput("\r");

    expect(openChat).toHaveBeenCalledWith(expect.objectContaining({
      roleId: "quality_reviewer",
      roleName: "Independent Reviewer",
      activated: false,
    }));
  });
});

describe("LaunchComponent", () => {
  it("prioritizes saved chats over the opening artwork", () => {
    const sessions = Array.from({ length: 4 }, (_, index) => ({ id: `chat-${index}`, title: `Saved work ${index}`, cwd: "/workspace", model: "model", updatedAt: "2026-09-12T00:00:00Z", version: 2 as const }));
    const component = new LaunchComponent({ workspace: "project", currentSessionId: "chat-0", sessions }, { openSession() {}, newProject() {}, quit() {}, refresh() {} }, { rows: () => 30, theme: createTerminalTheme(process.stdout, { colorEnabled: false }) });
    const rows = component.render(100);
    for (const entry of sessions) expect(rows.join("\n")).toContain(entry.title);
    expect(rows).toHaveLength(30);
  });

  it.each([1, 2, 3, 4, 8, 10, 12, 24])("keeps home selection visible at %i rows after navigation and resize", (height) => {
    const openSession = vi.fn(), newProject = vi.fn();
    const sessions = Array.from({ length: 100 }, (_, i) => ({ id: `session-${i}`, cwd: "/workspace", model: `model-${i}`, updatedAt: "2026-09-12T00:00:00Z", version: 2 as const }));
    const component = new LaunchComponent({ workspace: "project", currentSessionId: "session-0", sessions }, { openSession, newProject, quit() {}, refresh() {} }, { rows: () => height });
    for (let i = 0; i < 100; i++) component.handleInput("\u001b[B");
    const rows = component.render(32);
    expect(rows.length).toBeLessThanOrEqual(height);
    expect(rows.every((row) => visibleWidth(row) <= 32)).toBe(true);
    expect(rows.join("\n")).toContain("> Start new chat");
    component.handleInput("\r");
    expect(newProject).toHaveBeenCalledOnce();
    component.handleInput("\u001b[B");
    expect(component.render(32).join("\n")).toContain("> Current chat");
    component.handleInput("\r");
    expect(openSession).toHaveBeenCalledWith("session-0");
  });
  it("shows real recent chats plus a new chat that retains the current configuration", () => {
    const openSession = vi.fn();
    const newProject = vi.fn();
    const component = new LaunchComponent({
      workspace: "auth-service",
      currentSessionId: "session-current",
      sessions: [{
        id: "session-current",
        cwd: "/workspace/auth-service",
        model: "gpt-5.6-sol",
        updatedAt: "2026-08-14T01:00:00.000Z",
        version: 2,
      }, {
        id: "session-older",
        cwd: "/workspace/auth-service",
        model: "gpt-5.6-terra",
        updatedAt: "2026-08-13T01:00:00.000Z",
        version: 2,
      }],
    }, {
      openSession,
      newProject,
      quit() {},
      refresh() {},
    });

    const first = component.render(92).join("\n");
    expect(first).toContain("RECURS / AUTH-SERVICE");
    expect(first).toContain("Chats · 2");
    expect(first).toContain("Use current model");
    expect(first).not.toContain("████   █████");
    expect(first).toContain("> Current chat");
    expect(first).toContain("gpt-5.6-sol");
    expect(first).not.toContain("session-current");
    expect(first).not.toContain("session-older");
    expect(first).toContain("Start new chat");

    component.handleInput("\u001b[B");
    component.handleInput("\r");
    expect(openSession).toHaveBeenCalledWith("session-older");

    component.handleInput("\u001b[B");
    component.handleInput("\r");
    expect(newProject).toHaveBeenCalledOnce();
  });

  it("keeps the new-project onboarding action available with no saved chats", () => {
    const newProject = vi.fn();
    const component = new LaunchComponent({
      workspace: "new-project",
      currentSessionId: null,
      sessions: [],
    }, {
      openSession() {},
      newProject,
      quit() {},
      refresh() {},
    });

    expect(component.render(34).join("\n")).toContain("> Start new chat");
    component.handleInput("\r");
    expect(newProject).toHaveBeenCalledOnce();
  });
});

describe("TaskPanelComponent", () => {
  it("shows only real assignments and opens the selected role", async () => {
    const openChat = vi.fn();
    const back = vi.fn();
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
      workspace: "auth-service",
    }, companyBlueprintV2Fixture());
    await state.emit({
      type: "company_goal_started",
      goalRunId: "goal-1",
      objective: "Ship secure authentication",
      assignmentCount: 1,
      maxActiveAgents: 4,
      maxConcurrentAgents: 2,
      maxDelegationDepth: 2,
      maxRequests: 30,
    });
    await state.emit({
      type: "company_assignment_started",
      goalRunId: "goal-1",
      assignmentId: "implement-1",
      parentAssignmentId: null,
      childAgentId: "agent-1",
      departmentId: "engineering",
      roleId: "scoped_builder",
      roleName: "Scoped Builder",
      task: "Implement authentication",
    });
    await state.emit({
      type: "agent_started",
      childAgentId: "agent-1",
      childSessionId: "child-session",
      modelId: "implement-model",
      reasoningEffort: "medium",
    });
    const panel = new TaskPanelComponent(state, {
      openChat,
      back,
      refresh() {},
      rows: () => 12,
    });

    const renderedRows = panel.render(88);
    const rendered = renderedRows.join("\n");
    expect(renderedRows).toHaveLength(12);
    expect(renderedRows.at(-1)).toContain("ENTER INSPECT");
    expect(rendered).toContain("RECURS / AUTH-SERVICE / TASKS");
    expect(rendered).toContain("Execution history");
    expect(rendered).not.toContain("goal-1");
    expect(rendered).toContain("Scoped Builder");
    expect(rendered).toContain("implement-model · medium");
    expect(rendered).not.toContain("Independent Reviewer");
    panel.handleInput("\r");
    panel.handleInput("\u001b");

    expect(openChat).toHaveBeenCalledWith(expect.objectContaining({
      roleId: "scoped_builder",
    }));
    expect(back).toHaveBeenCalledOnce();
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
  it("refreshes same-session mode limits without changing recorded child pins", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-shell-mode-"));
    const terminal = new TestTerminal(120, 40);
    let running: ReturnType<RecursInteractiveShell["start"]> | undefined;
    let runtime: RecursRuntime | undefined;
    try {
      const sessions = new JsonlSessionStore(path.join(root, "sessions"));
      const parentPin = testBackendPin("parent-model");
      const parent = await sessions.createPinnedSession({
        id: "mode-parent", cwd: root, at: testAt, backend: parentPin,
        agent: createRootAgentDescriptor("mode-parent", parentPin, "balanced_v6", "ask_always", "act", {
          blueprintId: "company", blueprintVersion: 2, blueprintRevision: 1, roleId: "orchestrator", roleVersion: 1,
        }),
      });
      const childPin = testBackendPin("recorded-child-model", "child-connection");
      const child = await sessions.createPinnedSession({
        id: "mode-child", cwd: root, at: testAt, backend: childPin,
        agent: {
          ...createRootAgentDescriptor("mode-child", childPin),
          role: "child", profile: { id: "implement_v1", version: 1 },
          operatingMode: { id: "balanced_v3", version: 3 },
          limits: { maxDepth: 1, maxConcurrentChildren: 3, maxRetries: 0, maxRequests: 8, maxReportedCostUsd: 3 },
          parentAgentId: parent.agent.id, parentSessionId: parent.id, depth: 1,
          task: { id: "child-task", description: "Recorded child", prompt: "Inspect files" },
          backend: { strategy: "inherit_parent", adapterId: childPin.adapterId, connectionId: childPin.connectionId, modelId: childPin.modelId },
        },
      });
      const provider = new ScriptedProvider([]);
      const loop = new AgentLoop({
        provider, tools: new ToolRegistry(), sessions,
        approvals: { async request() { return "deny"; } },
        async emit() {},
        createToolContext(session, signal) {
          return { sessionId: session.id, cwd: session.cwd, signal, executionMode: session.executionMode, readRevisions: new Map() };
        },
      });
      runtime = new RecursRuntime({
        commands: createCommandRegistry({ sessions, provider }), loop, sessions,
        confirm: async () => true, now: () => testAt,
      }, parent);
      const shell = new RecursInteractiveShell({ terminal, cwd: root, animate: false, colorEnabled: false });
      running = shell.start(runtime, { launch: false });
      await vi.waitFor(() => expect(terminal.input).not.toBeNull());
      terminal.input?.("\u0014");
      await vi.waitFor(() => expect(terminal.output).toContain(`depth 1/${parent.agent.limits.maxDepth} max`));
      terminal.input?.("\u001b");
      terminal.input?.("\u001b[200~/agents mode max\u001b[201~");
      terminal.input?.("\r");
      await vi.waitFor(() => expect(runtime?.session).toMatchObject({
        id: parent.id, agent: { operatingMode: { id: "max_v6" } },
      }));
      const updated = runtime.session;
      if (!isPinnedSessionState(updated)) throw new Error("Expected pinned session");
      expect(updated.agent.limits.maxDepth).not.toBe(parent.agent.limits.maxDepth);
      const previousWrites = terminal.writes.length;
      terminal.input?.("\u0014");
      await vi.waitFor(() => {
        const frame = terminal.writes.slice(previousWrites).join("");
        expect(frame).toContain(`depth 1/${updated.agent.limits.maxDepth} max`);
        expect(frame).toContain("recorded-child-model");
      });
      expect(updated.backend.pin).toEqual(parent.backend.pin);
      const retainedChild = await sessions.loadState(child.id);
      expect(retainedChild).toMatchObject({ backend: { pin: childPin }, agent: { limits: child.agent.limits } });
      terminal.input?.("\u0011");
      await expect(running).resolves.toEqual({ type: "quit" });
    } finally {
      terminal.input?.("\u0011");
      await running;
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  // An explicit RECURS_THEME override intentionally bypasses the saved file.
  it.skipIf(process.env.RECURS_THEME !== undefined)("restores the conversation alongside an invalid appearance warning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-shell-appearance-"));
    const terminal = new TestTerminal(120, 40);
    const inspectExecution = vi.fn(async () => ({
      messages: [
        { role: "user", content: "Restore this saved conversation marker." },
        { role: "assistant", content: "The earlier answer is still available." },
      ],
    }));
    const runtime = {
      state: {
        type: "session",
        session: {
          id: "saved-appearance-session",
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      inspectExecution,
      companyBlueprint: null,
      setConfirmHandler() {}, setApprovalHandler() {}, setUserInputHandler() {},
      cancel() { return false; }, async close() {},
      commandNames() { return ["quit"]; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;
    let running: ReturnType<RecursInteractiveShell["start"]> | undefined;
    try {
      await mkdir(path.join(root, "config"), { mode: 0o700 });
      await writeFile(path.join(root, "config", "appearance.json"), "", { mode: 0o600 });
      const shell = new RecursInteractiveShell({
        terminal, cwd: root, dataDirectory: root, animate: false, colorEnabled: false,
      });
      running = shell.start(runtime, { launch: false });
      await vi.waitFor(() => {
        const frame = terminal.writes.find((write) =>
          write.includes("Appearance could not be loaded") &&
          write.includes("Restore this saved conversation marker.") &&
          write.includes("The earlier answer is still available.")
        );
        expect(frame).toBeDefined();
      });
      expect(inspectExecution).toHaveBeenCalledExactlyOnceWith("saved-appearance-session");
      terminal.input?.("\u0011");
      await expect(running).resolves.toEqual({ type: "quit" });
    } finally {
      terminal.input?.("\u0011");
      await running;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens on the chat list and enters the current project without recreating it", async () => {
    const terminal = new TestTerminal(92, 30);
    const runtime = {
      state: {
        type: "session",
        session: {
          id: "session-current",
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      async listSessions() {
        return [{
          id: "session-current",
          cwd: "/workspace/auth-service",
          model: "parent-model",
          updatedAt: "2026-08-14T01:00:00.000Z",
          version: 2 as const,
        }];
      },
      companyBlueprint: companyBlueprintV2Fixture(),
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
      cwd: "/workspace/auth-service",
      animate: false,
      colorEnabled: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("Chats · 1");
    expect(terminal.output).toContain("> Current chat");
    expect(terminal.output).not.toContain("session-current");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("RECURS / AUTH-SERVICE / CHAT");
    terminal.input?.("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.writes.at(-1)).toContain("Chats · 1");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\u0011");
    await expect(running).resolves.toEqual({ type: "quit" });
  });

  it("opens a legacy session without a company directly in normal chat", async () => {
    const terminal = new TestTerminal(92, 30);
    const runtime = {
      state: {
        type: "session",
        session: {
          id: "legacy-session",
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      async listSessions() {
        return [{
          id: "legacy-session",
          cwd: "/workspace/auth-service",
          model: "parent-model",
          updatedAt: "2026-08-14T01:00:00.000Z",
          version: 2 as const,
        }];
      },
      companyBlueprint: null,
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
      cwd: "/workspace/auth-service",
      animate: false,
      colorEnabled: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(terminal.output).toContain("RECURS / AUTH-SERVICE / CHAT");
    expect(terminal.output).not.toContain("Your company is ready");
    terminal.input?.("\u0011");
    await expect(running).resolves.toEqual({ type: "quit" });
  });

  it("returns a new-project action from the launch screen", async () => {
    const terminal = new TestTerminal(80, 24);
    const runtime = {
      state: { type: "workspace", permissionMode: "approved_for_me" },
      async listSessions() { return []; },
      setConfirmHandler() {},
      setApprovalHandler() {},
      setUserInputHandler() {},
      cancel() { return false; },
      async close() {},
      commandNames() { return ["quit"]; },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace/new-project",
      animate: false,
      colorEnabled: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("> Start new chat");
    terminal.input?.("\r");
    await expect(running).resolves.toEqual({ type: "new_project" });
  });

  it.each([
    [80, 30, true, "████   █████   ████", true],
    [80, 30, false, "████   █████   ████", false],
    [24, 16, true, "▗█▀▀█▖", true],
    [24, 16, false, "▗█▀▀█▖", false],
  ] as const)(
    "renders the first-launch setup at %d columns and %d rows with color=%s",
    async (columns, rows, colorEnabled, expected, hasColor) => {
      const terminal = new TestTerminal(columns, rows);
      const shell = new RecursInteractiveShell({
        terminal,
        cwd: "/workspace",
        animate: false,
        colorEnabled,
      });
      const onboarding = shell.onboard(async (ui) =>
        await ui.selectChoice("Choose a provider", [{
          id: "saved",
          label: "Use saved account",
          detail: "vendor-owned authentication",
        }])
      );
      const rejected = expect(onboarding).rejects.toMatchObject({
        name: "AbortError",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const finalFrame = terminal.writes.at(-1) ?? "";
      expect(finalFrame).not.toContain(expected);
      expect(finalFrame).toContain("RECURS / WORKSPACE");
      expect(finalFrame).toContain("SETUP");
      expect(finalFrame).toContain("Use saved account");
      expect(finalFrame).toContain("Esc cancel");
      expect(terminal.output.includes("\u001b[38;2;243;160;91m")).toBe(hasColor);
      terminal.input?.("\u001b");
      await rejected;
    },
  );

  it("uses the user's terminal background in a color-capable terminal", async () => {
    const terminal = new TestTerminal(80, 24);
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      colorEnabled: true,
    });
    const onboarding = shell.onboard(async (ui) =>
      await ui.selectChoice("Choose a provider", [{
        id: "saved",
        label: "Use saved account",
        detail: "vendor-owned authentication",
      }])
    );
    const rejected = expect(onboarding).rejects.toMatchObject({
      name: "AbortError",
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.writes.at(-1)).not.toContain("48;2;0;0;0");
    terminal.input?.("\u001b");
    await rejected;
  });

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

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
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

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    if (prompt === "text") {
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
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

      await new Promise<void>((resolve) => setTimeout(resolve, 30));
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

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("RECURS / WORKSPACE");
    expect(terminal.output).toContain("Use saved Codex");
    expect(terminal.output).toContain("vendor-owned authentication");
    expect(terminal.output).not.toContain("\u001b]0;unsafe\u0007");
    expect(terminal.output).toContain("[38;2;243;160;91m");
    terminal.input?.("\r");

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("Name this team");
    expect(terminal.output).toContain("Platform");
    terminal.input?.("\r");

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
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

  it("starts each setup choice on its explicit recommended option", async () => {
    const terminal = new TestTerminal(80, 24);
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      colorEnabled: false,
    });
    const onboarding = shell.onboard(async (ui) =>
      await ui.selectChoice("Choose teamwork", [{
        id: "economy",
        label: "Economy",
        detail: "one agent",
      }, {
        id: "balanced",
        label: "Balanced",
        detail: "recommended bounded company",
        recommended: true,
      }])
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");

    await expect(onboarding).resolves.toBe("balanced");
  });

  it("wraps the selected setup explanation instead of truncating it", async () => {
    const terminal = new TestTerminal(52, 20);
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      colorEnabled: false,
    });
    const onboarding = shell.onboard(async (ui) =>
      await ui.selectChoice("Choose a model connection", [{
        id: "saved",
        label: "Use saved Codex",
        detail: "Use vendor-owned authentication without losing the security boundary",
      }])
    );
    const rejected = expect(onboarding).rejects.toMatchObject({
      name: "AbortError",
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.writes.at(-1)).toContain("security boundary");
    terminal.input?.("\u001b");
    await rejected;
  });

  it("shows only the current setup step and never exposes connection IDs", async () => {
    const terminal = new TestTerminal(70, 20);
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
      colorEnabled: false,
    });
    const onboarding = shell.onboard(async (ui) => {
      ui.stdout.write("01/06  PARENT MODEL\n");
      ui.stdout.write("Verified — codex-d54998d3-9fc9 · gpt-5.6-sol\n");
      ui.stdout.write("02/06  AUTHORITY\n");
      return await ui.selectChoice("Choose authority", [{
        id: "approved",
        label: "Approved for Me",
        detail: "ask before consequential work",
      }]);
    });
    const rejected = expect(onboarding).rejects.toMatchObject({
      name: "AbortError",
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const frame = terminal.writes.at(-1) ?? "";
    expect(frame).toContain("02/06  AUTHORITY");
    expect(frame).toContain("Parent model connected · gpt-5.6-sol");
    expect(frame).not.toContain("01/06  PARENT MODEL");
    expect(frame).not.toContain("codex-d54998d3-9fc9");
    terminal.input?.("\u001b");
    await rejected;
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    await shell.events.emit({
      type: "warning",
      sessionId: "session-1",
      at: "2026-08-06T00:00:00.000Z",
      message: "Context is nearly full",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("Warning: Context is nearly full");
    expect(terminal.output).not.toContain("[33mWarning");

    terminal.input?.("\u001b[200~/quit\u001b[201~");
    terminal.input?.("\r");
    await running;
  });

  it("starts in the parent conversation and closes runtime truthfully", async () => {
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("RECURS / WORKSPACE / CHAT");
    terminal.input?.("\u0011");
    await running;

    expect(closed).toBe(1);
    expect(terminal.input).toBeNull();
  });

  it("advances onboarding animation frames and stops the timer when setup exits", async () => {
    const render = vi.spyOn(terminalOpening, "renderTerminalOpening");
    const terminal = new TestTerminal(100, 40);
    const shell = new RecursInteractiveShell({ terminal, cwd: "/workspace", colorEnabled: true });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const onboarding = shell.onboard(async () => gate);
    try {
      await vi.waitFor(() => expect(render.mock.calls.some((call) => (call[3] ?? 0) > 1)).toBe(true));
      finish(); await onboarding;
      const count = render.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(render.mock.calls).toHaveLength(count);
    } finally { finish(); await onboarding; render.mockRestore(); }
  });

  it("loads the approved onboarding blueprint into the team tree", async () => {
    const terminal = new TestTerminal(110, 36);
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      companyBlueprint: companyBlueprintV2Fixture(),
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
      cwd: "/workspace/auth-service",
      animate: false,
      colorEnabled: false,
    });

    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\u0007");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("Recurs · auth-service · Team");
    expect(terminal.output).toContain("Independent Reviewer");
    expect(terminal.output).toContain("Scoped Builder");
    expect(terminal.output).toContain("not activated");
    terminal.input?.("\u0011");
    await running;
  });

  it("opens a truthful live-task panel with Ctrl+T", async () => {
    const terminal = new TestTerminal(100, 30);
    const runtime = {
      state: {
        type: "session",
        session: {
          model: "parent-model",
          permissionMode: "approved_for_me",
          agent: { operatingMode: { id: "balanced_v6" } },
        },
      },
      companyBlueprint: companyBlueprintV2Fixture(),
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
      cwd: "/workspace/auth-service",
      animate: false,
      colorEnabled: false,
    });
    const running = shell.start(runtime);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    await shell.events.emit({
      type: "company_goal_started",
      goalRunId: "goal-1",
      objective: "Ship secure authentication",
      assignmentCount: 1,
      maxActiveAgents: 4,
      maxConcurrentAgents: 2,
      maxDelegationDepth: 2,
      maxRequests: 30,
    });
    await shell.events.emit({
      type: "company_assignment_started",
      goalRunId: "goal-1",
      assignmentId: "implement-1",
      parentAssignmentId: null,
      childAgentId: "agent-1",
      departmentId: "engineering",
      roleId: "scoped_builder",
      roleName: "Scoped Builder",
      task: "Implement authentication",
    });
    await shell.events.emit({
      type: "agent_started",
      childAgentId: "agent-1",
      childSessionId: "child-session",
      modelId: "implement-model",
      reasoningEffort: "medium",
    });

    expect(terminal.output).not.toContain("▄██▄");
    expect(terminal.output).toContain("Enter send");

    terminal.input?.("\u0014");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("RECURS / AUTH-SERVICE / TASKS");
    expect(terminal.output).toContain("Scoped Builder");
    terminal.input?.("\u001b");
    terminal.input?.("\u0011");
    await running;
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\u0011");
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("RECURS / WORKSPACE / CHAT");
    expect(terminal.output).toContain("Enter send");

    terminal.input?.("\u001b[200~/quit\u001b[201~");
    terminal.input?.("\r");
    await running;
    expect(submitted).toEqual(["/quit"]);
  });

  it("submits a goal from the parent conversation", async () => {
    const terminal = new TestTerminal(100, 30);
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
        return { type: "quit" as const };
      },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({
      terminal,
      cwd: "/workspace",
      animate: false,
    });

    const running = shell.start(runtime, { launch: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("RECURS / WORKSPACE / CHAT");
    expect(terminal.output).toContain("Enter send");
    terminal.input?.("\u001b[200~/goal ship the release\u001b[201~");
    terminal.input?.("\r");

    await expect(running).resolves.toEqual({ type: "quit" });
    expect(submitted).toEqual(["/goal ship the release"]);
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    for (const line of ["render text", "/quit"]) {
      terminal.input?.(`\u001b[200~${line}\u001b[201~`);
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    for (const line of [
      "/image screen.png",
      "Inspect this screen",
      "Continue",
      "/quit",
    ]) {
      terminal.input?.(`\u001b[200~${line}\u001b[201~`);
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    terminal.input?.("\u001b[200~/attach\u001b[201~");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    terminal.input?.("\u001b[200~/attach\u001b[201~");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    terminal.input?.("\u001b[200~ask\u001b[201~");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("╭─ APPROVAL REQUIRED");
    expect(terminal.output).toContain("Apply the reviewed change? [y/N]");
    terminal.input?.("yes");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    for (const line of ["first", "second"]) {
      terminal.input?.(`\u001b[200~${line}\u001b[201~`);
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
    expect(submitted).toEqual(["first"]);
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\u0011");
    await running;

    expect(terminal.output).toContain("draft kept");
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    terminal.input?.("\u001b[200~ask twice\u001b[201~");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("yes");
    terminal.input?.("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const showedSecond = terminal.output.includes("Approve review? [y/N]");
    if (showedSecond) {
      terminal.input?.("no");
      terminal.input?.("\r");
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      terminal.input?.("\u001b[200~/quit\u001b[201~");
      terminal.input?.("\r");
    } else {
      terminal.input?.("\u0007");
      terminal.input?.("\u0011");
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const answer = askUser!(
      { question: "Which path?", options: ["A", "B"] },
      controller.signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(terminal.output).toContain("Which path?");
    terminal.input?.("\u0003");

    await expect(answer).resolves.toBeNull();
    terminal.input?.("\u0007");
    terminal.input?.("\u0011");
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
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.input?.("\r");
    terminal.input?.("unfinished draft");
    const decision = confirm!("Apply the reviewed change?");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminal.output = "";
    terminal.input?.("yes");
    terminal.input?.("\r");
    await expect(decision).resolves.toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(terminal.output).toContain("unfinished draft");
    terminal.input?.("\u0007");
    terminal.input?.("\u0011");
    await running;
  });
});


it("keeps input submitted during a session transition as the next chat draft", async () => {
  const terminal = new TestTerminal();
  let release!: () => void;
  const transition = new Promise<void>((resolve) => { release = resolve; });
  const session = { id: "first", model: "parent-model", permissionMode: "ask_always", agent: { operatingMode: { id: "balanced_v6" } } };
  const submit = vi.fn(async () => { await transition; session.id = "second"; return { type: "message", text: "New chat" }; });
  const runtime = {
    state: { type: "session", session },
    setConfirmHandler() {}, setApprovalHandler() {}, setUserInputHandler() {},
    cancel() { return false; }, async close() {}, commandNames() { return ["new"]; }, submit,
  } as unknown as RecursRuntime;
  const shell = new RecursInteractiveShell({ terminal, cwd: "/workspace", animate: false });
  const first = shell.start(runtime);
  await vi.waitFor(() => expect(terminal.input).not.toBeNull());
  terminal.input?.("\r");
  terminal.input?.("/new"); terminal.input?.("\r");
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  terminal.input?.("keep this draft"); terminal.input?.("\r");
  await vi.waitFor(() => expect(terminal.output).toContain("draft kept"));
  expect(submit).toHaveBeenCalledOnce();
  release();
  expect(await first).toEqual({ type: "resume_session", sessionId: "second" });
  terminal.output = "";
  const second = shell.start(runtime);
  await vi.waitFor(() => expect(terminal.input).not.toBeNull());
  terminal.input?.("\r");
  await vi.waitFor(() => expect(terminal.output).toContain("keep this draft"));
  terminal.input?.("\u0011");
  await second;
});
