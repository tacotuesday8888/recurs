import type { PtyDriver } from "@recurs/tools";
import type { spawn as spawnPty } from "@lydell/node-pty";

interface NodePtyModule {
  readonly spawn: typeof spawnPty;
}

export async function loadPtyDriver(
  load: () => Promise<NodePtyModule> = () => import("@lydell/node-pty"),
): Promise<PtyDriver | undefined> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return undefined;
  }
  try {
    const nodePty = await load();
    if (typeof nodePty.spawn !== "function") return undefined;
    return {
      spawn(file, args, options) {
        return nodePty.spawn(file, [...args], {
          name: options.name,
          cols: options.columns,
          rows: options.rows,
          cwd: options.cwd,
          env: { ...options.env },
        });
      },
    };
  } catch {
    return undefined;
  }
}
