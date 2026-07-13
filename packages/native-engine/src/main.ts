#!/usr/bin/env node

import {
  discardInheritedNativeAuthorityDescriptorEnvironment,
  takeInheritedNativeAuthoritySocket,
} from "./inherited-socket.js";

const input = claimPrivateEngineInput();
const { runPrivateEngineProcess } = await import("./native-authority.js");
await runPrivateEngineProcess(input);

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
