# Real multi-file coding and session recovery acceptance — 2026-09-09 UTC

This acceptance uses the installed historical Candidate A through the supported external Codex app-server and existing ChatGPT login. It is one real coding task with deliberate cancellation and restart, not a comparison of model intelligence or evidence for recursive team quality.

## Tested artifact and authority

- Candidate A archive SHA-256: `5b0cbfd645173d1b2fd4865c86a474affe472c1400adc0fd65bf790367e6b865`.
- Installed executable SHA-256: `cbaf5844435159fc6670c356cc94c8d4f3a08400f25639d2eb40c0fec428e44a`.
- The candidate reported `0.1.0-alpha.10` but contained unreleased working-tree changes based on `a968cd3`. These exact bytes are distinct from the public alpha.10 archive and later release builds.
- macOS arm64; Node 22.22.3; external Codex 0.145.0; adapter `codex-app-server`; capability profile `codex-app-server-0.145.0-host-tools-v2`; mutable model alias `gpt-5.6-sol`, high reasoning. No immutable vendor model revision was available.
- Fresh temporary Git workspace, HOME and Recurs data directory; existing Codex login used in place through the supported runtime. No credentials were copied or printed. No dependencies, new credentials, resets or credit purchases were used.
- A supported read-only `account/read` and `account/rateLimits/read` preflight confirmed ChatGPT login, 27% remaining included quota, and zero prepaid credits. Shared quota is not per-task billing evidence; the runtime does not report monetary cost.
- The actual surface was installed readline (`RECURS_NO_TUI=1`) under a PTY. The session used `act` / `full_access` and Standard agent policy. This is not a permission-prompt or full-screen terminal acceptance.

## Independently defined task

The fixture contained four deliberately broken JavaScript modules, a specification, three visible tests, and no dependencies. The contract required:

1. `normalize.mjs`: validate task shape, trim IDs/dependencies, reject duplicate IDs and invalid priorities, deduplicate dependencies and preserve inputs.
2. `graph.mjs`: construct deterministic topological layers and reject missing dependencies and cycles.
3. `schedule.mjs`: schedule ready tasks by priority and ID within a positive integer concurrency limit, releasing dependencies only after each batch completes.
4. `cli.mjs`: read JSON from stdin, accept `--concurrency`, produce exact JSON output, and give concise non-stack errors with exit status 1. Absolute-path invocation must work from a different directory.

A separate 24-case verifier was written before launch and kept outside the model workspace. It directly imports the resulting modules and invokes the CLI from another directory. The untouched baseline passed **3/24**. The model could see the specification and three visible tests, but was not supplied the independent verifier. Scope allowed exactly four implementation files; tests, specification, package manifest and workspace instructions were immutable.

## Restart protocol and bounds

The first parent prompt asked only to read the specification and implementations and remember `SCHEDULER_RECOVERY_814`. After Recurs durably recorded the specification read, the driver sent Ctrl+C, observed durable cancellation, quit the process, reopened the installed executable and resumed the exact saved session ID. A second parent prompt requested full implementation and verification, asking it to repeat the saved marker without supplying that marker again.

The driver allowed two parent prompts, at most one optional read-only Explore child, at most 60 observed host-tool calls, an eight-minute resumed-turn deadline and a ten-minute overall deadline. Vendor-internal model requests are not exposed by this runtime, so these are host/runtime bounds, not an assertion about internal request count. No deadline was extended. The model was told not to install dependencies, use network tools, access external files, commit, or delegate beyond the single optional child.

## Result

**The implementation passed 24/24 independent checks, but the resumed model turn did not finish before its eight-minute deadline. This is a partial acceptance result, not a clean live completion.**

The final verifier ran after cancellation. Only `normalize.mjs`, `graph.mjs`, `schedule.mjs`, and `cli.mjs` changed: 207 inserted lines and six removed lines. The specification, visible tests, package manifest and workspace instructions were byte-identical to their initial Git versions. Both model-invoked `npm test` runs passed three tests; a separate post-cancellation `npm test` also passed. The independent cases cover normalization, malformed input, immutability, empty and diamond graphs, missing dependencies, general/self cycles, priority ties, dependency release, invalid concurrency and CLI success/error behavior. [Sanitized machine-readable evidence](product-live-coding-acceptance-2026-09.json) includes all case results and resulting file hashes.

The run started at **11:56:19.754 UTC**. First-turn cancellation was observed by **11:56:35.350 UTC**; exact-session reopening then succeeded. The resumed-turn deadline triggered cancellation, recorded at **12:04:36.942 UTC**, **497,188 ms overall**. A final answer had begun streaming, but no `runtime_completed` or `turn_completed` event was recorded. The saved recovery marker had not been repeated before cancellation. Durable session reopening and continued coding are proven; marker recall and a completed final response are not.

There were **29 host-tool starts: 27 completed and two failed**, across two parent turns, with two durable cancellations and no child sessions. One `run_verification` request was rejected as `invalid_input` because its inline command was outside the verification allowlist; the model successfully reran its assertions through the bounded command runner. One `apply_patch` was rejected as `stale_file`; rereading the file and retrying succeeded. These checks stayed enforced. There were two changed-file events and two recorded verification events.

The optional Explore child was not invoked. This run therefore gives no live parent-child hierarchy evidence. Runtime token aggregates were unavailable because the turn did not complete; internal request count and monetary cost remain unknown. No further inference was launched after the bound.

## Scope of evidence

The test establishes only the behavior actually observed for these candidate bytes and one task. The optional child is not required for task success; absence of a child provides no live hierarchy evidence. The external runtime has its own conversation internals, which this record cannot enumerate. Full-screen UI, company formation, cross-platform operation and peer model quality remain separate evidence.
