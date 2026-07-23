import type { PermissionIntent, PermissionRisk } from "./types.js";

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = (): void => {
    const segment = current.trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      flush();
      index += 1;
      continue;
    }
    if (character === ";" || character === "\n" || character === "|") {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return segments;
}

function intent(
  category: PermissionIntent["category"],
  resource: string,
  risk: PermissionRisk,
): PermissionIntent {
  return { category, resource, risk };
}

function normalizedShellToken(token: string): string {
  return token
    .replaceAll("\\", "")
    .replaceAll('"', "")
    .replaceAll("'", "");
}

function hasShortOption(token: string, option: string): boolean {
  const normalized = normalizedShellToken(token);
  return normalized.startsWith("-") &&
    !normalized.startsWith("--") &&
    normalized.slice(1).includes(option);
}

function isDestructiveRemoval(tokens: readonly string[]): boolean {
  const commandIndex = tokens.indexOf("rm");
  if (commandIndex < 0) return false;
  return tokens.slice(commandIndex + 1).some((token) => {
    const normalized = normalizedShellToken(token);
    return normalized === "--recursive" ||
      normalized === "--force" ||
      hasShortOption(normalized, "r") ||
      hasShortOption(normalized, "f");
  });
}

function isDestructiveGitCommand(tokens: readonly string[]): boolean {
  if (tokens[0] !== "git") return false;
  const subcommand = tokens[1];
  if (subcommand === "reset") {
    return tokens.slice(2).some((token) =>
      normalizedShellToken(token) === "--hard"
    );
  }
  if (subcommand === "clean") {
    return tokens.slice(2).some((token) => {
      const normalized = normalizedShellToken(token);
      return normalized === "--force" || hasShortOption(normalized, "f");
    });
  }
  if (subcommand === "checkout") {
    return normalizedShellToken(tokens[2] ?? "") === "--";
  }
  return subcommand === "restore" && tokens.length > 2;
}

function classifySegment(segment: string): PermissionIntent {
  const normalized = segment.trim().replace(/\s+/gu, " ");
  const lower = normalized.toLowerCase();
  const tokens = lower.split(" ");

  if (
    /(^|\s)(sudo|doas)(\s|$)/u.test(lower) ||
    isDestructiveRemoval(tokens) ||
    isDestructiveGitCommand(tokens) ||
    /^(?:mkfs|fdisk|diskutil\s+erase|dd\s+if=|shutdown|reboot|halt)(\s|$)/u.test(lower) ||
    /^(?:launchctl|systemctl|service)\s+(?:unload|disable|stop|remove)/u.test(lower) ||
    /(^|\s)(?:eval|bash\s+-c|sh\s+-c|zsh\s+-c)(\s|$)/u.test(lower) ||
    lower.includes("$(") ||
    lower.includes("`")
  ) {
    return intent("shell", normalized, "destructive");
  }

  if (
    /(^|\s)(?:\.env(?:\.|\s|$)|id_rsa|id_ed25519|\.ssh\/|\.aws\/|credentials)(\s|$)/u.test(
      lower,
    ) ||
    /^(?:printenv|env)(\s|$)/u.test(lower)
  ) {
    return intent("credential", normalized, "elevated");
  }

  if (
    /^(?:npm|pnpm|yarn|cargo)\s+publish(\s|$)/u.test(lower) ||
    /^(?:vercel|firebase|fly|railway|kubectl\s+apply)(\s|$)/u.test(lower)
  ) {
    return intent("deploy", normalized, "elevated");
  }

  if (
    /^(?:curl|wget|ssh|scp|sftp|rsync|nc|netcat|ping)(\s|$)/u.test(lower) ||
    /^git\s+(?:clone|fetch|pull|push)(\s|$)/u.test(lower) ||
    /^(?:npm|pnpm|yarn|bun)\s+(?:install|add)(\s|$)/u.test(lower)
  ) {
    return intent("network", normalized, "elevated");
  }

  if (
    /^git\s+(?:status|diff|log|show)(\s|$)/u.test(lower) ||
    /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|build|typecheck|check))(\s|$)/u.test(
      lower,
    ) ||
    /^(?:cargo\s+(?:test|check)|go\s+test|pytest|python\s+-m\s+pytest)(\s|$)/u.test(
      lower,
    ) ||
    /^(?:rg|grep|find|ls|pwd|head|tail|wc|printf|echo)(\s|$)/u.test(lower)
  ) {
    return intent("shell", normalized, "normal");
  }

  return intent("shell", normalized, "elevated");
}

export function classifyCommand(command: string): PermissionIntent[] {
  const normalized = command.trim();
  if (normalized.length === 0) {
    return [];
  }
  if (
    /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sh|bash|zsh)\b/iu.test(normalized)
  ) {
    return [intent("shell", normalized, "destructive")];
  }
  return splitShellSegments(normalized).map(classifySegment);
}
