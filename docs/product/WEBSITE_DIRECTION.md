# Recurs Website Direction

Status: design brief only. Website implementation is intentionally paused and
belongs in a separate milestone.

Last updated: 2026-08-08

## Purpose

This document preserves the website direction agreed during the Recurs product
work so a future website task can start from the right product story and
interaction model without rushing the design.

It is not an implementation plan, a promise that the website exists, or
permission to copy another product's brand, copy, or feature claims.

## Product truth the site must communicate

Recurs is a coding-agent CLI, not an IDE and not a generic chat wrapper.

Its central idea is:

> The best coding model is a team. You control the team.

The experience should feel like a real, bounded company working on a coding
goal. An orchestrator can coordinate leads, specialists, implementation,
independent review, repair, and synthesis. The user remains in control of the
company rather than receiving an opaque "ultra" button.

The site should make these controls understandable:

- how many agents may activate;
- how many delegation layers may exist;
- which paths work may take through the company;
- which roles and model routes are eligible;
- whether agents may communicate across or upward through layers;
- concurrency, retries, permissions, authority, and spend limits;
- what evidence, review, repair, usage, and final result came back.

Recurs can be positioned as an open-source, user-controlled alternative to
opaque heavy-agent or "Ultra" modes. Do not claim that Recurs is the first,
self-improving, faster, cheaper, or better until reproducible evidence supports
the exact claim.

## Firm experience decisions

1. The website is a separate product milestone. Do not mix it into engine,
   provider, release, or CLI hardening work.
2. The site may study the interaction quality of products such as Pi, but it
   must not copy their product story, feature sequence, language, or visual
   identity.
3. The opening animation lasts no more than about two seconds.
4. The opening is never a blocking splash screen. Scroll, click, keypress, or
   terminal focus interrupts it immediately.
5. The main proof is a genuinely interactive browser terminal, not a video,
   screenshot, or terminal-shaped animation.
6. The terminal comes immediately after the short opening.
7. The supported installation methods come immediately below the terminal.
8. The page must remain honest about what happens in the browser. A client-side
   product tour is a safe simulation, not a real shell and not a claim that an
   agent is editing the visitor's repository.

## Recommended page sequence

### 1. Two-second opening

The opening should establish Recurs's pixel identity and company metaphor in
one short motion: a small root operator appears, connections fan into bounded
layers, and the Recurs mark resolves.

Requirements:

- maximum duration of roughly 1.5 to 2 seconds;
- no scroll lock and no input lock;
- any user interaction ends it immediately;
- the terminal beneath it is already ready;
- reduced-motion users skip directly to the resolved state;
- the logo may provide an explicit replay control;
- returning visitors should not be forced through the animation again.

The opening should not explain the whole product. Its job is recognition and a
clean transition into the product proof.

### 2. Interactive Recurs terminal

The terminal is the hero and the primary demonstration.

It begins an optional, truthful scripted company run so an idle visitor can
understand Recurs. At any point, the visitor can focus the prompt, interrupt
the scripted typing, and take control.

The browser terminal must:

- accept keyboard input and preserve command history for the page session;
- expose clear focus and a real cursor;
- support a small set of commands grounded in the real CLI;
- let the visitor choose or edit a sample coding goal;
- render normalized company activity rather than fake prose logs;
- let the visitor restart the tour through a clearly labeled page control;
- identify itself as a demo environment;
- never execute a host shell, access local files, request credentials, or make
  provider calls;
- remain useful when JavaScript motion is reduced or unavailable.

Real Recurs commands appropriate for the demo include:

```text
/goal <objective>
/goal launch
/agents
/agents controls
/company status
/model auto
/permissions
/status
/help
```

Do not invent permanent CLI commands for the website. Any page-only action,
such as restarting the demonstration, must be visibly labeled as a demo
control rather than presented as a Recurs command.

### 3. Install immediately below the terminal

Show only installation paths that are actually published and verified. At the
time of this brief, the current alpha documentation exposes:

```bash
npm install --global recurs@alpha
bun install --global recurs@alpha
curl -fsSL https://github.com/tacotuesday8888/recurs/releases/download/v0.1.0-alpha.7/install.sh | sh
brew install tacotuesday8888/recurs/recurs
```

The website should source current versions and commands from one maintained
release-data surface rather than duplicating stale strings in multiple
components.

The Bun tab must say that Bun installs the package while Node.js remains the
supported Recurs runtime. Curl and Homebrew must continue to resolve to the
same reviewed release artifact rather than implying independent binaries.

Each method needs a keyboard-accessible tab and copy button. The requirements
and upgrade path should be one click away, not mixed into the hero.

### 4. Concise product proof

After installation, explain the product through one coherent run instead of a
long grid of generic feature cards:

```text
goal -> company forms -> work fans out -> evidence returns
     -> independent review -> repair -> synthesis -> user approval
```

The story should demonstrate control, visibility, and bounded authority. It
should not show every supported command or repeat the repository documentation.

### 5. Evidence and open-source handoff

End with truthful links to the repository, documentation, capability status,
security model, benchmark methodology, and current alpha limitations. A small
"implemented / experimental / planned" distinction is more credible than a
large roadmap or unsupported performance claim.

## Interactive terminal choreography

The default tour should follow the rhythm of a real coding-agent turn without
pretending to contact a model:

1. Type a short sample goal at a human-readable pace.
2. Pause briefly after submission.
3. Show the bounded company and operating-mode decision.
4. Activate only the roles that actually participate in the scenario.
5. Fan implementation work through one or more visible layers.
6. Return concise evidence rather than walls of synthetic logs.
7. Have independent review identify a concrete, understandable issue.
8. Show repair address that issue.
9. Synthesize the result with permissions, requests, usage, and any unknown
   cost labeled honestly.
10. Return control to the prompt.

Recommended motion characteristics:

- prompt typing should be readable, not instant and not theatrically slow;
- pauses should communicate state changes, not pad the run;
- output arrives in bounded bursts so the visitor can follow it;
- the visitor can interrupt before or during any scripted prompt;
- autoplay pauses when the tab is hidden;
- the terminal never loops endlessly without an explicit replay;
- completed output remains inspectable instead of disappearing.

The sample goal should exercise Recurs's actual differentiator. A useful shape
is a small coding fix where implementation succeeds, independent review catches
one issue, repair resolves it, and synthesis reports the evidence. The final
scenario must be checked against the real engine and command vocabulary before
publication.

## Company visualization

The company visualization and the terminal are one interaction, not two
unrelated decorations.

The terminal's normalized events drive the visualization:

- role activation creates a visible node;
- delegation opens a bounded connection;
- work in progress moves a subtle signal along that connection;
- evidence returning travels back toward the parent;
- review and repair use distinct states;
- cancellation, failure, and missing usage remain visible;
- inactive roster members never appear to be working.

The preferred composition is layered and company-like:

- root orchestrator at the top;
- leads or senior roles in the middle;
- bounded specialist or implementation roles below;
- independent review visually separate from the implementation chain;
- curved, dotted connections rather than a generic org-chart grid;
- connections move only while real demo work is in flight;
- selecting a role does not add a large box around its mascot.

Earlier exploration favored small pixel operators or mascots for each level.
Their silhouettes may become slightly more detailed at higher levels, and role
color can help distinguish authority or function. This remains art direction,
not a final asset decision. The future design task should create proper assets
and test them in context rather than improvising CSS or text art.

The visualization must let the visitor understand and adjust at least these
dimensions without exposing a control panel full of jargon:

- team size;
- delegation depth;
- communication routes;
- model selection mode;
- authority profile;
- concurrency or budget intensity.

## Visual direction

Desired qualities:

- terminal-native and pixel-aware without looking like a novelty game;
- a strong black or near-black foundation is a valid direction;
- disciplined color rather than generic neon gradients;
- a centered, slanted Recurs mark where it improves recognition;
- precise alignment, typography, and spacing;
- curved routes and moving dotted signals as a Recurs signature;
- one memorable interaction system rather than many unrelated effects.

Avoid:

- generic AI startup gradients, glass cards, and purple glow;
- a dashboard or IDE frame on the marketing page;
- huge amounts of explanatory copy before the product proof;
- ornamental motion that does not correspond to a state change;
- fake benchmark numbers, fake token savings, or fake model activity;
- copying Pi's cream grid, editorial type, wording, or feature chapters;
- copying Claude Code's mascot or agent-view assets;
- presenting every possible Recurs feature at once.

Color, mascot design, exact typography, and the final wordmark treatment remain
open decisions. They should be chosen through a deliberate visual pass rather
than locked by this document.

## Desktop and mobile behavior

Desktop may place the live company view beside or behind the terminal if the
terminal remains the dominant control surface. The page must not turn into a
full-screen IDE.

On mobile:

- keep the two-second opening interruptible;
- stack the company view with the terminal rather than shrinking both into an
  unreadable split screen;
- keep the prompt and current output readable without horizontal page scroll;
- allow deliberate horizontal scrolling only inside code or install controls;
- avoid sticky storytelling that traps the reader in a tall scene;
- preserve keyboard and focus behavior for real input;
- provide a compact, readable transcript when animation is reduced.

## Accessibility requirements

- Respect `prefers-reduced-motion` and provide a static resolved opening.
- Never require motion to understand hierarchy, status, or completion.
- Use semantic controls with visible focus and usable keyboard order.
- Give the terminal a clear label and concise usage instructions.
- Keep continuously changing output out of an aggressive live region; announce
  only important state transitions politely.
- Provide a readable transcript or equivalent structured status for assistive
  technology.
- Do not flash, rapidly pulse, or depend on color alone.
- Pause scripted activity when the page is not visible.
- Maintain sufficient contrast in the chosen final palette.

## Performance requirements

- The first useful terminal state should render without waiting for the intro.
- Prefer transforms and opacity for motion.
- Avoid a heavy 3D engine or permanent high-frequency canvas loop unless a
  measured prototype proves it necessary.
- Keep the terminal and company state machine deterministic and locally
  testable.
- Load optional visual assets after the essential page structure.
- Test on desktop and mobile with motion enabled and reduced.

## What the Pi study established

The reference was inspected directly in Chrome on desktop and mobile.

Useful interaction principles:

- Pi opens with a short replayable pixel-logo sequence rather than a long
  cinematic gate.
- Its desktop page uses a persistent terminal stage that changes by content
  chapter; mobile replaces that with inline terminal scenes.
- The terminal display is an Asciinema playback, not an interactive input.
- Its recording types prompts, pauses, shows compressed tool output, and lands
  on a visible result.
- Its strongest demonstration has the terminal change the surrounding website,
  so product behavior and page behavior reinforce each other.
- Natural scrolling and restrained typography carry more of the experience
  than constant animation.

Recurs should adopt the principle of behavioral proof, not Pi's implementation
or content. Recurs's improvement is direct visitor control: terminal input
drives a safe demo company, and company events visibly alter the layered map.

Reference: <https://pi.dev/>

## Acceptance criteria for a future website milestone

The website is not ready merely because it looks polished. A future milestone
should require all of the following:

- the opening completes within two seconds and is interruptible by every
  specified input path;
- the terminal accepts keyboard input and cancels scripted typing immediately;
- every demonstrated command exists or is clearly labeled as page-only;
- terminal and company-view state derive from one deterministic event model;
- the sample run shows activation, delegation, evidence, review, repair, and
  synthesis without unsupported claims;
- install methods match the current published release and copy correctly;
- the page works at representative desktop and mobile widths;
- reduced motion, keyboard navigation, focus, and screen-reader output are
  verified;
- performance and layout remain stable without horizontal page overflow;
- content is concise and clearly distinguishes implemented, experimental, and
  planned capabilities;
- the implementation receives visual comparison, interaction, accessibility,
  and code review before release.

## Decisions deliberately left for the website task

- final palette and typography;
- final mascot/operator assets;
- exact headline and supporting copy;
- the representative coding scenario;
- whether the desktop company map sits beside, behind, or immediately below
  the terminal;
- the exact balance between autoplay and an explicit "run demo" action;
- hosting, domain, analytics, and release cadence.

Those decisions should be made together from working visual prototypes. They
should not be rushed as part of unrelated Recurs engine work.
