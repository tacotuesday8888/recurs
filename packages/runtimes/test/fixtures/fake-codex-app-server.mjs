import readline from "node:readline";

const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex === -1 ? "happy" : process.argv[scenarioIndex + 1];

if (scenario === "stderr-overflow") {
  process.stderr.write("x".repeat(4_096));
}
if (scenario === "frame-overflow") {
  process.stdout.write(`${JSON.stringify({ method: "oversized", params: { value: "x".repeat(8_192) } })}\n`);
}

let pendingServerRequest = null;
let pendingRuntimeTurn = null;
let initialized = false;
const lines = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex/1.0",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "test",
      },
    });
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (message.method === "account/read") {
    if (!initialized) {
      send({ id: message.id, error: { code: -32000, message: "not initialized" } });
      return;
    }
    const account = scenario === "unauthenticated"
      ? null
      : scenario === "api-key"
        ? { type: "apiKey" }
        : { type: "chatgpt", email: "person@example.com", planType: "pro" };
    send({ id: message.id, result: { account, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === "model/list") {
    if (scenario === "malformed-catalog") {
      send({ id: message.id, result: { data: [{ id: "bad" }], nextCursor: null } });
      return;
    }
    const secondPage = message.params?.cursor === "page-2";
    const models = secondPage
      ? [{
          id: "gpt-5.6-luna",
          model: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
          ],
          defaultReasoningEffort: "medium",
        }]
      : [{
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "ultra", description: "Highest effort" },
          ],
          defaultReasoningEffort: "low",
        }];
    send({
      id: message.id,
      result: { data: models, nextCursor: secondPage ? null : "page-2" },
    });
    return;
  }
  if (message.method === "thread/start") {
    const safe = message.params?.model === "gpt-test" &&
      Array.isArray(message.params?.environments) &&
      message.params.environments.length === 0 &&
      message.params?.sandbox === "read-only" &&
      message.params?.approvalPolicy === "never" &&
      Array.isArray(message.params?.dynamicTools);
    if (!safe) {
      send({ id: message.id, error: { code: -32000, message: "unsafe thread" } });
      return;
    }
    send({
      id: message.id,
      result: {
        thread: { id: "vendor-thread-1" },
        model: "gpt-test",
        reasoningEffort: null,
      },
    });
    return;
  }
  if (message.method === "turn/start") {
    if (
      message.params?.threadId !== "vendor-thread-1" ||
      message.params?.model !== "gpt-test" ||
      message.params?.effort !== "ultra" ||
      !Array.isArray(message.params?.environments) ||
      message.params.environments.length !== 0
    ) {
      send({ id: message.id, error: { code: -32000, message: "unsafe turn" } });
      return;
    }
    send({ id: message.id, result: { turn: { id: "vendor-turn-1" } } });
    if (scenario === "runtime-cancel") {
      pendingRuntimeTurn = "vendor-turn-1";
      return;
    }
    if (scenario === "runtime-tool") {
      pendingRuntimeTurn = "vendor-turn-1";
      send({
        id: "dynamic-tool-1",
        method: "item/tool/call",
        params: {
          threadId: "vendor-thread-1",
          turnId: "vendor-turn-1",
          callId: "call-1",
          namespace: null,
          tool: "read_file",
          arguments: { path: "README.md" },
        },
      });
      return;
    }
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "vendor-thread-1",
        turnId: "vendor-turn-1",
        itemId: "message-1",
        delta: "hello from Codex",
      },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "vendor-thread-1",
        turnId: "vendor-turn-1",
        tokenUsage: {
          total: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 2, totalTokens: 14 },
          last: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 2, totalTokens: 14 },
          modelContextWindow: 1000,
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "vendor-thread-1",
        turn: { id: "vendor-turn-1", status: "completed", error: null },
      },
    });
    return;
  }
  if (message.id === "dynamic-tool-1" && pendingRuntimeTurn !== null) {
    const text = message.result?.contentItems?.[0]?.text;
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "vendor-thread-1",
        turnId: pendingRuntimeTurn,
        itemId: "message-2",
        delta: `tool said: ${text}`,
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "vendor-thread-1",
        turn: { id: pendingRuntimeTurn, status: "completed", error: null },
      },
    });
    pendingRuntimeTurn = null;
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: "vendor-thread-1",
        turn: { id: pendingRuntimeTurn ?? "vendor-turn-1", status: "interrupted", error: null },
      },
    });
    pendingRuntimeTurn = null;
    return;
  }
  if (message.method === "echo") {
    send({ id: message.id, result: message.params });
    return;
  }
  if (message.method === "notify-test") {
    send({ method: "test/notification", params: message.params });
    return;
  }
  if (message.method === "server-request-test") {
    pendingServerRequest = message.id;
    send({
      id: "server-request-1",
      method: "item/tool/call",
      params: { tool: "read_file", arguments: { path: "README.md" } },
    });
    return;
  }
  if (message.id === "server-request-1" && pendingServerRequest !== null) {
    send({ id: pendingServerRequest, result: message.result });
    pendingServerRequest = null;
    return;
  }
  if (message.method === "hang") return;
  send({ id: message.id, error: { code: -32601, message: "unknown method" } });
});
