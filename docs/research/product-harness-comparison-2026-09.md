# Matched operational harness comparison — September 2026

This comparison runs installed Recurs and Pi against a deterministic local
OpenAI-compatible fixture. It measures tool execution, file results, interruption,
and durable continuation. **It is not a model-quality benchmark or evidence that
Recurs solves coding tasks better than Pi.** There is no inference model behind
the fixture: it prescribes the same semantic actions and adapts their arguments
to each harness's native tool schema.

## Protocol fixed before execution

Each harness gets an independent temporary workspace and home, identical seed
files and prompt, and an eight-request maximum per case. Each process has a
20-second wall timeout. The interruption case can start a second process; both
processes share the same eight-request budget. No API keys or vendor credentials
are copied, and no paid inference is used. The current environment had no
provider API-key variables; Ollama's local HTTP service was unavailable.

Pi is installed separately at version **0.85.1** from
`@earendil-works/pi-coding-agent`. Its custom `models.json` uses the documented
`openai-completions` transport and a dummy key for the local fixture. Extensions,
skills, prompt templates, and theme discovery are disabled. Exact continuation
uses the saved session file. These are ordinary supported CLI features, verified
against the installed package and the official [custom-model documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
and [CLI reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

Recurs uses a clean installed candidate with `setup local`, `run --format jsonl`,
and `--resume` with the exact recorded session ID. Its initial run selects
`full_access` so this scripted comparison does not require interactive approvals;
normal Recurs process containment remains enabled. Pi's tool process authority
differs. This experiment does not compare permission isolation or security.

| Case | Prescribed semantic actions | Independent success condition |
| --- | --- | --- |
| Multi-file bug | Read normalization and matching modules, edit each, run verifier | Whitespace/case normalization and matching assertions pass |
| Interruption/recovery | Read module, interrupt while waiting for the next provider response, reopen exact session, read again, edit, verify | Earlier context marker reaches the resumed provider request; repaired arithmetic passes |
| Review/repair | Read source and a supplied review finding, repair quantity handling, run verifier | Quantity and empty-list assertions pass |

The read after reopening is intentional: both harnesses re-observe the file
before editing. The review finding is supplied, not independently discovered by
a second agent. These small fixtures exercise mechanics rather than difficult
reasoning, large repositories, autonomous team design, or multi-agent quality.

## Reproduction and recorded evidence

Run from the repository after installing both packages into isolated prefixes:

```sh
node scripts/compare-harnesses.mjs --recurs /installed/recurs/bin/recurs --pi /installed/pi/bin/pi
```

The script prints its temporary report path and retains structured per-case
requests, outputs, exit statuses, executable hashes, verifier outcomes, and final
file hashes. It checks that each harness ran the verifier, that the independent
verifier also passes, and that the verifier file is unchanged. A matched run
requires identical final file hashes across harnesses. Fixture request bodies
contain only seeded task data and generated conversation data; no user projects
or credentials are loaded.

## Executed matched result

The installed **unreleased Candidate A**, built from the working tree based on
`a968cd3`, passed all three cases against Pi **0.85.1**. Its package still reports
`0.1.0-alpha.10`; that version string must not be treated as the public alpha.10
release or as an identifier for later candidates. Exact archive SHA-256:
`5b0cbfd645173d1b2fd4865c86a474affe472c1400adc0fd65bf790367e6b865`.

The [structured results](product-harness-comparison-2026-09.json) retain executable
hashes, platform/runtime versions, requests, timings, exits, and final file hashes.

| Case | Recurs / Pi requests | Independent verifier | Native verifier result | Final file hashes | Recurs / Pi elapsed |
| --- | --- | --- | --- | --- | --- |
| Multi-file bug | 6 / 6 | Both pass | Both pass | Identical | 3657 / 343 ms |
| Interruption/recovery | 6 / 6 | Both pass | Both pass | Identical | 3041 / 605 ms |
| Review/repair | 5 / 5 | Both pass | Both pass | Identical | 2629 / 341 ms |

Both harnesses preserved the exact earlier context marker when reopening the
interrupted session. SIGINT ended the waiting process in 4 ms for Recurs and
3 ms for Pi; both were signal exits, and subsequent resumed processes exited
zero. Every completed case exited zero, kept its verifier unchanged, and stayed
within the request cap. No fixture errors occurred. This interruption takes
place after a completed read while awaiting a provider response, not while a
subprocess is mutating files.

Pi had lower elapsed time in these runs. This reveals useful operational
overhead to investigate; it does not establish the cause or normalize away the
different containment, checkpoint, session, or tool policies. Neither harness
showed a correctness or recovery advantage on these prescribed cases.

Single-run timing is diagnostic only. Different tokenization, prompts, tool
schemas, startup work, and runtime policies prevent interpreting these timings
as a model-speed, cost-efficiency, or intelligence ranking.
