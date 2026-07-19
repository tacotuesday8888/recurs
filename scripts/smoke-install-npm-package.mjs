import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "recurs-install-smoke-"));
const packageDirectory = path.join(temporaryDirectory, "package");
const installDirectory = path.join(temporaryDirectory, "install");
const homeDirectory = path.join(temporaryDirectory, "home");
const workspaceDirectory = path.join(temporaryDirectory, "workspace");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const modelId = "recurs-install-smoke";
const taskMarker = "RECURS_INSTALLED_AGENT_READ_OK";
const finalText = "Installed Recurs completed the guarded workspace task.";
const sandboxedFile = path.join(workspaceDirectory, "SANDBOXED.md");
const escapedFile = path.join(temporaryDirectory, "ESCAPED.txt");
const sandboxCommand =
  `printf '${taskMarker}\\n' > SANDBOXED.md; printf 'escape\\n' > ../ESCAPED.txt`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function requestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    assert(bytes <= 1024 * 1024, "The local smoke request exceeded 1 MB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function streamResponse(response, payload) {
  response.writeHead(200, {
    connection: "close",
    "content-type": "text/event-stream",
  });
  response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
}

async function startLocalModelServer() {
  const chatRequests = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, {
          connection: "close",
          "content-type": "application/json",
        });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: modelId, object: "model", owned_by: "recurs-smoke" }],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const body = await requestJson(request);
        chatRequests.push(body);
        if (chatRequests.length === 1) {
          streamResponse(response, {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call-installed-command",
                  type: "function",
                  function: {
                    name: "run_command",
                    arguments: JSON.stringify({
                      command: sandboxCommand,
                      timeoutMs: 10_000,
                    }),
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 8, completion_tokens: 4 },
          });
          return;
        }
        if (chatRequests.length === 2) {
          streamResponse(response, {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call-installed-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "SANDBOXED.md" }),
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4 },
          });
          return;
        }
        streamResponse(response, {
          choices: [{
            delta: { content: finalText },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        });
        return;
      }
      response.writeHead(404, { connection: "close" });
      response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(
    typeof address === "object" && address !== null,
    "The local smoke server did not bind a TCP port.",
  );
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    chatRequests,
    server,
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

let localModelServer;

try {
  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  await execFileAsync("git", ["init", "--quiet"], {
    cwd: workspaceDirectory,
    encoding: "utf8",
  });
  const { stdout: packOutput } = await execFileAsync(npm, [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packageDirectory,
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const packReport = JSON.parse(packOutput);
  const filename = packReport[0]?.filename;
  assert(typeof filename === "string", "npm pack did not report an artifact filename.");
  const archive = path.join(packageDirectory, filename);
  await readFile(archive);

  await execFileAsync(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
    archive,
  ], {
    cwd: installDirectory,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const executable = process.platform === "win32"
    ? path.join(installDirectory, "node_modules/.bin/recurs.cmd")
    : path.join(installDirectory, "node_modules/.bin/recurs");
  const environment = {
    HOME: homeDirectory,
    LANG: "C.UTF-8",
    PATH: process.env.PATH ?? "",
    RECURS_HOME: path.join(homeDirectory, ".recurs"),
    USERPROFILE: homeDirectory,
  };
  const { stdout: help, stderr: helpError } = await execFileAsync(executable, ["--help"], {
    cwd: installDirectory,
    encoding: "utf8",
    env: environment,
  });
  assert(help.includes("Recurs coding-agent harness"), "The installed CLI did not render its help.");
  assert(helpError === "", "The installed CLI wrote unexpected help diagnostics.");

  const { stdout: accounts, stderr: accountError } = await execFileAsync(
    executable,
    ["account", "list", "--json"],
    {
      cwd: installDirectory,
      encoding: "utf8",
      env: environment,
    },
  );
  assert(JSON.parse(accounts).accounts?.length === 0, "A fresh install must start with no accounts.");
  assert(accountError === "", "The installed CLI wrote unexpected account diagnostics.");

  localModelServer = await startLocalModelServer();
  const { stdout: setup, stderr: setupError } = await execFileAsync(
    executable,
    [
      "setup",
      "local",
      "--url",
      localModelServer.baseUrl,
      "--model",
      modelId,
    ],
    {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: environment,
    },
  );
  assert(setup.includes(`Ready — Local model · ${modelId}`), "The installed CLI did not configure the local model.");
  assert(setupError === "", "The installed CLI wrote unexpected setup diagnostics.");

  const { stdout: run, stderr: runError } = await execFileAsync(
    executable,
    [
      "run",
      "Create a sandboxed workspace marker, read it, and report completion.",
      "--permissions",
      "full",
      "--format",
      "jsonl",
    ],
    {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const events = run.trim().split("\n").map((line) => JSON.parse(line));
  const eventSummary = events.map((event) => ({
    type: event.type,
    ...(event.call?.name === undefined ? {} : { tool: event.call.name }),
    ...(event.callId === undefined ? {} : { callId: event.callId }),
    ...(event.error?.code === undefined ? {} : { error: event.error.code }),
    ...(event.error?.message === undefined
      ? {}
      : { message: event.error.message }),
  }));
  const commandFailure = events.find((event) =>
    event.type === "tool_failed" &&
    event.callId === "call-installed-command"
  );
  assert(
    events.some((event) =>
      event.type === "tool_started" && event.call?.name === "run_command"
    ),
    "The installed agent did not start its sandboxed command tool.",
  );
  assert(
    commandFailure?.error?.message.includes("[process_failed]") === true,
    `The installed agent did not report its denied sandbox escape: ${JSON.stringify(eventSummary)}`,
  );
  assert(
    events.some((event) =>
      event.type === "tool_started" && event.call?.name === "read_file"
    ),
    "The installed agent did not start its model-requested read tool.",
  );
  assert(
    events.some((event) =>
      event.type === "tool_completed" && event.callId === "call-installed-read"
    ),
    `The installed agent did not complete its guarded workspace read: ${JSON.stringify(eventSummary)}`,
  );
  assert(
    events.some((event) =>
      event.type === "model_text_delta" && event.text === finalText
    ),
    "The installed agent did not render the final model result.",
  );
  assert(
    events.some((event) => event.type === "turn_completed"),
    "The installed agent did not complete its turn.",
  );
  assert(runError === "", "The installed agent wrote unexpected run diagnostics.");
  assert(
    await readFile(sandboxedFile, "utf8") === `${taskMarker}\n`,
    "The sandboxed command did not write its workspace marker.",
  );
  assert(
    !(await pathExists(escapedFile)),
    "The sandboxed command escaped the workspace write boundary.",
  );
  assert(
    localModelServer.chatRequests.length === 3,
    "The installed agent did not make exactly two tool turns and one final turn.",
  );
  assert(
    JSON.stringify(localModelServer.chatRequests[2]).includes(taskMarker),
    "The guarded tool result was not returned to the model.",
  );
} finally {
  if (localModelServer !== undefined) {
    await closeServer(localModelServer.server);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write("npm package installed-agent smoke passed\n");
