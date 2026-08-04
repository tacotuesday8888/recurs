import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export class PrivateUserConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrivateUserConfigurationError";
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

export async function readPrivateUserConfiguration(input: {
  readonly dataDirectory: string;
  readonly filename: string;
  readonly label: string;
  readonly maximumBytes: number;
}): Promise<string | null> {
  const file = path.join(input.dataDirectory, "config", input.filename);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PrivateUserConfigurationError(
      `${input.label} could not be inspected safely`,
      { cause: error },
    );
  }
  const directory = path.dirname(file);
  let directoryDetails: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryDetails = await lstat(directory);
  } catch (error) {
    throw new PrivateUserConfigurationError(
      `${input.label} directory could not be inspected safely`,
      { cause: error },
    );
  }
  const privateDirectory = process.platform === "win32" ||
    (directoryDetails.mode & 0o077) === 0;
  const directoryOwned = typeof process.getuid !== "function" ||
    directoryDetails.uid === process.getuid();
  if (
    !directoryDetails.isDirectory() || directoryDetails.isSymbolicLink() ||
    !privateDirectory || !directoryOwned ||
    await realpath(directory) !== path.resolve(directory)
  ) {
    throw new PrivateUserConfigurationError(
      `${input.label} directory must be private, owned, and canonical`,
    );
  }
  const privateMode = process.platform === "win32" || (before.mode & 0o077) === 0;
  const owned = typeof process.getuid !== "function" || before.uid === process.getuid();
  if (
    !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
    !privateMode || !owned || before.size <= 0 || before.size > input.maximumBytes
  ) {
    throw new PrivateUserConfigurationError(
      `${input.label} must be a private, owned, single-link regular file`,
    );
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!sameFile(before, opened)) {
      throw new PrivateUserConfigurationError(
        `${input.label} changed while it was opened`,
      );
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await lstat(file);
    if (!sameFile(before, after)) {
      throw new PrivateUserConfigurationError(
        `${input.label} changed while it was read`,
      );
    }
    return contents;
  } catch (error) {
    if (error instanceof PrivateUserConfigurationError) throw error;
    throw new PrivateUserConfigurationError(
      `${input.label} could not be read safely`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}
