import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CompanyBenchmarkTrialV1 } from "@recurs/contracts";
import type { CompanyBenchmarkScenario } from "@recurs/core";

/** Retain only declared fixture files, never the private runtime home or transcripts. */
export async function retainCompanyBenchmarkArtifacts(input: {
  readonly directory: string;
  readonly workspace: string;
  readonly scenario: CompanyBenchmarkScenario;
  readonly trial: CompanyBenchmarkTrialV1 | null;
  readonly campaignId: string;
  readonly slotId: string;
}): Promise<string> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const destination = await mkdtemp(path.join(input.directory, "trial-"));
  const workspace = await realpath(input.workspace);
  const files: { path: string; status: string; sha256?: string }[] = [];
  for (const fixture of input.scenario.files) {
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
      for (const [kind, bytes] of [["candidate", content], ["fixture", fixture.content]] as const) {
        const target = path.join(destination, kind, fixture.path);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
      }
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
    fixtureSha256: input.scenario.fixtureSha256,
    trial: input.trial,
    files,
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return destination;
}
