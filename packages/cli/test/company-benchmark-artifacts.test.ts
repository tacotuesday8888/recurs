import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { getCompanyBenchmarkScenario, materializeCompanyBenchmarkScenario } from "@recurs/core";
import { retainCompanyBenchmarkArtifacts } from "../src/company-benchmark-artifacts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("retains bounded declared files but excludes symlinks, missing files and undeclared data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-artifact-test-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const scenario = getCompanyBenchmarkScenario("options_precedence", 1);
  await materializeCompanyBenchmarkScenario(scenario, workspace);
  await writeFile(path.join(root, "outside.txt"), "outside sentinel");
  await rm(path.join(workspace, "src/options.js"));
  await symlink(path.join(root, "outside.txt"), path.join(workspace, "src/options.js"));
  await rm(path.join(workspace, "README.md"));
  await writeFile(path.join(workspace, "private-unlisted.txt"), "unlisted sentinel");
  const directory = await retainCompanyBenchmarkArtifacts({
    directory: path.join(root, "artifacts"), workspace, scenario,
    trial: null, campaignId: "test-campaign", slotId: "slot_1_single-strong",
  });
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  expect(manifest.trial).toBeNull();
  expect(manifest.files.find((file: { path: string }) => file.path === "src/options.js").status).toBe("not_bounded_regular_file");
  expect(manifest.files.find((file: { path: string }) => file.path === "README.md").status).toBe("unavailable");
  expect(await readdir(path.join(directory, "candidate"))).not.toContain("private-unlisted.txt");
  expect(await readFile(path.join(directory, "candidate/package.json"), "utf8")).toBe(scenario.files.find(file => file.path === "package.json")!.content);
  expect(await readFile(path.join(directory, "fixture/README.md"), "utf8")).toBe(scenario.files.find(file => file.path === "README.md")!.content);
  expect(await readFile(path.join(directory, "fixture/src/options.js"), "utf8")).toBe(scenario.files.find(file => file.path === "src/options.js")!.content);
  expect(manifest.teamDiagnostics).toEqual([]);
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
});

it("retains bounded structured findings while identifying unavailable staged code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-artifact-review-"));
  roots.push(root);
  const scenario = getCompanyBenchmarkScenario("queue_cancellation", 1);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await materializeCompanyBenchmarkScenario(scenario, workspace);
  const directory = await retainCompanyBenchmarkArtifacts({
    directory: path.join(root, "artifacts"), workspace, scenario,
    trial: null, campaignId: "test-campaign", slotId: "slot_1_company-auto",
    teamRuns: [{ descriptor: { id: "team-1" }, status: "failed", artifacts: [], reviews: [{
      round: 1, claimEpoch: 1, verdict: "changes_requested", evidence: ["Public test failed."],
      findings: [{ path: "src/queue.js", problem: "x".repeat(3000), acceptance: "Release the slot before resolving.", evidence: ["queue.stats()"] }],
    }] }],
  });
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  expect(manifest.teamDiagnostics[0]).toMatchObject({
    runId: "team-1", status: "failed", stagedCandidate: "not_retained", truncated: true,
    reviews: [{ verdict: "changes_requested", evidence: ["Public test failed."] }],
  });
  expect(manifest.teamDiagnostics[0].reviews[0].findings[0].problem).toHaveLength(2048);
  expect(manifest.teamDiagnostics[0].reviews[0].findings[0].acceptance).toBe("Release the slot before resolving.");
});
