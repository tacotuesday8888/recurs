import { describe, expect, it } from "vitest";

import { parseCliHelpRequest } from "../src/cli-help.js";

describe("CLI help", () => {
  it("gives interrupted users an exact, safe recovery path", () => {
    const request = parseCliHelpRequest(["help", "recovery"]);

    expect(request).toMatchObject({ valid: true });
    if (request?.valid !== true) throw new Error("Expected recovery help");
    expect(request.text).toContain("recurs doctor");
    expect(request.text).toContain("/company resume <run-id>");
    expect(request.text).toContain("does not restart settled work");
  });
});
