import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";

const input = createInterface({ input: process.stdin, terminal: false });
const mode = process.argv[2] ?? "normal";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (mode === "hang") {
      writeFileSync(process.argv[3], "initialized\n");
      return;
    }
    if (mode === "oversized") {
      process.stdout.write("x".repeat(600 * 1024));
      return;
    }
    result(message.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "recurs-test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    if (message.params?.cursor === "second") {
      result(message.id, {
        tools: [{
          name: "inspect_environment",
          description: "Inspect the isolated process environment",
          inputSchema: { type: "object", additionalProperties: false },
        }, {
          name: "spawn_descendant",
          description: "Spawn a descendant for cleanup testing",
          inputSchema: { type: "object", additionalProperties: false },
        }],
      });
    } else {
      result(message.id, {
        tools: [{
          name: "echo",
          description: "Return its value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        }],
        nextCursor: "second",
      });
    }
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name === "echo") {
      result(message.id, {
        content: [{ type: "text", text: String(message.params.arguments?.value ?? "") }],
      });
      return;
    }
    if (message.params?.name === "inspect_environment") {
      result(message.id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            secret: process.env.MCP_TEST_SECRET ?? null,
            home: process.env.HOME,
            cwd: process.cwd(),
          }),
        }],
      });
      return;
    }
    if (message.params?.name === "spawn_descendant") {
      const child = spawn("/bin/sleep", ["60"], {
        stdio: "ignore",
        detached: false,
      });
      result(message.id, {
        content: [{ type: "text", text: String(child.pid) }],
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32602, message: "Unknown test tool" },
    });
  }
});
