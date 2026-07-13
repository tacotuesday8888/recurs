import { readFile } from "node:fs/promises";
import { PassThrough, type Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  NativeAuthorityInheritedSocketError,
  takeInheritedNativeAuthoritySocket,
  type NativeAuthorityInheritedSocketDependencies,
} from "../src/inherited-socket.js";

function dependencies(
  overrides: Partial<NativeAuthorityInheritedSocketDependencies> = {},
): {
  readonly calls: number[];
  readonly closed: number[];
  readonly socket: Duplex;
  readonly value: NativeAuthorityInheritedSocketDependencies;
} {
  const calls: number[] = [];
  const closed: number[] = [];
  const socket = new PassThrough();
  return {
    calls,
    closed,
    socket,
    value: {
      fstat: (descriptor) => {
        calls.push(descriptor);
        return { isSocket: () => true };
      },
      createSocket: (descriptor) => {
        calls.push(descriptor);
        return socket;
      },
      closeDescriptor: (descriptor) => {
        closed.push(descriptor);
      },
      ...overrides,
    },
  };
}

describe("private native-engine package boundary", () => {
  it("is private and exposes neither a public export map nor a bin", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      name: "@recurs/native-engine",
      private: true,
    });
    expect(manifest).not.toHaveProperty("bin");
    expect(manifest).not.toHaveProperty("exports");
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("types");
  });

  it("claims the descriptor before dynamically importing the broader host", async () => {
    const source = await readFile(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    const claim = source.indexOf("const input = claimPrivateEngineInput()");
    const hostImport = source.indexOf(
      'await import("./native-authority.js")',
    );

    expect(source).toContain('from "./inherited-socket.js";');
    expect(source).not.toMatch(/from\s+["']@recurs\//u);
    expect(claim).toBeGreaterThan(-1);
    expect(hostImport).toBeGreaterThan(claim);
  });
});

describe("inherited native authority descriptor", () => {
  it("deletes, validates, and transfers one canonical inherited descriptor", () => {
    const environment = { RECURS_NATIVE_FD: "37" };
    const fixture = dependencies({
      fstat: (descriptor) => {
        expect(environment).not.toHaveProperty("RECURS_NATIVE_FD");
        fixture.calls.push(descriptor);
        return { isSocket: () => true };
      },
    });

    expect(
      takeInheritedNativeAuthoritySocket(environment, fixture.value),
    ).toBe(fixture.socket);
    expect(fixture.calls).toEqual([37, 37]);
    expect(fixture.closed).toEqual([]);
  });

  it.each([
    undefined,
    "",
    " 3",
    "3 ",
    "+3",
    "03",
    "3.0",
    "2",
    "2147483648",
    "SECRET_DESCRIPTOR_CANARY",
  ])("rejects noncanonical descriptor %j with a fixed error", (input) => {
    const environment: Record<string, string | undefined> = {
      RECURS_NATIVE_FD: input,
    };
    const fixture = dependencies();

    let error: unknown;
    try {
      takeInheritedNativeAuthoritySocket(environment, fixture.value);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NativeAuthorityInheritedSocketError);
    expect(error).toMatchObject({
      name: "NativeAuthorityInheritedSocketError",
      message: "Native authority launcher is unavailable.",
    });
    if (input !== undefined && input.length > 0) {
      expect(JSON.stringify(error)).not.toContain(input);
    }
    expect(environment).not.toHaveProperty("RECURS_NATIVE_FD");
    expect(fixture.calls).toEqual([]);
  });

  it("closes a claimed descriptor when fstat says it is not a socket", () => {
    const fixture = dependencies({
      fstat: () => ({ isSocket: () => false }),
    });

    expect(() =>
      takeInheritedNativeAuthoritySocket(
        { RECURS_NATIVE_FD: "9" },
        fixture.value,
      ),
    ).toThrowError(NativeAuthorityInheritedSocketError);
    expect(fixture.closed).toEqual([9]);
  });

  it("closes a claimed descriptor when fstat or wrapping fails", () => {
    for (const overrides of [
      {
        fstat: () => {
          throw new Error("SECRET_FSTAT_CANARY");
        },
      },
      {
        createSocket: () => {
          throw new Error("SECRET_WRAP_CANARY");
        },
      },
    ]) {
      const fixture = dependencies(overrides);

      expect(() =>
        takeInheritedNativeAuthoritySocket(
          { RECURS_NATIVE_FD: "9" },
          fixture.value,
        ),
      ).toThrowError("Native authority launcher is unavailable.");
      expect(fixture.closed).toEqual([9]);
    }
  });

  it("maps hostile environment access to a fixed error", () => {
    const environment = new Proxy<Record<string, string | undefined>>({}, {
      get() {
        throw new Error("SECRET_ENVIRONMENT_CANARY");
      },
    });
    const fixture = dependencies();

    let error: unknown;
    try {
      takeInheritedNativeAuthoritySocket(environment, fixture.value);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: "NativeAuthorityInheritedSocketError",
      message: "Native authority launcher is unavailable.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_ENVIRONMENT_CANARY");
    expect(fixture.calls).toEqual([]);
  });
});
