import process from "node:process";

import {
  ToolError,
  type ProcessResult,
  type RunProcessOptions,
} from "@recurs/tools";
import { describe, expect, it } from "vitest";

import {
  createDoctorReport,
  renderDoctorReport,
} from "../src/doctor.js";

function result(stdout: string, exitCode = 0): ProcessResult {
  return { stdout, stderr: "", exitCode };
}

describe("doctor readiness", () => {
  it("reports a ready release without exposing paths or provider identity", async () => {
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly options: RunProcessOptions;
    }> = [];
    const report = await createDoctorReport({
      cwd: "/SECRET_WORKSPACE",
      dataDirectory: "/SECRET_RECURS_HOME",
      nodeVersion: "24.4.0",
      platform: "darwin",
      recursVersion: "0.1.0",
      inspectConnections: async () => ({
        primaryConnectionId: "SECRET_CONNECTION",
        connections: [{ id: "SECRET_CONNECTION" }],
      }),
      async processRunner(command, args, options) {
        calls.push({ command, args, options });
        if (command === "rg") return result("ripgrep 15.1.0\n");
        if (command === process.execPath) return result("sandbox-ok");
        if (args.includes("--get-regexp")) return result("", 1);
        if (args.includes("rev-parse")) return result("true\n");
        return result("git version 2.50.1\n");
      },
    });

    expect(report.overallStatus).toBe("ok");
    expect(report.checks).toHaveLength(7);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "provider.registry", status: "ok" }),
      expect.objectContaining({ id: "sandbox.command", status: "ok" }),
    ]));
    const sandbox = calls.find((call) => call.command === process.execPath);
    expect(sandbox?.options.sandbox).toEqual({
      mode: "workspace",
      network: "deny",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/SECRET_WORKSPACE|SECRET_RECURS_HOME|SECRET_CONNECTION/u);
    expect(renderDoctorReport(report)).toContain("7 ok · 0 warning · 0 fail · ok");
  });

  it("distinguishes actionable failures from optional setup warnings", async () => {
    const report = await createDoctorReport({
      cwd: "/workspace",
      dataDirectory: "/data",
      nodeVersion: "20.0.0",
      platform: "win32",
      recursVersion: "development",
      inspectConnections: async () => ({
        primaryConnectionId: null,
        connections: [],
      }),
      async processRunner() {
        throw new ToolError("process_failed", "SECRET_PROCESS_FAILURE");
      },
    });

    expect(report.overallStatus).toBe("fail");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "runtime.node", status: "fail" }),
      expect.objectContaining({ id: "installation.version", status: "warning" }),
      expect.objectContaining({ id: "runtime.git", status: "fail" }),
      expect.objectContaining({ id: "runtime.ripgrep", status: "fail" }),
      expect.objectContaining({ id: "workspace.git", status: "warning" }),
      expect.objectContaining({ id: "provider.registry", status: "warning" }),
      expect.objectContaining({ id: "sandbox.command", status: "fail" }),
    ]));
    expect(JSON.stringify(report)).not.toContain("SECRET_PROCESS_FAILURE");
  });

  it("fails closed on corrupt provider state and preserves cancellation", async () => {
    const healthyRunner = async (
      command: string,
      args: readonly string[],
      options: RunProcessOptions,
    ): Promise<ProcessResult> => {
      void options;
      if (command === "rg") return result("ripgrep 15.1.0\n");
      if (command === process.execPath) return result("sandbox-ok");
      if (args.includes("--get-regexp")) return result("", 1);
      if (args.includes("rev-parse")) return result("true\n");
      return result("git version 2.50.1\n");
    };
    const report = await createDoctorReport({
      cwd: "/workspace",
      dataDirectory: "/data",
      platform: "linux",
      recursVersion: "0.1.0",
      processRunner: healthyRunner,
      inspectConnections: async () => {
        throw new Error("SECRET_CORRUPTION_DETAIL");
      },
    });
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "provider.registry",
      status: "fail",
    }));
    expect(JSON.stringify(report)).not.toContain("SECRET_CORRUPTION_DETAIL");

    const controller = new AbortController();
    controller.abort();
    await expect(createDoctorReport({
      cwd: "/workspace",
      dataDirectory: "/data",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
