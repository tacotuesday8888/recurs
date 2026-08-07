# Website design record

## Accepted direction

The selected direction is a true-black page with one cyan-to-mint Recurs
accent family, a large slanted pixel wordmark, and a living company diagram.
The hierarchy moves from parent/orchestrator to leads and specialists. Pixel
mascots gain detail with seniority and animate only when their work state is
active. Selection changes local emphasis and a compact caption; it never adds
a large enclosing card.

Entering the company replaces the map with a credible terminal conversation
and activity stream. It is intentionally not an IDE mockup.

## System

- Background: `#000`; surface: `#090d0d`; foreground: `#f3f7f5`.
- Accent family: Recurs cyan `#3ddbd9` through mint `#b7f34a`.
- Type: system sans for product copy, system monospace for identity and CLI.
- Containers: open composition, hairline rules, no generic card grid.
- Motion: dotted connector travel and tiny working-state mascot ticks; all
  movement is removed by `prefers-reduced-motion`. Downstream sections use one
  progressive IntersectionObserver reveal; content remains visible without JS.

## Copy boundary

The page describes the implemented public alpha as an open-source coding-agent
harness with controlled team size, routes, depth, communication, authority,
and budgets. It makes no benchmark-superiority or self-improvement claim.
Bun is described only as an installer; Node.js 22.22+ remains the runtime.

## Reference audit (2026-08-07)

Current official product sites and documentation were reviewed for interaction
principles, not copied assets or layouts:

- OpenCode: compact promise, immediate multi-channel install switcher, product
  surface adjacent to the hero — <https://dev.opencode.ai/>
- Pi: terse positioning and an install-first documentation path —
  <https://pi.dev/docs/latest>
- Gemini CLI: open-source/terminal framing and direct quickstart —
  <https://github.com/google-gemini/gemini-cli>
- Codex: product continuity across terminal and other surfaces —
  <https://openai.com/codex/>
- Qwen Code: fast install-to-first-prompt path and explicit terminal scope —
  <https://qwenlm.github.io/qwen-code-docs/en/>
- Kimi Code CLI: conversation, activity, and subagent steps remain legible as
  a normal coding-agent transcript — <https://moonshotai.github.io/kimi-cli/>
- goose: plain-language capability framing and visible subagent positioning —
  <https://block.github.io/goose/>
- Aider: direct terminal positioning with a real product demonstration —
  <https://aider.chat/>

Only broad principles were adapted: fast comprehension, honest product UI,
visible installation, and high-signal terminal states. The Recurs composition,
art, mascots, motion, copy, and implementation are original.
