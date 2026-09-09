import { createHash } from "node:crypto";
import path from "node:path";

import { fetchPublicWeb } from "@recurs/tools";

export interface DownloadedSkillBundle {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly provenance: { readonly repository: string; readonly requestedRef: string; readonly commit: string; readonly path: string };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

/** Fetch Git objects without running a repository's hooks, filters, or scripts. */
export async function downloadGithubSkill(source: string, fetch = fetchPublicWeb): Promise<DownloadedSkillBundle> {
  const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([^:]+):(.+)$/u.exec(source);
  if (!match) throw new Error("Use github:OWNER/REPO@REF:PATH with an explicit ref and skill directory");
  const owner = match[1]!, repo = match[2]!, ref = match[3]!, directory = match[4]!;
  if (ref.length > 256 || directory.length > 1024 || directory.split("/").some((part) =>
    part.length === 0 || part === "." || part === ".." || /[\\\p{Cc}\p{Cf}]/u.test(part))) {
    throw new Error("GitHub skill source contains an invalid ref or path");
  }
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const signal = AbortSignal.timeout(60_000);
  let requests = 0;
  async function get(endpoint: string): Promise<unknown> {
    if (++requests > 128) throw new Error("Skill download exceeds the 128-request limit");
    const response = await fetch(`${base}/${endpoint}`, {
      signal, timeoutMs: 15_000, maxResponseBytes: 1024 * 1024, maxRedirects: 0,
    });
    if (response.status !== 200) throw new Error(`GitHub skill source returned HTTP ${response.status}. Check the repository/ref/path and public API rate limit.`);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as unknown;
  }
  const commit = await get(`commits/${encodeURIComponent(ref)}`);
  if (!object(commit) || !sha(commit.sha) || !object(commit.commit) || !object(commit.commit.tree) || !sha(commit.commit.tree.sha)) {
    throw new Error("GitHub returned invalid commit metadata");
  }
  interface TreeEntry { path: string; mode: string; type: string; sha: string }
  async function tree(id: string): Promise<TreeEntry[]> {
    const response = await get(`git/trees/${id}`);
    if (!object(response) || response.sha !== id || response.truncated === true || !Array.isArray(response.tree)) {
      throw new Error("GitHub returned an incomplete skill tree");
    }
    return response.tree.map((entry: unknown) => {
      if (!object(entry) || typeof entry.path !== "string" || entry.path === "." || entry.path === ".." ||
          entry.path.length === 0 || (entry.path.includes("/") || /[\\\p{Cc}\p{Cf}]/u.test(entry.path)) ||
          typeof entry.mode !== "string" || typeof entry.type !== "string" || !sha(entry.sha)) {
        throw new Error("GitHub returned an invalid tree entry");
      }
      return { path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha };
    });
  }
  let current = commit.commit.tree.sha;
  for (const segment of directory.split("/")) {
    const entry = (await tree(current)).find((candidate) => candidate.path === segment);
    if (!entry || entry.type !== "tree" || entry.mode !== "040000") throw new Error("Selected GitHub skill directory does not exist or is not a directory");
    current = entry.sha;
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  async function visit(id: string, prefix: string, depth: number): Promise<void> {
    if (depth > 3) throw new Error("Skill bundle exceeds the directory depth limit");
    for (const entry of await tree(id)) {
      const relative = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === "tree" && entry.mode === "040000") await visit(entry.sha, relative, depth + 1);
      else if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) {
        if (files.size >= 65) throw new Error("Skill bundle exceeds the 65-file limit");
        const blob = await get(`git/blobs/${entry.sha}`);
        if (!object(blob) || blob.sha !== entry.sha || blob.encoding !== "base64" || typeof blob.content !== "string" || typeof blob.size !== "number") {
          throw new Error("GitHub returned invalid blob content");
        }
        const maximum = relative === "SKILL.md" ? 128 * 1024 : 256 * 1024;
        const bytes = Buffer.from(blob.content, "base64");
        if (bytes.length !== blob.size || bytes.length > maximum) throw new Error("Skill source file exceeds the size limit or is incomplete");
        const digest = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (digest !== entry.sha) throw new Error("Skill source blob does not match its Git object identity");
        total += bytes.length;
        if (total > 8 * 1024 * 1024) throw new Error("Skill bundle exceeds the 8 MiB limit");
        files.set(relative, bytes);
      } else throw new Error("Skill bundle contains a symlink, submodule, or unsupported Git object");
    }
  }
  await visit(current, "", 1);
  if (!files.has("SKILL.md")) throw new Error("Selected directory does not contain SKILL.md");
  return { files, provenance: { repository: `${owner}/${repo}`, requestedRef: ref, commit: commit.sha, path: path.posix.normalize(directory) } };
}
