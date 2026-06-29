# Product Design

## One-Line Promise

Run a serious coding project through a managed team of specialized agents, with scope, review, tooling, progress, and handoffs visible.

## Category

This should feel like a new kind of agentic development environment.

It is not a traditional IDE, not a VS Code clone, and not just another chat-first coding assistant. Products like Cursor, Chat Codex, Claude Code, and Windsurf are powerful, but the experience often still feels centered on one agent or one chat thread. Sub-agents may exist, but users usually need to intentionally call them out or manage the coordination themselves.

This product makes sub-agent orchestration the core interface.

Possible category language:

- Agentic engineering operations.
- Sub-agent development manager.
- AI engineering command center.
- Vibe coding with engineering discipline.

## Positioning

The product should not feel like it is only for non-technical users.

The stronger position is:

> A professional agentic development environment where the core interface is a managed team of specialized coding agents.

The product can become great for non-technical users because the UX is excellent, but the first version should earn trust from technical founders and senior builders.

## Primary User

The first user is a technical founder or senior builder.

This user understands software, code quality, scope, deployment, and technical risk. Their problem is not that they cannot code. Their problem is that AI coding workflows can become messy:

- One agent tries to do too much.
- Multi-agent orchestration requires manual prompting.
- MCP servers, skills, plugins, and CLIs become confusing.
- Generated code can be sloppy.
- Review loops are inconsistent.
- Project memory is weak.
- Tooling setup is repetitive.
- Deployment is still a separate, painful process.

The app should make this user feel like they are managing a high-performing AI engineering team.

## Secondary User

The secondary user is a product-minded builder who knows what they want but does not want to manage every code detail.

The app should be clear enough for this person, but should not be designed in a way that makes technical users feel like it is a simplified toy.

## Core Thesis

Vibe coding is powerful because it collapses the distance between idea and software. The weakness is that the workflow often lacks engineering discipline.

This product keeps the speed and creativity, then adds:

- Agent team design.
- Scoped execution.
- Specialist review.
- Testing.
- Security checks.
- Tool curation.
- Deployment guidance.
- Project memory.
- Roadmap progress.
- Clear handoffs.

## Core Differentiator

The differentiated experience is A plus B. C is the proof.

### A. Agent Team Design

The system proposes the right "agent company" for the project.

This should feel like a company, not a flat list of assistants.

The agent organization can have levels:

- Executive or project-lead level: orchestrator and high-level planning.
- Senior staff level: architecture, implementation lead, product planning, and tool strategy.
- Specialist level: testing, security, deployment, infrastructure, payments, design, and domain experts.
- Builder level: scoped implementers working on bounded code areas.
- Spawned worker level: temporary child agents created by senior agents or specialists for specific tasks.

Departments should be fixed in v1 so users learn a stable mental model:

- Product.
- Engineering.
- QA.
- Security.
- Tools.
- Deployment.

Project-specific specialists can still exist, but they should attach inside the closest matching fixed department rather than creating new top-level departments.

For a normal new app project, v1 should start with at least 7-8 pre-built sub-agents. The team can still be adaptive, but the default should feel meaningfully sub-agent-heavy from the start rather than showing only a tiny 3-agent setup.

Long term, the architecture should support much larger agent organizations, including hundreds of sub-agents when a project requires it. The UI should not show 300-400 agents as one flat graph. It should group them into teams, departments, squads, or collapsed branches so the user sees the company structure clearly.

Baseline roles the product may recommend:

- Project planner.
- Orchestrator.
- Implementation lead.
- Scoped implementers.
- Testing specialist.
- Security reviewer.
- Tool curator.
- Deployment guide.
- Maintenance or marketing agent later.
- Domain specialists for work like iOS, web, payments, infrastructure, or reinforcement learning.

These roles are product concepts at this stage, not separate Markdown prompt files in this repo.

The v1 model should use pre-built agents with strong built-in system prompts. Users should not need to write custom agents from scratch during onboarding.

Users should configure agent autonomy through permission presets. Advanced custom agent creation can come later.

Example permission presets:

- Ask for approval: agent proposes actions and waits for user confirmation.
- Auto-review: agent can act inside scope, but another agent must review before completion.
- Full access: agent has broad autonomy, reserved for trusted or low-risk scopes.
- Read-only: agent can inspect, explain, and advise, but cannot change files.
- Scoped write: agent can edit only approved files, folders, or modules.
- Deploy-gated: agent can prepare release work, but cannot ship without approval.

Onboarding should ask for a project-wide autonomy mode first:

- Conservative: most meaningful actions require approval.
- Balanced: agents can act inside scope, with review gates for important work.
- Autonomous: agents can act more freely, while deployment, secrets, destructive commands, and production changes still require approval.

Advanced users can override permissions per agent after choosing the project-wide mode.

The default mode should always be Conservative. This builds trust and prevents the product from feeling reckless.

Mode changes should not appear as part of normal coding-task output. For now, permission mode selection belongs in onboarding and project settings. More adaptive suggestions can be explored later, but they should not interrupt agent work.

### B. Live Agent Operations

The user sees the team working:

- Which agents exist.
- Why each agent exists.
- What each agent is doing.
- How agents connect.
- Which tools they use.
- Which tasks are blocked.
- Which handoffs happened.
- Which reviews passed.
- Which approvals are needed.
- Which senior agents spawned child agents.
- How large sub-agent groups roll up into visible teams or departments.

### C. Quality Proof

The product must prove the method works through better software output:

- Cleaner diffs.
- Better tests.
- Better docs.
- Fewer broken files.
- Stronger security checks.
- Clearer PRs.
- Deployment readiness.

## Product Is Not

- A normal IDE with a chat panel.
- A generic app builder for beginners.
- A marketplace of random tools.
- A cluttered list of individual skills.
- A decorative agent visualization.
- A literal office simulator as the core product.

## Product Is

- A Mac app for managing multiple AI coding projects.
- A first-party agentic development engine that can also expose a CLI.
- A calm project launcher at the app level.
- A serious sub-agent workspace inside each project.
- A guided setup flow for scope, development style, and tools.
- A system that recommends an agent team and plugin bundle.
- A connected, operational map of agents and work.
- A roadmap with real quality gates.
- A layer above one or more coding harnesses.

## Feature Inventory

The product should be understood as a complete development operating system for agentic work, not only a chat app with extra agents.

Core feature areas:

- Project launcher: shows ongoing projects, status, active agents, last activity, and blocked state.
- Guided onboarding: turns project type, scope, voice/chat description, development style, permissions, and tool choices into a ready project setup.
- Tool readiness: checks local tools, recommends MCP servers, skills, CLIs, docs, templates, and plugins, then groups them into understandable bundles.
- Agent company: creates a visible hierarchy of departments, senior agents, specialists, builders, reviewers, and spawned child agents.
- Live graph: shows who is working, how agents connect, where tasks are blocked, which tools are being used, and how work moves between agents.
- Command surface: lets users type normal messages, use slash commands, open panels with `/`, click graph nodes, or use the CLI while hitting the same underlying engine.
- Roadmap: tracks real progress through gates such as scope, architecture, implementation, tests, review, security, deployment, and maintenance.
- Quality proof: records diffs, tests, reviews, security checks, docs updates, deployment readiness, and remaining risks.
- Project memory: generates and maintains readable project docs such as product brief, architecture notes, agent plan, roadmap, tool choices, risks, and open questions.
- Deployment and infrastructure: guides backend, payments, hosting, app store release, environment setup, and release checks.
- Maintenance and marketing: later beta area for ongoing project health, launch work, and recurring improvement suggestions.

Important missing or underdefined areas to resolve:

- Account and billing: how the app charges, tracks model/tool usage, and explains cost.
- Model/provider strategy: which LLM providers are supported and how users choose between speed, cost, and quality.
- Local security model: how files, secrets, approvals, sandboxes, and destructive actions are protected.
- Collaboration: whether multiple humans can share one project, assign approvals, and view the same agent company.
- Observability: how users inspect runs, logs, failed tool calls, agent mistakes, and replayable decisions.
- Recovery: how users undo work, roll back tasks, pause agents, resume runs, or recover from bad changes.
- Marketplace boundary: which plugin bundles are first-party, community-made, project-generated, or private to a team.
- Evaluation loop: how the product proves that the sub-agent approach produces better code over time.

## Product Surfaces

The Mac app should be the flagship experience because the product's strongest idea is visual: a live company graph of agents, departments, tasks, handoffs, reviews, blockers, tools, and quality gates.

The CLI should exist as a second surface over the same engine, not as a separate product and not as a stripped-down clone. The CLI is useful when users want to work from a terminal, run project automation, trigger agent workflows from scripts, or use the product on machines where the full Mac UI is not active.

The shared engine should make both surfaces feel consistent:

- Same projects.
- Same boss/orchestrator.
- Same agent company.
- Same permissions.
- Same tool bundles.
- Same roadmap state.
- Same review and approval rules.
- Same project memory.

The Mac app is best for seeing and managing the company. The CLI is best for direct commands, scripting, automation, remote work, and quick project actions.

Example CLI commands:

- `subagents projects list`: show known projects.
- `subagents open <project>`: select the active project.
- `subagents launch-team`: create or refresh the recommended agent company.
- `subagents ask "build the onboarding flow"`: send a message to the boss/orchestrator.
- `subagents agent qa ask "retest signup"`: target a specific agent.
- `subagents graph status`: print the current departments, active agents, blockers, and reviews.
- `subagents approvals`: list pending approval requests.
- `subagents approve <id>`: approve a specific action.
- `subagents roadmap`: show milestone and quality-gate progress.

## App Home

The app opens calmly.

The home screen should show:

- Logo or app name.
- Ongoing projects as folders, cards, or list rows.
- Project status.
- Current phase.
- Active agent count.
- Last activity.
- New project action.
- Open existing project action.

The home screen should not expose all agent complexity. It is a polished project launcher.

## Project Workspace

Opening a project reveals the actual product.

The workspace should include:

- Agent relationship graph.
- Command chat.
- Roadmap.
- Active tasks.
- Review and approval queue.
- Tool bundle panel.
- Generated project docs.
- Deployment path.
- Activity timeline.

Chat is available, but chat is not the whole product. The unique interface is the connected sub-agent system around the chat.

The v1 workspace should be graph-led, not split into disconnected sections. The left or main area should be the connected sub-agent map. A compact right-side agent-manager panel can preserve the familiar vibe-coding flow: chat, approvals, reviews, task updates, and summaries.

Balanced means the user can still talk to the project normally, not that every surface gets equal space.

The right-side panel should combine chat-first and activity-first behavior. The user should be able to talk to the project normally, but the same stream should expose agent activity, handoffs, blockers, review requests, and approvals. It should not feel like chat hiding the work; it should feel like chat embedded in a live operations feed.

The user should be able to talk to both the whole project and selected graph nodes. By default, chat targets the whole project. If an agent, department, task, blocker, or review is selected, the user can target that selection directly before sending.

Examples:

- Whole project: "Build the onboarding flow."
- Selected Security department: "What risks do you see?"
- Selected Engineering department: "Focus on auth first."
- Selected QA agent: "Retest the signup flow."

When no graph node is selected, the user talks to the main boss agent. This is the starting agent that handles routing, orchestration, delegation, and summaries. It should have a memorable name, but "Bob" is only a placeholder until the naming system is designed.

All sub-agents should have distinct names, not only functional role labels. The role should stay clear, but the name gives the agent more identity.

When a specific agent responds, the chat/activity output should make the speaker obvious. For example:

- A visually outlined message card.
- Agent character/avatar shown beside the message.
- Agent name and role displayed together.
- Department color or badge.
- Graph node highlighted while the message is active.

If a targeted message changes work, it should appear in chat and update the graph. For example, a command to Engineering can create or update a task node, highlight Engineering, and show the related handoff or dependency.

This is the chosen interaction model: targeted commands are both chat messages and graph actions when they change project state.

## Agent Graph

The graph is the most distinctive product surface.

It should feel inspired by connected-map tools like Obsidian, but it represents live development work rather than notes.

The graph should show:

- Agents.
- Tasks.
- Tools.
- Handoffs.
- Blockers.
- Reviews.
- Milestones.
- Parent-child sub-agent relationships.
- Collapsed teams or departments when many sub-agents exist.

The graph must be operational. Clicking an agent, connection, task, blocker, review, or tool should reveal real state and useful controls.

Connections should represent both authority structure and live work flow, but they must look different. For example:

- Solid lines for reporting, ownership, or department membership.
- Animated or highlighted lines for live handoffs.
- Red lines for blockers.
- Purple or blue lines for reviews.
- Tool-specific lines when agents are using a plugin, MCP, CLI, or doc bundle.

Graph animation should be medium intensity:

- Active agents can subtly pulse.
- Handoff lines can animate briefly.
- Blockers can glow red.
- Completed work can trigger a short checkmark effect.

The graph should feel alive without becoming distracting.

The graph should dominate the main area of the v1 interface, while a smaller right-side panel keeps concrete work controls close. This makes the product feel meaningfully different from chat-first tools without removing the familiar command flow.

The default graph model should be hybrid. Agents are the main nodes and feel like the main characters, while tasks, reviews, tools, blockers, and milestones appear attached around them. This avoids a purely abstract relationship map and avoids turning the product into a normal project board.

For large projects, the graph should support progressive disclosure:

- Top level: departments, teams, senior agents, and major milestones.
- Expanded level: individual agents, tasks, reviews, and tools.
- Deep level: temporary spawned sub-agents and execution details.

This lets the product scale to a heavy multi-agent approach without overwhelming the user.

When many agents exist, the default view should be a company overview: departments and teams first, with individual agents visible when expanded. The graph should also offer filters for active work only and current milestone focus.

Departments should be mostly fixed so users learn a stable mental model. Default departments:

- Product.
- Engineering.
- QA.
- Security.
- Tools.
- Deployment.

Project-specific specialists can still appear inside the closest matching department instead of creating a new department every time.

Department names should use serious labels in v1. The product's personality should come from agent characters, motion, and visual polish rather than renaming core departments.

Department interaction should support both detail panels and expand/collapse:

- Single click can show department details in the right-side panel.
- Expand controls can reveal agents, teams, and spawned workers inside the graph.
- Collapse controls can return the graph to a clean company overview.

When a department is selected, the right panel should show both current work and department membership. Current work comes first, then the agents inside the department.

Example:

- Current work: active tasks, blockers, handoffs, review requests, approvals.
- Membership: department lead, agents, spawned child agents, permissions.

## Roadmap

The roadmap should be visible and motivating, with checkmarks and a completion percentage.

It should not be fake progress. It should be tied to real gates:

- Scope approved.
- Agent team configured.
- Tool bundle configured.
- Architecture decided.
- Code implemented.
- Tests passed.
- Review passed.
- Security checked where needed.
- Deployment ready.

The roadmap can borrow the satisfaction of a Duolingo-style path, but should feel more professional.

## Onboarding

Onboarding begins by asking what the user is building so the system can tailor tools and agents.

The v1 emphasis should be new-project creation. Existing-project support should still exist, but the strongest first-run experience should be: describe a new app, define scope, generate docs, recommend agents and tools, build the first version, and show progress through the graph and roadmap.

The new-project intake should be hybrid:

1. One quick project-type choice first.
2. Natural voice or chat idea dump second.
3. Structured confirmation third.

This gives the system enough context to ask better questions while still letting the user explain the idea naturally.

The project-type picker should use specific options, grouped visually so it does not feel overwhelming. Example options:

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

After the voice/chat idea dump, the structured confirmation screen should show all major outputs in one review flow, ordered from intent to execution:

1. Product brief: what the user is building.
2. Roadmap: how the app will be built.
3. Agent team: which pre-built agents are recommended and why.
4. Tool bundles: which plugins, MCP servers, skills, CLIs, docs, and templates are recommended.
5. Permissions: the default Conservative mode, with optional project settings for changes.

After confirmation, the user should choose one of three actions:

- Launch Agent Team.
- Save setup.
- Edit more.

This gives the user control without making onboarding feel heavy.

If the user chooses Launch Agent Team, the first visible work should be a split pass:

- Planner and tool-related agents prepare docs, architecture, roadmap, and tool setup.
- Builder-related agents begin safe foundation work in parallel.
- Review gates still apply before risky or final changes are treated as complete.

This makes the app feel fast while preserving discipline.

Core steps:

1. Choose new project, existing project, or skip guided setup.
2. Choose project type: iOS app, website, existing codebase, backend, infrastructure, AI/ML, reinforcement learning, or other.
3. Define scope.
4. Choose development style.
5. Choose development path.
6. Choose tool range.
7. Review recommended plugin/tool bundles.
8. Optionally complete a voice interview.
9. Confirm generated docs, roadmap, agents, and tools.
10. Enter the project workspace.

Guided onboarding should be skippable, but the app should make the guided path feel valuable.

## Voice Interview

The voice section lets the user talk through the app in detail.

It should feel like discussing the project with a senior product/engineering partner. The AI should ask follow-up questions and generate structured project memory.

Outputs:

- Product brief.
- Architecture notes.
- Agent team recommendation.
- Roadmap.
- Tool bundle recommendation.
- Open questions.
- Risks.

## Development Style Choices

The product should let users choose how agents orchestrate the project.

### Heavy Sub-Agent Model

The product default.

Best for serious projects where quality, review, and specialization matter.

### One Big Orchestrator

Best for smaller or medium projects where the user wants less visible agent complexity.

### Single Agent

Best for very simple work or users who want a normal coding-agent flow.

This should exist, but it is not the main product identity.

## Development Path Choices

### One-Shot MVP

The orchestrator tries to generate an MVP immediately.

Useful for small prototypes, but risky for broad scopes.

### Multi-Phase Build

The project is built in three or four phases with review gates.

This is the safer default for serious projects.

## Plugin and Tool Management

The user does not want a cluttered list of individual skills.

The app should group MCP servers, skills, CLIs, docs, repos, and templates into coherent bundles.

Bundles can be organized by:

- Project type.
- Source, such as a specific GitHub repo or vendor.
- Function, such as testing, security, deployment, billing, design, or infrastructure.
- AI-generated categories when no clean source category exists.

Tool range:

- Minimal: only the most needed tools.
- Recommended: the safest default.
- Expanded: every related tool for power users.

For specialized work like reinforcement learning, the AI should create categories and let users batch-add tools with checkboxes.

## Slash Commands

The product should support a familiar slash-command layer. This is a better way to think about the core engine than starting with abstract harness language.

Many coding agents already use command patterns such as review, plan, test, commit, help, undo, redo, or custom commands. The app should use that familiar convention, then add commands that are specific to the sub-agent company model.

Existing agent commands should be treated as inspiration or integration targets, not copied blindly if licenses or prompts do not allow it. Generic command names and workflow ideas can be adapted, but proprietary prompts or configs should not be copied without permission.

Typing `/` should open a command launcher, not only insert text into chat. The launcher should expose commands, panels, graph actions, agent targets, tool actions, and roadmap actions from the same place.

Examples:

- Type `/agent` to open agent search and inspect or target a specific agent.
- Type `/department` to focus Product, Engineering, QA, Security, Tools, or Deployment.
- Type `/graph` to switch graph focus, such as company overview, active work, or current milestone.
- Type `/tools` to open tool bundles and see what is installed, missing, or recommended.
- Type `/roadmap` to jump to roadmap progress and quality gates.
- Type `/approve` to view pending approvals and approve or deny a gated action.
- Type `/spawn` to create a scoped child agent when the selected agent has permission.

Example familiar commands:

- `/plan`: create or update the implementation plan.
- `/review`: review current changes.
- `/test`: run or request verification.
- `/commit`: prepare a commit.
- `/undo`: undo a recent agent action when supported.
- `/help`: show available commands.

Example product-specific commands:

- `/launch-team`: start the recommended agent team.
- `/agent`: inspect or target an agent.
- `/department`: inspect or target a department.
- `/graph`: change graph view or focus.
- `/handoff`: show recent handoffs.
- `/blockers`: show blocked work.
- `/roadmap`: show or update roadmap state.
- `/tools`: inspect tool bundles.
- `/permissions`: inspect project autonomy and agent permissions.

Slash commands should work with the graph. If a command changes work state, the graph and chat/activity panel should both update.

The v1 command strategy should be familiar base commands plus product-specific company commands.

Baseline familiar commands:

- `/plan`
- `/review`
- `/test`
- `/commit`
- `/help`

Product-specific commands:

- `/launch-team`
- `/agent`
- `/department`
- `/graph`
- `/handoff`
- `/blockers`
- `/roadmap`
- `/tools`
- `/permissions`
- `/spawn`
- `/approve`

This keeps the product comfortable for users who already know coding agents while making the sub-agent company model feel native.

The slash launcher should be context-aware:

- No graph selection: commands target the boss/orchestrator by default.
- Agent selected: commands can ask, inspect, pause, review, or change that agent's scope.
- Department selected: commands can focus the department, show current work, assign a task, or inspect permissions.
- Task selected: commands can review, retest, reassign, split, pause, or mark blocked.
- Tool selected: commands can inspect setup, run a safe check, request installation, or change bundle membership.

This turns `/` into a fast navigation and control layer for the app, not just a coding-agent command syntax.

## Core Engine Direction

The product should not be a generic "bring your own agent" wrapper.

The stronger direction is to build our own agent system by combining the best proven ideas from current open-source coding agents and harnesses, where licensing allows it.

This means:

- Research the best open-source coding agents.
- Identify the strongest patterns: slash commands, planning, review, diff handling, tool execution, context management, sub-agents, permissions, sandboxing, model providers, and extension systems.
- Copy or adapt only what licenses and attribution requirements allow.
- Build a cohesive first-party agent experience around our company model, graph, departments, named characters, permissions, and roadmap.

The goal is not to expose many engines to the user. The goal is to make our own engine feel like the best parts of the ecosystem, shaped into one product.

Important licensing rule: generic command names and workflow concepts can be adapted, but exact code, prompts, configs, docs, UI assets, or implementation details should only be copied after a license check at the exact source commit.

The engine design process should happen in two steps:

1. Audit the strongest existing coding agents and general agent frameworks.
2. Design our own first-party engine using the best legally reusable ideas and patterns.

This avoids designing in a vacuum while keeping the product from becoming a wrapper around other agents.

## Command System

The product should support familiar coding-agent slash commands while adding its own commands for the company-style agent workflow.

The goal is not to make users learn a totally new command language. Many coding agents already use commands like `/review`, and the app should preserve familiar patterns where they make sense.

Examples of familiar commands:

- `/review`
- `/test`
- `/fix`
- `/explain`
- `/commit`
- `/diff`

Examples of product-specific commands:

- `/launch-team`: start the recommended agent team.
- `/spawn`: create a scoped child agent under a senior agent.
- `/graph`: focus or inspect the agent graph.
- `/roadmap`: show or update the project roadmap.
- `/handoff`: move work from one agent or department to another.
- `/approve`: approve a pending action.
- `/department`: inspect or focus a department.
- `/tools`: inspect or adjust tool bundles.

The slash command system should work with the graph. If a command changes project state, the chat/activity panel should show the command and the graph should update.

## Deployment and Infrastructure

Specialized agents should help with:

- App Store preparation.
- Website deployment.
- Backend setup.
- Payment systems.
- Infrastructure choices.
- Environment configuration.
- Release checks.

The app should guide users through these choices instead of assuming deployment is outside the product.

## Maintenance and Marketing

Maintenance and marketing can be beta features.

Possible behavior:

- A persistent or scheduled agent monitors project health.
- It suggests maintenance tasks.
- It helps with launch and marketing work.
- It keeps docs and roadmap up to date.

This should not distract from the v1 core.

## Visual Direction

The product should lean purple, but avoid feeling like a generic purple AI app.

Desired feel:

- Modern.
- Polished.
- Sub-agent-heavy.
- Slightly playful.
- Technical enough to be credible.
- Calm at the app-home level.
- Alive inside the project workspace.

Agents should use a character-like visual direction. The user plans to provide pixel character designs later, and those designs should become part of the product identity.

Agents should share a coherent character system while differing by:

- Color.
- Motion.
- Role.
- Status.
- Connection style.
- Personality or feel.

Each pre-built agent should have a fixed character identity. For example, the planner always has the planner character, the testing specialist always has the testing character, and so on. This makes the agent team easier to recognize and gives the product a stronger identity.

The risk is credibility. Character agents should make the system memorable and easier to understand, but they should not make the product feel like a toy.

## Product Risks

- If the graph is decorative, users will not trust it.
- If the app feels beginner-only, technical founders will dismiss it.
- If tool bundling is messy, the product will recreate the MCP confusion it is meant to solve.
- If quality proof is weak, "better code" becomes a marketing claim rather than a product truth.
- If the app tries to build a full custom harness too early, the team may spend too much time below the product layer.
- If autonomy defaults are too aggressive, users may lose trust before they see the product's value.
- If permission prompts appear inside coding-task output, they may add noise and make the product feel less focused.
- If v1 gives equal weight to every project path, the first-run experience may feel unfocused. New-project creation should carry the strongest emphasis first.
- If hundreds of agents are shown as a flat graph, the core interface will become unreadable. The company model needs grouping and progressive disclosure.

## Open Product Questions

- How should the future pixel character designs map to agent roles, states, permissions, and graph relationships?
- Which quality proof metrics matter most in v1?
- Which existing coding harness should be adapted first?
