// First-run preview: the real onboarding and provider login, with private isolated state.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run npm run ui:preview in an interactive terminal.");
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preview = await mkdtemp(path.join(tmpdir(), "recurs-first-run-"));
const home = path.join(preview, "home");
const workspace = path.join(preview, "project");
const data = path.join(home, ".recurs");
await mkdir(path.join(data, "config"), { recursive: true, mode: 0o700 });
await mkdir(workspace);
await writeFile(path.join(data, "config", "appearance.json"), JSON.stringify({ version: 1, theme: "orange" }), { mode: 0o600 });
// Saved model choices and provider credential paths stay isolated.
// API keys may be explicitly supplied for the normal environment-key onboarding path.
const env = Object.fromEntries(["PATH", "TERM", "COLORTERM", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "WINDIR", "RECURS_REDUCED_MOTION"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
if (process.argv.includes("--use-env")) {
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && /(?:_API_KEY|_AUTH_TOKEN)$/.test(name)) env[name] = value;
  }
}
Object.assign(env, { HOME: home, USERPROFILE: home, RECURS_HOME: data, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share") });
console.log("Recurs · first run · real provider sign-in and onboarding");
console.log(`Private preview state: ${preview}`);
console.log("No account is preconnected. Provider requests after connection use your account.");
console.log("For the scripted tool demo instead: npm run ui:demo");
const child = spawn(process.execPath, [path.join(root, "dist/cli/main.js"), "setup"], { cwd: workspace, env, stdio: "inherit" });
child.once("error", (error) => { console.error(`Preview could not start: ${error.message}`); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
