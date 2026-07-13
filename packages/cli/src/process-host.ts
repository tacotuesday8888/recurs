import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout,
} from "node:process";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

import {
  createHostInvocation,
  type IntegrationFailure,
  type NativeAuthorityPort,
  type NativeAuthorityStatus,
} from "@recurs/contracts";
import {
  CodexOnboardingError,
  ConnectionLifecycleError,
  NativeAuthorityService,
  type ConnectionDisconnection,
  type ConnectionVerification,
  type CodexConnectionConfiguration,
} from "@recurs/app";
import { CoordinatedRunError, type EventSink } from "@recurs/core";

import { createStandaloneRuntime } from "./assembly.js";
import { setupCodexSubscription } from "./codex-connection.js";
import {
  listAccountSummaries,
  listProviderSummaries,
  disconnectAccount,
  setPrimaryAccount,
  verifyAccount,
  type AccountSummary,
  type ProviderSummary,
} from "./provider-account.js";
import {
  LocalConnectionError,
  setupLocalConnection,
  type LocalConnectionConfiguration,
} from "./local-connection.js";
import type { CommandResult } from "./commands/types.js";
import {
  JsonlEventRenderer,
  TextEventRenderer,
  renderCommandResult,
  writeOutput,
} from "./render.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { startRepl } from "./repl.js";
import {
  RuntimeError,
  isCancellation,
  type RecursRuntime,
} from "./runtime.js";

const help = `Recurs coding-agent harness

Usage:
  recurs                         Open the interactive CLI
  recurs run <prompt>            Run one prompt
  recurs run <prompt> --format text|jsonl
  recurs setup local --url <loopback-url> --model <model-id>
  recurs setup codex             Connect an existing ChatGPT Codex subscription
  recurs provider list [--all] [--json]
  recurs account list [--json]
  recurs account set-primary <id>
  recurs account verify <id>
  recurs account disconnect <id>
  recurs doctor native [--json]  Inspect native authority status
  recurs --help                  Show this help

Local setup supports credential-free OpenAI-compatible servers on literal loopback only.
Codex setup is interactive and Plan-only. It never imports or stores vendor credentials.
`;

export interface CliDependencies {
  stdout: Writable;
  stderr: Writable;
  stdin?: Readable;
  cwd?: string;
  interactive?: boolean;
  automation?: boolean;
  signal?: AbortSignal;
  confirm?(message: string): Promise<boolean>;
  nativeAuthority?: NativeAuthorityPort;
  createRuntime(events: EventSink): Promise<RecursRuntime>;
  setupLocal?(input: { baseUrl: string; modelId: string }): Promise<Pick<LocalConnectionConfiguration, "id" | "label" | "baseUrl" | "modelId" | "primary">>;
  setupCodex?(input: {
    cwd: string;
    interactive: true;
    billingSelection: "allow_declared_additional";
  }): Promise<Pick<CodexConnectionConfiguration, "id" | "label" | "modelId" | "planOnly" | "primary">>;
  listProviders?(input: {
    includeBlocked: boolean;
  }): Promise<readonly ProviderSummary[]>;
  listAccounts?(): Promise<readonly AccountSummary[]>;
  setPrimaryAccount?(id: string): Promise<AccountSummary>;
  verifyAccount?(id: string, cwd: string): Promise<ConnectionVerification>;
  disconnectAccount?(id: string): Promise<ConnectionDisconnection>;
}

interface RunArguments {
  prompt: string;
  format: "text" | "jsonl";
}

function nativeAuthorityText(status: NativeAuthorityStatus): string {
  if (status.state === "unavailable") {
    return `Native authority: unavailable\nReason: ${status.reason}\n`;
  }
  return [
    "Native authority: available",
    `Protocol: ${status.attestation.protocolVersion}`,
    `Launcher: ${status.attestation.launcherVersion}`,
    `Broker: ${status.attestation.brokerVersion}`,
    `Platform: ${status.attestation.platform} (macOS ${status.attestation.minimumMacosVersion}+)`,
    `Production signed: ${status.attestation.productionSigned ? "yes" : "no"}`,
    `Persistent credentials: ${status.attestation.persistentCredentials ? "yes" : "no"}`,
    `Keychain: ${status.health.keychain}`,
    `Peer identity: ${status.health.peerIdentity}`,
    "",
  ].join("\n");
}

function isAbortError(error: unknown): boolean {
  try {
    return error instanceof DOMException && error.name === "AbortError";
  } catch {
    return false;
  }
}

function parseRunArguments(args: readonly string[]): RunArguments | null {
  let format: RunArguments["format"] = "text";
  const prompt: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--format") {
      const value = args[index + 1];
      if (value !== "text" && value !== "jsonl") {
        return null;
      }
      format = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      return null;
    }
    prompt.push(argument);
  }
  const joined = prompt.join(" ").trim();
  return joined.length === 0 ? null : { prompt: joined, format };
}

function parseLocalSetupArguments(
  args: readonly string[],
): { baseUrl: string; modelId: string } | null {
  if (args[0] !== "local") return null;
  let baseUrl: string | undefined;
  let modelId: string | undefined;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--url" && baseUrl === undefined) baseUrl = value;
    else if (flag === "--model" && modelId === undefined) modelId = value;
    else return null;
  }
  return baseUrl === undefined || modelId === undefined
    ? null
    : { baseUrl, modelId };
}

function parseListArguments(
  args: readonly string[],
  allowAll: boolean,
): { json: boolean; includeBlocked: boolean } | null {
  if (args[0] !== "list") return null;
  let json = false;
  let includeBlocked = false;
  for (const flag of args.slice(1)) {
    if (flag === "--json" && !json) json = true;
    else if (flag === "--all" && allowAll && !includeBlocked) {
      includeBlocked = true;
    } else {
      return null;
    }
  }
  return { json, includeBlocked };
}

type AccountCommand =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "set_primary"; readonly id: string }
  | { readonly kind: "verify"; readonly id: string }
  | { readonly kind: "disconnect"; readonly id: string };

const ACCOUNT_CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function parseAccountCommand(args: readonly string[]): AccountCommand | null {
  const listed = parseListArguments(args, false);
  if (listed !== null) return { kind: "list", json: listed.json };
  if (args.length !== 2) return null;
  const [action, id] = args;
  if (id === undefined || !ACCOUNT_CONNECTION_ID.test(id)) return null;
  if (action === "set-primary") return { kind: "set_primary", id };
  if (action === "verify") return { kind: "verify", id };
  if (action === "disconnect") return { kind: "disconnect", id };
  return null;
}

function providerText(providers: readonly ProviderSummary[]): string {
  if (providers.length === 0) return "No provider paths are available.\n";
  return `${providers.map((provider) => {
    const sources = [
      provider.billing.primarySource,
      ...provider.billing.possibleAdditionalSources,
    ].join(" + ");
    return [
      `${provider.id} — ${provider.displayName}`,
      `  Status: ${provider.status} (${provider.supportStatus})`,
      `  Access: ${provider.accessKind} · ${provider.adapterKind} · ${provider.protocol}`,
      `  Credential owner: ${provider.connectionOwner}`,
      `  Billing: ${sources} · fallback ${provider.billing.providerFallback}`,
      ...provider.restrictions.slice(0, 2).map(
        (restriction) => `  Restriction: ${restriction}`,
      ),
    ].join("\n");
  }).join("\n\n")}\n`;
}

function accountText(accounts: readonly AccountSummary[]): string {
  if (accounts.length === 0) return "No configured accounts.\n";
  return `${accounts.map((account) => [
    `${account.primary ? "*" : " "} ${account.id} — ${account.label}`,
    `  Provider: ${account.providerId} · ${account.adapterId}`,
    `  Model: ${account.modelId} · ${account.execution}`,
    `  Account: ${account.account}`,
    `  Billing: ${account.billingSources.join(" + ")}`,
  ].join("\n")).join("\n\n")}\n`;
}

function isCommandResult(value: unknown): value is CommandResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "message" ||
      value.type === "submit_prompt" ||
      value.type === "quit")
  );
}

function exitCodeFor(error: unknown): number {
  if (isCancellation(error)) {
    return 130;
  }
  if (
    error instanceof RuntimeError &&
    (error.code === "invalid_input" || error.code === "provider_not_configured")
  ) {
    return 2;
  }
  if (error instanceof LocalConnectionError) return 2;
  if (error instanceof CodexOnboardingError) return 2;
  if (error instanceof ConnectionLifecycleError) {
    return error.code === "cancelled" ? 130 : 2;
  }
  if (error instanceof CoordinatedRunError && error.failure.phase === "preflight") {
    return 2;
  }
  return 1;
}

function configurationFailure(error: unknown): IntegrationFailure | null {
  if (error instanceof CoordinatedRunError && error.failure.phase === "preflight") {
    return error.failure;
  }
  if (
    error instanceof RuntimeError &&
    (error.code === "invalid_input" || error.code === "provider_not_configured")
  ) {
    return {
      domain: "connection",
      phase: "preflight",
      code: "connection_invalid",
      safeMessage: error.message,
      diagnosticId: randomUUID(),
      retryable: false,
      action: "select_connection",
    };
  }
  return null;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (
    argv.length === 1 &&
    (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")
  ) {
    await writeOutput(dependencies.stdout, help);
    return 0;
  }

  if (argv[0] === "doctor") {
    const json = argv.length === 3 && argv[2] === "--json";
    const nativeAuthority = dependencies.nativeAuthority;
    const valid =
      argv[1] === "native" &&
      (argv.length === 2 || json) &&
      nativeAuthority !== undefined;
    if (!valid) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      const status = await new NativeAuthorityService(nativeAuthority).status(
        dependencies.signal,
      );
      await writeOutput(
        dependencies.stdout,
        json
          ? `${JSON.stringify({ version: 1, nativeAuthority: status })}\n`
          : nativeAuthorityText(status),
      );
      return 0;
    } catch (error) {
      if (isAbortError(error)) {
        await writeOutput(
          dependencies.stderr,
          "Error: Native authority check was cancelled\n",
        );
        return 130;
      }
      const status: NativeAuthorityStatus = Object.freeze({
        state: "unavailable",
        reason: "broker_unavailable",
      });
      await writeOutput(
        dependencies.stdout,
        json
          ? `${JSON.stringify({ version: 1, nativeAuthority: status })}\n`
          : nativeAuthorityText(status),
      );
      return 0;
    }
  }

  if (argv.length === 0) {
    if (
      dependencies.interactive !== true ||
      dependencies.automation === true
    ) {
      await writeOutput(
        dependencies.stderr,
        "Error: The interactive CLI requires a user-present local terminal. Use recurs run for supported noninteractive providers.\n",
      );
      return 2;
    }
    const renderer = new TextEventRenderer(dependencies.stdout);
    try {
      const runtime = await dependencies.createRuntime(renderer);
      await startRepl(runtime, {
        ...(dependencies.stdin === undefined ? {} : { input: dependencies.stdin }),
        output: dependencies.stdout,
        invocation: createHostInvocation({
          invocation: "repl",
          userPresent: true,
          remote: false,
          scripted: false,
          embedding: "cli",
        }),
      });
      return 0;
    } catch (error) {
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCodeFor(error);
    }
  }

  if (argv[0] === "provider") {
    const parsed = parseListArguments(argv.slice(1), true);
    if (parsed === null || dependencies.listProviders === undefined) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      const providers = await dependencies.listProviders({
        includeBlocked: parsed.includeBlocked,
      });
      await writeOutput(
        dependencies.stdout,
        parsed.json
          ? `${JSON.stringify({ version: 1, providers })}\n`
          : providerText(providers),
      );
      return 0;
    } catch (error) {
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCodeFor(error);
    }
  }

  if (argv[0] === "account") {
    const command = parseAccountCommand(argv.slice(1));
    if (command === null) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      if (command.kind === "list") {
        if (dependencies.listAccounts === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const accounts = await dependencies.listAccounts();
        await writeOutput(
          dependencies.stdout,
          command.json
            ? `${JSON.stringify({ version: 1, accounts })}\n`
            : accountText(accounts),
        );
        return 0;
      }
      if (command.kind === "set_primary") {
        if (dependencies.setPrimaryAccount === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const account = await dependencies.setPrimaryAccount(command.id);
        await writeOutput(
          dependencies.stdout,
          `Primary connection — ${account.id} · ${account.modelId}\nProvider: ${account.providerId} · Billing: ${account.billingSources.join(" + ")}\nExisting sessions keep their pinned backend.\n`,
        );
        return 0;
      }
      if (
        dependencies.interactive !== true ||
        dependencies.automation === true
      ) {
        await writeOutput(
          dependencies.stderr,
          "Error: Account verification and disconnection require a user-present local terminal\n",
        );
        return 2;
      }
      if (command.kind === "verify") {
        if (dependencies.verifyAccount === undefined) {
          await writeOutput(dependencies.stderr, help);
          return 2;
        }
        const result = await dependencies.verifyAccount(
          command.id,
          dependencies.cwd ?? process.cwd(),
        );
        await writeOutput(
          dependencies.stdout,
          `Verified — ${result.connection.id} · ${result.connection.modelId}\nProvider: ${result.connection.providerId} · ${result.connection.execution}\n`,
        );
        return 0;
      }
      if (
        dependencies.confirm === undefined ||
        dependencies.disconnectAccount === undefined
      ) {
        await writeOutput(dependencies.stderr, help);
        return 2;
      }
      const confirmed = await dependencies.confirm(
        `Disconnect ${command.id} from Recurs? This removes Recurs metadata only; vendor authentication will not be changed.`,
      );
      if (!confirmed) {
        await writeOutput(
          dependencies.stderr,
          "Error: Account disconnection was not confirmed\n",
        );
        return 2;
      }
      const result = await dependencies.disconnectAccount(command.id);
      await writeOutput(
        dependencies.stdout,
        `Disconnected ${result.connectionId}. Vendor authentication was not changed.\n${result.primaryCleared ? "No primary connection is selected.\n" : ""}`,
      );
      return 0;
    } catch (error) {
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCodeFor(error);
    }
  }

  if (argv[0] === "setup") {
    if (argv.length === 2 && argv[1] === "codex") {
      if (
        dependencies.interactive !== true ||
        dependencies.automation === true ||
        dependencies.confirm === undefined ||
        dependencies.setupCodex === undefined
      ) {
        await writeOutput(
          dependencies.stderr,
          "Error: Codex setup requires an interactive local terminal\n",
        );
        return 2;
      }
      const accepted = await dependencies.confirm(
        "OpenAI documents Codex as included with eligible ChatGPT plans. After included limits, Codex may automatically use prepaid credits when available. Continue and allow both included subscription usage and that declared prepaid-credit fallback?",
      );
      if (!accepted) {
        await writeOutput(
          dependencies.stderr,
          "Error: Codex billing disclosure was not accepted\n",
        );
        return 2;
      }
      try {
        const connection = await dependencies.setupCodex({
          cwd: dependencies.cwd ?? process.cwd(),
          interactive: true,
          billingSelection: "allow_declared_additional",
        });
        await writeOutput(
          dependencies.stdout,
          `Ready — ${connection.label} · ${connection.modelId}\nMode: Plan-only (read-only Codex runtime)\nAccount: verified by the vendor runtime; credentials remain vendor-owned\n${connection.primary ? "Primary connection\n" : `Saved as secondary; use recurs account set-primary ${connection.id} to select it\n`}`,
        );
        return 0;
      } catch (error) {
        await writeOutput(
          dependencies.stderr,
          `Error: ${safeCliErrorMessage(error)}\n`,
        );
        return exitCodeFor(error);
      }
    }
    const input = parseLocalSetupArguments(argv.slice(1));
    if (input === null || dependencies.setupLocal === undefined) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      const connection = await dependencies.setupLocal(input);
      await writeOutput(
        dependencies.stdout,
        `Ready — ${connection.label} · ${connection.modelId}\nEndpoint: ${connection.baseUrl}\n${connection.primary ? "Primary connection\n" : `Saved as secondary; use recurs account set-primary ${connection.id} to select it\n`}`,
      );
      return 0;
    } catch (error) {
      await writeOutput(dependencies.stderr, `Error: ${safeCliErrorMessage(error)}\n`);
      return exitCodeFor(error);
    }
  }

  if (argv[0] !== "run") {
    await writeOutput(dependencies.stderr, help);
    return 2;
  }
  const parsed = parseRunArguments(argv.slice(1));
  if (parsed === null) {
    await writeOutput(dependencies.stderr, help);
    return 2;
  }
  const renderer = parsed.format === "jsonl"
    ? new JsonlEventRenderer(dependencies.stdout)
    : new TextEventRenderer(dependencies.stdout);
  try {
    const runtime = await dependencies.createRuntime(renderer);
    const result = await runtime.submit(
      parsed.prompt,
      createHostInvocation({
        invocation: "one_shot",
        userPresent: false,
        remote: false,
        scripted: true,
        embedding: "cli",
      }),
    );
    if (isCommandResult(result)) {
      await renderCommandResult(result, dependencies.stdout, dependencies.stderr);
    }
    return 0;
  } catch (error) {
    const failure = configurationFailure(error);
    if (parsed.format === "jsonl" && failure !== null) {
      await writeOutput(
        dependencies.stdout,
        `${JSON.stringify({
          version: 1,
          type: "configuration_error",
          error: failure,
        })}\n`,
      );
      return 2;
    }
    await writeOutput(
      dependencies.stderr,
      `Error: ${safeCliErrorMessage(error)}\n`,
    );
    return exitCodeFor(error);
  }
}

const AUTOMATION_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "TEAMCITY_VERSION",
  "JENKINS_URL",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
]);

export function isAutomationEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  return AUTOMATION_ENVIRONMENT_KEYS.some((key) => {
    const value = environment[key]?.trim().toLowerCase();
    return value !== undefined && value !== "" && value !== "0" &&
      value !== "false" && value !== "no" && value !== "off";
  });
}

export async function runCliProcess(
  nativeAuthority: NativeAuthorityPort,
): Promise<void> {
  const argv = process.argv.slice(2);
  const nativeDoctorRequested =
    argv[0] === "doctor" &&
    argv[1] === "native" &&
    (argv.length === 2 || (argv.length === 3 && argv[2] === "--json"));
  const nativeDoctorController = nativeDoctorRequested
    ? new AbortController()
    : undefined;
  const cancelNativeDoctor = (): void => {
    nativeDoctorController?.abort();
  };
  if (nativeDoctorController !== undefined) {
    process.once("SIGINT", cancelNativeDoctor);
  }
  const confirm = async (message: string): Promise<boolean> => {
    const terminal = createInterface({
      input: processStdin,
      output: processStdout,
    });
    try {
      const answer = await terminal.question(`${message}\nContinue? [y/N] `);
      return answer.trim().toLowerCase() === "y" ||
        answer.trim().toLowerCase() === "yes";
    } finally {
      terminal.close();
    }
  };
  const dataDirectory = process.env.RECURS_HOME ?? path.join(homedir(), ".recurs");
  try {
    process.exitCode = await runCli(argv, {
      stdin: processStdin,
      stdout: processStdout,
      stderr: processStderr,
      cwd: process.cwd(),
      interactive: processStdin.isTTY === true && processStdout.isTTY === true,
      automation: isAutomationEnvironment(process.env),
      ...(nativeDoctorController === undefined
        ? {}
        : { signal: nativeDoctorController.signal }),
      confirm,
      nativeAuthority,
      createRuntime: (events) => createStandaloneRuntime(events),
      setupLocal: (input) => setupLocalConnection(
        dataDirectory,
        input,
      ),
      setupCodex: (input) => setupCodexSubscription(dataDirectory, input),
      listProviders: async ({ includeBlocked }) =>
        listProviderSummaries(includeBlocked),
      listAccounts: () => listAccountSummaries(dataDirectory),
      setPrimaryAccount: (id) => setPrimaryAccount(dataDirectory, id),
      verifyAccount: (id, cwd) => verifyAccount(dataDirectory, id, cwd),
      disconnectAccount: (id) => disconnectAccount(dataDirectory, id),
    });
  } finally {
    process.removeListener("SIGINT", cancelNativeDoctor);
  }
}
