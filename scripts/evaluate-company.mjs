#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  CompanyEvaluationArgumentError,
  parseCompanyEvaluationCommand,
  renderCompanyEvaluationScenarios,
  renderCompanyEvaluationReport,
  runCompanyEvaluationCommand,
  safeCliErrorMessage,
} from "../packages/cli/dist/index.js";

function usage() {
  return [
    "Usage: npm run eval:company -- --list [--json]",
    "       [--scenario company_formation_v1] [--json]",
    "       [--configured --allow-network] [--connection <id>] [--json]",
    "       --scenario company_goal_execution_v1 --run <id> [--json]",
    "       [--project <path>] [--recurs-home <path>]",
    "",
    "Offline mode is deterministic and performs no network requests.",
    "Configured mode uses one exact selected or primary direct/local connection.",
    "Stored goal evaluation is read-only and never contacts a provider.",
  ].join("\n");
}

function parseArguments(argv) {
  let projectRoot = process.cwd();
  let dataDirectory = process.env.RECURS_HOME ?? path.join(homedir(), ".recurs");
  const commandArguments = ["company"];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--project" || argument === "--recurs-home") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(usage());
      }
      if (argument === "--project") projectRoot = path.resolve(value);
      else dataDirectory = path.resolve(value);
      index += 1;
      continue;
    }
    commandArguments.push(argument);
  }
  return {
    help: false,
    options: parseCompanyEvaluationCommand(commandArguments),
    projectRoot,
    dataDirectory,
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.options.action === "list") {
    process.stdout.write(
      `${renderCompanyEvaluationScenarios(parsed.options.json)}\n`,
    );
    return;
  }
  const report = await runCompanyEvaluationCommand(parsed.options, {
    projectRoot: parsed.projectRoot,
    dataDirectory: parsed.dataDirectory,
    environment: process.env,
    ...(parsed.options.json
      ? {}
      : {
          onProgress(progress) {
            process.stderr.write(`${progress.message}\n`);
          },
        }),
  });
  process.stdout.write(parsed.options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${renderCompanyEvaluationReport(report)}\n`);
  if (report.status === "failed" || report.status === "cancelled") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof CompanyEvaluationArgumentError
    ? error.message
    : safeCliErrorMessage(error)}\n`);
  process.exitCode = 1;
});
