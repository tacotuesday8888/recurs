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
const lines = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
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
