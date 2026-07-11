import type { RuntimeContinuationHandle } from "@recurs/contracts";

export function restoredRuntimePredecessor(
  predecessor: RuntimeContinuationHandle | null,
  successor: RuntimeContinuationHandle,
): RuntimeContinuationHandle | null {
  if (
    predecessor === null ||
    predecessor.storageClass !== "process_scoped" ||
    successor.storageClass !== "process_scoped" ||
    predecessor.ownerInstanceId !== successor.ownerInstanceId ||
    predecessor.expiresAt === undefined ||
    successor.expiresAt === undefined ||
    Date.parse(successor.expiresAt) <= Date.parse(predecessor.expiresAt)
  ) {
    return predecessor;
  }
  return { ...predecessor, expiresAt: successor.expiresAt };
}
