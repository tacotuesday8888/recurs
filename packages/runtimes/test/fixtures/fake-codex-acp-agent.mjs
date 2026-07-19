#!/usr/bin/env node
/* global process */

import readline from "node:readline";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex === -1
  ? "existing-chatgpt"
  : process.argv[scenarioIndex + 1];
const eventFileIndex = process.argv.indexOf("--event-file");
const eventFile = eventFileIndex === -1 ? null : process.argv[eventFileIndex + 1];
const counterFileIndex = process.argv.indexOf("--counter-file");
const counterFile = counterFileIndex === -1 ? null : process.argv[counterFileIndex + 1];
const accountFileIndex = process.argv.indexOf("--account-file");
const accountFile = accountFileIndex === -1 ? null : process.argv[accountFileIndex + 1];
let processOrdinal = 1;
if (counterFile !== null) {
  let previous = 0;
  try {
    previous = Number(readFileSync(counterFile, "utf8"));
  } catch {
    // The first fake-agent process creates the counter.
  }
  processOrdinal = previous + 1;
  writeFileSync(counterFile, String(processOrdinal), { mode: 0o600 });
}

let currentMode = "agent";
let currentModel = "gpt-test";
let statusChecks = 0;
let promptId = null;
let promptSessionId = null;

function record(method) {
  if (eventFile === null) return;
  appendFileSync(
    eventFile,
    `${JSON.stringify({ pid: process.pid, processOrdinal, method })}\n`,
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

function configOptions() {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: [
        { value: "read-only", name: "Read-only" },
        { value: "agent", name: "Agent" },
        { value: "agent-full-access", name: "Agent (full access)" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "gpt-test", name: "GPT test" },
        { value: "gpt-test-mini", name: "GPT test mini" },
      ],
    },
  ];
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  record(message.method ?? "response");
  if (message.method === "initialize") {
    if (message.params?.clientInfo?.name !== "recurs") {
      error(message.id, -32602, "unexpected client identity");
      return;
    }
    result(message.id, {
      protocolVersion: 1,
      agentInfo: { name: "@agentclientprotocol/codex-acp", version: "1.1.2" },
      authMethods: scenario === "no-browser"
        ? [{ id: "api-key", name: "API Key" }]
        : [
            { id: "api-key", name: "API Key" },
            { id: "chat-gpt", name: "ChatGPT" },
          ],
      agentCapabilities: {
        sessionCapabilities: { resume: {}, close: {} },
      },
    });
    return;
  }
  if (message.method === "authentication/status") {
    statusChecks += 1;
    if (scenario === "secret-status-error") {
      secretError(message.id);
      return;
    }
    if (scenario === "invalid-secret-status") {
      result(message.id, {
        type: "chat-gpt",
        email: "owner@example.com",
        SUPER_SECRET_FIELD: "SUPER_SECRET_AGENT_DATA",
      });
      return;
    }
    const status = scenario === "unauthenticated" || scenario === "no-browser"
      ? { type: "unauthenticated" }
      : scenario === "api-key"
        ? { type: "api-key" }
        : scenario === "gateway"
          ? { type: "gateway", name: "custom" }
          : {
              type: "chat-gpt",
              email: accountFile !== null
                ? readFileSync(accountFile, "utf8").trim()
                : (scenario === "account-switch-after-preflight" &&
                    processOrdinal >= 3) ||
                    (scenario === "account-switch-during-setup" &&
                      statusChecks >= 2)
                  ? "other@example.com"
                  : "owner@example.com",
            };
    result(message.id, status);
    return;
  }
  if (message.method === "authenticate") {
    if (message.params?.methodId !== "chat-gpt" || scenario === "no-browser") {
      error(message.id, -32602, "unsupported authentication method");
      return;
    }
    if (scenario === "secret-auth-error") {
      secretError(message.id);
      return;
    }
    result(message.id, {});
    return;
  }
  if (message.method === "session/new") {
    if (scenario === "secret-session-error") {
      secretError(message.id);
      return;
    }
    result(message.id, {
      sessionId: "temporary-vendor-session",
      modes: {
        currentModeId: currentMode,
        availableModes: [
          { id: "read-only", name: "Read-only" },
          { id: "agent", name: "Agent" },
          { id: "agent-full-access", name: "Agent (full access)" },
        ],
      },
      configOptions: configOptions(),
    });
    return;
  }
  if (message.method === "session/resume") {
    if (message.params?.sessionId !== "temporary-vendor-session") {
      error(message.id, -32002, "missing session");
      return;
    }
    result(message.id, {
      modes: {
        currentModeId: currentMode,
        availableModes: [
          { id: "read-only", name: "Read-only" },
          { id: "agent", name: "Agent" },
          { id: "agent-full-access", name: "Agent (full access)" },
        ],
      },
      configOptions: configOptions(),
    });
    return;
  }
  if (message.method === "session/set_mode") {
    if (message.params?.modeId !== "read-only") {
      error(message.id, -32602, "unsafe mode");
      return;
    }
    currentMode = "read-only";
    result(message.id, {});
    return;
  }
  if (message.method === "session/set_config_option") {
    if (message.params?.configId === "mode") currentMode = message.params.value;
    else if (message.params?.configId === "model") currentModel = message.params.value;
    else {
      error(message.id, -32602, "unknown config option");
      return;
    }
    result(message.id, { configOptions: configOptions() });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    promptSessionId = message.params?.sessionId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: promptSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "same-process" },
        },
      },
    });
    result(promptId, {
      stopReason: "end_turn",
      usage: { totalTokens: 2, inputTokens: 1, outputTokens: 1 },
    });
    return;
  }
  if (message.method === "session/cancel") {
    if (promptId !== null && message.params?.sessionId === promptSessionId) {
      result(promptId, { stopReason: "cancelled" });
    }
    return;
  }
  if (message.method === "session/close") {
    result(message.id, {});
  }
});

rl.on("close", () => process.exit(0));
