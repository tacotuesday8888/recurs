#!/usr/bin/env node

import {
  discardInheritedNativeAuthorityDescriptorEnvironment,
  takeInheritedNativeAuthoritySocket,
} from "./inherited-socket.js";

const input = claimPrivateEngineInput();
let ownershipTransferred = false;
try {
  const { runPrivateEngineProcess } = await import("./native-authority.js");
  ownershipTransferred = true;
  await runPrivateEngineProcess(input);
} finally {
  if (!ownershipTransferred && "duplex" in input) {
    try {
      input.duplex.destroy();
    } catch {
      // Pre-transfer closure never exposes private transport details.
    }
  }
}

function claimPrivateEngineInput() {
  if (process.platform !== "darwin") {
    discardInheritedNativeAuthorityDescriptorEnvironment(process.env);
    return { unavailableReason: "unsupported_platform" } as const;
  }
  try {
    return {
      duplex: takeInheritedNativeAuthoritySocket(process.env),
    } as const;
  } catch {
    return { unavailableReason: "launcher_unavailable" } as const;
  }
}
