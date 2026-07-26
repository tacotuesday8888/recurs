import { createHash } from "node:crypto";

import { RECURS_VERSION, type ModelReasoningEffort } from "@recurs/contracts";
import { z } from "zod";

import {
  type CodexAppServerClient,
  CodexAppServerProtocolError,
  createCodexAppServerClient,
  type CodexAppServerProcessProfile,
} from "./codex-app-server-protocol.js";
import {
  CODEX_ALLOWED_ENVIRONMENT_KEYS,
} from "./codex-acp-profile.js";
import { resolveCodexCliInstallation } from "./codex-cli-installation.js";

export type CodexAppServerCatalogErrorCode =
  | "authentication_required"
  | "account_mismatch"
  | "catalog_invalid"
  | "adapter_unavailable"
  | "cancelled";

export class CodexAppServerCatalogError extends Error {
  readonly code: CodexAppServerCatalogErrorCode;

  constructor(code: CodexAppServerCatalogErrorCode, message: string) {
    super(message);
    this.name = "CodexAppServerCatalogError";
    this.code = code;
  }
}

export interface CodexSubscriptionModel {
  readonly id: string;
  readonly displayName: string;
  readonly defaultReasoningEffort: ModelReasoningEffort;
  readonly supportedReasoningEfforts: readonly ModelReasoningEffort[];
}

export interface CodexSubscriptionCatalog {
  readonly accountSubjectFingerprint: string;
  readonly accountDisplayLabel: string;
  readonly planType: string;
  readonly models: readonly CodexSubscriptionModel[];
}

const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const initializeSchema = z.object({
  userAgent: z.string().min(1).max(512),
  codexHome: z.string().min(1).max(4_096),
  platformFamily: z.string().min(1).max(64),
  platformOs: z.string().min(1).max(64),
});
const accountSchema = z.object({
  account: z.discriminatedUnion("type", [
    z.object({ type: z.literal("apiKey") }),
    z.object({
      type: z.literal("chatgpt"),
      email: z.string().email().max(320).nullable(),
      planType: z.string().min(1).max(64),
    }),
    z.object({
      type: z.literal("amazonBedrock"),
      usesCodexManagedCredentials: z.boolean(),
    }),
  ]).nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const modelListSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    hidden: z.boolean(),
    supportedReasoningEfforts: z.array(z.object({
      reasoningEffort: reasoningEffortSchema,
      description: z.string().max(1_024),
    })).min(1).max(16),
    defaultReasoningEffort: reasoningEffortSchema,
  })).max(128),
  nextCursor: z.string().min(1).max(1_024).nullable(),
});
const loginStartSchema = z.object({
  type: z.literal("chatgpt"),
  loginId: z.string().min(1).max(256),
  authUrl: z.string().url().max(8_192),
});
const loginCompletedSchema = z.object({
  loginId: z.string().min(1).max(256),
  success: z.boolean(),
  error: z.string().max(4_096).nullable(),
});

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MAX_MODEL_PAGES = 16;
const MAX_MODELS = 512;

function catalogError(error: unknown): CodexAppServerCatalogError {
  if (error instanceof CodexAppServerCatalogError) return error;
  if (
    error instanceof CodexAppServerProtocolError &&
    error.code === "cancelled"
  ) {
    return new CodexAppServerCatalogError(
      "cancelled",
      "Codex subscription discovery was cancelled",
    );
  }
  return new CodexAppServerCatalogError(
    "adapter_unavailable",
    "Codex app-server could not be inspected",
  );
}

export function codexSubscriptionAccountFingerprint(email: string): string {
  return `sha256:${createHash("sha256")
    .update(`openai-codex-chatgpt\0${email.toLocaleLowerCase("en-US")}`)
    .digest("hex")}`;
}

function accountDisplayLabel(planType: string): string {
  const normalized = planType.replace(/[_-]+/gu, " ").trim();
  const title = normalized.length === 0
    ? "ChatGPT"
    : normalized.replace(/\b\p{L}/gu, (character) => character.toUpperCase());
  return `ChatGPT ${title} subscription`;
}

export function codexAppServerEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of CODEX_ALLOWED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}

export function createCodexAppServerProcessProfile(): CodexAppServerProcessProfile {
  const installation = resolveCodexCliInstallation();
  return Object.freeze({
    command: installation.codexExecutable,
    args: Object.freeze([
      "app-server",
      "--listen",
      "stdio://",
      "--disable",
      "apps",
      "--disable",
      "browser_use",
      "--disable",
      "computer_use",
      "--disable",
      "code_mode_host",
      "--disable",
      "hooks",
      "--disable",
      "image_generation",
      "--disable",
      "multi_agent",
      "--disable",
      "plugins",
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "--disable",
      "workspace_dependencies",
      "-c",
      "mcp_servers={}",
      "-c",
      'web_search="disabled"',
    ]),
    environment: codexAppServerEnvironment(),
    bounds: Object.freeze({
      maxFrameBytes: 2 * 1_024 * 1_024,
      maxStdoutBytes: 32 * 1_024 * 1_024,
      maxStderrBytes: 256 * 1_024,
      maxFrames: 20_000,
      maxPendingRequests: 64,
      requestTimeoutMs: 120_000,
      shutdownTimeoutMs: 5_000,
    }),
  });
}

async function initializeCodexAppServer(
  client: CodexAppServerClient,
  signal: AbortSignal,
): Promise<void> {
  initializeSchema.parse(await client.request("initialize", {
    clientInfo: {
      name: "recurs",
      title: "Recurs",
      version: RECURS_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  }, signal));
  client.notify("initialized");
}

export interface CodexChatGptLoginPrompt {
  readonly loginId: string;
  readonly authUrl: string;
}

export async function loginCodexAppServerChatGpt(
  profile: CodexAppServerProcessProfile,
  signal: AbortSignal,
  present: (
    prompt: CodexChatGptLoginPrompt,
  ) => void | Promise<void>,
): Promise<void> {
  if (signal.aborted) {
    throw new CodexAppServerCatalogError(
      "cancelled",
      "Codex ChatGPT login was cancelled",
    );
  }
  let expectedLoginId: string | null = null;
  let bufferedCompletion: z.infer<typeof loginCompletedSchema> | null = null;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  let completed = false;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const acceptCompletion = (
    result: z.infer<typeof loginCompletedSchema>,
  ): void => {
    if (completed || result.loginId !== expectedLoginId) return;
    completed = true;
    if (result.success) resolveCompletion();
    else {
      rejectCompletion(new CodexAppServerCatalogError(
        "authentication_required",
        "Codex ChatGPT login did not complete",
      ));
    }
  };
  const client = createCodexAppServerClient(profile, {
    onMessage(message) {
      if (message.method !== "account/login/completed") return;
      const result = loginCompletedSchema.parse(message.params);
      if (expectedLoginId === null) bufferedCompletion = result;
      else acceptCompletion(result);
    },
  });
  let loginId: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(new CodexAppServerCatalogError(
    "cancelled",
    "Codex ChatGPT login was cancelled",
  ));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await initializeCodexAppServer(client, signal);
    const started = loginStartSchema.parse(await client.request(
      "account/login/start",
      {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      },
      signal,
    ));
    loginId = started.loginId;
    expectedLoginId = loginId;
    if (bufferedCompletion !== null) acceptCompletion(bufferedCompletion);
    await present(Object.freeze({
      loginId,
      authUrl: started.authUrl,
    }));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CodexAppServerCatalogError(
        "authentication_required",
        "Codex ChatGPT login timed out",
      )), 10 * 60_000);
    });
    await Promise.race([
      completion,
      aborted,
      timeout,
      client.closed.then(() => {
        throw new CodexAppServerCatalogError(
          "authentication_required",
          "Codex app-server closed before login completed",
        );
      }),
    ]);
  } catch (error) {
    if (loginId !== null && !completed) {
      await client.request("account/login/cancel", { loginId })
        .catch(() => undefined);
    }
    throw catalogError(error);
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await client.close();
  }
}

export async function inspectCodexAppServerSubscription(
  profile: CodexAppServerProcessProfile,
  signal: AbortSignal,
): Promise<CodexSubscriptionCatalog> {
  if (signal.aborted) {
    throw new CodexAppServerCatalogError(
      "cancelled",
      "Codex subscription discovery was cancelled",
    );
  }
  const client = createCodexAppServerClient(profile);
  try {
    await initializeCodexAppServer(client, signal);

    const accountResponse = accountSchema.parse(
      await client.request("account/read", { refreshToken: false }, signal),
    );
    if (accountResponse.account === null) {
      throw new CodexAppServerCatalogError(
        "authentication_required",
        "Codex is not logged in with ChatGPT",
      );
    }
    if (
      accountResponse.account.type !== "chatgpt" ||
      accountResponse.account.email === null
    ) {
      throw new CodexAppServerCatalogError(
        "account_mismatch",
        "Codex is not using an account-bound ChatGPT subscription",
      );
    }

    const models = new Map<string, CodexSubscriptionModel>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const response = modelListSchema.parse(await client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      }, signal));
      for (const model of response.data) {
        if (
          model.hidden ||
          model.id !== model.model ||
          !SAFE_MODEL_ID.test(model.model) ||
          models.has(model.model) ||
          !model.supportedReasoningEfforts.some((effort) =>
            effort.reasoningEffort === model.defaultReasoningEffort
          ) ||
          models.size >= MAX_MODELS
        ) {
          throw new CodexAppServerCatalogError(
            "catalog_invalid",
            "Codex returned an invalid model catalog",
          );
        }
        models.set(model.model, Object.freeze({
          id: model.model,
          displayName: model.displayName,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: Object.freeze(
            model.supportedReasoningEfforts.map((effort) =>
              effort.reasoningEffort
            ),
          ),
        }));
      }
      cursor = response.nextCursor;
      if (cursor === null) break;
      if (cursors.has(cursor)) {
        throw new CodexAppServerCatalogError(
          "catalog_invalid",
          "Codex returned an invalid model catalog cursor",
        );
      }
      cursors.add(cursor);
      if (page === MAX_MODEL_PAGES - 1) {
        throw new CodexAppServerCatalogError(
          "catalog_invalid",
          "Codex model catalog exceeded its page limit",
        );
      }
    }
    if (models.size === 0) {
      throw new CodexAppServerCatalogError(
        "catalog_invalid",
        "Codex did not return any selectable subscription models",
      );
    }
    const planType = accountResponse.account.planType;
    return Object.freeze({
      accountSubjectFingerprint: codexSubscriptionAccountFingerprint(
        accountResponse.account.email,
      ),
      accountDisplayLabel: accountDisplayLabel(planType),
      planType,
      models: Object.freeze([...models.values()].sort((left, right) =>
        left.id.localeCompare(right.id)
      )),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new CodexAppServerCatalogError(
        "catalog_invalid",
        "Codex returned invalid account or model metadata",
      );
    }
    throw catalogError(error);
  } finally {
    await client.close();
  }
}
