# Product Questions

This is the working decision list for Subagents IDE.

Use it as a checklist. Answer sections in any order. If a question already has a current recommendation or likely answer, that is included so the decision is easier to make.

## How To Answer

For each question, answer with:

- The option letter.
- Any edits or caveats.
- Any examples you want preserved.

Example:

> 2.3: B, but the advanced mode should be hidden behind project settings.

## 1. Positioning And Audience

### 1.1 What should the main category name be?

A. **Agentic engineering operations**

Examples:

- "A command center for agentic engineering work."
- "Run software projects through an AI engineering organization."

B. **Sub-agent development manager**

Examples:

- "A Mac app for managing sub-agents that build software."
- "A manager for planner, builder, QA, security, and deployment agents."

C. **Vibe coding with engineering discipline**

Examples:

- "Keep the speed of vibe coding, but add planning, reviews, tests, and deployment gates."
- "Vibe coding that produces serious code."

Current leaning: C as the plain-language promise, with A or B as the more formal category.

### 1.2 Who should the first version feel built for?

A. **Technical founder or senior builder**

Examples:

- Someone who already uses Cursor, Codex, Claude Code, or OpenCode.
- Someone who understands code quality but wants better agent orchestration.

B. **Product-minded builder**

Examples:

- Someone who knows what they want to build but does not want to manage every code detail.
- Someone who wants a polished guided app-building flow.

C. **Engineering team lead**

Examples:

- Someone coordinating AI agents across an existing team.
- Someone who wants review gates, project memory, and deployment control.

Current decision: A first, while keeping the UX clear enough for B.

### 1.3 What should the product explicitly avoid feeling like?

A. **Beginner-only app builder**

Examples:

- "Describe an app and get a toy prototype."
- "No-code AI app generator."

B. **Traditional IDE clone**

Examples:

- VS Code layout with a file tree, editor, and chat panel.
- Cursor-style coding chat as the main identity.

C. **Generic tool marketplace**

Examples:

- A list of hundreds of MCP servers and skills.
- A plugin shelf without opinionated project guidance.

Current decision: avoid all three.

## 2. App Home And Project Model

### 2.1 What should the app show when first opened?

A. **Calm project launcher**

Examples:

- Logo, app name, and a list of ongoing projects.
- Project cards showing current phase, active agents, last activity, and blocked status.

B. **Global dashboard**

Examples:

- All agents across all projects.
- Global task queue and cross-project activity feed.

C. **Start-new-project wizard**

Examples:

- App opens directly into "What are you building?"
- Existing projects are secondary.

Current decision: A.

### 2.2 How should ongoing projects appear?

A. **Folder-like project cards**

Examples:

- "iOS Fitness App", "Marketing Site Rewrite", "Billing Migration."
- Each card shows active agents and percent complete.

B. **List rows**

Examples:

- Dense table with name, status, last activity, active agents.
- Better for power users with many projects.

C. **Both**

Examples:

- Card view by default.
- List view toggle for power users.

Recommendation: C.

### 2.3 Should there be a hidden/simple "start from scratch" path?

A. **Yes, visible but secondary**

Examples:

- "Skip guided setup" under the main new-project flow.
- Good for advanced users who want a normal coding-agent start.

B. **Yes, hidden in advanced options**

Examples:

- Available from a dropdown or command palette.
- Keeps new users on the guided flow.

C. **No, all new projects go through guided setup**

Examples:

- Every project chooses type, scope, tools, and agents first.
- Stronger consistency, less flexible.

Current leaning: A.

## 3. New Project Onboarding

### 3.1 What should be the strongest v1 path?

A. **New-project creation**

Examples:

- User describes a new app.
- System creates docs, roadmap, tools, agents, and first build.

B. **Existing-project acceleration**

Examples:

- User opens a repo.
- System maps the repo, recommends agents/tools, and starts feature work.

C. **Both equally**

Examples:

- New project and existing project get equal first-run polish.
- Broader but harder to do well.

Current decision: A, while still supporting existing projects.

### 3.2 What should the first serious input be?

A. **Structured setup first**

Examples:

- Pick platform, project type, scope, permissions, and tool range.
- Then add details.

B. **Voice/chat idea dump first**

Examples:

- User talks freely about the app.
- System extracts project type, scope, roadmap, tools, and agents.

C. **Hybrid**

Examples:

- Pick project type first.
- Then voice/chat idea dump.
- Then structured confirmation.

Current decision: C.

### 3.3 How specific should the project-type picker be?

A. **Few broad options**

Examples:

- iOS app.
- Web app.
- Backend.
- Existing project.
- Other.

B. **More specific options**

Examples:

- iOS app.
- macOS app.
- Web app.
- Backend.
- AI/ML.
- Infrastructure.
- Game.
- Plugin or developer tool.
- Existing project.
- Other.

C. **Search-like picker**

Examples:

- User types "AI calendar app."
- System suggests iOS app, AI/ML, backend, and calendar integrations.

Current decision: B.

### 3.4 Should tool recommendations be repo-specific?

A. **Yes, always inspect the repo or project folder when available**

Examples:

- Existing repo has `package.json`, so recommend Node/TypeScript tools.
- iOS project has `.xcodeproj`, so recommend Xcode, simulator, App Store, signing tools.

B. **Only after user approval**

Examples:

- App asks: "Can I inspect this folder to recommend tools?"
- Safer for privacy and trust.

C. **No, start from declared project type only**

Examples:

- User says "web app," so recommend web tools without scanning local files.
- Faster, less accurate.

Recommendation: B for trust, with A as a project setting.

### 3.5 Should the app scan the computer for installed tools?

A. **Yes, during onboarding**

Examples:

- Check for Git, GitHub CLI, Node, Python, Xcode, Docker, package managers.
- Show what is installed and what is missing.

B. **Yes, but only after explicit permission**

Examples:

- "Allow Subagents IDE to check installed developer tools?"
- Good trust posture for a Mac app.

C. **No, ask users to configure tools manually**

Examples:

- User manually picks GitHub CLI, Xcode, Docker, etc.
- Safer but more annoying.

Recommendation: B.

### 3.6 What basic local tools should the app check for?

A. **Core developer tools only**

Examples:

- Git.
- GitHub CLI.
- Node/npm/pnpm.
- Python.
- Xcode command line tools.

B. **Project-specific tools too**

Examples:

- For iOS: Xcode, simulators, CocoaPods, fastlane.
- For web: Node, pnpm, Vercel CLI, Docker.
- For AI/ML: Python, uv, conda, CUDA where relevant.

C. **Full environment inventory**

Examples:

- Shell, package managers, CLIs, cloud CLIs, database tools, language runtimes.
- More complete but easier to overwhelm users.

Recommendation: B, presented in plain categories.

### 3.7 How should tool setup be shown?

A. **Checklist**

Examples:

- Git: installed.
- GitHub CLI: missing.
- Xcode: installed.
- Docker: optional.

B. **Plugin bundles**

Examples:

- "iOS Build Bundle."
- "GitHub Workflow Bundle."
- "Deployment Bundle."

C. **Both**

Examples:

- User sees bundles first.
- Expanding a bundle shows the underlying tools/checklist.

Recommendation: C.

### 3.8 What should the structured confirmation screen show?

A. **Product brief only**

Examples:

- What the user is building.
- Target platform and first version scope.

B. **Roadmap only**

Examples:

- Plan, foundation, core feature, review, deploy.

C. **Agent team and tools only**

Examples:

- Recommended departments, agents, permissions, plugin bundles.

D. **All of the above**

Examples:

- Product brief.
- Roadmap.
- Agent team.
- Tool bundles.
- Permissions.

Current decision: D.

### 3.9 What happens after confirmation?

A. **Launch Agent Team**

Examples:

- Start the first run immediately.
- Planning/tools/docs and safe foundation work begin.

B. **Save setup**

Examples:

- Project is configured but not started.
- Useful if user wants to return later.

C. **Edit more**

Examples:

- User changes scope, tools, agents, or permissions.

Current decision: all three actions should be available.

## 4. Tool And Plugin Management

### 4.1 How should tools be organized?

A. **Individual tools**

Examples:

- GitHub CLI.
- XcodeBuildMCP.
- Vercel CLI.
- RevenueCat.

B. **Bundles/plugins**

Examples:

- iOS Build Bundle.
- GitHub Workflow Bundle.
- Web Deployment Bundle.
- Payments Bundle.

C. **Both**

Examples:

- Bundles by default.
- Advanced view shows individual tools.

Current leaning: C, with bundles as default.

### 4.2 How should tool range work?

A. **Minimal**

Examples:

- Only tools required to begin.
- Faster and less cluttered.

B. **Recommended**

Examples:

- Core tools plus common quality/deployment helpers.
- Best default.

C. **Expanded**

Examples:

- Every relevant plugin, MCP server, CLI, doc source, and template.
- Good for power users.

Current leaning: Recommended as default.

### 4.3 Who decides tool categories?

A. **Fixed categories**

Examples:

- Source control.
- Build.
- Test.
- Deploy.
- Payments.
- Analytics.

B. **AI-generated categories**

Examples:

- For reinforcement learning: simulation, training, evaluation, experiment tracking.
- For iOS: signing, simulator, App Store, crash reporting.

C. **Hybrid**

Examples:

- Fixed top-level categories.
- AI-generated subcategories inside them.

Recommendation: C.

### 4.4 Should the app support repo-specific plugin recommendations?

A. **Yes**

Examples:

- Detects Next.js and suggests Vercel/Next.js docs.
- Detects Firebase and suggests Firebase tools.

B. **No, project type only**

Examples:

- User says "web app," app suggests generic web bundle.

C. **Yes, but user approves repo scan first**

Examples:

- App asks to inspect local files before making repo-specific suggestions.

Recommendation: C.

## 5. Agent Company Model

### 5.1 How many agents should a normal new app start with?

A. **Small team**

Examples:

- Orchestrator.
- Planner.
- Builder.
- Tester.

B. **Full baseline team**

Examples:

- Orchestrator.
- Product planner.
- Architecture agent.
- Tool curator.
- Implementation lead.
- Feature builder.
- QA agent.
- Security/release agent.

C. **Adaptive baseline**

Examples:

- Starts with 7-8 core agents.
- Adds specialists for iOS, payments, infrastructure, AI/ML, etc.

Current decision: C, with at least 7-8 agents to start.

### 5.2 Should departments be fixed or generated?

A. **Fixed departments**

Examples:

- Product.
- Engineering.
- QA.
- Security.
- Tools.
- Deployment.

B. **Generated departments**

Examples:

- AI creates departments like Reinforcement Learning, Payments, Design, iOS Release.

C. **Hybrid departments**

Examples:

- Fixed core departments plus generated project-specific departments.

Current decision: A. Specialists attach inside the closest fixed department.

### 5.3 How should department names feel?

A. **Serious labels**

Examples:

- Product.
- Engineering.
- QA.
- Security.

B. **Branded labels**

Examples:

- Vision Studio.
- Build Forge.
- Test Lab.
- Launch Bay.

C. **Both**

Examples:

- Product: Vision Studio.
- Engineering: Build Forge.

Current decision: A.

### 5.4 How should departments be explored?

A. **Expand/collapse**

Examples:

- Expand Engineering to see agents.
- Collapse it to return to company view.

B. **Detail panel**

Examples:

- Click Security and see current risks, reviews, and agents in the right panel.

C. **Both**

Examples:

- Click opens details.
- Expand reveals child nodes.

Current decision: C.

### 5.5 What should a department detail panel show?

A. **Current work**

Examples:

- Active tasks.
- Blockers.
- Handoffs.
- Review requests.

B. **Who is inside**

Examples:

- Department lead.
- Agent roster.
- Child agents.
- Permissions.

C. **Both**

Examples:

- Current work first.
- Membership second.

Current decision: C.

### 5.6 How should hundreds of agents be displayed?

A. **Company overview**

Examples:

- Departments and teams first.
- Drill down into individual agents.

B. **Active work only**

Examples:

- Only agents doing something now.
- Inactive agents hidden.

C. **Current milestone focus**

Examples:

- Show only agents connected to the current roadmap milestone.

Current decision: A default, with filters for B and C.

## 6. Agent Names And Characters

### 6.1 What visual style should agents use?

A. **Abstract symbols**

Examples:

- Circles, status rings, role icons.
- Easier and more technical.

B. **Character-like agents**

Examples:

- Pixel characters.
- Each agent has a visual identity.

C. **Hybrid**

Examples:

- Character icons inside clean technical graph nodes.

Current decision: B. User will provide pixel character designs later.

### 6.2 Should characters be fixed per agent role?

A. **Fixed identity**

Examples:

- Planner always has the planner character.
- QA always has the QA character.

B. **Skins**

Examples:

- User can assign different characters to roles.

C. **Hybrid**

Examples:

- Fixed defaults, swappable later.

Current decision: A.

### 6.3 How should the main boss/orchestrator be named?

A. **Human-style name**

Examples:

- Bob.
- Ada.
- Jules.
- Miles.

B. **Role-title name**

Examples:

- The Operator.
- The Director.
- The Chief.
- The Conductor.

C. **Brand-specific proper name**

Examples:

- Atlas.
- Nova.
- Maven.
- Hermes.

Recommendation: B or C. Avoid "Bob" unless the product intentionally wants a casual tone.

### 6.4 Should all sub-agents have names?

A. **Yes, name plus role**

Examples:

- Ada, Product Planner.
- Knox, Security Reviewer.
- Juno, QA Agent.

B. **Role labels only**

Examples:

- Product Planner.
- Security Reviewer.
- QA Agent.

C. **Names only after expansion**

Examples:

- Graph shows "QA."
- Detail panel reveals "Juno, QA Agent."

Recommendation: A.

## 7. Workspace And Graph

### 7.1 What is the v1 workspace layout?

A. **Graph-first full canvas**

Examples:

- Graph dominates nearly the whole screen.
- Chat and roadmap are drawers.

B. **Graph-led with right panel**

Examples:

- Main/left area is the graph.
- Right panel is chat plus activity.

C. **Equal multi-panel workspace**

Examples:

- Graph, roadmap, chat, and tasks all share space equally.

Current decision: B.

### 7.2 What should the graph show by default?

A. **Agent relationships**

Examples:

- Who reports to whom.
- Who spawned whom.

B. **Work progress**

Examples:

- Tasks, milestones, blockers, quality gates.

C. **Hybrid**

Examples:

- Agents are main nodes.
- Tasks, reviews, blockers, tools, and milestones attach around them.

Current decision: C.

### 7.3 What should graph connections mean?

A. **Work handoffs**

Examples:

- Builder sends code to QA.
- QA sends failed test back to Engineering.

B. **Authority/reporting**

Examples:

- Orchestrator manages Engineering.
- Engineering lead manages feature builders.

C. **Both, visually different**

Examples:

- Solid lines for reporting.
- Animated lines for handoffs.
- Red lines for blockers.
- Purple/blue lines for reviews.

Current decision: C.

### 7.4 How much animation should the graph use?

A. **Low**

Examples:

- Subtle active status.
- No moving edges.

B. **Medium**

Examples:

- Active agents pulse.
- Handoff lines animate briefly.
- Blockers glow.
- Completed work gets a short effect.

C. **High**

Examples:

- Agents move around.
- Lines constantly animate.
- Characters visibly emote or work.

Current decision: B.

## 8. Chat And Commands

### 8.1 Who does the user talk to by default?

A. **Main boss/orchestrator**

Examples:

- No graph selection means the message goes to the main agent.
- Main agent routes the work.

B. **Whole project**

Examples:

- Message is broadcast to the project.
- Orchestrator decides silently.

C. **Last selected agent**

Examples:

- If user last clicked QA, future messages keep going to QA.

Current decision: A.

### 8.2 Can users target selected nodes?

A. **Yes**

Examples:

- Click Engineering and type "focus on auth."
- Click QA and type "retest signup."

B. **No**

Examples:

- User always talks to main boss.
- Main boss handles routing.

C. **Only advanced users**

Examples:

- Targeting appears after enabling advanced controls.

Current decision: A.

### 8.3 What happens when chat changes work?

A. **Chat only**

Examples:

- Message appears in chat.
- Work changes happen invisibly.

B. **Graph action only**

Examples:

- Command creates task nodes or changes graph state without normal chat output.

C. **Both**

Examples:

- Message appears in chat.
- Graph highlights target and updates tasks/handoffs/blockers.

Current decision: C.

### 8.4 What command strategy should v1 use?

A. **Familiar base plus custom commands**

Examples:

- `/plan`, `/review`, `/test`, `/commit`, `/help`.
- `/launch-team`, `/graph`, `/department`, `/handoff`, `/permissions`.

B. **Mostly copy selected harness commands**

Examples:

- If we start from OpenCode, mirror most OpenCode commands.
- Add only a few product commands.

C. **Mostly our own language**

Examples:

- `/launch-team`, `/assign`, `/inspect-agent`, `/focus-roadmap`.
- Standard coding commands are hidden behind buttons.

Current decision: A.

### 8.5 Should typing `/` only run commands, or also open interface panels?

A. **Command launcher and interface launcher**

Examples:

- `/agent` opens agent search and targeting.
- `/tools` opens tool bundles.
- `/graph` changes graph focus.
- `/approve` opens pending approvals.

B. **Text commands only**

Examples:

- `/review` runs a review.
- `/test` runs tests.
- `/plan` creates a plan.

C. **Separate command palette**

Examples:

- `/review` stays inside chat.
- `Command-K` opens app navigation, panels, tools, and graph actions.

Recommendation: A. It makes `/` feel like the fastest way to control the agent company, while `Command-K` can still exist as a keyboard shortcut for the same launcher.

## 9. Permissions And Safety

### 9.1 How should permission mode be chosen?

A. **Project-wide first**

Examples:

- Conservative.
- Balanced.
- Autonomous.
- Advanced users can override per agent.

B. **Per-agent first**

Examples:

- Each agent shows read-only, scoped write, full access, etc.

C. **Both equally**

Examples:

- User chooses project mode and sees all agent permissions immediately.

Current decision: A.

### 9.2 What should the default mode be?

A. **Conservative**

Examples:

- Most meaningful actions ask for approval.
- Strongest trust posture.

B. **Balanced**

Examples:

- Agents act within scope.
- Reviews gate risky work.

C. **Autonomous**

Examples:

- Agents act freely except secrets, destructive commands, production, and deployment.

Current decision: A.

### 9.3 Where should permission changes appear?

A. **Onboarding and settings only**

Examples:

- User picks mode during setup.
- Later changes it in project settings.

B. **Contextual prompts during work**

Examples:

- App suggests "switch to Balanced" after repeated approvals.

C. **Command-driven**

Examples:

- User types `/permissions` to inspect or change modes.

Current decision: A for normal UI. `/permissions` can exist for inspection.

### 9.4 What actions always require explicit approval?

A. **Safety-critical only**

Examples:

- Secrets.
- Destructive commands.
- Production changes.
- Deployment.

B. **Code-changing actions too**

Examples:

- Any file edit.
- Any dependency install.

C. **Configurable**

Examples:

- Conservative requires approval for edits.
- Balanced allows scoped edits.
- Autonomous allows more, but never secrets/destructive/deploy.

Recommendation: C, with safety-critical always gated.

## 10. Harness And Core Engine

### 10.1 What is the high-level harness direction?

A. **Wrap one existing harness**

Examples:

- Use OpenCode or another agent engine directly.
- Build UI around it.

B. **First-party engine informed by open source**

Examples:

- Study OpenCode, Pi, Aider, Cline, OpenHands, LangGraph, ACP, etc.
- Build our own coherent system using legally reusable ideas.

C. **Bring your own agent**

Examples:

- Users choose any installed coding agent.
- App wraps whatever it finds.

Current decision: B.

### 10.2 What should research produce?

A. **Survey only**

Examples:

- List agents, licenses, good ideas, risks.

B. **Architecture recommendation only**

Examples:

- Define our command layer, runtime, permissions, graph event model.

C. **Both**

Examples:

- `HARNESS_RESEARCH.md`.
- `HARNESS_APPROACH.md`.

Current decision: C. This is being handled in the separate harness research thread.

### 10.3 What should the first engine build prove?

A. **Slash command loop**

Examples:

- `/plan`, `/review`, `/test`, `/launch-team`.
- Commands route to agents and update chat/graph state.

B. **Multi-agent runtime**

Examples:

- Orchestrator spawns planner, builder, QA, and security agents.
- Agents hand off tasks.

C. **Permission and sandbox layer**

Examples:

- Conservative mode gates file edits and commands.
- Tool access is explicit.

D. **End-to-end thin slice**

Examples:

- New project setup.
- Tool readiness and bundle setup.
- Launch Agent Team.
- Agents produce plan, one code change, review, test result, and graph updates.

Current decision: D, and tool-readiness must be included. In plain language, the first prototype should prove that onboarding, tool setup, agent-company creation, and visible work state connect into one flow.

### 10.4 Should v1 use an existing engine internally while our first-party engine matures?

A. **Yes**

Examples:

- Use one existing coding engine for execution.
- Our app owns commands, graph, permissions, docs, and orchestration.

B. **No**

Examples:

- Build the full execution runtime ourselves from the start.

C. **Only for prototyping**

Examples:

- Use existing engines to learn.
- Replace before public release.

Recommendation: A or C depending on license/research findings.

### 10.5 Should the CLI be part of the core product?

A. **Yes, as a second surface over the same engine**

Examples:

- Mac app shows the live company graph.
- CLI runs the same commands from terminal.
- `subagents review` and `/review` create the same internal command event.

B. **Yes, but only after the Mac app is mature**

Examples:

- Build the Mac app first.
- Add CLI once project state, commands, permissions, and worker runtime are stable.

C. **No, Mac app only**

Examples:

- All orchestration happens through the visual app.
- Terminal users use existing external coding agents instead.

Recommendation: A. The CLI should be designed into the architecture now, even if the Mac app ships first.

### 10.6 What should the first CLI prove?

A. **Project and status commands**

Examples:

- `subagents projects list`.
- `subagents graph status`.
- `subagents roadmap`.

B. **Command execution**

Examples:

- `subagents ask "build the onboarding flow"`.
- `subagents review`.
- `subagents test`.

C. **Approval and safety loop**

Examples:

- `subagents approvals`.
- `subagents approve <id>`.
- `subagents deny <id>`.

D. **Thin slice of all three**

Examples:

- Select a project.
- Ask the boss/orchestrator for work.
- Inspect graph status.
- Approve one gated action.
- See roadmap or review output update.

Recommendation: D.

### 10.7 How should the CLI ship?

A. **Bundled with the Mac app**

Examples:

- User installs the Mac app.
- The app offers to install `subagents` into the shell path.

B. **Separate package**

Examples:

- Install with Homebrew or a direct binary download.
- Useful for servers, CI, and terminal-first users.

C. **Both**

Examples:

- Mac app bundles the CLI for normal users.
- Separate package exists for headless and advanced environments.

Recommendation: C eventually, with A as the simplest first path.

## 11. Project Memory And Documentation

### 11.1 What docs should the app generate inside user projects?

A. **Minimal docs**

Examples:

- Product brief.
- Roadmap.
- Agent plan.

B. **Full project memory**

Examples:

- Product brief.
- Architecture.
- Roadmap.
- Agent plan.
- Tool choices.
- Risks.
- Open questions.
- Deployment notes.

C. **Adaptive docs**

Examples:

- Small projects get minimal docs.
- Serious projects get full memory.

Recommendation: C.

### 11.2 Should docs be user-editable?

A. **Yes, directly**

Examples:

- User edits Markdown in app.
- Agents read the updated docs.

B. **Yes, through guided changes**

Examples:

- User says "change target platform to iOS."
- App updates docs.

C. **Both**

Examples:

- Direct editing for power users.
- Guided changes for normal flow.

Recommendation: C.

### 11.3 Should generated docs be repo-specific?

A. **Yes**

Examples:

- Existing project docs mention actual frameworks, file structure, and dependencies.

B. **No**

Examples:

- Docs stay generic from onboarding answers.

C. **With permission**

Examples:

- App asks to inspect repo before creating repo-specific docs.

Recommendation: C.

## 12. Roadmap And Quality Proof

### 12.1 What should completion percentage mean?

A. **Task count**

Examples:

- 7 of 10 tasks complete means 70%.

B. **Quality gates**

Examples:

- Scope approved.
- Build passes.
- Tests pass.
- Reviews complete.
- Deployment ready.

C. **Weighted mix**

Examples:

- Milestones plus gates plus blockers.

Recommendation: C.

### 12.2 What quality proof should v1 show?

A. **Basic proof**

Examples:

- Build result.
- Test result.
- Review summary.

B. **Detailed proof**

Examples:

- Tests added.
- Files changed.
- Risk notes.
- Security review.
- Deployment readiness.

C. **Progressive proof**

Examples:

- Basic proof in normal view.
- Detailed proof when expanded.

Current decision: C.

### 12.3 What should happen when quality gates fail?

A. **Stop and ask**

Examples:

- QA fails.
- User approves retry or scope change.

B. **Auto-route to responsible department**

Examples:

- QA failure goes back to Engineering.
- Security issue goes to Security and Engineering.

C. **Both depending on permission mode**

Examples:

- Conservative asks.
- Balanced auto-routes inside scope.

Recommendation: C.

## 13. Deployment, Infrastructure, Maintenance

### 13.1 How prominent should deployment be in v1?

This question means: should deployment be mandatory for every v1 project, optional when the user is ready, or postponed entirely?

A. **Core v1 path**

Examples:

- Every project has deployment planning and release checks.

B. **Optional track**

Examples:

- Deployment panel exists but does not block early builds.

C. **Later**

Examples:

- V1 focuses on building and review only.

Recommendation: B. Deployment should be available as an optional track, but early projects should not be blocked just because deployment is not configured yet.

### 13.2 How should infrastructure choices work?

A. **User picks stack**

Examples:

- Supabase, Firebase, custom backend, Vercel, AWS.

B. **AI recommends stack**

Examples:

- Based on project type and scope, app recommends backend/payment/deploy stack.

C. **AI recommends, user confirms**

Examples:

- App suggests Supabase + Stripe + Vercel.
- User accepts or changes.

Recommendation: C.

### 13.3 When should maintenance/marketing agents appear?

A. **In v1**

Examples:

- Always-on maintenance and launch agent.

B. **Beta feature**

Examples:

- Available after project ships.
- Optional maintenance/marketing track.

C. **Later**

Examples:

- Not in first product.

Current leaning: B.

## 14. Business, Packaging, And Trust

### 14.1 How local should the Mac app be?

A. **Mostly local**

Examples:

- Local project files.
- Local tool checks.
- Local logs.

B. **Cloud-assisted**

Examples:

- Cloud runners for heavy agent work.
- Local app remains command center.

C. **Hybrid**

Examples:

- Local by default.
- Cloud optional for long-running teams or large jobs.

Recommendation: C.

### 14.2 How should secrets be handled?

A. **Never store secrets**

Examples:

- User provides tokens per session.

B. **Use macOS secure storage**

Examples:

- Keychain for API keys.
- Redacted logs.

C. **External secret manager**

Examples:

- 1Password, Doppler, cloud secret stores.

Current decision: A. Recurs stores only non-secret connection metadata and
reads direct-provider credentials from a named process environment variable.

### 14.3 What should be the trust promise?

A. **Safe by default**

Examples:

- Conservative mode.
- Explicit approvals.
- No secret printing.

B. **Fast by default**

Examples:

- Agents act quickly and ask less.

C. **Configurable autonomy**

Examples:

- Safe default, faster modes when user chooses.

Current decision: C with A as default.

### 14.4 How should users connect model access?

A. **Bring your own API keys**

Examples:

- User connects OpenAI API key.
- User connects Anthropic API key.
- API keys remain in a named process environment variable and are not persisted
  by Recurs.

B. **Official coding-client integrations**

Examples:

- Use Claude Code if it is installed and authenticated.
- Use Codex-style official auth where supported.
- Route tasks through those clients without exposing their internals to the user.

C. **Managed credits**

Examples:

- User pays Subagents IDE for included usage.
- App handles provider billing behind the scenes.

Current decision: A and B for v1. C can come later.

### 14.5 What should the default model mode be?

A. **Quality-first**

Examples:

- Best available model for most agents.
- Higher cost, strongest default quality.

B. **Balanced**

Examples:

- Best model for boss/orchestrator, architect, security, and final review.
- Cheaper or faster models for bounded subtasks, summaries, and routine checks.

C. **Economy**

Examples:

- Cheap models by default.
- Escalate only when the user asks or a task fails.

Current decision: B.

## 15. What To Answer First

If you want to move fastest, answer these first:

1. 3.4: Should tool recommendations be repo-specific?
2. 3.5: Should the app scan the computer for installed tools?
3. 6.3: What should the main boss/orchestrator be named?
4. 11.1: What docs should the app generate inside user projects?
5. 13.1: How prominent should deployment be in v1?
6. 14.1: How local should the Mac app be?
7. 14.2: How should secrets be handled?
