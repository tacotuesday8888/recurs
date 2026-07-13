import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_COMPONENT_VERSION,
  type NativeAuthorityStatus,
  type NativeAuthorityStatusPort,
} from "@recurs/contracts";

import * as app from "../src/index.js";

const auth = vi.hoisted(() => ({
  createNativeAuthorityClientFromInheritedFd: vi.fn(),
}));

vi.mock("@recurs/auth", () => ({
  createNativeAuthorityClientFromInheritedFd:
    auth.createNativeAuthorityClientFromInheritedFd,
}));

const unavailableReasons = [
  "unsupported_platform",
  "unsupported_os_version",
  "launcher_unavailable",
  "broker_unavailable",
  "protocol_mismatch",
  "peer_identity_unverified",
  "production_signing_required",
  "keychain_unavailable",
  "unsupported_operation",
] as const;

describe("NativeAuthorityService", () => {
  beforeEach(() => {
    auth.createNativeAuthorityClientFromInheritedFd.mockReset();
  });

  it("is exposed through the bounded app surface", () => {
    expect(app).toHaveProperty(
      "NativeAuthorityService",
      expect.any(Function),
    );
  });

  it("delegates a ready status and returns only the public contract fields", async () => {
    const controller = new AbortController();
    const calls: Array<AbortSignal | undefined> = [];
    const raw = {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
        nativePath: "/SECRET/launcher",
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
        descriptor: 42,
      },
      account: "SECRET_ACCOUNT_CANARY",
    };
    const port: NativeAuthorityStatusPort = {
      async status(signal) {
        calls.push(signal);
        return raw as unknown as NativeAuthorityStatus;
      },
    };

    const service = new app.NativeAuthorityService(port);
    const result = await service.status(controller.signal);

    expect(calls).toEqual([controller.signal]);
    expect(result).toEqual({
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|nativePath|descriptor|account/u);
  });

  it.each(unavailableReasons)(
    "preserves only the fixed unavailable reason %s",
    async (reason) => {
      const port: NativeAuthorityStatusPort = {
        async status() {
          return {
            state: "unavailable",
            reason,
            endpoint: "https://SECRET_ENDPOINT_CANARY.example",
          } as unknown as NativeAuthorityStatus;
        },
      };

      const result = await new app.NativeAuthorityService(port).status();

      expect(result).toEqual({ state: "unavailable", reason });
      expect(JSON.stringify(result)).not.toContain("SECRET_ENDPOINT_CANARY");
    },
  );

  it("owns an independent deeply frozen snapshot", async () => {
    const raw = {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "locked",
        broker: "available",
        peerIdentity: "verified",
      },
    };
    const service = new app.NativeAuthorityService({
      async status() {
        return raw as NativeAuthorityStatus;
      },
    });

    const result = await service.status();
    if (result.state !== "ready") throw new Error("expected ready status");

    expect(result).not.toBe(raw);
    expect(result.attestation).not.toBe(raw.attestation);
    expect(result.health).not.toBe(raw.health);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attestation)).toBe(true);
    expect(Object.isFrozen(result.health)).toBe(true);
    raw.attestation.launcherVersion = "9.9.9";
    raw.health.keychain = "unavailable";
    expect(result.attestation.launcherVersion).toBe(NATIVE_COMPONENT_VERSION);
    expect(result.health.keychain).toBe("locked");
    expect(() => {
      (result.health as { keychain: string }).keychain = "unavailable";
    }).toThrow(TypeError);

    const unavailable = await new app.NativeAuthorityService({
      async status() {
        return { state: "unavailable", reason: "broker_unavailable" };
      },
    }).status();
    expect(Object.isFrozen(unavailable)).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an unknown state", { state: "SECRET_STATE_CANARY" }],
    ["an unknown reason", { state: "unavailable", reason: "SECRET_REASON_CANARY" }],
    ["a missing attestation", {
      state: "ready",
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    }],
    ["a wrong protocol", {
      state: "ready",
      attestation: {
        protocolVersion: 2,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    }],
    ["a non-string component version", {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: 1,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    }],
    ["an unknown platform", {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "SECRET_PLATFORM_CANARY",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    }],
    ["an unknown minimum OS", {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "SECRET_OS_CANARY",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    }],
    ["a non-boolean signing value", {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: "SECRET_SIGNING_CANARY",
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    }],
    ["an unknown keychain status", {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "SECRET_KEYCHAIN_CANARY",
        broker: "available",
        peerIdentity: "verified",
      },
    }],
    ["an unknown broker status", {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "SECRET_BROKER_CANARY",
        peerIdentity: "verified",
      },
    }],
    ["an unknown peer identity", {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "SECRET_PEER_CANARY",
      },
    }],
  ] as const)("maps %s to one fixed unavailable status", async (_name, raw) => {
    const result = await new app.NativeAuthorityService({
      async status() {
        return raw as unknown as NativeAuthorityStatus;
      },
    }).status();

    expect(result).toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET_");
  });

  it("does not execute hostile prototype, extra-field, or descriptor traps", async () => {
    let getterCalls = 0;
    const hostilePrototype = Object.create(null, {
      account: {
        get() {
          getterCalls += 1;
          throw new Error("SECRET_PROTOTYPE_CANARY");
        },
      },
    });
    const raw = Object.assign(Object.create(hostilePrototype) as object, {
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    });
    Object.defineProperty(raw, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("SECRET_EXTRA_GETTER_CANARY");
      },
    });

    const ready = await new app.NativeAuthorityService({
      async status() {
        return raw as NativeAuthorityStatus;
      },
    }).status();

    expect(ready).toMatchObject({ state: "ready" });
    expect(getterCalls).toBe(0);
    expect(Object.getPrototypeOf(ready)).toBe(Object.prototype);

    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("SECRET_DESCRIPTOR_CANARY");
      },
    });
    const unavailable = await new app.NativeAuthorityService({
      async status() {
        return hostile as NativeAuthorityStatus;
      },
    }).status();

    expect(unavailable).toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(JSON.stringify(unavailable)).not.toContain("SECRET_DESCRIPTOR_CANARY");
  });

  it("rejects inherited and accessor contract fields without invoking them", async () => {
    let requiredGetterCalls = 0;
    const inherited = Object.create({
      state: "unavailable",
      reason: "protocol_mismatch",
    }) as object;
    const accessor = Object.create(null) as object;
    Object.defineProperties(accessor, {
      state: {
        get() {
          requiredGetterCalls += 1;
          return "unavailable";
        },
      },
      reason: { value: "protocol_mismatch" },
    });

    for (const raw of [inherited, accessor]) {
      await expect(new app.NativeAuthorityService({
        async status() {
          return raw as NativeAuthorityStatus;
        },
      }).status()).resolves.toEqual({
        state: "unavailable",
        reason: "broker_unavailable",
      });
    }
    expect(requiredGetterCalls).toBe(0);
  });

  it.each([
    new Error("SECRET_ERROR_CANARY"),
    "SECRET_STRING_THROW_CANARY",
    new Proxy({}, {
      get() {
        throw new Error("SECRET_ERROR_PROXY_CANARY");
      },
    }),
  ])("maps an unknown port failure to a fixed unavailable snapshot", async (failure) => {
    const result = await new app.NativeAuthorityService({
      async status() {
        throw failure;
      },
    }).status();

    expect(result).toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET_");
  });

  it("rejects already-requested cancellation without calling the port", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort("SECRET_ABORT_REASON_CANARY");
    const service = new app.NativeAuthorityService({
      async status() {
        calls += 1;
        return { state: "unavailable", reason: "broker_unavailable" };
      },
    });

    const error = await service.status(controller.signal).catch(
      (caught: unknown) => caught,
    );

    expect(calls).toBe(0);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_ABORT_REASON_CANARY");
  });

  it("normalizes an AbortError from the delegated port", async () => {
    const service = new app.NativeAuthorityService({
      async status() {
        throw new DOMException("SECRET_PORT_ABORT_CANARY", "AbortError");
      },
    });

    const error = await service.status().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_PORT_ABORT_CANARY");
  });

  it("honors cancellation requested while the delegated status resolves", async () => {
    const controller = new AbortController();
    const service = new app.NativeAuthorityService({
      async status() {
        controller.abort("SECRET_RACING_ABORT_CANARY");
        return {
          state: "unavailable",
          reason: "broker_unavailable",
        };
      },
    });

    const error = await service.status(controller.signal).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_RACING_ABORT_CANARY");
  });

  it.each(["launcherVersion", "brokerVersion"] as const)(
    "rejects a %s that differs from the generated component version",
    async (field) => {
      const attestation = {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
        [field]: "SECRET_COMPONENT_VERSION_CANARY",
      };
      const result = await new app.NativeAuthorityService({
        async status() {
          return {
            state: "ready",
            attestation,
            health: {
              keychain: "available",
              broker: "available",
              peerIdentity: "verified",
            },
          } as unknown as NativeAuthorityStatus;
        },
      }).status();

      expect(result).toEqual({
        state: "unavailable",
        reason: "broker_unavailable",
      });
      expect(JSON.stringify(result)).not.toContain("SECRET_COMPONENT_VERSION_CANARY");
    },
  );

  it.each(["productionSigned", "persistentCredentials"] as const)(
    "rejects ready attestation when %s is false",
    async (field) => {
      const result = await new app.NativeAuthorityService({
        async status() {
          return {
            state: "ready",
            attestation: {
              protocolVersion: 1,
              launcherVersion: NATIVE_COMPONENT_VERSION,
              brokerVersion: NATIVE_COMPONENT_VERSION,
              platform: "darwin",
              minimumMacosVersion: "14.4",
              productionSigned: true,
              persistentCredentials: true,
              [field]: false,
            },
            health: {
              keychain: "available",
              broker: "available",
              peerIdentity: "verified",
            },
          } as NativeAuthorityStatus;
        },
      }).status();

      expect(result).toEqual({
        state: "unavailable",
        reason: "broker_unavailable",
      });
    },
  );

  it("assembles the inherited-FD client with the generated component version", async () => {
    const client: NativeAuthorityStatusPort = {
      async status() {
        return {
          state: "unavailable",
          reason: "keychain_unavailable",
        };
      },
    };
    auth.createNativeAuthorityClientFromInheritedFd.mockResolvedValueOnce(
      client,
    );
    const factory = Reflect.get(
      app,
      "createNativeAuthorityServiceFromInheritedFd",
    ) as (() => Promise<NativeAuthorityStatusPort>) | undefined;

    expect(factory).toBeTypeOf("function");
    const service = await (factory as () => Promise<NativeAuthorityStatusPort>)();

    expect(auth.createNativeAuthorityClientFromInheritedFd).toHaveBeenCalledWith({
      engineVersion: NATIVE_COMPONENT_VERSION,
    });
    await expect(service.status()).resolves.toEqual({
      state: "unavailable",
      reason: "keychain_unavailable",
    });
  });

  it("closes a factory-owned inherited client exactly once", async () => {
    const close = vi.fn();
    auth.createNativeAuthorityClientFromInheritedFd.mockResolvedValueOnce({
      async status() {
        return { state: "unavailable", reason: "broker_unavailable" };
      },
      close,
    });
    const service = await app.createNativeAuthorityServiceFromInheritedFd();
    const closeService = Reflect.get(service, "close") as
      | (() => void)
      | undefined;

    expect(closeService).toBeTypeOf("function");
    closeService?.call(service);
    closeService?.call(service);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fails closed without delegating after the service is closed", async () => {
    let calls = 0;
    const service = new app.NativeAuthorityService({
      async status() {
        calls += 1;
        return { state: "unavailable", reason: "keychain_unavailable" };
      },
    });

    service.close();

    await expect(service.status()).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(calls).toBe(0);
  });

  it("does not publish a status that settles after the service is closed", async () => {
    let settle: ((status: NativeAuthorityStatus) => void) | undefined;
    const response = new Promise<NativeAuthorityStatus>((resolve) => {
      settle = resolve;
    });
    const service = new app.NativeAuthorityService({
      async status() {
        return response;
      },
    });

    const pending = service.status();
    service.close();
    settle?.({
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    });

    await expect(pending).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
  });

  it("preserves cancellation triggered while a status is sanitized", async () => {
    const controller = new AbortController();
    let triggered = false;
    const raw = new Proxy({
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    }, {
      getOwnPropertyDescriptor(target, property) {
        if (!triggered) {
          triggered = true;
          controller.abort("SECRET_SANITIZE_ABORT_CANARY");
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const service = new app.NativeAuthorityService({
      async status() {
        return raw as NativeAuthorityStatus;
      },
    });

    const error = await service.status(controller.signal).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_");
  });

  it("does not publish a status that closes its service while sanitized", async () => {
    let triggered = false;
    const raw = new Proxy({
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    }, {
      getOwnPropertyDescriptor(target, property) {
        if (!triggered) {
          triggered = true;
          service.close();
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const service = new app.NativeAuthorityService({
      async status() {
        return raw as NativeAuthorityStatus;
      },
    });

    await expect(service.status()).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
  });

  it("does not expose close callback failures", async () => {
    let calls = 0;
    const service = new app.NativeAuthorityService(
      {
        async status() {
          calls += 1;
          return { state: "unavailable", reason: "keychain_unavailable" };
        },
      },
      () => {
        throw new Error("SECRET_CLOSE_FAILURE_CANARY");
      },
    );

    expect(() => service.close()).not.toThrow();
    await expect(service.status()).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(calls).toBe(0);
  });

  it("passes cancellation into inherited-FD handshake assembly", async () => {
    const controller = new AbortController();
    const client: NativeAuthorityStatusPort = {
      async status() {
        return { state: "unavailable", reason: "broker_unavailable" };
      },
    };
    auth.createNativeAuthorityClientFromInheritedFd.mockResolvedValueOnce(
      client,
    );

    await app.createNativeAuthorityServiceFromInheritedFd(controller.signal);

    expect(auth.createNativeAuthorityClientFromInheritedFd).toHaveBeenCalledWith({
      engineVersion: NATIVE_COMPONENT_VERSION,
      signal: controller.signal,
    });
  });

  it("rejects pre-cancelled assembly before opening the inherited descriptor", async () => {
    const controller = new AbortController();
    controller.abort("SECRET_FACTORY_PRE_ABORT_CANARY");

    const error = await app.createNativeAuthorityServiceFromInheritedFd(
      controller.signal,
    ).catch((caught: unknown) => caught);

    expect(auth.createNativeAuthorityClientFromInheritedFd).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_FACTORY_PRE_ABORT_CANARY");
  });

  it.each([
    ["launcher_unavailable", "launcher_unavailable"],
    ["unsupported_platform", "unsupported_platform"],
    ["protocol_mismatch", "protocol_mismatch"],
    ["SECRET_FACTORY_REASON_CANARY", "broker_unavailable"],
  ] as const)(
    "maps inherited-FD setup reason %s to safe status %s",
    async (sourceReason, expectedReason) => {
      auth.createNativeAuthorityClientFromInheritedFd.mockRejectedValueOnce(
        Object.assign(new Error("SECRET_FACTORY_ERROR_CANARY"), {
          reason: sourceReason,
        }),
      );

      const service = await app.createNativeAuthorityServiceFromInheritedFd();
      const result = await service.status();

      expect(result).toEqual({
        state: "unavailable",
        reason: expectedReason,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("SECRET_");
    },
  );

  it("preserves inherited-FD assembly cancellation with a fixed AbortError", async () => {
    auth.createNativeAuthorityClientFromInheritedFd.mockRejectedValueOnce(
      new DOMException("SECRET_FACTORY_ABORT_CANARY", "AbortError"),
    );

    const error = await app.createNativeAuthorityServiceFromInheritedFd().catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_FACTORY_ABORT_CANARY");
  });
});
