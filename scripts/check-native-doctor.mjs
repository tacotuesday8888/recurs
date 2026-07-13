import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import { NATIVE_COMPONENT_VERSION } from "../packages/contracts/dist/index.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cli = path.join(root, "packages/cli/dist/main.js");
const fakePeer = path.join(
  root,
  "packages/auth/test/fixtures/fake-native-peer.mjs",
);
const maximumOutputBytes = 64 * 1024;
const timeoutMilliseconds = 5_000;

const home = await mkdtemp(path.join(tmpdir(), "recurs-native-doctor-"));

try {
  const environment = { ...process.env, RECURS_HOME: home };
  delete environment.RECURS_NATIVE_FD;

  const source = await runChild(
    [cli, "doctor", "native", "--json"],
    { environment },
  );
  assertUnavailable(
    source,
    process.platform === "darwin"
      ? "launcher_unavailable"
      : "unsupported_platform",
  );

  if (process.platform === "darwin") {
    const peerArguments = ["--component-version", NATIVE_COMPONENT_VERSION];
    const { peer, channel } = startFakePeer(peerArguments);

    try {
      const injected = await runChild(
        [cli, "doctor", "native", "--json"],
        {
          environment: {
            ...environment,
            RECURS_NATIVE_FD: "3",
          },
          descriptor: channel,
        },
      );
      assertUnavailable(injected, "peer_identity_unverified");
    } finally {
      channel.destroy();
      peer.kill();
    }

    const interruptedPeer = startFakePeer(
      [...peerArguments, "--hang-health"],
      true,
    );
    let interruptedChild;
    interruptedPeer.peer.stdout.once("data", () => {
      interruptedChild?.kill("SIGINT");
    });
    try {
      const interrupted = await runChild(
        [cli, "doctor", "native", "--json"],
        {
          environment: {
            ...environment,
            RECURS_NATIVE_FD: "3",
          },
          descriptor: interruptedPeer.channel,
          onSpawn(child) {
            interruptedChild = child;
          },
        },
      );
      assertCancelled(interrupted);
    } finally {
      interruptedPeer.channel.destroy();
      interruptedPeer.peer.kill();
    }
  }
} finally {
  await rm(home, { recursive: true, force: true });
}

process.stdout.write("native doctor smoke passed\n");

function runChild(
  args,
  { environment, descriptor, onSpawn },
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: environment,
      stdio: descriptor === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", descriptor],
    });
    if (descriptor !== undefined) descriptor.destroy();

    let stdout = "";
    let stderr = "";
    let settled = false;
    let failure;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      if (failure === undefined) resolve(result);
      else reject(failure);
    };
    const append = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > maximumOutputBytes) {
        terminate(new Error("Native doctor smoke exceeded its output bound."));
        return current;
      }
      return next;
    };
    function onStdout(chunk) {
      stdout = append(stdout, chunk);
    }
    function onStderr(chunk) {
      stderr = append(stderr, chunk);
    }
    function onError() {
      terminate(new Error("Native doctor smoke could not start the CLI."));
    }
    function terminate(error) {
      if (failure !== undefined) return;
      failure = error;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdout.destroy();
      child.stderr.destroy();
      try {
        child.kill("SIGKILL");
      } catch {
        // The close event remains the single settlement point.
      }
    }

    timer = setTimeout(() => {
      terminate(new Error("Native doctor smoke timed out."));
    }, timeoutMilliseconds);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", (code, signal) => {
      finish({ code, signal, stdout, stderr });
    });
    try {
      onSpawn?.(child);
    } catch {
      terminate(new Error("Native doctor smoke setup failed."));
    }
  });
}

function startFakePeer(args, observeHealth = false) {
  const peer = spawn(process.execPath, [fakePeer, ...args], {
    cwd: root,
    stdio: ["ignore", observeHealth ? "pipe" : "ignore", "ignore", "pipe"],
  });
  peer.once("error", () => {});
  const channel = peer.stdio[3];
  if (channel === null || (observeHealth && peer.stdout === null)) {
    peer.kill();
    throw new Error("Native doctor smoke could not create its test channel.");
  }
  return { peer, channel };
}

function assertUnavailable(result, reason) {
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.stderr !== ""
  ) {
    throw new Error("Native doctor smoke returned an unexpected process result.");
  }

  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("Native doctor smoke returned invalid JSON.");
  }
  const expected = {
    version: 1,
    nativeAuthority: {
      state: "unavailable",
      reason,
    },
  };
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("Native doctor smoke returned an unexpected status.");
  }
}

function assertCancelled(result) {
  if (
    result.code !== 130 ||
    result.signal !== null ||
    result.stdout !== "" ||
    result.stderr !== "Error: Native authority check was cancelled\n"
  ) {
    throw new Error("Native doctor smoke returned an invalid cancellation.");
  }
}
