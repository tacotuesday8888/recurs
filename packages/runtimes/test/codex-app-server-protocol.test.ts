import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerProtocolError,
  createCodexAppServerClient,
  type CodexAppServerMessage,
  type CodexAppServerProcessProfile,
} from "@recurs/runtimes";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

function profile(
  scenario = "happy",
  overrides: Partial<CodexAppServerProcessProfile["bounds"]> = {},
): CodexAppServerProcessProfile {
  return {
    command: process.execPath,
    args: [fixture, "--scenario", scenario],
    environment: {},
    bounds: {
      maxFrameBytes: 2_048,
      maxStdoutBytes: 16_384,
      maxStderrBytes: 2_048,
      maxFrames: 64,
      maxPendingRequests: 8,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      ...overrides,
    },
  };
}

describe("Codex app-server protocol", () => {
  it("correlates requests and forwards bounded notifications", async () => {
    const notifications: CodexAppServerMessage[] = [];
    const client = createCodexAppServerClient(profile(), {
      onMessage(message) {
        notifications.push(message);
      },
    });
    try {
      await expect(client.request("echo", { value: "ok" })).resolves.toEqual({
        value: "ok",
      });
      client.notify("notify-test", { n: 1 });
      await expect.poll(() => notifications).toContainEqual({
        method: "test/notification",
        params: { n: 1 },
      });
    } finally {
      await client.close();
    }
  });

  it("answers server requests without confusing request ownership", async () => {
    const client = createCodexAppServerClient(profile(), {
      async onRequest(request) {
        expect(request).toEqual({
          id: "server-request-1",
          method: "item/tool/call",
          params: { tool: "read_file", arguments: { path: "README.md" } },
        });
        return { content: [{ type: "inputText", text: "contents" }] };
      },
    });
    try {
      await expect(client.request("server-request-test", {})).resolves.toEqual({
        content: [{ type: "inputText", text: "contents" }],
      });
    } finally {
      await client.close();
    }
  });

  it("fails closed on oversized frames and stderr", async () => {
    const frameClient = createCodexAppServerClient(
      profile("frame-overflow", { maxFrameBytes: 512 }),
    );
    await expect(frameClient.closed).rejects.toMatchObject({
      code: "protocol_limit",
    });
    await frameClient.close();

    const stderrClient = createCodexAppServerClient(
      profile("stderr-overflow", { maxStderrBytes: 128 }),
    );
    await expect(stderrClient.closed).rejects.toMatchObject({
      code: "protocol_limit",
    });
    await stderrClient.close();
  });

  it("times out and cancels individual requests", async () => {
    const timeoutClient = createCodexAppServerClient(
      profile("happy", { requestTimeoutMs: 20 }),
    );
    await expect(timeoutClient.request("hang", {})).rejects.toMatchObject({
      code: "timeout",
    });
    await timeoutClient.close();

    const abortClient = createCodexAppServerClient(profile());
    const controller = new AbortController();
    const pending = abortClient.request("hang", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await abortClient.close();
  });

  it("rejects invalid process profiles before spawning", () => {
    expect(() => createCodexAppServerClient({
      ...profile(),
      command: "relative/codex",
    })).toThrow(CodexAppServerProtocolError);
  });
});
