import { stat } from "node:fs/promises";

import {
  assertNonCredentialPath,
  pathPermissionIntents,
  WorkspacePathPolicy,
  type PathPolicyOptions,
} from "../path-policy.js";
import { runProcess } from "../process.js";
import { resolveTypeScriptCompilerPath } from "../typescript-compiler-path.js";
import { ToolError, type Tool } from "../types.js";

const DEFAULT_PROJECT = "tsconfig.json";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TYPESCRIPT_EXIT_CODES = [0, 1, 2] as const;

export interface TypeScriptDiagnosticsInput {
  readonly project: string;
  readonly timeoutMs: number;
}

function parseInput(value: unknown): TypeScriptDiagnosticsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError(
      "invalid_input",
      "typescript_diagnostics requires an object",
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "project" && key !== "timeoutMs")) {
    throw new ToolError(
      "invalid_input",
      "typescript_diagnostics received an unknown option",
    );
  }
  const project = record.project ?? DEFAULT_PROJECT;
  const timeoutMs = record.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof project !== "string" || project.trim().length === 0) {
    throw new ToolError("invalid_input", "project must be a non-empty path");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < 1 ||
    (timeoutMs as number) > MAX_TIMEOUT_MS
  ) {
    throw new ToolError(
      "invalid_input",
      `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return { project: project.trim(), timeoutMs: timeoutMs as number };
}

function compilerPath(): string {
  const resolved = resolveTypeScriptCompilerPath();
  if (resolved !== undefined) return resolved;
  throw new ToolError(
    "tool_unavailable",
    "The bundled TypeScript compiler is unavailable",
  );
}

function diagnosticCount(output: string): number {
  return [...output.matchAll(/\berror TS\d+:/gu)].length;
}

export function createTypeScriptDiagnosticsTool(
  options: PathPolicyOptions = {},
): Tool<TypeScriptDiagnosticsInput> {
  return {
    definition: {
      name: "typescript_diagnostics",
      description:
        "Type-check a workspace TypeScript project without emitting files or running a shell",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Workspace-relative tsconfig path (defaults to tsconfig.json)",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: MAX_TIMEOUT_MS,
          },
        },
        additionalProperties: false,
      },
    },
    executionClass: "fixed_process",
    mutating: false,
    available() {
      return resolveTypeScriptCompilerPath() !== undefined;
    },
    parse: parseInput,
    permissions(input) {
      return pathPermissionIntents("read", input.project, options.sensitivePatterns);
    },
    async execute(input, context) {
      const resolved = await new WorkspacePathPolicy(context.cwd, options)
        .resolveReadable(input.project);
      assertNonCredentialPath(resolved.relative);
      const projectStat = await stat(resolved.absolute);
      if (!projectStat.isFile()) {
        throw new ToolError(
          "invalid_input",
          `TypeScript project is not a file: ${input.project}`,
        );
      }

      const result = await runProcess(
        process.execPath,
        [
          compilerPath(),
          "--project",
          resolved.absolute,
          "--pretty",
          "false",
          "--noEmit",
          "--tsBuildInfoFile",
          process.platform === "win32" ? "NUL" : "/dev/null",
        ],
        {
          cwd: context.cwd,
          signal: context.signal,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          acceptableExitCodes: TYPESCRIPT_EXIT_CODES,
          ...(context.processSandbox === undefined
            ? {}
            : { sandbox: context.processSandbox }),
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      const count = diagnosticCount(output);
      const clean = result.exitCode === 0;
      return {
        output: clean
          ? `No TypeScript diagnostics in ${resolved.relative}.\n`
          : output,
        metadata: {
          project: resolved.relative,
          status: clean ? "clean" : "issues",
          diagnosticCount: count,
          exitCode: result.exitCode,
          evidence: [
            clean
              ? `${resolved.relative} type-check passed without emit`
              : `${resolved.relative} reported ${count} TypeScript diagnostic${count === 1 ? "" : "s"}`,
          ],
        },
      };
    },
  };
}
