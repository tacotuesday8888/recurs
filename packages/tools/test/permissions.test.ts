import { describe, expect, it } from "vitest";

import {
  PermissionEngine,
  type PermissionIntent,
} from "../src/index.js";

const intents = {
  read: { category: "read", resource: "src/a.ts", risk: "normal" },
  write: { category: "write", resource: "src/a.ts", risk: "normal" },
  safeShell: { category: "shell", resource: "npm test", risk: "normal" },
  network: {
    category: "network",
    resource: "example.com",
    risk: "elevated",
  },
  sensitive: {
    category: "sensitive",
    resource: ".env",
    risk: "elevated",
  },
  destructive: {
    category: "shell",
    resource: "rm -rf .",
    risk: "destructive",
  },
} as const satisfies Record<string, PermissionIntent>;

describe("PermissionEngine", () => {
  it("implements Ask Always", () => {
    const engine = new PermissionEngine("ask_always");

    expect(engine.evaluate(intents.read)).toBe("allow");
    expect(engine.evaluate(intents.write)).toBe("ask");
    expect(engine.evaluate(intents.safeShell)).toBe("ask");
    expect(engine.evaluate(intents.sensitive)).toBe("ask");
    expect(engine.evaluate(intents.destructive)).toBe("ask");
  });

  it("implements Approved for Me", () => {
    const engine = new PermissionEngine("approved_for_me");

    expect(engine.evaluate(intents.read)).toBe("allow");
    expect(engine.evaluate(intents.write)).toBe("allow");
    expect(engine.evaluate(intents.safeShell)).toBe("ask");
    expect(engine.evaluate(intents.network)).toBe("ask");
    expect(engine.evaluate(intents.destructive)).toBe("ask");
  });

  it("implements Full Access without disabling integrity guards", () => {
    const engine = new PermissionEngine("full_access");

    expect(engine.evaluate(intents.destructive)).toBe("allow");
    expect(engine.evaluate(intents.network)).toBe("allow");
    expect(engine.integrityGuardsEnabled).toBe(true);
  });

  it("limits reusable grants to an exact session resource", () => {
    const engine = new PermissionEngine("ask_always");
    engine.grantForSession(intents.write);

    expect(engine.evaluate(intents.write)).toBe("allow");
    expect(
      engine.evaluate({ ...intents.write, resource: "src/other.ts" }),
    ).toBe("ask");
  });
});
