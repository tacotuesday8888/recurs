import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { releaseMetadataFailures } from "./check-npm-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "tacotuesday8888/recurs";
const safeVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)))*)?$/u;
const safeLicense = /^[0-9A-Za-z.+() -]{1,128}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rubyString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("#{", "\\#{")}"`;
}

function releaseValues(input) {
  assert(safeVersion.test(input.version), "Release version is not canonical semver.");
  assert(input.version !== "0.0.0", "Release version cannot be the placeholder.");
  assert(input.tag === `v${input.version}`, "Release tag must exactly match the package version.");
  assert(sha256Pattern.test(input.sha256), "Release archive SHA-256 is invalid.");
  assert(safeLicense.test(input.license), "Release license is not safe formula metadata.");
  const filename = `recurs-${input.version}.tgz`;
  return {
    ...input,
    filename,
    githubUrl: `https://github.com/${repository}/releases/download/${input.tag}/${filename}`,
    npmUrl: `https://registry.npmjs.org/recurs/-/${filename}`,
  };
}

export function renderInstaller(input) {
  const values = releaseValues(input);
  return `#!/bin/sh
set -eu

version=${JSON.stringify(values.version)}
archive=${JSON.stringify(values.filename)}
archive_url=${JSON.stringify(values.githubUrl)}
archive_sha256=${JSON.stringify(values.sha256)}

fail() {
  printf '%s\n' "recurs install: $1" >&2
  exit 1
}

for command_name in curl node npm; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && (minor > 22 || (minor === 22 && patch >= 0))) ? 0 : 1)' || fail "Node.js 22.22.0 or newer is required"

if [ -n "\${RECURS_INSTALL_PREFIX:-}" ]; then
  prefix=$RECURS_INSTALL_PREFIX
else
  [ -n "\${HOME:-}" ] || fail "HOME or RECURS_INSTALL_PREFIX is required"
  prefix=$HOME/.local
fi
case "$prefix" in
  /*) ;;
  *) fail "RECURS_INSTALL_PREFIX must be an absolute path" ;;
esac

temporary_directory=$(mktemp -d "\${TMPDIR:-/tmp}/recurs-install.XXXXXX") || fail "could not create a temporary directory"
trap 'rm -rf "$temporary_directory"' 0
trap 'exit 1' HUP INT TERM
archive_path="$temporary_directory/$archive"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$archive_url" --output "$archive_path" || fail "download failed"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$archive_path")
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 "$archive_path")
else
  fail "sha256sum or shasum is required"
fi
actual_sha256=\${actual_sha256%% *}
[ "$actual_sha256" = "$archive_sha256" ] || fail "archive checksum mismatch"

mkdir -p "$prefix" || fail "could not create the install prefix"
npm install --global --ignore-scripts --no-audit --no-fund --prefix "$prefix" "$archive_path" || fail "npm installation failed"
"$prefix/bin/recurs" --help >/dev/null 2>&1 || fail "installed CLI health check failed"

printf '%s\n' "Recurs $version installed at $prefix/bin/recurs"
case ":\${PATH:-}:" in
  *":$prefix/bin:"*) ;;
  *) printf '%s\n' "Add $prefix/bin to PATH to run recurs." ;;
esac
`;
}

export function renderHomebrewFormula(input) {
  const values = releaseValues(input);
  return `class Recurs < Formula
  desc "Coding-agent harness with durable, bounded team orchestration"
  homepage "https://github.com/${repository}"
  url "${values.npmUrl}"
  sha256 "${values.sha256}"
  license ${rubyString(values.license)}

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "Recurs coding-agent harness", shell_output("#{bin}/recurs --help")
  end
end
`;
}

export function renderChecksums(input) {
  const values = releaseValues(input);
  return `${values.sha256}  ${values.filename}\n`;
}

export function archiveIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function verifyPublishedIntegrity(bytes, integrity) {
  assert(typeof integrity === "string", "Published npm integrity is missing.");
  assert(
    archiveIntegrity(bytes) === integrity,
    "Published npm package integrity does not match the release archive.",
  );
}

async function writeAsset(directory, filename, contents, mode) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const destination = path.join(directory, filename);
  const temporary = path.join(
    directory,
    `.${filename}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return destination;
}

function parseArguments(argv) {
  if (
    argv.length === 6 &&
    argv[0] === "--tag" &&
    argv[2] === "--archive" &&
    argv[4] === "--output" &&
    argv[1] !== undefined &&
    argv[3] !== undefined &&
    argv[5] !== undefined
  ) {
    return { kind: "render", tag: argv[1], archive: argv[3], output: argv[5] };
  }
  if (
    argv.length === 4 &&
    argv[0] === "--verify-published-integrity" &&
    argv[1] !== undefined &&
    argv[2] === "--integrity" &&
    argv[3] !== undefined
  ) {
    return { kind: "verify", archive: argv[1], integrity: argv[3] };
  }
  throw new Error(
    "Usage: render-install-assets.mjs --tag <vVERSION> --archive <tgz> --output <dir> | --verify-published-integrity <tgz> --integrity <sha512-SRI>",
  );
}

async function renderReleaseAssets(command) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const licenseText = await readFile(path.join(root, "LICENSE"), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const noticesText = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const failures = releaseMetadataFailures({ packageJson, licenseText, noticesText });
  assert(failures.length === 0, `Release metadata is not ready: ${failures.join(", ")}`);
  const archive = path.resolve(command.archive);
  const details = await stat(archive);
  assert(details.isFile() && details.size > 0, "Release archive must be a nonempty regular file.");
  const expectedFilename = `recurs-${packageJson.version}.tgz`;
  assert(path.basename(archive) === expectedFilename, "Release archive filename does not match the package version.");
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const input = {
    version: packageJson.version,
    tag: command.tag,
    sha256,
    license: packageJson.license,
  };
  const output = path.resolve(command.output);
  await Promise.all([
    writeAsset(output, "install.sh", renderInstaller(input), 0o755),
    writeAsset(output, "recurs.rb", renderHomebrewFormula(input), 0o644),
    writeAsset(output, "SHA256SUMS", renderChecksums(input), 0o644),
    writeAsset(output, "npm-integrity.txt", `${archiveIntegrity(bytes)}\n`, 0o644),
  ]);
  process.stdout.write(`release install assets rendered for ${command.tag}\n`);
}

async function main() {
  const command = parseArguments(process.argv.slice(2));
  if (command.kind === "verify") {
    verifyPublishedIntegrity(await readFile(path.resolve(command.archive)), command.integrity);
    process.stdout.write("published npm integrity matches the release archive\n");
    return;
  }
  await renderReleaseAssets(command);
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
