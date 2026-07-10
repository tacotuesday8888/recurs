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

function classifySegment(segment: string): PermissionIntent {
  const normalized = segment.trim().replace(/\s+/gu, " ");
  const lower = normalized.toLowerCase();

  if (
    /(^|\s)(sudo|doas)(\s|$)/u.test(lower) ||
    /(^|\s)rm\s+[^\n]*(?:-[^\s]*r|--recursive|-[^\s]*f|--force)/u.test(lower) ||
    /^git\s+(?:reset\s+--hard|clean\s+.*-[^\s]*f|checkout\s+--|restore\s+)/u.test(lower) ||
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
