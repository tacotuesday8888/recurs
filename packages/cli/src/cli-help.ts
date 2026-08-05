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
  recurs data path [--json]      Show the durable local-data directory
  recurs hooks [--json]          Inspect bounded user lifecycle hooks
  recurs permissions [--json]    Inspect exact workspace permission rules
  recurs eval company [--json]   Run a bounded company-formation evaluation
  recurs benchmark company --configured --allow-network [--scenario <id>] [--repetitions 1|2|3] [--compare-all-strong] [--json]
  recurs help <command>          Show scoped command help
  recurs --version               Show the installed Recurs version
  recurs --help                  Show this help

Interactive sessions stage a local image with /image <path>; /image clear
discards staged attachments before the next ordinary prompt.
Local setup supports credential-free OpenAI-compatible servers on literal loopback only.
Cross-platform BYOK saves provider/model metadata and an environment-variable name, never the key.
Ephemeral override remains available with RECURS_PROVIDER, RECURS_MODEL, and RECURS_API_KEY together.
Codex setup is interactive and exposes only Recurs-scoped tools. It never imports or stores vendor credentials.
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

Setup is local and user-present. BYOK stores only the environment-variable name
and a one-way binding. Codex credentials remain owned by the official runtime.
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

The default report checks Node.js, Git, ripgrep, the current Git worktree, saved
provider metadata, and a real network-denied OS-sandbox launch. It is read-only,
does not contact a provider, and never reveals paths, account values, or secrets.
`,
  data: `Locate Recurs durable local data

Usage:
  recurs data path [--json]

The directory contains private sessions, prompts, tool records, checkpoints,
provider-routing metadata, and company state. This command only reports its
location; it never reads or deletes the directory.
`,
  hooks: `Inspect bounded user lifecycle hooks

Usage:
  recurs hooks [--json]

Hooks are configured in $RECURS_HOME/config/hooks.json. They receive sanitized
JSON lifecycle envelopes and run from a bounded asynchronous queue in
deterministic order. Commands are identity-bound owned executables outside the
workspace and can observe a read-only workspace without network or credential
access. Hooks cannot modify prompts, tools, results, permissions, or agent
authority. Project repositories cannot register executable hooks.
`,
  permissions: `Inspect exact workspace permission rules

Usage:
  recurs permissions [--json] [-C <dir>]

Rules come only from the private user-owned
$RECURS_HOME/config/permissions.json file. Matching is exact across the
canonical workspace, category, resource, and risk. Credential access remains
denied, destructive actions cannot be persistently allowed, and agent profile,
Plan mode, parent-ceiling, and OS-containment checks remain authoritative.
`,
  recovery: `Recover an interrupted session or company goal

Start with:
  recurs doctor
  recurs help recovery

Inside an interactive session:
  /status                         Inspect the active session, goal, and limits
  /resume [session-id]            List durable sessions or resume one exact session
  /company operations             Find unresolved company goals
  /company run <run-id>           Inspect recorded work, evidence, and failure
  /company resume <run-id>        Resume one exact interrupted company goal

Recovery is explicit and user-present. Inspect a run before resuming it.
Company recovery reconciles the durable record and does not restart settled work.
If a provider connection is missing or unhealthy, use \`recurs provider detect\`,
\`recurs account list\`, or \`recurs setup\`; Recurs never imports, displays, or
reuses provider credentials outside an authorized official flow.
`,
  eval: `Evaluate the bounded company foundation

Usage:
  recurs eval company --list [--json]
  recurs eval company [--scenario company_formation_<quick|guided|deep>_v1] [--json] [-C <dir>]
  recurs eval company --configured --allow-network [--connection <id>] [--json] [-C <dir>]
  recurs eval company --scenario company_goal_execution_v1 --run <id> [--json] [-C <dir>]

Offline evaluation is deterministic, uses a temporary private Recurs home,
exposes only the restricted onboarding read tools, and makes no network request.
Depth-specific scenarios produce distinct Quick, Guided, and Deep evidence;
company_formation_v1 remains a compatibility alias for Guided.
Configured evaluation uses the exact selected or primary direct/local connection
and requires explicit network opt-in. Stored goal evaluation is read-only and
never contacts a provider. Reports are sanitized and contain no prompts,
credentials, private paths, or environment values.
`,
  benchmark: `Run the bounded single-agent versus company proof

Usage:
  recurs benchmark company --list [--json]
  recurs benchmark company --configured --allow-network
                           [--scenario <id>] [--connection <id>]
                           [--repetitions 1|2|3]
                           [--compare-all-strong] [--json]
  recurs benchmark company --resume <campaign-id> --allow-network [--json]

Each trial gets a byte-identical temporary fixture and private Recurs home.
The selected parent-only baseline and the currently configured saved role-route
snapshot share the exact parent route. Add --compare-all-strong to explicitly
schedule an additional all-strong company when saved worker routes differ.
External hidden verification—not model prose—determines correctness.
Normalized reports include activated roles, review, Repair, latency, usage,
cache and cost coverage, overlap, intervention counts, and conservative failure
attribution without prompts, credentials, private paths, or continuation
identifiers. A shared parent-boundary failure remains a reliability failure and
is excluded only from roster evidence when every arm fails at the same parent
boundary before workers activate. Configured execution requires explicit
network consent; interrupted campaigns are immutable and resumable without
replaying settled slots.
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
