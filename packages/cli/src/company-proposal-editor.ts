import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  lstat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COMPANY_ONBOARDING_TOOL_NAMES,
  CompanyOnboardingCoordinatorError,
  type CompanyOnboardingCoordinator,
  type CompanyProposalRevisionModelPort,
  type SequencedCompanyState,
} from "@recurs/core";
import {
  getCompanyOnboardingDepthPolicy,
  type CompanyBlueprintV2,
  type CompanyOnboardingRunV1,
} from "@recurs/contracts";

import {
  diffCompanyBlueprints,
  parseCompanyBlueprintYaml,
  renderCompanyBlueprintYaml,
} from "./company-blueprint-yaml.js";

const MAX_EDITOR_COMMAND_BYTES = 4_096;
const MAX_EDITOR_ARGUMENTS = 64;
const MAX_YAML_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const EDITOR_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TERM_PROGRAM",
  "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "DISPLAY",
  "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
] as const);

export interface CompanyEditorCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export type CompanyProposalEditResult = {
  readonly kind: "updated" | "unchanged" | "invalid" | "unavailable" |
    "cancelled";
  readonly run: SequencedCompanyState<CompanyOnboardingRunV1>;
  readonly blueprint: CompanyBlueprintV2;
  readonly changes: readonly string[];
  readonly message: string | null;
};

export interface CompanyProposalEditorDependencies {
  readonly coordinator: Pick<
    CompanyOnboardingCoordinator,
    "reviseProposal" | "save"
  >;
  readonly model: CompanyProposalRevisionModelPort;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly temporaryDirectory?: string;
  readonly launchEditor?: (
    command: CompanyEditorCommand,
    file: string,
    signal: AbortSignal,
  ) => Promise<"completed" | "failed" | "cancelled">;
}

function boundedInstruction(value: string): string {
  const instruction = value.trim();
  if (instruction.length === 0 || instruction.includes("\0") ||
    encoder.encode(instruction).byteLength > 8_192) {
    throw new TypeError("Company revision instructions must be bounded text");
  }
  return instruction;
}

export function parseCompanyEditorCommand(value: string): CompanyEditorCommand {
  if (value.length === 0 || value.includes("\0") || /[\r\n]/u.test(value) ||
    encoder.encode(value).byteLength > MAX_EDITOR_COMMAND_BYTES) {
    throw new TypeError("Editor command must be bounded single-line text");
  }
  const tokens: string[] = [];
  let token = "";
  let state: "plain" | "single" | "double" = "plain";
  let escaping = false;
  let started = false;
  const push = () => {
    if (!started) return;
    tokens.push(token);
    token = "";
    started = false;
  };
  for (const character of value.trim()) {
    if (escaping) {
      token += character;
      started = true;
      escaping = false;
      continue;
    }
    if (state === "single") {
      if (character === "'") state = "plain";
      else token += character;
      started = true;
      continue;
    }
    if (state === "double") {
      if (character === '"') state = "plain";
      else if (character === "\\") escaping = true;
      else token += character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      started = true;
    } else if (character === "'") {
      state = "single";
      started = true;
    } else if (character === '"') {
      state = "double";
      started = true;
    } else if (/\s/u.test(character)) {
      push();
    } else {
      token += character;
      started = true;
    }
  }
  if (escaping || state !== "plain") {
    throw new TypeError("Editor command contains an unfinished quote or escape");
  }
  push();
  const [executable, ...arguments_] = tokens;
  if (executable === undefined || executable.length === 0 ||
    arguments_.length > MAX_EDITOR_ARGUMENTS) {
    throw new TypeError("Editor command is invalid");
  }
  return Object.freeze({
    executable,
    arguments: Object.freeze(arguments_),
  });
}

export function companyEditorEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(EDITOR_ENVIRONMENT_KEYS.flatMap((key) => {
    const value = environment[key];
    return value === undefined ? [] : [[key, value]];
  })));
}

async function launchEditorProcess(
  command: CompanyEditorCommand,
  file: string,
  signal: AbortSignal,
  environment: Readonly<Record<string, string>>,
): Promise<"completed" | "failed" | "cancelled"> {
  if (signal.aborted) return "cancelled";
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: "completed" | "failed" | "cancelled") => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command.executable, [...command.arguments, file], {
      stdio: "inherit",
      shell: false,
      signal,
      env: environment,
    });
    child.once("error", (error) => {
      finish(error.name === "AbortError" || signal.aborted
        ? "cancelled"
        : "failed");
    });
    child.once("close", (code) => {
      finish(signal.aborted ? "cancelled" : code === 0 ? "completed" : "failed");
    });
  });
}

function currentBlueprint(
  run: SequencedCompanyState<CompanyOnboardingRunV1>,
): CompanyBlueprintV2 {
  if (run.state.status !== "proposed" || run.state.proposal === null) {
    throw new CompanyOnboardingCoordinatorError(
      "invalid_state",
      "Company onboarding has no proposal to edit",
    );
  }
  return run.state.proposal.blueprint;
}

function result(
  kind: CompanyProposalEditResult["kind"],
  run: SequencedCompanyState<CompanyOnboardingRunV1>,
  previous: CompanyBlueprintV2,
  message: string | null = null,
): CompanyProposalEditResult {
  const blueprint = currentBlueprint(run);
  return Object.freeze({
    kind,
    run,
    blueprint,
    changes: kind === "updated"
      ? diffCompanyBlueprints(previous, blueprint)
      : Object.freeze([]),
    message,
  });
}

export class CompanyProposalEditor {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #launchEditor: NonNullable<
    CompanyProposalEditorDependencies["launchEditor"]
  >;

  constructor(readonly dependencies: CompanyProposalEditorDependencies) {
    this.#environment = dependencies.environment ?? process.env;
    this.#launchEditor = dependencies.launchEditor ?? ((command, file, signal) =>
      launchEditorProcess(
        command,
        file,
        signal,
        companyEditorEnvironment(this.#environment),
      ));
  }

  async discuss(input: {
    readonly run: SequencedCompanyState<CompanyOnboardingRunV1>;
    readonly instruction: string;
    readonly signal?: AbortSignal;
  }): Promise<CompanyProposalEditResult> {
    const previous = currentBlueprint(input.run);
    const signal = input.signal ?? new AbortController().signal;
    if (signal.aborted) return result("cancelled", input.run, previous);
    let instruction: string;
    try {
      instruction = boundedInstruction(input.instruction);
    } catch {
      return result(
        "invalid",
        input.run,
        previous,
        "Enter a non-empty revision request of at most 8 KiB.",
      );
    }
    const policy = getCompanyOnboardingDepthPolicy(
      input.run.state.depth,
      input.run.state.authority.operatingModeId,
    );
    const remaining = policy.maxModelRequests -
      input.run.state.usage.modelRequests;
    if (remaining < 1) {
      return result(
        "invalid",
        input.run,
        previous,
        "The onboarding request budget is exhausted.",
      );
    }
    try {
      const revision = await this.dependencies.model.revise({
        run: input.run.state,
        blueprint: previous,
        instruction,
        allowedTools: COMPANY_ONBOARDING_TOOL_NAMES,
        maxRequests: remaining,
      }, signal);
      const revised = await this.dependencies.coordinator.reviseProposal(
        input.run.state.id,
        input.run.sequence,
        { source: "chat", ...revision },
        signal,
      );
      return result(
        revised.changed ? "updated" : "unchanged",
        revised.run,
        previous,
      );
    } catch (error) {
      if (signal.aborted || error instanceof Error && error.name === "AbortError") {
        return result("cancelled", input.run, previous);
      }
      const latest = await this.dependencies.coordinator.save(
        input.run.state.id,
      ).catch(() => input.run);
      return result(
        "invalid",
        latest,
        previous,
        error instanceof CompanyOnboardingCoordinatorError &&
            error.code === "policy_violation"
          ? error.message
          : "The proposed chat revision was invalid; the company was not changed.",
      );
    }
  }

  async applyYaml(input: {
    readonly run: SequencedCompanyState<CompanyOnboardingRunV1>;
    readonly yaml: string;
    readonly signal?: AbortSignal;
  }): Promise<CompanyProposalEditResult> {
    const previous = currentBlueprint(input.run);
    if (input.signal?.aborted === true) {
      return result("cancelled", input.run, previous);
    }
    try {
      const blueprint = parseCompanyBlueprintYaml(input.yaml);
      const revised = await this.dependencies.coordinator.reviseProposal(
        input.run.state.id,
        input.run.sequence,
        {
          source: "yaml",
          blueprint,
          requestsUsed: 0,
          reportedCostUsd: 0,
        },
        input.signal,
      );
      return result(
        revised.changed ? "updated" : "unchanged",
        revised.run,
        previous,
      );
    } catch {
      return result(
        "invalid",
        input.run,
        previous,
        "The edited YAML was invalid or widened immutable company authority.",
      );
    }
  }

  async editYaml(input: {
    readonly run: SequencedCompanyState<CompanyOnboardingRunV1>;
    readonly signal?: AbortSignal;
  }): Promise<CompanyProposalEditResult> {
    const previous = currentBlueprint(input.run);
    const commandText = this.#environment.VISUAL?.trim() ||
      this.#environment.EDITOR?.trim();
    if (commandText === undefined || commandText.length === 0) {
      return result(
        "unavailable",
        input.run,
        previous,
        "Set VISUAL or EDITOR to edit the company YAML.",
      );
    }
    let command: CompanyEditorCommand;
    try {
      command = parseCompanyEditorCommand(commandText);
    } catch {
      return result(
        "invalid",
        input.run,
        previous,
        "VISUAL or EDITOR is not a valid bounded command.",
      );
    }
    const signal = input.signal ?? new AbortController().signal;
    const directory = await mkdtemp(path.join(
      this.dependencies.temporaryDirectory ?? tmpdir(),
      "recurs-company-",
    ));
    try {
      await chmod(directory, 0o700);
      const file = path.join(directory, "company.yaml");
      await writeFile(file, renderCompanyBlueprintYaml(previous), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const launched = await this.#launchEditor(command, file, signal);
      if (launched === "cancelled") return result("cancelled", input.run, previous);
      if (launched === "failed") {
        return result(
          "invalid",
          input.run,
          previous,
          "The editor exited without a usable company revision.",
        );
      }
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() ||
        metadata.size > MAX_YAML_BYTES) {
        return result(
          "invalid",
          input.run,
          previous,
          "The edited company YAML was not a bounded regular file.",
        );
      }
      return await this.applyYaml({
        run: input.run,
        yaml: await readFile(file, "utf8"),
        signal,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
