import { FileConnectionRegistry } from "@recurs/app";
import { RECURS_VERSION } from "@recurs/contracts";
import {
  ToolError,
  runProcess,
  safeGitArguments,
  type ProcessResult,
  type RunProcessOptions,
} from "@recurs/tools";

export type DoctorCheckStatus = "ok" | "warning" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly summary: string;
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly type: "doctor_report";
  readonly recursVersion: string;
  readonly overallStatus: DoctorCheckStatus;
  readonly checks: readonly DoctorCheck[];
}

type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export interface DoctorOptions {
  readonly cwd: string;
  readonly dataDirectory: string;
  readonly signal?: AbortSignal;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly recursVersion?: string;
  readonly processRunner?: ProcessRunner;
  readonly inspectConnections?: () => Promise<{
    readonly primaryConnectionId: string | null;
    readonly connections: readonly { readonly id: string }[];
  }>;
}

const STATUS_RANK = Object.freeze({
  ok: 0,
  warning: 1,
  fail: 2,
} satisfies Record<DoctorCheckStatus, number>);

function versionParts(value: string): readonly number[] | null {
  const match = /^(?:v|git version |ripgrep )?(\d+)\.(\d+)(?:\.(\d+))?/u.exec(value);
  if (match === null) return null;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3] ?? "0", 10),
  ];
}

function versionAtLeast(
  actual: readonly number[],
  minimum: readonly number[],
): boolean {
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function cancelled(error: unknown, signal: AbortSignal | undefined): never | void {
  if (
    signal?.aborted === true ||
    (error instanceof ToolError && error.code === "cancelled")
  ) {
    throw new DOMException("Doctor was cancelled", "AbortError");
  }
}

function failure(
  id: string,
  summary: string,
  remediation: string,
): DoctorCheck {
  return { id, status: "fail", summary, remediation };
}

async function commandVersionCheck(
  input: {
    readonly id: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly label: string;
    readonly minimum?: readonly number[];
    readonly remediation: string;
  },
  cwd: string,
  signal: AbortSignal | undefined,
  runner: ProcessRunner,
): Promise<DoctorCheck> {
  try {
    const result = await runner(input.command, input.args, {
      cwd,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 5_000,
      maxOutputBytes: 4 * 1024,
    });
    const firstLine = result.stdout.trim().split(/\r?\n/u)[0] ?? "";
    const parsed = versionParts(firstLine);
    if (
      firstLine.length === 0 ||
      parsed === null ||
      (input.minimum !== undefined && !versionAtLeast(parsed, input.minimum))
    ) {
      return failure(
        input.id,
        `${input.label} is unavailable or unsupported`,
        input.remediation,
      );
    }
    return {
      id: input.id,
      status: "ok",
      summary: `${input.label} ${parsed.join(".")}`,
    };
  } catch (error) {
    cancelled(error, signal);
    return failure(
      input.id,
      `${input.label} is unavailable or unsupported`,
      input.remediation,
    );
  }
}

async function workspaceCheck(
  cwd: string,
  signal: AbortSignal | undefined,
  runner: ProcessRunner,
): Promise<DoctorCheck> {
  try {
    const args = await safeGitArguments(cwd, [
      "rev-parse",
      "--is-inside-work-tree",
    ], signal, runner);
    const result = await runner("git", args, {
      cwd,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 5_000,
      maxOutputBytes: 4 * 1024,
      acceptableExitCodes: [0, 128],
    });
    if (result.exitCode === 0 && result.stdout.trim() === "true") {
      return {
        id: "workspace.git",
        status: "ok",
        summary: "workspace is a protected Git worktree",
      };
    }
  } catch (error) {
    cancelled(error, signal);
  }
  return {
    id: "workspace.git",
    status: "warning",
    summary: "workspace is not a supported Git worktree",
    remediation: "Run Recurs from a Git worktree for checkpoints, review, and team agents.",
  };
}

async function connectionCheck(
  inspect: NonNullable<DoctorOptions["inspectConnections"]>,
  signal: AbortSignal | undefined,
): Promise<DoctorCheck> {
  try {
    const registry = await inspect();
    if (signal?.aborted === true) {
      throw new DOMException("Doctor was cancelled", "AbortError");
    }
    const primary = registry.primaryConnectionId;
    const primaryExists = primary !== null &&
      registry.connections.some((connection) => connection.id === primary);
    if (primaryExists) {
      return {
        id: "provider.registry",
        status: "ok",
        summary: `${registry.connections.length} saved connection${registry.connections.length === 1 ? "" : "s"}; primary selected`,
      };
    }
    return {
      id: "provider.registry",
      status: "warning",
      summary: registry.connections.length === 0
        ? "no saved provider connection"
        : `${registry.connections.length} saved connection${registry.connections.length === 1 ? "" : "s"}; no primary selected`,
      remediation: "Run `recurs setup` or select an exact saved connection for a new run.",
    };
  } catch (error) {
    cancelled(error, signal);
    return failure(
      "provider.registry",
      "saved provider metadata is unreadable",
      "Inspect the private Recurs configuration and rerun `recurs doctor`.",
    );
  }
}

async function sandboxCheck(
  cwd: string,
  platform: NodeJS.Platform,
  signal: AbortSignal | undefined,
  runner: ProcessRunner,
): Promise<DoctorCheck> {
  if (platform !== "darwin" && platform !== "linux") {
    return failure(
      "sandbox.command",
      "OS-level command sandboxing is unavailable on this platform",
      "Use macOS or Linux for model-callable command execution.",
    );
  }
  try {
    const result = await runner(
      process.execPath,
      ["--input-type=module", "--eval", 'process.stdout.write("sandbox-ok")'],
      {
        cwd,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024,
        sandbox: { mode: "workspace", network: "deny" },
      },
    );
    if (result.stdout !== "sandbox-ok") {
      throw new ToolError("sandbox_unavailable", "Sandbox smoke returned invalid output");
    }
    return {
      id: "sandbox.command",
      status: "ok",
      summary: `${platform === "darwin" ? "Seatbelt" : "Bubblewrap"} workspace sandbox launched with network denied`,
    };
  } catch (error) {
    cancelled(error, signal);
    return failure(
      "sandbox.command",
      "OS-level command sandboxing failed its smoke test",
      platform === "linux"
        ? "Install system Bubblewrap and enable unprivileged user namespaces, then rerun `recurs doctor`."
        : "Verify `/usr/bin/sandbox-exec` is available, then rerun `recurs doctor`.",
    );
  }
}

export async function createDoctorReport(
  options: DoctorOptions,
): Promise<DoctorReport> {
  const runner = options.processRunner ?? runProcess;
  const signal = options.signal;
  if (signal?.aborted === true) {
    throw new DOMException("Doctor was cancelled", "AbortError");
  }

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeParts = versionParts(nodeVersion);
  const checks: DoctorCheck[] = [{
    id: "runtime.node",
    ...(nodeParts !== null && versionAtLeast(nodeParts, [22, 22, 0])
      ? {
          status: "ok" as const,
          summary: `Node.js ${nodeParts.join(".")}`,
        }
      : {
          status: "fail" as const,
          summary: "Node.js is unavailable or unsupported",
          remediation: "Install Node.js 22.22 or newer.",
        }),
  }];

  checks.push(await commandVersionCheck({
    id: "runtime.git",
    command: "git",
    args: ["--version"],
    label: "Git",
    minimum: [2, 45, 0],
    remediation: "Install Git 2.45 or newer.",
  }, options.cwd, signal, runner));
  checks.push(await commandVersionCheck({
    id: "runtime.ripgrep",
    command: "rg",
    args: ["--version"],
    label: "ripgrep",
    remediation: "Install ripgrep and ensure `rg` is on PATH.",
  }, options.cwd, signal, runner));
  checks.push(await workspaceCheck(options.cwd, signal, runner));

  const inspect = options.inspectConnections ?? (() =>
    new FileConnectionRegistry(options.dataDirectory).inspect());
  checks.push(await connectionCheck(inspect, signal));
  checks.push(await sandboxCheck(
    options.cwd,
    options.platform ?? process.platform,
    signal,
    runner,
  ));

  const recursVersion = options.recursVersion ?? RECURS_VERSION;
  checks.splice(1, 0, recursVersion === "development" || recursVersion === "0.0.0"
    ? {
        id: "installation.version",
        status: "warning",
        summary: `Recurs ${recursVersion} is an unreleased build`,
        remediation: "Use a versioned release artifact when one becomes available.",
      }
    : {
        id: "installation.version",
        status: "ok",
        summary: `Recurs ${recursVersion}`,
      });

  const overallStatus = checks.reduce<DoctorCheckStatus>(
    (current, check) =>
      STATUS_RANK[check.status] > STATUS_RANK[current] ? check.status : current,
    "ok",
  );
  return Object.freeze({
    schemaVersion: 1,
    type: "doctor_report",
    recursVersion,
    overallStatus,
    checks: Object.freeze(checks.map((check) => Object.freeze(check))),
  });
}

export function renderDoctorReport(report: DoctorReport): string {
  const marker = { ok: "[ok]", warning: "[!!]", fail: "[xx]" } as const;
  const lines = [
    `Recurs Doctor ${report.recursVersion}`,
    "",
    ...report.checks.flatMap((check) => [
      `${marker[check.status]} ${check.id}  ${check.summary}`,
      ...(check.remediation === undefined ? [] : [`     ${check.remediation}`]),
    ]),
  ];
  const counts = report.checks.reduce(
    (result, check) => ({ ...result, [check.status]: result[check.status] + 1 }),
    { ok: 0, warning: 0, fail: 0 },
  );
  lines.push(
    "",
    `${counts.ok} ok · ${counts.warning} warning · ${counts.fail} fail · ${report.overallStatus}`,
    "",
  );
  return lines.join("\n");
}
