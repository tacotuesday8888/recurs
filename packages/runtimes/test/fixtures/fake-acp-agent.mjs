#!/usr/bin/env node
/* global Buffer, process, setTimeout */

import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : "happy";
const expectedClientName = process.argv.includes("--expect-client-info");
const expectedEnvironmentKey = process.argv.includes("--expect-env")
  ? process.argv[process.argv.indexOf("--expect-env") + 1]
  : null;
const pidFile = process.argv.includes("--pid-file")
  ? process.argv[process.argv.indexOf("--pid-file") + 1]
  : null;
const eventFile = process.argv.includes("--event-file")
  ? process.argv[process.argv.indexOf("--event-file") + 1]
  : null;

let authenticated = false;
let promptId = null;
let promptSessionId = null;
let permissionRequestId = null;
let currentModel = "wrong-model";
let currentMode = "unsafe";
let currentApproval = "wrong-approval";
const confirmedSelectors = new Set();

function record(method) {
  if (eventFile === null) return;
  appendFileSync(
    eventFile,
    `${JSON.stringify({ pid: process.pid, method })}\n`,
    { mode: 0o600 },
  );
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function secretError(id) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: "SUPER_SECRET_AGENT_MESSAGE",
      data: { token: "SUPER_SECRET_AGENT_DATA" },
    },
  });
}

function update(sessionId, value) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
}

function initialize(message) {
  if (expectedClientName && message.params?.clientInfo?.name !== "recurs") {
    error(message.id, -32602, "invalid client info");
    return;
  }
  if (expectedEnvironmentKey && process.env[expectedEnvironmentKey] !== "visible") {
    error(message.id, -32602, "missing allowed environment");
    return;
  }
  if (scenario === "protocol-version") {
    result(message.id, { protocolVersion: 999, agentCapabilities: {} });
    return;
  }
  if (scenario === "secret-initialize-error") {
    secretError(message.id);
    return;
  }
  const response = {
    protocolVersion: 1,
    agentInfo: { name: "fake-acp", version: "1.0.0" },
    authMethods: [
      { id: "browser-login", name: "Browser login" },
      {
        id: "api-key",
        name: "API key",
        type: "env_var",
        vars: [{ name: "SECRET_KEY", secret: true }],
      },
    ],
    agentCapabilities: {
      sessionCapabilities:
        scenario === "no-lifecycle"
          ? {}
          : { resume: {}, close: {} },
    },
    models: [{ id: "extension-is-tolerated" }],
  };

  if (scenario === "fragmented") {
    const encoded = `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\r\n`;
    const midpoint = Math.floor(encoded.length / 2);
    process.stdout.write(encoded.slice(0, midpoint));
    setTimeout(() => process.stdout.write(encoded.slice(midpoint)), 5);
    return;
  }
  if (scenario === "invalid-utf8") {
    process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
    return;
  }
  if (scenario === "malformed-json") {
    process.stdout.write("{not-json}\n");
    return;
  }
  if (scenario === "invalid-envelope") {
    send({ jsonrpc: "1.0", id: message.id, result: response });
    return;
  }
  if (scenario === "unknown-response") {
    result("wrong-id", response);
    return;
  }
  if (scenario === "fractional-id") {
    result(1.5, response);
    return;
  }
  if (scenario === "null-id") {
    result(null, response);
    return;
  }
  if (scenario === "result-and-error") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: response,
      error: { code: -32603, message: "conflict" },
    });
    return;
  }
  if (scenario === "unknown-method") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "unknown-1", method: "unsafe/extension", params: {} })}\n`,
    );
    return;
  }
  if (scenario === "duplicate-response") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n`,
    );
    return;
  }
  if (scenario === "request-shaped-update") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n` +
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-update-shape",
        method: "session/update",
        params: {
          sessionId: "shape",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "invalid" },
          },
        },
      })}\n`,
    );
    return;
  }
  if (scenario === "notification-shaped-permission") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n` +
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/request_permission",
        params: {
          sessionId: "shape",
          toolCall: { toolCallId: "shape", title: "Shape", kind: "read" },
          options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
        },
      })}\n`,
    );
    return;
  }
  if (scenario === "request-shaped-cancel") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })}\n` +
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-cancel-shape",
        method: "$/cancel_request",
        params: { requestId: "shape" },
      })}\n`,
    );
    return;
  }
  if (scenario === "frame-burst") {
    const frames = [
      { jsonrpc: "2.0", id: message.id, result: response },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "burst",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "a" },
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "burst",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "b" },
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "burst",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "c" },
          },
        },
      },
    ];
    process.stdout.write(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
    return;
  }
  if (scenario === "oversized-frame") {
    result(message.id, { protocolVersion: 1, padding: "x".repeat(16_384) });
    return;
  }
  if (scenario === "stderr-canary") {
    process.stderr.write("SUPER_SECRET_CANARY_VALUE");
    result(message.id, response);
    return;
  }
  if (scenario === "early-exit") {
    process.exit(23);
  }
  if (scenario === "partial-frame") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response }), () => {
      process.exit(0);
    });
    return;
  }
  if (scenario === "hang") {
    return;
  }
  result(message.id, response);
}

function sessionState() {
  const reportedModel = scenario === "selector-confirmation"
    ? "test-model"
    : currentModel;
  const reportedMode = scenario === "selector-confirmation"
    ? "reviewed-plan"
    : currentMode;
  const state = {
    modes: {
      currentModeId: reportedMode,
      availableModes: [
        { id: "unsafe", name: "Unsafe" },
        { id: "reviewed-plan", name: "Reviewed plan" },
        { id: "reviewed-act", name: "Reviewed act" },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: scenario === "wrong-selector-category" ? "mode" : "model",
        type: "select",
        currentValue: reportedModel,
        options: [
          { value: "wrong-model", name: "Wrong" },
          { value: "test-model", name: "Reviewed" },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: reportedMode,
        options: [
          { value: "unsafe", name: "Unsafe" },
          { value: "reviewed-plan", name: "Reviewed plan" },
          { value: "reviewed-act", name: "Reviewed act" },
        ],
      },
      {
        id: "approval",
        name: "Approval",
        type: "select",
        currentValue: currentApproval,
        options: [
          { value: "wrong-approval", name: "Wrong" },
          { value: "ask", name: "Ask" },
          { value: "auto", name: "Auto" },
        ],
      },
    ],
  };
  if (scenario === "duplicate-mode-id") {
    state.modes.availableModes.push({ id: "reviewed-plan", name: "Duplicate" });
  }
  if (scenario === "duplicate-config-id") {
    state.configOptions.push({ ...state.configOptions[0], name: "Duplicate model" });
  }
  if (scenario === "duplicate-select-value") {
    state.configOptions[0].options.push({ value: "test-model", name: "Duplicate" });
  }
  if (scenario === "duplicate-group-value") {
    state.configOptions[0].options = [
      {
        group: "first",
        name: "First",
        options: [{ value: "test-model", name: "Reviewed" }],
      },
      {
        group: "second",
        name: "Second",
        options: [{ value: "test-model", name: "Duplicate" }],
      },
    ];
  }
  if (scenario === "duplicate-group-id") {
    state.configOptions[0].options = [
      {
        group: "same",
        name: "First",
        options: [{ value: "wrong-model", name: "Wrong" }],
      },
      {
        group: "same",
        name: "Second",
        options: [{ value: "test-model", name: "Reviewed" }],
      },
    ];
  }
  return state;
}

function startPrompt(message) {
  promptId = message.id;
  promptSessionId = message.params?.sessionId;
  const prompt = message.params?.prompt;
  if (!Array.isArray(prompt) || prompt.length !== 1 || prompt[0]?.type !== "text") {
    error(message.id, -32602, "invalid prompt");
    return;
  }
  if (
    scenario === "selector-confirmation" &&
    (!confirmedSelectors.has("model") || !confirmedSelectors.has("mode"))
  ) {
    error(message.id, -32602, "reviewed selectors were not confirmed");
    return;
  }

  if (scenario.startsWith("cancel")) {
    update(promptSessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "before cancel" },
    });
    return;
  }
  if (scenario === "prompt-hang") return;

  update(promptSessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hello " },
  });
  update(promptSessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "reasoning" },
  });
  update(promptSessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Edit a file",
    kind: "edit",
    status: "in_progress",
    content: [
      {
        type: "diff",
        path: `${message.params?._meta?.cwd ?? process.cwd()}/src/file.ts`,
        oldText: "a",
        newText: "b",
      },
    ],
    locations: [{ path: `${process.cwd()}/src/file.ts` }],
  });
  update(promptSessionId, {
    sessionUpdate: "usage_update",
    used: 999,
    size: 1000,
  });

  if (scenario === "future-update") {
    update(promptSessionId, {
      sessionUpdate: "future_display_extension",
      bounded: true,
    });
  }
  if (scenario === "mode-drift") {
    update(promptSessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: "unsafe",
    });
  }
  if (scenario === "terminal-large") {
    update(promptSessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "y".repeat(2_200) },
    });
  }
  if (scenario === "delayed-post-terminal") {
    setTimeout(() => {
      update(promptSessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "too late after close" },
      });
    }, 40);
  }

  if ([
    "simple",
    "post-terminal",
    "future-update",
    "mode-drift",
    "terminal-large",
    "delayed-post-terminal",
    "post-terminal-permission",
  ].includes(scenario)) {
    result(promptId, {
      stopReason: "end_turn",
      usage: { totalTokens: 7, inputTokens: 4, outputTokens: 3 },
    });
    if (scenario === "post-terminal") {
      update(promptSessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "too late" },
      });
    }
    return;
  }

  if (scenario === "refusal") {
    result(promptId, { stopReason: "refusal" });
    return;
  }

  permissionRequestId = "permission-1";
  send({
    jsonrpc: "2.0",
    id: permissionRequestId,
    method: "session/request_permission",
    params: {
      sessionId: promptSessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "Edit a file",
        kind: "edit",
        locations: [{ path: `${process.cwd()}/src/file.ts` }],
      },
      options: [
        { optionId: "once-a", name: "Allow this edit", kind: "allow_once" },
        { optionId: "once-b", name: "Allow alternate", kind: "allow_once" },
        { optionId: "deny-a", name: "Deny", kind: "reject_once" },
      ],
    },
  });
}

function finishPermission(message) {
  if (
    scenario === "approval-hang" &&
    message.result?.outcome?.outcome === "cancelled"
  ) {
    return;
  }
  if (message.result?.outcome?.outcome !== "selected" ||
      message.result.outcome.optionId !== "once-b") {
    error(promptId, -32603, "wrong permission option echoed");
    return;
  }
  update(promptSessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "world" },
  });
  update(promptSessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
  });
  result(promptId, {
    stopReason: scenario === "length" ? "max_tokens" : "end_turn",
    usage: {
      totalTokens: 15,
      inputTokens: 9,
      outputTokens: 6,
      thoughtTokens: 2,
      cachedReadTokens: 3,
      cachedWriteTokens: 1,
    },
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(31);
    return;
  }
  record(message.method ?? "response");

  if (message.method === "initialize") {
    initialize(message);
    return;
  }
  if (message.method === "authenticate") {
    if (message.params?.methodId !== "browser-login") {
      error(message.id, -32602, "unknown auth method");
      return;
    }
    if (scenario === "secret-auth-error") {
      secretError(message.id);
      return;
    }
    authenticated = true;
    result(message.id, { content: "authenticated" });
    return;
  }
  if (message.method === "session/new") {
    if (scenario === "new-hang") return;
    if (scenario === "secret-session-error") {
      secretError(message.id);
      return;
    }
    if (scenario === "auth-required" && !authenticated) {
      error(message.id, -32000, "authentication required");
      return;
    }
    if (!message.params || !String(message.params.cwd).startsWith("/") ||
        !Array.isArray(message.params.mcpServers) || message.params.mcpServers.length !== 0) {
      error(message.id, -32602, "invalid session scope");
      return;
    }
    result(message.id, { sessionId: "vendor-session-secret-123", ...sessionState() });
    return;
  }
  if (message.method === "session/resume") {
    if (scenario === "resume-hang" || scenario === "reconcile-hang") return;
    if (scenario === "resume-gone") {
      error(message.id, -32002, "resource not found");
      return;
    }
    if (message.params?.sessionId !== "vendor-session-secret-123") {
      error(message.id, -32602, "wrong session");
      return;
    }
    result(message.id, sessionState());
    return;
  }
  if (message.method === "session/set_mode") {
    if (scenario === "config-hang") return;
    if (!["reviewed-act", "reviewed-plan"].includes(message.params?.modeId)) {
      error(message.id, -32602, "unreviewed mode");
      return;
    }
    currentMode = message.params.modeId;
    result(message.id, {});
    return;
  }
  if (message.method === "session/set_config_option") {
    const { configId, value } = message.params ?? {};
    if ((configId === "model" && value !== "test-model") ||
        (configId === "mode" && !["reviewed-plan", "reviewed-act"].includes(value)) ||
        (configId === "approval" && !["ask", "auto"].includes(value))) {
      error(message.id, -32602, "unreviewed config");
      return;
    }
    if (configId === "model") currentModel = value;
    if (configId === "mode") currentMode = value;
    if (configId === "model" || configId === "mode") {
      confirmedSelectors.add(configId);
    }
    if (configId === "approval") currentApproval = value;
    const state = sessionState().configOptions;
    result(message.id, { configOptions: state });
    return;
  }
  if (message.method === "session/prompt") {
    startPrompt(message);
    return;
  }
  if (message.method === "session/cancel") {
    if (scenario === "prompt-hang" || scenario === "cancel-hang") return;
    if (message.params?.sessionId === promptSessionId && promptId !== null) {
      if (scenario === "cancel-error") {
        error(promptId, -32800, "request cancelled");
        return;
      }
      result(promptId, {
        stopReason: scenario === "cancel-normal" ? "end_turn" : "cancelled",
      });
    }
    return;
  }
  if (message.method === "session/close") {
    if (scenario === "post-terminal-permission") {
      send({
        jsonrpc: "2.0",
        id: "late-permission",
        method: "session/request_permission",
        params: {
          sessionId: promptSessionId,
          toolCall: { toolCallId: "late", title: "Late", kind: "read" },
          options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
        },
      });
    }
    result(message.id, {});
    return;
  }
  if (message.id === permissionRequestId) {
    finishPermission(message);
  }
});

rl.on("close", () => {
  if (scenario === "delayed-post-terminal") {
    setTimeout(() => process.exit(0), 80);
  } else {
    process.exit(0);
  }
});

if (scenario === "descendant" || scenario === "resistant-descendant") {
  const script = scenario === "resistant-descendant"
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    : "setInterval(() => {}, 1000)";
  const descendant = spawn(process.execPath, ["-e", script], {
    stdio: "ignore",
  });
  if (pidFile) writeFileSync(pidFile, String(descendant.pid), { mode: 0o600 });
}
