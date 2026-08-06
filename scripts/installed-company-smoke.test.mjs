import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPANY_CORRECT_SOURCE,
  COMPANY_FLAWED_SOURCE,
  COMPANY_SYNTHESIS_MARKER,
  createInstalledCompanyPromptDriver,
  createInstalledCompanyResponder,
  ptyExitSucceeded,
} from "./installed-company-smoke.mjs";

function request(messages, tools = []) {
  return {
    messages,
    tools: tools.map((name) => ({ function: { name } })),
  };
}

function text(response) {
  assert.equal(response.kind, "text");
  return response.text;
}

function tool(response) {
  assert.equal(response.kind, "tool");
  return response;
}

describe("installed company smoke responder", () => {
  it("forms a tailored company and emits the exact approved layered assignment path", () => {
    const responder = createInstalledCompanyResponder();
    const question = JSON.parse(text(responder.respond(request([
      { role: "system", content: "Recurs company formation" },
    ]))));
    assert.deepEqual(question, {
      kind: "question",
      id: "installed_outcome",
      question: "What outcome should this installed company own?",
    });

    const proposal = JSON.parse(text(responder.respond(request([
      { role: "system", content: "Recurs company formation" },
      { role: "user", content: "Ship the installed reviewed clamp fixture." },
    ]))));
    assert.equal(proposal.kind, "propose");
    assert.deepEqual(proposal.project, {
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
    });
    assert.equal(
      proposal.initialGoal,
      "Implement the safe clamp contract and pass its tests.",
    );

    const delegated = tool(responder.respond(request([
      {
        role: "system",
        content: "Coding-goal role path: top-level lead role-lead; nested implementation role-build is parented by that lead assignment; top-level review role-review depends on both assignments.",
      },
    ], ["delegate_company_goal"])));
    assert.equal(delegated.kind, "tool");
    assert.equal(delegated.id, "installed-delegate-company");
    assert.equal(delegated.name, "delegate_company_goal");
    assert.equal(
      delegated.arguments.objective,
      "Implement the safe clamp contract and pass its tests.",
    );
    assert.deepEqual(
      delegated.arguments.assignments.map((assignment) => ({
        id: assignment.id,
        roleId: assignment.roleId,
        parentAssignmentId: assignment.parentAssignmentId,
        dependsOn: assignment.dependsOn,
      })),
      [{
          id: "plan",
          roleId: "role-lead",
          parentAssignmentId: null,
          dependsOn: [],
        }, {
          id: "implement",
          roleId: "role-build",
          parentAssignmentId: "plan",
          dependsOn: [],
        }, {
          id: "review",
          roleId: "role-review",
          parentAssignmentId: null,
          dependsOn: ["plan", "implement"],
      }],
    );
  });

  it("drives implementation through independent change request, repair, approval, and synthesis", () => {
    const responder = createInstalledCompanyResponder();
    const lead = `Company goal: Implement the safe clamp contract and pass its tests.`;
    assert.equal(tool(responder.respond(request([
      { role: "system", content: lead },
    ]))).name, "read_file");
    assert.equal(text(responder.respond(request([
      { role: "system", content: lead },
      { role: "tool", content: '{"name":"recurs-installed-company"}' },
    ]))), "Planned the one-file clamp boundary for the implementation handoff.");

    const implement = "You are a Recurs Implement agent";
    assert.equal(tool(responder.respond(request([
      { role: "system", content: implement },
    ]))).name, "read_file");
    assert.ok(tool(responder.respond(request([
      { role: "system", content: implement },
      { role: "tool", content: "initial clamp fixture" },
    ]))).arguments.patch.includes("+  return Math.min(max, value);"));
    assert.deepEqual(tool(responder.respond(request([
      { role: "system", content: implement },
      { role: "tool", content: "initial clamp fixture" },
      { role: "tool", content: "Patch applied" },
    ]))), {
      kind: "tool",
      id: "installed-implement-test",
      name: "run_verification",
      arguments: { command: "npm test", timeoutMs: 10_000 },
    });

    const review = "You are a Recurs Review agent";
    assert.equal(tool(responder.respond(request([
      { role: "system", content: review },
    ]))).name, "read_file");
    const requested = JSON.parse(text(responder.respond(request([
      { role: "system", content: review },
      { role: "tool", content: COMPANY_FLAWED_SOURCE },
    ]))));
    assert.equal(requested.verdict, "request_changes");
    assert.equal(requested.findings[0]?.path, "src/clamp.js");

    const repair = "You are a Recurs Repair agent";
    assert.ok(tool(responder.respond(request([
      { role: "system", content: repair },
      { role: "tool", content: COMPANY_FLAWED_SOURCE },
    ]))).arguments.patch.includes(
      "+  return Math.min(max, Math.max(min, value));",
    ));
    const approved = JSON.parse(text(responder.respond(request([
      { role: "system", content: review },
      { role: "tool", content: COMPANY_CORRECT_SOURCE },
    ]))));
    assert.deepEqual(approved, {
      verdict: "approve",
      summary: "The repaired clamp implementation satisfies both bounds.",
      findings: [],
      evidence: ["Inspected the complete repaired staged candidate."],
    });

    assert.equal(text(responder.respond(request([
      { role: "system", content: "parent" },
      { role: "tool", content: "Company goal completed" },
    ], ["delegate_company_goal"]))), COMPANY_SYNTHESIS_MARKER);
  });
});

describe("installed company prompt driver", () => {
  it("answers only the ordered onboarding and explicit-apply prompts", () => {
    const writes = [];
    const driver = createInstalledCompanyPromptDriver({
      connectionId: "local-account-1",
      write(value) { writes.push(value); },
    });
    const prompts = [
      "This unrelated output must not receive input.",
      "Choose a saved, detected, or recommended model connection:",
      "Choose how much Recurs may do without asking:",
      "Choose how much agent teamwork Recurs should use:",
      "Choose the team-control detail:",
      "Tailor the first Recurs agent company to this project:",
      "How deeply should Recurs understand the project before proposing your company?:",
      "How should Recurs form the company?:",
      "Allow company formation to inspect this project read-only",
      "What outcome should this installed company own?:",
      "Review the proposed agent company:",
      "Give the new agent team project context:",
      "recurs ›",
      "Allow write access to team candidate apply?",
      "Allow shell access to fixed Git worktree orchestration?",
      "Allow shell access to npm test?",
      COMPANY_SYNTHESIS_MARKER,
      "recurs ›",
      "approved | apply | round 1 | 3/3 children | team-run-123",
      "recurs ›",
    ];
    const synthesisIndex = prompts.indexOf(COMPANY_SYNTHESIS_MARKER);
    for (const prompt of prompts.slice(0, synthesisIndex + 1)) {
      driver.push(prompt);
    }
    assert.equal(writes.includes("/agents teams\r"), false);
    for (const prompt of prompts.slice(synthesisIndex + 1)) {
      driver.push(prompt);
    }

    assert.deepEqual(writes, [
      "local-account-1\r",
      "approved_for_me\r",
      "balanced_v6\r",
      "recommended\r",
      "create\r",
      "quick\r",
      "stable_core_specialists\r",
      "y\r",
      "Ship the installed reviewed clamp fixture.\r",
      "approve\r",
      "skip\r",
      "/goal launch\r",
      "a\r",
      "a\r",
      "a\r",
      "/agents teams\r",
      "/quit\r",
    ]);
    assert.deepEqual(driver.result(), {
      applied: true,
      companyGoalLaunched: true,
      teamRunId: "team-run-123",
    });
  });

  it("accepts clean PTY exits when the platform omits the signal", () => {
    assert.equal(ptyExitSucceeded({ exitCode: 0 }), true);
    assert.equal(ptyExitSucceeded({ exitCode: 0, signal: 0 }), true);
    assert.equal(ptyExitSucceeded({ exitCode: 1 }), false);
    assert.equal(ptyExitSucceeded({ exitCode: 0, signal: 15 }), false);
  });
});
