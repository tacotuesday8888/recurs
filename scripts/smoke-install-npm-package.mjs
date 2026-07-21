import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
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
const skillName = "installed-release-check";
const skillMarker = "RECURS_INSTALLED_SKILL_OK";
const mcpMarker = "RECURS_INSTALLED_MCP_OK";
const taskMarker = "RECURS_INSTALLED_AGENT_READ_OK";
const finalText = "Installed Recurs completed the guarded workspace task.";
const resumePrompt = "Continue the exact installed session.";
const resumeFinalText = "RECURS_INSTALLED_RESUME_OK";
const freshPrompt = "Start a separate installed session.";
const freshFinalText = "RECURS_INSTALLED_FRESH_OK";
const stdinPrompt = "Inspect this exact piped installed prompt.";
const stdinFinalText = "RECURS_INSTALLED_STDIN_OK";
const acpPrompt = "Report the installed ACP transport marker.";
const acpFinalText = "RECURS_INSTALLED_ACP_OK";
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

function streamToolCall(response, id, name, arguments_) {
  streamResponse(response, {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(arguments_) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  });
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
        const messages = JSON.stringify(body.messages);
        if (messages.includes(acpPrompt)) {
          streamResponse(response, {
            choices: [{
              delta: { content: acpFinalText },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 8, completion_tokens: 4 },
          });
          return;
        }
        if (messages.includes(resumePrompt)) {
          streamResponse(response, {
            choices: [{
              delta: { content: resumeFinalText },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 16, completion_tokens: 4 },
          });
          return;
        }
        if (messages.includes(freshPrompt)) {
          streamResponse(response, {
            choices: [{
              delta: { content: freshFinalText },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 6, completion_tokens: 4 },
          });
          return;
        }
        if (messages.includes(stdinPrompt)) {
          streamResponse(response, {
            choices: [{
              delta: { content: stdinFinalText },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 7, completion_tokens: 4 },
          });
          return;
        }
        if (chatRequests.length === 1) {
          streamToolCall(response, "call-installed-skill", "activate_skill", {
            name: skillName,
            resource: "guide.md",
          });
          return;
        }
        if (chatRequests.length === 2) {
          streamToolCall(response, "call-installed-mcp", "mcp", {
            server: "installed-probe",
            action: "call_tool",
            tool: "package_probe",
            arguments: {},
          });
          return;
        }
        if (chatRequests.length === 3) {
          streamToolCall(response, "call-installed-command", "run_command", {
            command: sandboxCommand,
            timeoutMs: 10_000,
          });
          return;
        }
        if (chatRequests.length === 4) {
          streamToolCall(response, "call-installed-read", "read_file", {
            path: "SANDBOXED.md",
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

async function writeInteropFixtures(dataDirectory) {
  const skillDirectory = path.join(dataDirectory, "skills", skillName);
  const configDirectory = path.join(dataDirectory, "config");
  const mcpServer = path.join(workspaceDirectory, "installed-mcp-server.mjs");
  await Promise.all([
    mkdir(skillDirectory, { recursive: true, mode: 0o700 }),
    mkdir(configDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    path.join(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${skillName}`,
      "description: Verify the installed package interoperability path",
      "---",
      `Use the installed package release procedure. ${skillMarker}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(skillDirectory, "guide.md"),
    `Installed package guide: ${skillMarker}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    mcpServer,
    [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin, terminal: false });',
      'const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);',
      'const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });',
      'lines.on("line", (line) => {',
      '  const message = JSON.parse(line);',
      '  if (message.method === "initialize") {',
      '    result(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "recurs-installed-smoke", version: "1.0.0" } });',
      '  } else if (message.method === "ping") {',
      '    result(message.id, {});',
      '  } else if (message.method === "tools/list") {',
      '    result(message.id, { tools: [{ name: "package_probe", description: "Prove installed MCP interoperability", inputSchema: { type: "object", additionalProperties: false } }] });',
      '  } else if (message.method === "tools/call" && message.params?.name === "package_probe") {',
      `    result(message.id, { content: [{ type: "text", text: "${mcpMarker}" }] });`,
      '  } else if (message.id !== undefined && message.method !== "notifications/initialized") {',
      '    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported smoke method" } });',
      '  }',
      '});',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(configDirectory, 0o700);
  const configuration = path.join(configDirectory, "mcp-servers.json");
  await writeFile(configuration, `${JSON.stringify({
    version: 1,
    servers: [{
      id: "installed-probe",
      description: "Deterministic installed-package MCP probe",
      command: process.execPath,
      args: [mcpServer],
      network: "deny",
    }],
  })}\n`, { mode: 0o600 });
  await chmod(configuration, 0o600);
}

function withTimeout(promise, label, milliseconds = 15_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runInstalledWithInput(executable, args, environment, input) {
  const child = spawn(executable, args, {
    cwd: workspaceDirectory,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const collect = async (stream, label) => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      assert(bytes <= 10 * 1024 * 1024, `${label} exceeded its output limit.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(input);
  const [status, stdout, stderr] = await withTimeout(Promise.all([
    exited,
    collect(child.stdout, "Installed stdin stdout"),
    collect(child.stderr, "Installed stdin stderr"),
  ]), "installed stdin run");
  assert(
    status.code === 0 && status.signal === null,
    `The installed stdin run exited unexpectedly: ${JSON.stringify(status)}`,
  );
  return { stdout, stderr };
}

async function runInstalledAcpSmoke(executable, environment) {
  const child = spawn(executable, ["acp"], {
    cwd: workspaceDirectory,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const notifications = [];
  let nextId = 1;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    assert(stderr.length <= 64 * 1024, "The installed ACP server exceeded its stderr limit.");
  });
  const output = createInterface({ input: child.stdout, terminal: false });
  output.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = responses.get(message.id);
      if (pending === undefined) return;
      responses.delete(message.id);
      if (message.error === undefined) pending.resolve(message.result);
      else pending.reject(new Error(`ACP error: ${JSON.stringify(message.error)}`));
      return;
    }
    notifications.push(message);
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const request = (method, params) => {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      responses.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return withTimeout(response, `ACP ${method}`);
  };

  try {
    const initialized = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "recurs-install-smoke", version: "1" },
    });
    assert(
      initialized?.protocolVersion === 1 && initialized?.agentInfo?.name === "recurs",
      "The installed ACP server did not negotiate the supported protocol.",
    );
    const created = await request("session/new", {
      cwd: workspaceDirectory,
      mcpServers: [],
    });
    assert(
      typeof created?.sessionId === "string" && created.sessionId.length > 0,
      "The installed ACP server did not create a session.",
    );
    const prompt = await request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: acpPrompt }],
    });
    assert(
      prompt?.stopReason === "end_turn",
      "The installed ACP session did not complete its prompt.",
    );
    assert(
      notifications.some((message) =>
        message.method === "session/update" &&
        message.params?.sessionId === created.sessionId &&
        message.params?.update?.sessionUpdate === "agent_message_chunk" &&
        message.params?.update?.content?.text === acpFinalText
      ),
      "The installed ACP server did not stream its model result.",
    );
    await request("session/close", { sessionId: created.sessionId });
    child.stdin.end();
    const status = await withTimeout(exited, "ACP process shutdown");
    assert(
      status.code === 0 && status.signal === null,
      `The installed ACP process exited unexpectedly: ${JSON.stringify(status)}`,
    );
    assert(stderr === "", `The installed ACP server wrote diagnostics: ${stderr}`);
  } finally {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
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
  await writeInteropFixtures(environment.RECURS_HOME);
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
      "Use the installed skill and MCP server, then create and read a sandboxed workspace marker.",
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
  const initialSessionId = events.find((event) =>
    event.type === "turn_started"
  )?.sessionId;
  assert(
    typeof initialSessionId === "string" && initialSessionId.length > 0,
    "The installed JSONL run did not expose its durable session id.",
  );
  assert(
    events.every((event) => event.sessionId === initialSessionId),
    "The installed JSONL run emitted inconsistent session identities.",
  );
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
      event.type === "tool_completed" && event.callId === "call-installed-skill"
    ),
    `The installed agent did not activate its packaged skill path: ${JSON.stringify(eventSummary)}`,
  );
  assert(
    events.some((event) =>
      event.type === "tool_completed" && event.callId === "call-installed-mcp"
    ),
    `The installed agent did not complete its stdio MCP call: ${JSON.stringify(eventSummary)}`,
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
    localModelServer.chatRequests.length === 5,
    "The installed agent did not make exactly four tool turns and one final turn.",
  );
  assert(
    JSON.stringify(localModelServer.chatRequests[1]).includes(skillMarker),
    "The activated skill and its resource were not returned to the model.",
  );
  assert(
    JSON.stringify(localModelServer.chatRequests[2]).includes(mcpMarker),
    "The stdio MCP result was not returned to the model.",
  );
  assert(
    JSON.stringify(localModelServer.chatRequests[4]).includes(taskMarker),
    "The guarded tool result was not returned to the model.",
  );
  assert(
    localModelServer.chatRequests[0]?.tools?.some((tool) =>
      tool.function?.name === "activate_skill"
    ) === true &&
      localModelServer.chatRequests[0]?.tools?.some((tool) =>
        tool.function?.name === "mcp"
      ) === true,
    "The installed model request did not expose Agent Skills and MCP tools.",
  );

  const { stdout: resumed, stderr: resumedError } = await execFileAsync(
    executable,
    [
      "run",
      resumePrompt,
      "--resume",
      initialSessionId,
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
  const resumedEvents = resumed.trim().split("\n").map((line) => JSON.parse(line));
  assert(
    resumedEvents.length > 0 &&
      resumedEvents.every((event) => event.sessionId === initialSessionId),
    "The installed one-shot resume did not keep the exact session identity.",
  );
  assert(
    resumedEvents.some((event) =>
      event.type === "model_text_delta" && event.text === resumeFinalText
    ),
    "The installed resumed session did not complete its follow-up turn.",
  );
  assert(resumedError === "", "The installed resumed run wrote unexpected diagnostics.");
  assert(
    JSON.stringify(localModelServer.chatRequests[5]?.messages).includes(finalText),
    "The installed resumed request did not retain its prior visible context.",
  );

  const { stdout: fresh, stderr: freshError } = await execFileAsync(
    executable,
    ["run", freshPrompt, "--format", "jsonl"],
    {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const freshEvents = fresh.trim().split("\n").map((line) => JSON.parse(line));
  const freshSessionId = freshEvents.find((event) =>
    event.type === "turn_started"
  )?.sessionId;
  assert(
    typeof freshSessionId === "string" && freshSessionId !== initialSessionId,
    "An installed one-shot run without --resume reused prior session state.",
  );
  assert(
    freshEvents.some((event) =>
      event.type === "model_text_delta" && event.text === freshFinalText
    ),
    "The installed fresh session did not complete its turn.",
  );
  assert(freshError === "", "The installed fresh run wrote unexpected diagnostics.");
  assert(
    !JSON.stringify(localModelServer.chatRequests[6]?.messages).includes(finalText),
    "An installed fresh one-shot request inherited prior visible context.",
  );

  const stdinRun = await runInstalledWithInput(
    executable,
    ["run", "-", "--mode", "economy", "--format", "jsonl"],
    environment,
    `${stdinPrompt}\n`,
  );
  const stdinEvents = stdinRun.stdout.trim().split("\n").map((line) =>
    JSON.parse(line)
  );
  const stdinSessionId = stdinEvents.find((event) =>
    event.type === "turn_started"
  )?.sessionId;
  assert(
    typeof stdinSessionId === "string" &&
      stdinSessionId !== initialSessionId &&
      stdinSessionId !== freshSessionId,
    "The installed stdin prompt did not start one fresh durable session.",
  );
  const projectId = createHash("sha256")
    .update(await realpath(workspaceDirectory))
    .digest("hex")
    .slice(0, 24);
  const stdinSession = JSON.parse((await readFile(path.join(
    environment.RECURS_HOME,
    "projects",
    projectId,
    "sessions",
    `${stdinSessionId}.jsonl`,
  ), "utf8")).split("\n", 1)[0]);
  assert(
    stdinSession.agent?.operatingMode?.id === "economy_v5",
    "The installed headless mode flag did not pin the requested policy.",
  );
  assert(
    stdinEvents.some((event) =>
      event.type === "model_text_delta" && event.text === stdinFinalText
    ),
    "The installed stdin prompt did not complete its model turn.",
  );
  assert(stdinRun.stderr === "", "The installed stdin run wrote diagnostics.");
  assert(
    JSON.stringify(localModelServer.chatRequests[7]?.messages).includes(stdinPrompt),
    "The installed stdin prompt did not reach the configured model.",
  );

  await runInstalledAcpSmoke(executable, environment);
  assert(
    localModelServer.chatRequests.length === 9,
    "The installed ACP prompt did not reach the configured model backend exactly once.",
  );
} finally {
  if (localModelServer !== undefined) {
    await closeServer(localModelServer.server);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write("npm package installed-agent smoke passed\n");
