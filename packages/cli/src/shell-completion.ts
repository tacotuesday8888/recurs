/**
 * Static shell completion for the `recurs` command.
 *
 * The scripts describe the reviewed command surface only. They never run
 * Recurs, read private state, or complete session, connection, or file
 * identifiers; those stay explicit user input.
 */

export const COMPLETION_SHELLS = Object.freeze(["bash", "zsh", "fish"] as const);

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string | undefined): value is CompletionShell {
  return value !== undefined && (COMPLETION_SHELLS as readonly string[]).includes(value);
}

interface CommandSpec {
  readonly description: string;
  readonly subcommands?: Readonly<Record<string, string>>;
  readonly options?: readonly string[];
}

const COMMANDS: Readonly<Record<string, CommandSpec>> = Object.freeze({
  run: {
    description: "Run one prompt in one working root",
    options: [
      "--plan", "--format", "--permissions", "--mode", "--connection",
      "--resume", "--continue", "--stdin", "--image", "-C",
    ],
  },
  review: {
    description: "Review the current Git diff in a fresh Plan session",
    options: ["--format", "--permissions", "--mode", "--connection", "-C"],
  },
  setup: {
    description: "Guide provider, model, and permission setup",
    subcommands: {
      local: "Connect a loopback OpenAI-compatible server",
      byok: "Connect a reviewed provider through a named environment variable",
      codex: "Connect an existing ChatGPT Codex subscription",
      copilot: "Connect GitHub Copilot through the official SDK",
    },
  },
  provider: {
    description: "Inspect provider catalog, detection, and runtimes",
    subcommands: {
      list: "List saved and available providers",
      catalog: "Search the provider catalog",
      detect: "Detect local runtimes and accounts",
      runtime: "Inspect one delegated runtime",
      models: "List models for one provider",
    },
  },
  account: {
    description: "Manage saved model connections",
    subcommands: {
      list: "List saved connections",
      "set-primary": "Choose the primary connection",
      route: "Assign an Implement, Review, or Repair route",
      verify: "Verify one saved connection",
      disconnect: "Remove one saved connection",
    },
  },
  doctor: { description: "Check installation and execution readiness", options: ["--json"] },
  mcp: {
    description: "Manage MCP servers",
    subcommands: {
      list: "List MCP servers", add: "Add an MCP server", inspect: "Inspect one MCP server",
      enable: "Enable one MCP server", disable: "Disable one MCP server",
      diagnose: "Diagnose one MCP server", auth: "Authorize one MCP server",
      remove: "Remove one MCP server",
    },
  },
  skills: {
    description: "Manage Agent Skills",
    subcommands: {
      list: "List Agent Skills", inspect: "Inspect one skill", add: "Add a local skill bundle",
      install: "Install a skill from an explicit source", enable: "Enable one skill",
      disable: "Disable one skill", remove: "Remove one skill",
    },
  },
  data: { description: "Locate durable local data", subcommands: { path: "Show the data directory" } },
  hooks: { description: "Inspect bounded user lifecycle hooks", options: ["--json"] },
  permissions: { description: "Inspect exact workspace permission rules", options: ["--json", "-C"] },
  eval: { description: "Run a bounded company evaluation", subcommands: { company: "Evaluate company formation" } },
  benchmark: { description: "Run the company proof benchmark", subcommands: { company: "Compare parent-only and company runs" } },
  acp: { description: "Serve Recurs over ACP on stdio" },
  completion: {
    description: "Print a shell completion script",
    subcommands: { bash: "Bash completion", zsh: "Zsh completion", fish: "Fish completion" },
  },
  help: { description: "Show scoped command help" },
});

const OPTION_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "--format": ["text", "json", "jsonl"],
  "--permissions": ["ask", "approved", "full"],
  "--mode": ["economy", "standard", "balanced", "performance", "max"],
});

const GLOBAL_OPTIONS = Object.freeze(["--help", "--version", "-C"]);

function words(values: Iterable<string>): string {
  return [...values].join(" ");
}

function renderBash(): string {
  const lines = [
    "# recurs bash completion. Load with: eval \"$(recurs completion bash)\"",
    "_recurs() {",
    "  local cur prev command",
    "  COMPREPLY=()",
    "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    "  prev=\"${COMP_WORDS[COMP_CWORD-1]}\"",
    "  command=\"${COMP_WORDS[1]}\"",
    "  case \"$prev\" in",
  ];
  for (const [option, values] of Object.entries(OPTION_VALUES)) {
    lines.push(`    ${option}) COMPREPLY=( $(compgen -W "${words(values)}" -- "$cur") ); return 0 ;;`);
  }
  lines.push(
    "    -C|--image) COMPREPLY=( $(compgen -f -- \"$cur\") ); return 0 ;;",
    "    --connection|--resume|--key-env|--model|--url|--provider) return 0 ;;",
    "  esac",
    "  if [ \"$COMP_CWORD\" -eq 1 ]; then",
    `    COMPREPLY=( $(compgen -W "${words([...Object.keys(COMMANDS), ...GLOBAL_OPTIONS])}" -- "$cur") )`,
    "    return 0",
    "  fi",
    "  case \"$command\" in",
  );
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const candidates = [
      ...Object.keys(spec.subcommands ?? {}),
      ...(spec.options ?? []),
    ];
    if (name === "help") candidates.push(...Object.keys(COMMANDS));
    if (candidates.length === 0) continue;
    lines.push(`    ${name}) COMPREPLY=( $(compgen -W "${words(candidates)}" -- "$cur") ) ;;`);
  }
  lines.push("  esac", "  return 0", "}", "complete -F _recurs recurs", "");
  return lines.join("\n");
}

function zshQuote(value: string): string {
  return value.replaceAll(":", "\\:");
}

function renderZsh(): string {
  const lines = [
    "#compdef recurs",
    "# recurs zsh completion. Load with: eval \"$(recurs completion zsh)\"",
    "_recurs() {",
    "  local -a commands",
    "  commands=(",
    ...Object.entries(COMMANDS).map(([name, spec]) => `    '${name}:${zshQuote(spec.description)}'`),
    "  )",
    "  if (( CURRENT == 2 )); then",
    "    _describe -t commands 'recurs command' commands",
    "    return",
    "  fi",
    "  case \"${words[CURRENT-1]}\" in",
  ];
  for (const [option, values] of Object.entries(OPTION_VALUES)) {
    lines.push(`    ${option}) compadd -- ${words(values)}; return ;;`);
  }
  lines.push(
    "    -C|--image) _files; return ;;",
    "  esac",
    "  local -a candidates",
    "  case \"${words[2]}\" in",
  );
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const candidates = [
      ...Object.entries(spec.subcommands ?? {}).map(([sub, description]) => `'${sub}:${zshQuote(description)}'`),
      ...(spec.options ?? []).map((option) => `'${option}'`),
    ];
    if (name === "help") {
      candidates.push(...Object.entries(COMMANDS).map(([sub, subSpec]) => `'${sub}:${zshQuote(subSpec.description)}'`));
    }
    if (candidates.length === 0) continue;
    lines.push(`    ${name}) candidates=(${candidates.join(" ")}) ;;`);
  }
  lines.push(
    "  esac",
    "  (( ${#candidates} )) && _describe -t candidates 'recurs argument' candidates",
    "}",
    "compdef _recurs recurs",
    "",
  );
  return lines.join("\n");
}

function fishQuote(value: string): string {
  return value.replaceAll("'", "\\'");
}

function renderFish(): string {
  const lines = [
    "# recurs fish completion. Load with: recurs completion fish | source",
    "complete -c recurs -f",
  ];
  const commandNames = Object.keys(COMMANDS).join(" ");
  for (const [name, spec] of Object.entries(COMMANDS)) {
    lines.push(`complete -c recurs -n '__fish_use_subcommand' -a ${name} -d '${fishQuote(spec.description)}'`);
    for (const [sub, description] of Object.entries(spec.subcommands ?? {})) {
      lines.push(`complete -c recurs -n '__fish_seen_subcommand_from ${name}' -a ${sub} -d '${fishQuote(description)}'`);
    }
    for (const option of spec.options ?? []) {
      const values = OPTION_VALUES[option];
      const flag = option.startsWith("--") ? `-l ${option.slice(2)}` : `-s ${option.slice(1)}`;
      lines.push(
        `complete -c recurs -n '__fish_seen_subcommand_from ${name}' ${flag}${
          values === undefined
            ? option === "-C" || option === "--image" ? " -r -F" : ""
            : ` -x -a '${values.join(" ")}'`
        }`,
      );
    }
    if (name === "help") {
      lines.push(`complete -c recurs -n '__fish_seen_subcommand_from help' -a '${commandNames}'`);
    }
  }
  lines.push(
    "complete -c recurs -n '__fish_use_subcommand' -l help -d 'Show help'",
    "complete -c recurs -n '__fish_use_subcommand' -l version -d 'Show the installed version'",
    "complete -c recurs -n '__fish_use_subcommand' -s C -r -F -d 'Working root'",
    "",
  );
  return lines.join("\n");
}

export function renderShellCompletion(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return renderBash();
    case "zsh":
      return renderZsh();
    case "fish":
      return renderFish();
  }
}
