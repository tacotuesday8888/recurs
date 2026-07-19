import { describe, expect, it, vi } from "vitest";

import { createHostInvocation } from "@recurs/contracts";

import {
  activeGoal,
  createSessionState,
  reduceSessionRecord,
  type SessionRecord,
  type SessionState,
} from "@recurs/core";
import { ProviderError } from "@recurs/providers";

import {
  CommandRegistry,
  createCommandRegistry,
  parseCommand,
  type CommandContext,
} from "../src/index.js";

const at = "2026-07-10T00:00:00.000Z";

function commandContext(
  overrides: Partial<SessionState> = {},
  confirm = vi.fn(async () => true),
  cancelActiveRun = vi.fn(async () => true),
): CommandContext & { records: SessionRecord[] } {
  const context: CommandContext & { records: SessionRecord[] } = {
    session: {
      ...createSessionState({
        id: "s1",
        cwd: "/workspace",
        model: "scripted",
      }),
      ...overrides,
    },
    invocation: createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    }),
    records: [],
    confirm,
    cancelActiveRun,
    now() {
      return at;
    },
    async applyRecord(record) {
      context.records.push(record);
      context.session = reduceSessionRecord(context.session, record);
    },
  };
  return context;
}

describe("parseCommand", () => {
  it("parses command names, aliases, and inline arguments", () => {
    expect(parseCommand("/goal ship auth")).toEqual({
      name: "goal",
      args: "ship auth",
    });
    expect(parseCommand("  /EXIT  ")).toEqual({ name: "exit", args: "" });
    expect(parseCommand("normal prompt")).toBeNull();
  });

  it("rejects an empty or malformed command name", () => {
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("/goal! nope")).toBeNull();
  });
});

describe("foundation slash commands", () => {
  it("sanitizes unknown slash-command exceptions with a diagnostic id", async () => {
    const registry = new CommandRegistry([
      {
        name: "explode",
        description: "Fail unsafely",
        usage: "/explode",
        async execute() {
          throw new Error("RECURS_SLASH_COMMAND_CANARY", {
            cause: new Error("RECURS_SLASH_COMMAND_CAUSE_CANARY"),
          });
        },
      },
    ]);

    const result = await registry.execute("/explode", commandContext());

    expect(result).toMatchObject({
      type: "message",
      level: "error",
      text: expect.stringMatching(
        /^Unexpected failure \(diagnostic [0-9a-f-]{36}\)$/u,
      ),
    });
    expect(JSON.stringify(result)).not.toContain("RECURS_SLASH_COMMAND_CANARY");
    expect(JSON.stringify(result)).not.toContain(
      "RECURS_SLASH_COMMAND_CAUSE_CANARY",
    );
  });

  it("renders typed provider failures canonically in slash commands", async () => {
    const registry = new CommandRegistry([
      {
        name: "compact",
        description: "Compact",
        usage: "/compact",
        async execute() {
          throw new ProviderError(
            "authentication",
            "RECURS_COMPACT_COMMAND_CANARY",
            false,
          );
        },
      },
    ]);

    expect(await registry.execute("/compact", commandContext())).toMatchObject({
      type: "message",
      level: "error",
      text: "Provider authentication failed",
    });
  });

  it("creates, shows, pauses, and resumes a durable goal", async () => {
    const registry = createCommandRegistry();
    const context = commandContext();

    expect(await registry.execute("/goal ship auth", context)).toMatchObject({
      type: "message",
      level: "info",
    });
    expect(context.session.goal).toMatchObject({
      objective: "ship auth",
      status: "active",
    });
    expect(await registry.execute("/goal", context)).toMatchObject({
      text: expect.stringContaining("ship auth"),
    });
    await registry.execute("/goal pause", context);
    expect(context.session.goal?.status).toBe("paused");
    await registry.execute("/goal resume", context);
    expect(context.session.goal?.status).toBe("active");
    expect(context.records.filter((record) => record.type === "goal_updated")).toHaveLength(3);
  });

  it("requires confirmation before replacing or clearing an unfinished goal", async () => {
    const confirm = vi.fn(async () => false);
    const registry = createCommandRegistry();
    const context = commandContext({ goal: activeGoal("first", at) }, confirm);

    expect(await registry.execute("/goal second", context)).toMatchObject({
      level: "warning",
    });
    expect(await registry.execute("/goal clear", context)).toMatchObject({
      level: "warning",
    });
    expect(context.session.goal?.objective).toBe("first");
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("completes a goal only with an assistant summary and evidence", async () => {
    const registry = createCommandRegistry();
    const context = commandContext({ goal: activeGoal("ship auth", at) });

    expect(await registry.execute("/goal complete", context)).toMatchObject({
      level: "error",
    });
    context.session = {
      ...context.session,
      goal: {
        ...activeGoal("ship auth", at),
        progress: "Auth shipped and verified.",
        evidence: ["npm test passed"],
      },
    };

    expect(await registry.execute("/goal complete", context)).toMatchObject({
      level: "info",
    });
    expect(context.session.goal).toMatchObject({
      status: "completed",
      progress: "Auth shipped and verified.",
      evidence: ["npm test passed"],
    });
  });

  it("enters Plan mode, submits an optional prompt, and restores permissions", async () => {
    const registry = createCommandRegistry();
    const context = commandContext({ permissionMode: "approved_for_me" });

    expect(await registry.execute("/plan inspect auth", context)).toEqual({
      type: "submit_prompt",
      prompt: "inspect auth",
    });
    expect(context.session).toMatchObject({
      executionMode: "plan",
      prePlanPermissionMode: "approved_for_me",
    });
    await registry.execute("/plan exit", context);
    expect(context.session).toMatchObject({
      executionMode: "act",
      permissionMode: "approved_for_me",
    });
  });

  it("requires explicit confirmation before enabling Full Access", async () => {
    const registry = createCommandRegistry();
    const deniedConfirm = vi.fn(async () => false);
    const denied = commandContext({}, deniedConfirm);

    expect(await registry.execute("/permissions full", denied)).toMatchObject({
      level: "warning",
    });
    expect(denied.session.permissionMode).toBe("ask_always");

    const acceptedConfirm = vi.fn(async () => true);
    const accepted = commandContext({}, acceptedConfirm);
    await registry.execute("/permissions full_access", accepted);
    expect(accepted.session.permissionMode).toBe("full_access");
    expect(acceptedConfirm).toHaveBeenCalledOnce();
    expect(acceptedConfirm.mock.calls[0]?.[0]).toContain(
      "Direct credential requests remain blocked",
    );
    expect(acceptedConfirm.mock.calls[0]?.[0]).toContain(
      "current platform sandbox",
    );
  });

  it("reports status, cancellation, help, aliases, and unknown commands", async () => {
    const registry = createCommandRegistry();
    const cancel = vi.fn(async () => true);
    const context = commandContext({}, vi.fn(async () => true), cancel);

    expect(await registry.execute("/status", context)).toMatchObject({
      text: expect.stringContaining("Ask Always"),
    });
    expect(await registry.execute("/help", context)).toMatchObject({
      text: expect.stringMatching(/\/goal[\s\S]*\/agents \[profiles\|mode name\]/u),
    });
    expect(await registry.execute("/cancel", context)).toMatchObject({ level: "info" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await registry.execute("/exit", context)).toEqual({ type: "quit" });
    expect(await registry.execute("/q", context)).toEqual({ type: "quit" });
    expect(await registry.execute("/missing", context)).toMatchObject({
      level: "error",
    });
  });
});
