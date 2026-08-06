export const COMPANY_INITIAL_SOURCE = `
export function clamp(value, min, max) {
  throw new Error("not implemented");
}
`.trimStart();

export const COMPANY_FLAWED_SOURCE = `
export function clamp(value, min, max) {
  return Math.min(max, value);
}
`.trimStart();

export const COMPANY_CORRECT_SOURCE = `
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
`.trimStart();

export const COMPANY_SYNTHESIS_MARKER =
  "RECURS_INSTALLED_COMPANY_SYNTHESIS_OK";
export const COMPANY_APPLIED_MARKER = "Company goal completed";

const COMPANY_GOAL = "Implement the safe clamp contract and pass its tests.";
const COMPANY_INTERVIEW_ANSWER = "Ship the installed reviewed clamp fixture.";

function requestContext(request) {
  return (request.messages ?? []).map((message) =>
    typeof message?.content === "string"
      ? message.content
      : JSON.stringify(message?.content ?? null)
  ).join("\n");
}

function replacePatch(path, before, after) {
  const oldLines = before.trimEnd().split("\n");
  const newLines = after.trimEnd().split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function toolNames(request) {
  return new Set((request.tools ?? []).map((tool) =>
    tool?.function?.name ?? tool?.name
  ).filter((name) => typeof name === "string"));
}

function toolMessages(request) {
  return (request.messages ?? []).filter((message) => message?.role === "tool");
}

function text(text_) {
  return { kind: "text", text: text_ };
}

function tool(id, name, arguments_) {
  return { kind: "tool", id, name, arguments: arguments_ };
}

function proposal() {
  return {
    kind: "propose",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Ship the installed company journey through one reviewed patch.",
      users: ["Recurs maintainers"],
      successCriteria: ["The reviewed clamp patch passes its installed fixture test."],
      constraints: ["Never widen child authority or apply unreviewed work."],
      risks: ["A one-sided clamp can silently accept values below the lower bound."],
      architecturePreferences: ["Use the existing durable company runtime."],
      deploymentTargets: ["Recurs CLI"],
      repository: { inspected: false, markers: [], evidence: [] },
    },
    initialGoal: COMPANY_GOAL,
    roadmap: ["Deliver one independently reviewed and explicitly applied patch."],
  };
}

function companyAssignments(context) {
  const layered =
    /top-level lead (\S+); nested implementation (\S+) is parented by that lead assignment; top-level review (\S+) depends on both assignments\./u
      .exec(context);
  if (layered !== null) {
    const [, leadRoleId, implementationRoleId, reviewRoleId] = layered;
    return [{
      id: "plan",
      roleId: leadRoleId,
      parentAssignmentId: null,
      dependsOn: [],
      description: "Plan the bounded clamp repair",
      prompt: "Confirm the one-file implementation boundary and hand it to the builder.",
      acceptance: ["Name src/clamp.js as the only implementation file."],
    }, {
      id: "implement",
      roleId: implementationRoleId,
      parentAssignmentId: "plan",
      dependsOn: [],
      description: "Implement and verify the clamp contract",
      prompt: "Implement both clamp bounds in src/clamp.js and run the fixture test.",
      acceptance: ["node --test passes for the clamp fixture."],
    }, {
      id: "review",
      roleId: reviewRoleId,
      parentAssignmentId: null,
      dependsOn: ["plan", "implement"],
      description: "Independently review the staged clamp candidate",
      prompt: "Inspect the full staged candidate, request any concrete repair, and approve only the correct two-sided clamp.",
      acceptance: ["Both lower and upper bounds are independently verified."],
    }];
  }
  const direct =
    /top-level implementation (\S+); top-level review (\S+) depends on it\./u
      .exec(context);
  if (direct === null) {
    throw new Error("The installed company prompt did not expose a supported role path.");
  }
  const [, implementationRoleId, reviewRoleId] = direct;
  return [{
    id: "implement",
    roleId: implementationRoleId,
    parentAssignmentId: null,
    dependsOn: [],
    description: "Implement and verify the clamp contract",
    prompt: "Implement both clamp bounds in src/clamp.js and run the fixture test.",
    acceptance: ["node --test passes for the clamp fixture."],
  }, {
    id: "review",
    roleId: reviewRoleId,
    parentAssignmentId: null,
    dependsOn: ["implement"],
    description: "Independently review the staged clamp candidate",
    prompt: "Inspect the full staged candidate, request any concrete repair, and approve only the correct two-sided clamp.",
    acceptance: ["Both lower and upper bounds are independently verified."],
  }];
}

export function createInstalledCompanyResponder() {
  return {
    respond(request) {
      const context = requestContext(request);
      const tools = toolNames(request);
      const results = toolMessages(request);

      if (
        context.includes("Recurs company-formation interviewer") ||
        context.includes("Recurs company formation")
      ) {
        return text(JSON.stringify(context.includes(COMPANY_INTERVIEW_ANSWER)
          ? proposal()
          : {
              kind: "question",
              id: "installed_outcome",
              question: "What outcome should this installed company own?",
            }));
      }

      if (tools.has("delegate_company_goal")) {
        if (results.length > 0) return text(COMPANY_SYNTHESIS_MARKER);
        return tool(
          "installed-delegate-company",
          "delegate_company_goal",
          { objective: COMPANY_GOAL, assignments: companyAssignments(context) },
        );
      }

      if (context.includes("Recurs Review agent")) {
        if (results.length === 0) {
          return tool("installed-review-read", "read_file", {
            path: "src/clamp.js",
          });
        }
        return text(JSON.stringify(context.includes(COMPANY_CORRECT_SOURCE.trim())
          ? {
              verdict: "approve",
              summary: "The repaired clamp implementation satisfies both bounds.",
              findings: [],
              evidence: ["Inspected the complete repaired staged candidate."],
            }
          : {
              verdict: "request_changes",
              summary: "The candidate enforces only the upper bound.",
              findings: [{
                path: "src/clamp.js",
                problem: "Values below min are returned unchanged.",
                acceptance: "Clamp values to both min and max.",
                evidence: ["The staged implementation calls Math.min but not Math.max."],
              }],
              evidence: ["Inspected the complete staged candidate."],
            }));
      }

      if (context.includes("Recurs Repair agent")) {
        if (results.length === 0) {
          return tool("installed-repair-read", "read_file", {
            path: "src/clamp.js",
          });
        }
        if (results.length === 1) {
          return tool("installed-repair-patch", "apply_patch", {
            patch: replacePatch(
              "src/clamp.js",
              COMPANY_FLAWED_SOURCE,
              COMPANY_CORRECT_SOURCE,
            ),
            files: [{ path: "src/clamp.js", expected_hash: "observed" }],
          });
        }
        if (results.length === 2) {
          return tool("installed-repair-test", "run_verification", {
            command: "npm test",
            timeoutMs: 10_000,
          });
        }
        return text("Repaired the lower bound and verified the complete clamp fixture.");
      }

      if (context.includes("Recurs Implement agent")) {
        if (results.length === 0) {
          return tool("installed-implement-read", "read_file", {
            path: "src/clamp.js",
          });
        }
        if (results.length === 1) {
          return tool("installed-implement-patch", "apply_patch", {
            patch: replacePatch(
              "src/clamp.js",
              COMPANY_INITIAL_SOURCE,
              COMPANY_FLAWED_SOURCE,
            ),
            files: [{ path: "src/clamp.js", expected_hash: "observed" }],
          });
        }
        if (results.length === 2) {
          return tool("installed-implement-test", "run_verification", {
            command: "npm test",
            timeoutMs: 10_000,
          });
        }
        return text("Implemented the bounded clamp candidate and returned test evidence.");
      }

      if (context.includes(`Company goal: ${COMPANY_GOAL}`)) {
        if (results.length === 0) {
          return tool("installed-lead-read", "read_file", {
            path: "package.json",
          });
        }
        return text("Planned the one-file clamp boundary for the implementation handoff.");
      }

      throw new Error("The installed company responder received an unknown request.");
    },
  };
}

export function isInstalledCompanyRequest(request) {
  const context = requestContext(request);
  const tools = toolNames(request);
  return context.includes("Recurs company-formation interviewer") ||
    tools.has("delegate_company_goal") ||
    context.includes(
      "You are a Recurs Implement agent assigned to one bounded staged code change.",
    ) ||
    context.includes(
      "You are a Recurs Review agent assigned to one bounded staged-change review.",
    ) ||
    context.includes(
      "You are a Recurs Repair agent assigned to one bounded staged repair.",
    ) || context.includes(`Company goal: ${COMPANY_GOAL}`);
}

function terminalText(value) {
  return value
    // ANSI control sequences are removed before prompt matching and assertions.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll("\r", "");
}

export function createInstalledCompanyPromptDriver({ connectionId, write }) {
  const onboarding = [
    ["Choose a saved, detected, or recommended model connection:", connectionId],
    ["Choose how much Recurs may do without asking:", "approved_for_me"],
    ["Choose how much agent teamwork Recurs should use:", "balanced_v6"],
    ["Choose the team-control detail:", "recommended"],
    ["Tailor the first Recurs agent company to this project:", "create"],
    ["How deeply should Recurs understand the project before proposing your company?:", "quick"],
    ["How should Recurs form the company?:", "stable_core_specialists"],
    ["Allow company formation to inspect this project read-only", "y"],
    ["What outcome should this installed company own?:", COMPANY_INTERVIEW_ANSWER],
    ["Review the proposed agent company:", "approve"],
    ["Give the new agent team project context:", "skip"],
    ["recurs ›", "/goal launch"],
  ];
  let buffer = "";
  let onboardingIndex = 0;
  let companyGoalLaunched = false;
  let synthesisSeen = false;
  let teamsRequested = false;
  let teamRunId = null;
  let teamApplyAuthorityApproved = false;
  let applied = false;
  let quitSent = false;

  const send = (answer) => write(`${answer}\r`);
  const consume = (marker) => {
    const index = buffer.indexOf(marker);
    if (index < 0) return false;
    buffer = buffer.slice(index + marker.length);
    return true;
  };

  const push = (output) => {
    buffer = `${buffer}${terminalText(output)}`.slice(-1024 * 1024);
    while (onboardingIndex < onboarding.length) {
      const [marker, answer] = onboarding[onboardingIndex];
      if (!consume(marker)) return;
      onboardingIndex += 1;
      send(answer);
      if (answer === "/goal launch") companyGoalLaunched = true;
    }

    for (const resource of [
      "fixed Git worktree orchestration",
      "npm test",
    ]) {
      const marker = `Allow shell access to ${resource}?`;
      if (consume(marker)) send("a");
    }
    if (consume("Allow write access to team candidate apply?")) {
      teamApplyAuthorityApproved = true;
      send("a");
    }

    if (!synthesisSeen && consume(COMPANY_SYNTHESIS_MARKER)) {
      synthesisSeen = true;
    }
    if (synthesisSeen && !teamsRequested && consume("recurs ›")) {
      teamsRequested = true;
      send("/agents teams");
    }
    if (teamsRequested && teamRunId === null) {
      const match = /(approved|completed)\s+\|[^\n]*\|\s+([a-z0-9][a-z0-9_-]{5,})\s*(?:\n|$)/iu.exec(buffer);
      if (match !== null) {
        teamRunId = match[2];
        applied = match[1]?.toLowerCase() === "approved" &&
          teamApplyAuthorityApproved;
        buffer = buffer.slice((match.index ?? 0) + match[0].length);
      }
    }
    if (applied && !quitSent && consume("recurs ›")) {
      quitSent = true;
      send("/quit");
    }
  };

  return {
    push,
    result() {
      return { applied, companyGoalLaunched, teamRunId };
    },
  };
}

export function ptyExitSucceeded(status) {
  return status.exitCode === 0 && (status.signal ?? 0) === 0;
}

export async function runInstalledCompanyJourney({
  executable,
  environment,
  workspaceDirectory,
  connectionId,
  timeoutMs = 120_000,
}) {
  const { spawn } = await import("@lydell/node-pty");
  const transcript = [];
  let transcriptBytes = 0;
  let terminal;
  const driver = createInstalledCompanyPromptDriver({
    connectionId,
    write(value) { terminal.write(value); },
  });
  terminal = spawn(executable, ["setup"], {
    cwd: workspaceDirectory,
    cols: 100,
    rows: 30,
    env: Object.fromEntries(Object.entries({
      ...environment,
      NO_COLOR: "1",
      RECURS_NO_TUI: "1",
      TERM: "xterm-256color",
    }).filter(([, value]) => typeof value === "string")),
  });
  const exited = new Promise((resolve) => {
    terminal.onExit(resolve);
  });
  terminal.onData((chunk) => {
    transcriptBytes += Buffer.byteLength(chunk, "utf8");
    if (transcriptBytes > 8 * 1024 * 1024) {
      terminal.kill();
      return;
    }
    transcript.push(chunk);
    driver.push(chunk);
  });
  let timer;
  const status = await Promise.race([
    exited,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        terminal.kill();
        reject(new Error([
          `Installed company journey exceeded ${timeoutMs}ms.`,
          `State: ${JSON.stringify(driver.result())}`,
          "Transcript tail:",
          terminalText(transcript.join("")).slice(-8_000),
        ].join("\n")));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (transcriptBytes > 8 * 1024 * 1024) {
    throw new Error("The installed company journey exceeded its output limit.");
  }
  if (!ptyExitSucceeded(status)) {
    throw new Error([
      `The installed company journey exited unexpectedly: ${JSON.stringify(status)}`,
      `State: ${JSON.stringify(driver.result())}`,
      "Transcript tail:",
      terminalText(transcript.join("")).slice(-8_000),
    ].join("\n"));
  }
  return {
    ...driver.result(),
    transcript: terminalText(transcript.join("")),
  };
}
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
