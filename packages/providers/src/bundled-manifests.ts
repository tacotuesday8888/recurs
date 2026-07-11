import type {
  BillingPolicy,
  BillingSelectionMode,
  BillingSource,
  ProviderManifest,
  ProviderEndpoint,
  ProviderRegionAvailability,
  SupportStatus,
  UsagePolicyRule,
} from "@recurs/contracts";

import { validateProviderManifest } from "./manifest-validator.js";

const REVIEWED_AT = "2026-07-11";
const EXPIRES_AT = "2026-10-11T00:00:00.000Z";

interface ManifestDefinition {
  id: string;
  displayName: string;
  adapterKind: ProviderManifest["adapterKind"];
  accessKind: ProviderManifest["accessKind"];
  authKinds: ProviderManifest["authKinds"];
  credentialOwner: ProviderManifest["credentialOwner"];
  protocol: ProviderManifest["protocol"];
  endpoints: readonly ProviderEndpoint[];
  endpointEvidence?: string;
  regionAvailability: ProviderRegionAvailability;
  billingPolicy: BillingPolicy;
  supportStatus: SupportStatus;
  runnable: boolean;
  sourceUrls: readonly string[];
  evidenceSummary: string;
  rules?: readonly UsagePolicyRule[];
  accountSharingForbidden?: boolean;
}

function billingPolicy(
  id: string,
  primarySource: BillingSource,
  options: {
    possibleAdditionalSources?: readonly BillingSource[];
    providerFallback?: BillingPolicy["providerFallback"];
    availableSelections?: readonly BillingSelectionMode[];
  } = {},
): BillingPolicy {
  return {
    revision: `billing:${id}:2026-07-11`,
    disclosureRevision: `billing-disclosure:${id}:2026-07-11`,
    primarySource,
    possibleAdditionalSources: options.possibleAdditionalSources ?? [],
    providerFallback: options.providerFallback ?? "none",
    availableSelections: options.availableSelections ?? ["strict_primary_only"],
  };
}

function claimRule(
  claimId: string,
  reason: string,
  when: UsagePolicyRule["when"] = {},
): UsagePolicyRule {
  return {
    when,
    decision: "conditional",
    condition: {
      type: "entitlement_claim",
      claimId,
      allowedValues: [true],
    },
    reason,
  };
}

function manifest(definition: ManifestDefinition): ProviderManifest {
  const candidate: ProviderManifest = {
    schemaVersion: 1,
    id: definition.id,
    displayName: definition.displayName,
    adapterKind: definition.adapterKind,
    accessKind: definition.accessKind,
    authKinds: definition.authKinds,
    credentialOwner: definition.credentialOwner,
    protocol: definition.protocol,
    endpoints: definition.endpoints,
    ...(definition.endpointEvidence === undefined
      ? {}
      : { endpointEvidence: definition.endpointEvidence }),
    regionAvailability: definition.regionAvailability,
    billingPolicy: definition.billingPolicy,
    supportStatus: definition.supportStatus,
    runnable: definition.runnable,
    usagePolicy: {
      revision: `${definition.id}-2026-07-11`,
      reviewedAt: REVIEWED_AT,
      expiresAt: EXPIRES_AT,
      defaultDecision: definition.supportStatus === "supported" ? "allowed" : "denied",
      rules: definition.rules ?? [],
      officialRuntimeRequired: definition.adapterKind === "agent_runtime",
      accountSharingForbidden: definition.accountSharingForbidden ?? true,
      sourceUrls: definition.sourceUrls,
      evidenceSummary: definition.evidenceSummary,
    },
  };
  return validateProviderManifest(candidate);
}

const bundled = [
  manifest({
    id: "openai-api",
    displayName: "OpenAI API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_responses",
    endpoints: [{ kind: "origin", value: "https://api.openai.com/v1" }],
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy("openai-api", "metered_api"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://developers.openai.com/api/docs/models"],
    evidenceSummary:
      "OpenAI documents direct API access with separate platform billing; activation awaits the native credential broker.",
  }),
  manifest({
    id: "openai-codex-chatgpt",
    displayName: "Codex with ChatGPT",
    adapterKind: "agent_runtime",
    accessKind: "subscription",
    authKinds: ["official_runtime"],
    credentialOwner: "vendor_runtime",
    protocol: "acp",
    endpoints: [],
    endpointEvidence:
      "The official Codex runtime owns transport and authentication instead of exposing an HTTP origin to Recurs.",
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy(
      "openai-codex-chatgpt",
      "included_subscription",
    ),
    supportStatus: "conditional",
    runnable: true,
    sourceUrls: [
      "https://developers.openai.com/codex/auth",
      "https://developers.openai.com/codex/sdk",
      "https://developers.openai.com/codex/app-server",
    ],
    evidenceSummary:
      "ChatGPT-plan access is delegated to the official Codex runtime and restricted to local user-present workflows with a verified plan entitlement.",
    rules: [
      claimRule(
        "openai.codex.chatgpt_plan_active",
        "The official runtime must report an active ChatGPT plan before local CLI use.",
        {
          presence: "present",
          location: "local",
          automation: "manual",
          embedding: "cli",
        },
      ),
      claimRule(
        "openai.codex.chatgpt_plan_active",
        "The official runtime must report an active ChatGPT plan before local desktop use.",
        {
          presence: "present",
          location: "local",
          automation: "manual",
          embedding: "desktop",
        },
      ),
    ],
  }),
  manifest({
    id: "anthropic-api",
    displayName: "Anthropic API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "anthropic_messages",
    endpoints: [{ kind: "origin", value: "https://api.anthropic.com/v1" }],
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy("anthropic-api", "metered_api"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: [
      "https://platform.claude.com/docs/en/manage-claude/authentication",
    ],
    evidenceSummary:
      "Anthropic documents direct Messages API authentication and metered API use; activation awaits the native credential broker.",
  }),
  manifest({
    id: "anthropic-claude-subscription",
    displayName: "Claude Subscription",
    adapterKind: "agent_runtime",
    accessKind: "subscription",
    authKinds: ["official_runtime"],
    credentialOwner: "vendor_runtime",
    protocol: "sdk",
    endpoints: [],
    endpointEvidence:
      "No Recurs-owned endpoint is permitted for this blocked delegated subscription path.",
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy(
      "anthropic-claude-subscription",
      "included_subscription",
    ),
    supportStatus: "blocked",
    runnable: false,
    sourceUrls: [
      "https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan",
      "https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan",
    ],
    evidenceSummary:
      "Third-party Claude subscription login remains blocked absent Anthropic approval; private credential stores are never imported.",
  }),
  manifest({
    id: "github-copilot-subscription",
    displayName: "GitHub Copilot Subscription",
    adapterKind: "agent_runtime",
    accessKind: "subscription",
    authKinds: ["official_runtime"],
    credentialOwner: "vendor_runtime",
    protocol: "sdk",
    endpoints: [],
    endpointEvidence:
      "The official Copilot SDK owns its network endpoints and authentication flow.",
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy(
      "github-copilot-subscription",
      "included_subscription",
    ),
    supportStatus: "conditional",
    runnable: false,
    sourceUrls: [
      "https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate",
      "https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/",
    ],
    evidenceSummary:
      "The official Copilot SDK supports delegated use, conditional on Recurs verifying its permission, tool, and runtime isolation capabilities.",
    rules: [
      claimRule(
        "github.copilot.runtime_capabilities_verified",
        "The delegated runtime capability gate must pass before Copilot is activated.",
      ),
    ],
  }),
  manifest({
    id: "openrouter-api",
    displayName: "OpenRouter API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key", "oauth_pkce"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://openrouter.ai/api/v1" }],
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy("openrouter-api", "prepaid_credits"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://openrouter.ai/docs/api/reference/authentication"],
    evidenceSummary:
      "OpenRouter documents API-key and OAuth-capable OpenAI-compatible access with account credit billing.",
  }),
  manifest({
    id: "opencode-zen",
    displayName: "OpenCode Zen",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_responses",
    endpoints: [{ kind: "origin", value: "https://opencode.ai/zen/v1" }],
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy("opencode-zen", "prepaid_credits"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://opencode.ai/docs/zen/"],
    evidenceSummary:
      "OpenCode documents Zen as a keyed, credit-funded model gateway with a Responses-compatible endpoint.",
  }),
  manifest({
    id: "opencode-go",
    displayName: "OpenCode Go",
    adapterKind: "model_provider",
    accessKind: "subscription",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://opencode.ai/zen/go/v1" }],
    regionAvailability: {
      kind: "fixed",
      regions: ["us", "eu", "singapore"],
    },
    billingPolicy: billingPolicy("opencode-go", "included_subscription", {
      possibleAdditionalSources: ["prepaid_credits"],
      providerFallback: "user_configured",
      availableSelections: [
        "strict_primary_only",
        "allow_declared_additional",
      ],
    }),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://opencode.ai/docs/go"],
    evidenceSummary:
      "OpenCode documents the Go subscription path separately from pay-as-you-go Zen access.",
  }),
  manifest({
    id: "kilo-gateway",
    displayName: "Kilo Gateway",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://api.kilo.ai/api/gateway" }],
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy("kilo-gateway", "prepaid_credits"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://kilo.ai/docs/gateway"],
    evidenceSummary:
      "Kilo documents its gateway as an API-key-authenticated OpenAI-compatible service with explicit usage and billing controls.",
  }),
  manifest({
    id: "nous-portal",
    displayName: "Nous Portal",
    adapterKind: "model_provider",
    accessKind: "subscription",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [],
    endpointEvidence:
      "No stable official public origin was accepted during the 2026-07-11 policy review.",
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy("nous-portal", "included_subscription"),
    supportStatus: "conditional",
    runnable: false,
    sourceUrls: ["https://portal.nousresearch.com/api-docs"],
    evidenceSummary:
      "Nous Portal remains conditional until a stable official public origin is verified and bound to the reviewed policy.",
    rules: [
      claimRule(
        "nous.portal.stable_origin_verified",
        "Activation requires a newly verified stable official origin and policy review.",
      ),
    ],
  }),
  manifest({
    id: "alibaba-model-studio-api",
    displayName: "Alibaba Model Studio API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [
      {
        kind: "origin",
        value: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    ],
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: billingPolicy(
      "alibaba-model-studio-api",
      "metered_api",
    ),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://www.alibabacloud.com/help/en/model-studio/models"],
    evidenceSummary:
      "Alibaba Model Studio documents a separately billed international API endpoint for programmatic use.",
  }),
  manifest({
    id: "alibaba-coding-plan",
    displayName: "Alibaba Coding Plan",
    adapterKind: "model_provider",
    accessKind: "coding_plan",
    authKinds: ["coding_plan_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [
      {
        kind: "origin",
        value: "https://coding-intl.dashscope.aliyuncs.com/v1",
      },
      {
        kind: "origin",
        value: "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
      },
    ],
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: billingPolicy(
      "alibaba-coding-plan",
      "included_subscription",
    ),
    supportStatus: "conditional",
    runnable: false,
    sourceUrls: [
      "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
      "https://www.alibabacloud.com/help/en/model-studio/more-tools",
    ],
    evidenceSummary:
      "Alibaba restricts Coding Plan use to foreground interactive programming tools; scripts and backend services are denied.",
    rules: [
      claimRule(
        "alibaba.coding_plan_active",
        "A current Coding Plan entitlement is required for foreground CLI use.",
        {
          presence: "present",
          location: "local",
          automation: "manual",
          embedding: "cli",
        },
      ),
      claimRule(
        "alibaba.coding_plan_active",
        "A current Coding Plan entitlement is required for foreground desktop use.",
        {
          presence: "present",
          location: "local",
          automation: "manual",
          embedding: "desktop",
        },
      ),
    ],
  }),
  manifest({
    id: "kimi-platform-api",
    displayName: "Kimi Platform API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://api.moonshot.ai/v1" }],
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: billingPolicy("kimi-platform-api", "metered_api"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://platform.kimi.ai/docs/api/chat"],
    evidenceSummary:
      "Moonshot documents the Kimi Platform API as a standard metered programmatic access path.",
  }),
  manifest({
    id: "kimi-code",
    displayName: "Kimi Code",
    adapterKind: "model_provider",
    accessKind: "coding_plan",
    authKinds: ["coding_plan_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [
      { kind: "origin", value: "https://api.kimi.com/coding/v1" },
      { kind: "origin", value: "https://api.kimi.com/coding/" },
    ],
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: billingPolicy("kimi-code", "included_subscription"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://www.kimi.com/code/docs/en/"],
    evidenceSummary:
      "Kimi documents a dedicated membership credential and coding endpoints for third-party coding agents.",
  }),
  manifest({
    id: "minimax-api",
    displayName: "MiniMax API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [
      { kind: "origin", value: "https://api.minimax.io/v1" },
      { kind: "origin", value: "https://api.minimax.io/anthropic" },
    ],
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: billingPolicy("minimax-api", "metered_api"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://platform.minimax.io/docs/pricing/overview"],
    evidenceSummary:
      "MiniMax documents standard metered API access separately from its Token Plan.",
  }),
  manifest({
    id: "minimax-token-plan",
    displayName: "MiniMax Token Plan",
    adapterKind: "model_provider",
    accessKind: "coding_plan",
    authKinds: ["coding_plan_key"],
    credentialOwner: "recurs_broker",
    protocol: "anthropic_messages",
    endpoints: [
      { kind: "origin", value: "https://api.minimax.io/v1" },
      { kind: "origin", value: "https://api.minimax.io/anthropic" },
    ],
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: billingPolicy(
      "minimax-token-plan",
      "included_subscription",
      {
        possibleAdditionalSources: ["prepaid_credits"],
        providerFallback: "automatic",
        availableSelections: [
          "strict_primary_only",
          "allow_declared_additional",
        ],
      },
    ),
    supportStatus: "conditional",
    runnable: false,
    sourceUrls: [
      "https://platform.minimax.io/docs/token-plan/intro",
      "https://platform.minimax.io/docs/pricing/overview",
    ],
    evidenceSummary:
      "A Token Plan credential can consume plan quota and prepaid credits, so activation requires an explicit current billing selection.",
    rules: [
      {
        when: {},
        decision: "conditional",
        condition: {
          type: "billing_selection",
          allowedModes: ["strict_primary_only", "allow_declared_additional"],
        },
        reason:
          "The user must select a provable plan-only path or explicitly allow the documented prepaid-credit source.",
      },
    ],
  }),
  manifest({
    id: "zai-api",
    displayName: "Z.ai API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://api.z.ai/api/paas/v4" }],
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: billingPolicy("zai-api", "metered_api"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://docs.z.ai/api-reference/introduction"],
    evidenceSummary:
      "Z.ai documents its general API as a separately billed programmatic access path.",
  }),
  manifest({
    id: "zai-glm-coding-plan",
    displayName: "Z.ai GLM Coding Plan",
    adapterKind: "model_provider",
    accessKind: "coding_plan",
    authKinds: ["coding_plan_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [
      { kind: "origin", value: "https://api.z.ai/api/coding/paas/v4" },
      { kind: "origin", value: "https://api.z.ai/api/anthropic" },
    ],
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: billingPolicy(
      "zai-glm-coding-plan",
      "included_subscription",
    ),
    supportStatus: "blocked_pending_written_approval",
    runnable: false,
    sourceUrls: [
      "https://docs.z.ai/devpack/tool/others",
      "https://docs.z.ai/devpack/usage-policy",
    ],
    evidenceSummary:
      "Coding Plan benefits are restricted to an official allowlist that does not include Recurs; written approval is required.",
  }),
  manifest({
    id: "deepseek-api",
    displayName: "DeepSeek API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "openai_chat",
    endpoints: [
      { kind: "origin", value: "https://api.deepseek.com" },
      { kind: "origin", value: "https://api.deepseek.com/anthropic" },
    ],
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy("deepseek-api", "metered_api"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://api-docs.deepseek.com/"],
    evidenceSummary:
      "DeepSeek documents metered programmatic API access through compatible endpoints.",
  }),
  manifest({
    id: "aws-bedrock",
    displayName: "AWS Bedrock",
    adapterKind: "model_provider",
    accessKind: "cloud_identity",
    authKinds: ["cloud_identity"],
    credentialOwner: "recurs_broker",
    protocol: "bedrock",
    endpoints: [
      {
        kind: "template",
        value: "https://bedrock-mantle.{region}.api.aws/v1",
      },
    ],
    regionAvailability: { kind: "provider_catalog", catalog: "aws" },
    billingPolicy: billingPolicy("aws-bedrock", "cloud_account"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: ["https://docs.aws.amazon.com/bedrock/latest/userguide/apis.html"],
    evidenceSummary:
      "AWS documents Bedrock as a regional cloud-identity service suitable for production and automated workloads.",
  }),
  manifest({
    id: "google-gemini-api",
    displayName: "Google Gemini API",
    adapterKind: "model_provider",
    accessKind: "api",
    authKinds: ["api_key"],
    credentialOwner: "recurs_broker",
    protocol: "gemini_generate_content",
    endpoints: [
      {
        kind: "origin",
        value: "https://generativelanguage.googleapis.com/v1beta",
      },
    ],
    regionAvailability: { kind: "global" },
    billingPolicy: billingPolicy("google-gemini-api", "metered_api"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: [
      "https://ai.google.dev/gemini-api/docs/api-key",
      "https://ai.google.dev/gemini-api/docs/billing/",
    ],
    evidenceSummary:
      "Google documents API-authorized Gemini Developer API access with project billing.",
  }),
  manifest({
    id: "google-vertex-ai",
    displayName: "Google Vertex AI",
    adapterKind: "model_provider",
    accessKind: "cloud_identity",
    authKinds: ["cloud_identity"],
    credentialOwner: "recurs_broker",
    protocol: "gemini_generate_content",
    endpoints: [
      { kind: "origin", value: "https://aiplatform.googleapis.com/v1" },
    ],
    regionAvailability: { kind: "provider_catalog", catalog: "gcp" },
    billingPolicy: billingPolicy("google-vertex-ai", "cloud_account"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: [
      "https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart",
    ],
    evidenceSummary:
      "Google documents Vertex AI for production workloads using supported cloud identities.",
  }),
  manifest({
    id: "azure-openai",
    displayName: "Azure OpenAI",
    adapterKind: "model_provider",
    accessKind: "cloud_identity",
    authKinds: ["cloud_identity"],
    credentialOwner: "recurs_broker",
    protocol: "azure_openai",
    endpoints: [
      {
        kind: "template",
        value: "https://{resource}.openai.azure.com/openai/v1",
      },
    ],
    regionAvailability: { kind: "provider_catalog", catalog: "azure" },
    billingPolicy: billingPolicy("azure-openai", "cloud_account"),
    supportStatus: "supported",
    runnable: false,
    sourceUrls: [
      "https://learn.microsoft.com/en-us/azure/developer/ai/how-to/switching-endpoints",
    ],
    evidenceSummary:
      "Microsoft documents resource-scoped Azure OpenAI endpoints with managed cloud authentication for production use.",
  }),
  manifest({
    id: "ollama-local",
    displayName: "Ollama Local",
    adapterKind: "model_provider",
    accessKind: "local",
    authKinds: ["local_endpoint"],
    credentialOwner: "none",
    protocol: "local_openai",
    endpoints: [{ kind: "origin", value: "http://127.0.0.1:11434/v1" }],
    regionAvailability: { kind: "local" },
    billingPolicy: billingPolicy("ollama-local", "local_compute"),
    supportStatus: "supported",
    runnable: true,
    sourceUrls: ["https://docs.ollama.com/api/openai-compatibility"],
    evidenceSummary:
      "Ollama documents a loopback OpenAI-compatible server; cloud-offloaded models remain excluded from the local path.",
    accountSharingForbidden: false,
  }),
  manifest({
    id: "lm-studio-local",
    displayName: "LM Studio Local",
    adapterKind: "model_provider",
    accessKind: "local",
    authKinds: ["local_endpoint"],
    credentialOwner: "none",
    protocol: "local_openai",
    endpoints: [{ kind: "origin", value: "http://127.0.0.1:1234/v1" }],
    regionAvailability: { kind: "local" },
    billingPolicy: billingPolicy("lm-studio-local", "local_compute"),
    supportStatus: "supported",
    runnable: true,
    sourceUrls: ["https://lmstudio.ai/docs/developer/core/server"],
    evidenceSummary:
      "LM Studio documents a user-enabled local server suitable for loopback and headless use.",
    accountSharingForbidden: false,
  }),
] as const;

export const BUNDLED_PROVIDER_MANIFESTS: readonly ProviderManifest[] =
  Object.freeze([...bundled]);
