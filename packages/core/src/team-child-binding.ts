import { createHash } from "node:crypto";

import type { AgentProfileId } from "@recurs/contracts";

export function teamChildAssignmentSha256(
  profileId: AgentProfileId,
  description: string,
  prompt: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([profileId, description, prompt]), "utf8")
    .digest("hex");
}
