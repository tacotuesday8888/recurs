import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Tool } from "../types.js";
import { ToolError } from "../types.js";
import {
  assertNonCredentialPath,
  isExternalPathApproved,
  pathPermissionIntents,
  WorkspacePathPolicy,
  type PathPolicyOptions,
} from "../path-policy.js";

const MAX_READ_BYTES = 256 * 1024;

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

function optionalPositiveInteger(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ToolError("invalid_input", `${name} must be a positive integer`);
  }
  return value as number;
}

function parseReadFileInput(value: unknown): ReadFileInput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("path" in value) ||
    typeof value.path !== "string"
  ) {
    throw new ToolError("invalid_input", "read_file requires a path");
  }
  const startLine = optionalPositiveInteger(
    "startLine" in value ? value.startLine : undefined,
    "startLine",
  );
  const endLine = optionalPositiveInteger(
    "endLine" in value ? value.endLine : undefined,
    "endLine",
  );
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new ToolError("invalid_input", "endLine must not precede startLine");
  }
  return {
    path: value.path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
}

export function createReadFileTool(
  options: PathPolicyOptions = {},
): Tool<ReadFileInput> {
  return {
    definition: {
      name: "read_file",
      description: "Read a bounded line range from a workspace file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    executionClass: "in_process",
    mutating: false,
    parallelSafe: true,
    parse: parseReadFileInput,
    permissions(input) {
      return pathPermissionIntents(
        "read",
        input.path,
        options.sensitivePatterns,
      );
    },
    async execute(input, context) {
      const resolved = await new WorkspacePathPolicy(
        context.cwd,
        options,
      ).resolveReadable(input.path, isExternalPathApproved(context, input.path));
      assertNonCredentialPath(resolved.relative);
      const bytes = await readFile(resolved.absolute);
      if (bytes.includes(0)) {
        throw new ToolError("invalid_input", `Cannot read binary file: ${input.path}`);
      }
      const content = bytes.toString("utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const lines = content.split("\n");
      if (lines.at(-1) === "") {
        lines.pop();
      }
      const startLine = input.startLine ?? 1;
      const endLine = Math.min(input.endLine ?? lines.length, lines.length);
      const selected = lines.slice(startLine - 1, endLine);
      const output = selected.length === 0 ? "" : `${selected.join("\n")}\n`;
      if (Buffer.byteLength(output, "utf8") > MAX_READ_BYTES) {
        throw new ToolError(
          "output_limit",
          `read_file output exceeds ${MAX_READ_BYTES} bytes; request a smaller line range`,
        );
      }
      context.readRevisions.set(resolved.absolute, sha256);
      return {
        output,
        metadata: {
          path: resolved.relative,
          sha256,
          startLine,
          endLine,
          totalLines: lines.length,
          sources: [
            `read ${resolved.relative}:${startLine}-${endLine} (sha256 ${sha256})`,
          ],
        },
      };
    },
  };
}
