import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";

const input = createInterface({ input: process.stdin, terminal: false });
const mode = process.argv[2] ?? "normal";

input.on("close", () => {
  if (mode === "lifecycle") {
    appendFileSync(process.argv[3], `closed:${process.pid}\n`);
  }
});

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
      writeFileSync(process.argv[3], `initialized:${process.pid}\n`);
      return;
    }
    if (mode === "oversized") {
      process.stdout.write("x".repeat(600 * 1024));
      return;
    }
    if (["lifecycle", "restart-on-ping", "exit-on-tool", "hang-tool", "hang-ping", "exit-after-result"].includes(mode)) {
      appendFileSync(process.argv[3], `init:${process.pid}\n`);
    }
    result(message.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "recurs-test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "notifications/cancelled") {
    if (mode === "hang-tool" || mode === "hang-ping") {
      appendFileSync(process.argv[3], `cancelled:${message.params?.requestId}\n`);
    }
    return;
  }
  if (message.method === "ping") {
    if (mode === "hang-ping") {
      appendFileSync(process.argv[3], `ping-started:${process.pid}\n`);
      return;
    }
    if (mode === "restart-on-ping" && !existsSync(process.argv[4])) {
      writeFileSync(process.argv[4], "failed\n");
      process.exit(17);
    }
    result(message.id, {});
    return;
  }
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
        }, ...(["lifecycle", "restart-on-ping", "hang-ping"].includes(mode) ? [{
          name: "process_id",
          description: "Return the MCP server process id",
          inputSchema: { type: "object", additionalProperties: false },
        }] : []), ...(mode === "hang-tool" ? [{
          name: "hang",
          description: "Wait until the request is cancelled",
          inputSchema: { type: "object", additionalProperties: false },
        }] : [])],
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
    if (mode === "exit-after-result") {
      const child = spawn("/bin/sleep", ["60"], {
        stdio: "ignore",
        detached: false,
      });
      result(message.id, {
        content: [{ type: "text", text: String(child.pid) }],
      });
      globalThis.setImmediate(() => process.exit(0));
      return;
    }
    if (mode === "exit-on-tool") {
      appendFileSync(process.argv[3], `call:${message.params?.name}\n`);
      process.exit(18);
    }
    if (mode === "hang-tool" && message.params?.name === "hang") {
      appendFileSync(process.argv[3], `started:${process.pid}\n`);
      return;
    }
    if (message.params?.name === "process_id") {
      result(message.id, {
        content: [{ type: "text", text: String(process.pid) }],
      });
      return;
    }
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
