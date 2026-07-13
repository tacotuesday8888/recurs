import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import console from "node:console";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicCli = path.join(root, "packages/cli/dist/main.js");
const canary = "SECRET_NATIVE_BRIDGE_CANARY";

try {
  assertPublicCliCannotClaimNativeDescriptor();
  await assertBrokerOwnedProvidersRemainDisabled();
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown failure";
  console.error(`native engine bridge smoke failed: ${reason}`);
  process.exit(1);
}

process.stdout.write("native engine bridge smoke passed\n");

function assertPublicCliCannotClaimNativeDescriptor() {
  const result = spawnSync(
    process.execPath,
    [publicCli, "doctor", "native", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        RECURS_NATIVE_FD: "3",
        RECURS_NATIVE_BRIDGE_CANARY: canary,
      },
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      timeout: 5_000,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stderr !== ""
  ) {
    throw new Error("public CLI native boundary failed");
  }

  const descriptorOutput = result.output?.[3] ?? "";
  if (Buffer.byteLength(descriptorOutput) !== 0) {
    throw new Error("public CLI wrote to the native descriptor");
  }
  if (
    result.stdout.includes(canary) ||
    result.stderr.includes(canary) ||
    String(descriptorOutput).includes(canary)
  ) {
    throw new Error("public CLI exposed an environment canary");
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("public CLI returned invalid native health JSON");
  }
  const expectedReason =
    process.platform === "darwin"
      ? "launcher_unavailable"
      : "unsupported_platform";
  if (
    payload?.version !== 1 ||
    payload.nativeAuthority?.state !== "unavailable" ||
    payload.nativeAuthority?.reason !== expectedReason
  ) {
    throw new Error("public CLI returned an invalid native health result");
  }
}

async function assertBrokerOwnedProvidersRemainDisabled() {
  const providers = await import(
    pathToFileURL(path.join(root, "packages/providers/dist/index.js")).href
  );
  const brokerOwned = providers.BUNDLED_PROVIDER_MANIFESTS.filter(
    (manifest) => manifest.credentialOwner === "recurs_broker",
  );
  if (brokerOwned.length === 0 || brokerOwned.some((manifest) => manifest.runnable)) {
    throw new Error("broker-owned provider activation changed");
  }
}
