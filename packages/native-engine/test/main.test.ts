import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  discard: vi.fn(),
  take: vi.fn(),
}));

vi.mock("../src/inherited-socket.js", () => ({
  discardInheritedNativeAuthorityDescriptorEnvironment: boundary.discard,
  takeInheritedNativeAuthoritySocket: boundary.take,
}));

vi.mock("../src/native-authority.js", () => {
  throw new Error("SECRET_PRIVATE_HOST_IMPORT_CANARY");
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  boundary.discard.mockReset();
  boundary.take.mockReset();
  vi.resetModules();
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("private engine bootstrap", () => {
  it("closes a claimed socket when the broader host import fails", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
    const socket = new PassThrough();
    boundary.take.mockReturnValueOnce(socket);

    const error = await import("../src/main.js").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      cause: {
        message: "SECRET_PRIVATE_HOST_IMPORT_CANARY",
      },
    });
    expect(boundary.take).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
  });
});
