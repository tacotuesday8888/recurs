export const CLI_HELP = `Recurs coding-agent harness

Usage:
  recurs [-C <dir>]              Open the interactive CLI in one working root
  recurs setup                   Guide provider, model, and permission setup
  recurs run <prompt> [-C <dir>] Run one prompt in one working root
  recurs run <prompt> [--plan] [--format text|json|jsonl] [--permissions ask|approved|full] [--mode economy|standard|balanced|performance|max] [--connection <id>]
  recurs run <prompt> --resume <session-id> [--format text|json|jsonl]
  recurs run -                   Read one bounded prompt from piped stdin
  recurs run <prompt> --stdin    Append bounded piped stdin to the prompt
  recurs run <prompt> --image <path> [--image <path>]
  recurs review [-C <dir>]      Review the current Git diff in a fresh Plan session
  recurs acp                     Serve Recurs over ACP on stdio
  recurs setup local --url <loopback-url> --model <model-id>
  recurs setup byok --provider <id> --model <id> --key-env <ENV> [--billing strict|allow-additional] [--reasoning-effort none|low|medium|high|xhigh|max]
  recurs setup codex             Connect an existing ChatGPT Codex subscription
  recurs setup openai [--model <exact-id>]
  recurs setup openai --recover  Reconcile interrupted OpenAI API setup
  recurs setup anthropic --model <exact-id>
  recurs setup kimi --model <exact-id>
  recurs provider list [--all] [--json]
  recurs provider catalog [query] [--json]
  recurs provider detect [--json]
  recurs provider models --provider <id> --key-env <ENV> [--json]
  recurs account list [--json]
  recurs account set-primary <id>
  recurs account route <implement|review|repair> <id|parent>
  recurs account verify <id>
  recurs account disconnect <id>
  recurs doctor [--json]         Check installation and execution readiness
  recurs doctor native [--json]  Inspect native authority status
  recurs eval company [--json]   Run the offline company-formation evaluation
  recurs help <command>          Show scoped command help
  recurs --version               Show the installed Recurs version
  recurs --help                  Show this help

Interactive sessions stage a local image with /image <path>; /image clear
discards staged attachments before the next ordinary prompt.
Local setup supports credential-free OpenAI-compatible servers on literal loopback only.
Cross-platform BYOK saves provider/model metadata and an environment-variable name, never the key.
Ephemeral override remains available with RECURS_PROVIDER, RECURS_MODEL, and RECURS_API_KEY together.
Codex setup is interactive and Plan-only. It never imports or stores vendor credentials.
OpenAI API setup captures credentials only in the native authority; API billing is separate from ChatGPT.
Anthropic API setup captures credentials only in the native authority; API billing is separate from Claude subscriptions.
Kimi Code setup captures its coding-plan key only in the native authority.
`;

const HELP_BY_TOPIC = Object.freeze({
  run: `Run one coding-agent prompt

Usage:
  recurs run <prompt> [-C <dir>]
  recurs run <prompt> [--format text|json|jsonl] [--permissions ask|approved|full]
                    [--mode economy|standard|balanced|performance|max]
                    [--connection <id>] [--plan]
                    [--image <path>] (repeat up to four times)
  recurs run <prompt> --resume <session-id> [--format text|json|jsonl]
  recurs run -
  recurs run <prompt> --stdin

Fresh runs create a new durable session. Resume retains the stored provider,
working root, permissions, and operating mode. JSON writes one terminal object;
JSONL streams normalized events. Stdin is bounded to 1 MiB of valid UTF-8.
Explicit PNG, JPEG, and WebP inputs are bounded to five MiB total and require
a direct provider adapter with image support. --plan pins the fresh session to
enforced read-only execution and cannot override a resumed session.
`,
  review: `Review the current staged and unstaged Git changes

Usage:
  recurs review [-C <dir>]
                [--format text|json|jsonl]
                [--permissions ask|approved|full]
                [--mode economy|standard|balanced|performance|max]
                [--connection <id>]

Review creates one fresh durable Plan session, reads bounded staged and
unstaged diffs through Recurs's hardened Git tool, and submits the existing
read-only review prompt. It does not accept positional prompts, stdin, images,
or session resume.
`,
  setup: `Configure a provider, model, permissions, and operating mode

Usage:
  recurs setup
  recurs setup local --url <loopback-url> --model <model-id>
  recurs setup byok --provider <id> --model <id> --key-env <ENV>
                     [--billing strict|allow-additional]
                     [--reasoning-effort none|low|medium|high|xhigh|max]
  recurs setup codex
  recurs setup openai [--model <exact-id>]
  recurs setup openai --recover
  recurs setup anthropic --model <exact-id>
  recurs setup kimi --model <exact-id>

Setup is local and user-present. BYOK stores only the environment-variable name
and a one-way binding. Native setup keeps supported persistent credentials in
the native authority. Codex credentials remain owned by the official runtime.
`,
  provider: `Inspect available provider paths and model catalogs

Usage:
  recurs provider list [--all] [--json]
  recurs provider catalog [query] [--json]
  recurs provider detect [--json]
  recurs provider models --provider <id> --key-env <ENV> [--json]

Catalog lists reviewed integrations. Detect reports safe local runtime evidence.
Models authenticates one reviewed provider endpoint without storing the key.
`,
  account: `Manage saved non-secret connection metadata

Usage:
  recurs account list [--json]
  recurs account set-primary <id>
  recurs account route <implement|review|repair> <id|parent>
  recurs account verify <id>
  recurs account disconnect <id>

Existing sessions retain their immutable backend pins. Disconnect removes
Recurs metadata and does not log out of the provider-owned account.
`,
  doctor: `Check Recurs installation and execution readiness

Usage:
  recurs doctor [--json]
  recurs doctor native [--json]

The default report checks Node.js, Git, ripgrep, the current Git worktree, saved
provider metadata, and a real network-denied OS-sandbox launch. It is read-only,
does not contact a provider, and never reveals paths, account values, or secrets.
The native subcommand reports the separate private native-authority status.
`,
  eval: `Evaluate the bounded company foundation

Usage:
  recurs eval company [--scenario company_formation_v1] [--json] [-C <dir>]
  recurs eval company --configured --allow-network [--json] [-C <dir>]

Offline evaluation is deterministic, uses a temporary private Recurs home,
exposes only the restricted onboarding read tools, and makes no network request.
Configured evaluation uses the saved primary direct/local connection and
requires explicit network opt-in. Reports are sanitized and contain no prompts,
credentials, private paths, or environment values.
`,
  acp: `Serve Recurs as an ACP agent over standard input and output

Usage:
  recurs acp

ACP is a machine protocol: standard output is reserved for protocol frames.
The client supplies one absolute workspace root per session.
`,
} as const);

export type CliHelpTopic = keyof typeof HELP_BY_TOPIC;

export type CliHelpRequest =
  | { readonly valid: true; readonly text: string }
  | { readonly valid: false };

function isTopic(value: string | undefined): value is CliHelpTopic {
  return value !== undefined && Object.hasOwn(HELP_BY_TOPIC, value);
}

export function parseCliHelpRequest(
  argv: readonly string[],
): CliHelpRequest | null {
  if (
    argv.length === 1 &&
    (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")
  ) {
    return { valid: true, text: CLI_HELP };
  }
  if (argv[0] === "help") {
    return argv.length === 2 && isTopic(argv[1])
      ? { valid: true, text: HELP_BY_TOPIC[argv[1]] }
      : { valid: false };
  }
  return argv.length === 2 &&
      (argv[1] === "--help" || argv[1] === "-h") &&
      isTopic(argv[0])
    ? { valid: true, text: HELP_BY_TOPIC[argv[0]] }
    : null;
}
