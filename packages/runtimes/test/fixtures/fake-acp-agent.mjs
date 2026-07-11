#!/usr/bin/env node
/* global Buffer, process, setTimeout */

import readline from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : "happy";
const expectedClientName = process.argv.includes("--expect-client-info");
const expectedEnvironmentKey = process.argv.includes("--expect-env")
  ? process.argv[process.argv.indexOf("--expect-env") + 1]
  : null;
const pidFile = process.argv.includes("--pid-file")
  ? process.argv[process.argv.indexOf("--pid-file") + 1]
  : null;

let authenticated = false;
let promptId = null;
let promptSessionId = null;
let permissionRequestId = null;
let currentModel = "wrong-model";
let currentApproval = "wrong-approval";

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
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
  return {
    modes: {
      currentModeId: "unsafe",
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
        type: "select",
        currentValue: currentModel,
        options: [
          { value: "wrong-model", name: "Wrong" },
          { value: "reviewed-model", name: "Reviewed" },
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
}

function startPrompt(message) {
  promptId = message.id;
  promptSessionId = message.params?.sessionId;
  const prompt = message.params?.prompt;
  if (!Array.isArray(prompt) || prompt.length !== 1 || prompt[0]?.type !== "text") {
    error(message.id, -32602, "invalid prompt");
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

  if (message.method === "initialize") {
    initialize(message);
    return;
  }
  if (message.method === "authenticate") {
    if (message.params?.methodId !== "browser-login") {
      error(message.id, -32602, "unknown auth method");
      return;
    }
    authenticated = true;
    result(message.id, { content: "authenticated" });
    return;
  }
  if (message.method === "session/new") {
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
    if (!["reviewed-act", "reviewed-plan"].includes(message.params?.modeId)) {
      error(message.id, -32602, "unreviewed mode");
      return;
    }
    result(message.id, {});
    return;
  }
  if (message.method === "session/set_config_option") {
    const { configId, value } = message.params ?? {};
    if ((configId === "model" && value !== "reviewed-model") ||
        (configId === "approval" && !["ask", "auto"].includes(value))) {
      error(message.id, -32602, "unreviewed config");
      return;
    }
    if (configId === "model") currentModel = value;
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

if (scenario === "descendant") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (pidFile) writeFileSync(pidFile, String(descendant.pid), { mode: 0o600 });
}
