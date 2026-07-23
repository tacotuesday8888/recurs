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
