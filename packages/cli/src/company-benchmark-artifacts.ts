import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CompanyBenchmarkTrialV1 } from "@recurs/contracts";
import type { CompanyBenchmarkScenario, TeamCandidateObservation, TeamRunState } from "@recurs/core";

export interface RetainedBenchmarkCandidate {
  readonly runId: string;
  readonly round: number;
  readonly phase: "implementation" | "repair";
  readonly artifactSha256: string;
  readonly directory: string;
}

/** Retain only declared fixture files, never the private runtime home or transcripts. */
export async function retainCompanyBenchmarkArtifacts(input: {
  readonly directory: string;
  readonly workspace: string;
  readonly scenario: CompanyBenchmarkScenario;
  readonly trial: CompanyBenchmarkTrialV1 | null;
  readonly campaignId: string;
  readonly slotId: string;
  readonly candidate?: Pick<TeamCandidateObservation, "runId" | "round" | "phase"> & { readonly artifactSha256: string };
  readonly stagedCandidates?: readonly RetainedBenchmarkCandidate[];
  readonly teamRuns?: readonly (Pick<TeamRunState, "status" | "reviews" | "artifacts"> & {
    readonly descriptor: Pick<TeamRunState["descriptor"], "id">;
  })[];
}): Promise<string> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const destination = await mkdtemp(path.join(input.directory, "trial-"));
  const workspace = await realpath(input.workspace);
  const files: { path: string; status: string; sha256?: string }[] = [];
  for (const fixture of input.scenario.files) {
    const fixtureTarget = path.join(destination, "fixture", fixture.path);
    await mkdir(path.dirname(fixtureTarget), { recursive: true, mode: 0o700 });
    await writeFile(fixtureTarget, fixture.content, { mode: 0o600, flag: "wx" });
    const source = path.join(workspace, fixture.path);
    try {
      const parent = await realpath(path.dirname(source));
      if (parent !== workspace && !parent.startsWith(workspace + path.sep)) {
        files.push({ path: fixture.path, status: "outside_workspace" });
        continue;
      }
      const stat = await lstat(source);
      if (!stat.isFile() || stat.size > 64 * 1024) {
        files.push({ path: fixture.path, status: "not_bounded_regular_file" });
        continue;
      }
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer;
      try {
        // Bound the read even if the file grows after lstat.
        const buffer = Buffer.alloc(64 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 64 * 1024) {
          files.push({ path: fixture.path, status: "too_large" });
          continue;
        }
        content = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      const target = path.join(destination, "candidate", fixture.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600, flag: "wx" });
      files.push({ path: fixture.path, status: "retained", sha256: createHash("sha256").update(content).digest("hex") });
    } catch {
      files.push({ path: fixture.path, status: "unavailable" });
    }
  }
  await writeFile(path.join(destination, "manifest.json"), JSON.stringify({
    version: 1,
    campaignId: input.campaignId,
    slotId: input.slotId,
    scenarioId: input.scenario.id,
    scenarioVersion: input.scenario.version,
    verifierId: input.scenario.verifierId,
    fixtureSha256: input.scenario.fixtureSha256,
    trial: input.trial,
    ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
    // Keep slot-level links even if an interrupted run has no final team state.
    ...(input.stagedCandidates === undefined ? {} : {
      stagedCandidates: input.stagedCandidates.slice(0, 32),
      stagedCandidatesTruncated: input.stagedCandidates.length > 32,
    }),
    files,
    // Structured review evidence only; never prompts, session records or raw transcripts.
    // Link only completed captures taken before staging cleanup.
    teamDiagnostics: (input.teamRuns ?? []).slice(0, 8).map((run) => ({
      runId: run.descriptor.id,
      status: run.status,
      reviews: run.reviews.slice(0, 8).map((review) => ({
        round: review.round,
        verdict: review.verdict,
        findings: review.findings.slice(0, 12).map((finding) => ({
          path: finding.path.slice(0, 256),
          problem: finding.problem.slice(0, 2048),
          acceptance: finding.acceptance.slice(0, 2048),
          evidence: finding.evidence.slice(0, 4).map((item) => item.slice(0, 1024)),
        })),
        evidence: review.evidence.slice(0, 4).map((item) => item.slice(0, 1024)),
      })),
      stagedCandidate: (input.stagedCandidates ?? []).some((candidate) => candidate.runId === run.descriptor.id) ? "retained" : "not_retained",
      ...(input.stagedCandidates === undefined ? {} : { stagedCandidates: input.stagedCandidates.filter((candidate) => candidate.runId === run.descriptor.id).slice(0, 32) }),
      artifactHashes: run.artifacts.slice(0, 32).map((artifact) => ({
        kind: artifact.kind, round: artifact.round, sha256: artifact.handle.sha256,
      })),
      truncated: run.reviews.length > 8 || run.artifacts.length > 32 || run.reviews.some((review) =>
        review.findings.length > 12 || review.evidence.length > 4 || review.evidence.some((item) => item.length > 1024) ||
        review.findings.some((finding) => finding.path.length > 256 || finding.problem.length > 2048 || finding.acceptance.length > 2048 || finding.evidence.length > 4 || finding.evidence.some((item) => item.length > 1024))),
    })),
    teamDiagnosticsTruncated: (input.teamRuns?.length ?? 0) > 8,
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return destination;
}
