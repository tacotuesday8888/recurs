import { closeSync, fstatSync } from "node:fs";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";

const NATIVE_AUTHORITY_DESCRIPTOR_ENVIRONMENT_KEY = "RECURS_NATIVE_FD";
const MAX_NATIVE_AUTHORITY_DESCRIPTOR = 0x7fff_ffff;
const canonicalDescriptorPattern = /^(?:[3-9]|[1-9][0-9]+)$/u;

export interface NativeAuthorityInheritedSocketDependencies {
  readonly fstat: (
    descriptor: number,
  ) => { readonly isSocket: () => boolean };
  readonly createSocket: (descriptor: number) => Duplex;
  readonly closeDescriptor: (descriptor: number) => void;
}

export class NativeAuthorityInheritedSocketError extends Error {
  constructor() {
    super("Native authority launcher is unavailable.");
    this.name = "NativeAuthorityInheritedSocketError";
  }
}

const systemDependencies: NativeAuthorityInheritedSocketDependencies =
  Object.freeze({
    fstat: (descriptor: number) => fstatSync(descriptor),
    createSocket: (descriptor: number) =>
      new Socket({
        fd: descriptor,
        readable: true,
        writable: true,
        allowHalfOpen: false,
      }),
    closeDescriptor: (descriptor: number) => closeSync(descriptor),
  });

export function takeInheritedNativeAuthoritySocket(
  environment: Record<string, string | undefined> = process.env,
  dependencies: NativeAuthorityInheritedSocketDependencies =
    systemDependencies,
): Duplex {
  let encodedDescriptor: string | undefined;
  try {
    encodedDescriptor =
      environment[NATIVE_AUTHORITY_DESCRIPTOR_ENVIRONMENT_KEY];
  } catch {
    discardInheritedNativeAuthorityDescriptorEnvironment(environment);
    throw new NativeAuthorityInheritedSocketError();
  }
  try {
    delete environment[NATIVE_AUTHORITY_DESCRIPTOR_ENVIRONMENT_KEY];
  } catch {
    throw new NativeAuthorityInheritedSocketError();
  }

  if (
    typeof encodedDescriptor !== "string" ||
    !canonicalDescriptorPattern.test(encodedDescriptor)
  ) {
    throw new NativeAuthorityInheritedSocketError();
  }
  const descriptor = Number(encodedDescriptor);
  if (
    !Number.isSafeInteger(descriptor) ||
    descriptor < 3 ||
    descriptor > MAX_NATIVE_AUTHORITY_DESCRIPTOR
  ) {
    throw new NativeAuthorityInheritedSocketError();
  }

  try {
    const stats = dependencies.fstat(descriptor);
    if (!stats.isSocket()) {
      closeClaimedDescriptor(descriptor, dependencies);
      throw new NativeAuthorityInheritedSocketError();
    }
  } catch (error) {
    if (!(error instanceof NativeAuthorityInheritedSocketError)) {
      closeClaimedDescriptor(descriptor, dependencies);
    }
    throw new NativeAuthorityInheritedSocketError();
  }

  try {
    return dependencies.createSocket(descriptor);
  } catch {
    closeClaimedDescriptor(descriptor, dependencies);
    throw new NativeAuthorityInheritedSocketError();
  }
}

export function discardInheritedNativeAuthorityDescriptorEnvironment(
  environment: Record<string, string | undefined> = process.env,
): void {
  try {
    delete environment[NATIVE_AUTHORITY_DESCRIPTOR_ENVIRONMENT_KEY];
  } catch {
    // The fixed launcher-unavailable result is authoritative.
  }
}

function closeClaimedDescriptor(
  descriptor: number,
  dependencies: NativeAuthorityInheritedSocketDependencies,
): void {
  try {
    dependencies.closeDescriptor(descriptor);
  } catch {
    // The fixed launcher-unavailable result is authoritative.
  }
}
