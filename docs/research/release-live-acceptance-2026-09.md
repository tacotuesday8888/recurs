# Installed live coding acceptance — 2026-09-09 UTC

One small coding task passed through the installed interactive Recurs CLI, the external supported Codex 0.145.0 app-server, and the existing ChatGPT login. This is functional acceptance of one task, not a benchmark or evidence that Recurs outperforms another agent.

## Artifact and environment

- Package: `recurs@0.1.0-alpha.8`, packed with `npm pack --ignore-scripts` and installed into a temporary prefix with `--omit=dev --ignore-scripts --no-audit --no-fund`.
- Archive SHA-256: `3601ec6afbde75717d7147aac25623721ad65c81fa72abb6d41c2252a4f938ad` (564,195 bytes).
- Built CLI bundle SHA-256: `c355d45d1fcfca305e3ce9beef7b8ad68a4e8222f42ee91a0bae5f84bc87e82c`.
- Source base: `e5999f5c32da05f4f03941a84119c2f28b914db8` plus uncommitted release work. Other agents were editing source concurrently. These hashes identify the actual tested bytes; this run does not certify every subsequent source change or the eventual release archive.
- Host: macOS arm64, Node 22.22.3. Installed executable reported `0.1.0-alpha.8`.
- Runtime: external Codex 0.145.0; adapter `codex-app-server`; capability revision `codex-app-server-0.145.0-host-tools-v2`; selected model `gpt-5.6-sol`.
- Isolated Git fixture, installation prefix, npm cache, and `RECURS_HOME` were under `/private/tmp/recurs-live-acceptance-i9rg_vff`. The existing vendor login was used in place through the supported external runtime. No credentials were copied or printed, and no personal skills or Recurs configuration were added.

## Task and independent result

The fixture initially exported `slugify(value)` using lowercasing and literal space replacement. The exact task requested consecutive non-ASCII-alphanumeric characters to collapse to one hyphen, edge hyphens to be removed, and empty/punctuation-only input to return an empty string. Instructions limited changes to `slug.js` and prohibited dependency installation, networking tools, delegation, and commits.

The installed terminal launched its workspace chat, displayed the running parent and selected model, streamed tool activity, and asked separately for write access to `slug.js` and shell access to `npm test`. Both received one-time approval. It then returned to the ready state and quit cleanly with Ctrl+Q.

Only `slug.js` changed according to independent `git status`/`git diff`. The resulting implementation was:

```js
export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
```

The model invoked the fixture's `npm test`; Recurs recorded the real exit status 0 and one passing visible test. A separate verifier outside the model's workspace improved from **2/7 before to 7/7 after**:

| Input | Expected output |
| --- | --- |
| `Hello World` | `hello-world` |
| `  Hello,   World!  ` | `hello-world` |
| `API_v2 / Setup` | `api-v2-setup` |
| `---Already--slug---` | `already-slug` |
| empty string | empty string |
| `!!!` | empty string |
| `version 2.0` | `version-2-0` |

The verifier imports the resulting file and compares exact strings; the model's own success claim is not the acceptance oracle.

## Bounds, usage, and cost

The durable session records one `turn_started`, one `runtime_completed`, one `turn_completed`, ten completed host-tool calls, two resolved permissions, one changed-file event, and one verification event. Host calls were two `git_status`, one `list_files`, four `read_file`, one `apply_patch`, one `run_verification`, and one `git_diff`. No child or company execution was requested.

Task start: **02:32:31.511 UTC**. Completion: **02:35:00.387 UTC**. Elapsed: **148.876 seconds**, including operator approval delays. This is not model-only latency. There was one submitted Recurs task/Codex turn and no follow-up model task. The runtime did not expose its internal model request count (`steps: null`), so this evidence cannot assert a five-internal-request ceiling.

Runtime-reported usage was 149,936 input tokens, 988 output tokens, 117,376 cached input tokens, and 284 reasoning tokens. These are vendor runtime aggregates, not independently metered totals or a per-request breakdown. **Monetary cost was not reported.** The account's included quota was used; no reset, purchase, top-up, or new paid API credential was used.

## Setup friction and limits

1. The first pack attempted the owner's configured npm cache and failed with a filesystem permission error. An isolated cache resolved it without changing owner permissions.
2. This artifact's external Codex version probe cleared PATH. The npm launcher could not find Node, and setup returned a generic unexpected-failure message. Selecting the supported native Codex executable through `RECURS_CODEX_PATH` completed setup. The source was subsequently fixed to pass only PATH to that version probe and return a useful public diagnostic; that newer fix is outside this archive's live evidence.
3. Setup's billing declaration couples included ChatGPT quota and prepaid fallback. This caused avoidable friction with a no-new-spending instruction. Automatic approval review initially rejected launching a potentially metered runtime. A read-only supported Codex usage check and the same external CLI's `account/rateLimits/read` established remaining included quota and zero prepaid credits; the identical launch was then approved. The rejection was not bypassed. Shared-account quota changes cannot be attributed solely to this run.
4. Model commentary briefly said it was waiting for the test after the terminal had already shown the successful verification event. The final answer correctly reported success. This is a visible commentary-ordering discrepancy, not a failed test.
5. This run does **not** establish live child cancellation, recursive company behavior, cross-platform terminal quality, live OAuth login, remote skills installation, or Guided/Deep formation. Those require separate acceptance evidence. Existing deterministic/source tests remain distinct from this real vendor-backed run.

## Installed coverage review

The repository's `scripts/smoke-install-npm-package.mjs` already checks an installed package with a local deterministic model server: skill resource activation, stdio MCP invocation, guarded workspace shell execution, saved model configuration, account/doctor views, resume/fresh session separation, stdin and image inputs, read-only TypeScript diagnostics, ACP, and Quick company formation followed by reviewed repair and explicit apply. Its company driver deliberately uses the readline surface (`RECURS_NO_TUI=1`), so passing it is not evidence for the full-screen company interface.

Before claiming complete installed acceptance, keep these distinctions visible: skill activation is not skill lifecycle management; stdio MCP is not HTTP/OAuth; Quick is not Guided or Deep; a deterministic responder is not a live multiagent quality evaluation. Source-level HTTP/OAuth and formation tests can establish logic and protocol behavior but cannot alone establish packed executable wiring.

## Follow-up installed acceptance and blocker fixed

`node scripts/smoke-extensions.mjs` passed against a freshly packed and installed **0.1.0-alpha.9** archive, SHA-256 **`081b872e5c6908e7fe743b73228ddda5de7ed710273c20da8f25e589e3faf9de`**. The script defaults to packing/installing the current built artifact into an isolated prefix/cache, or accepts an explicit absolute installed executable. It uses fresh homes and localhost fixture servers, cleans its state afterward, and makes **zero live model requests**. This is a separate later artifact from the alpha.8 vendor-backed task above.

Verified through actual installed commands and PTYs:

- Skills: add a valid named bundle whose parent path contains actual whitespace, double quotes, and a backslash; verify the linked `guide.md` bytes were copied; inspect resources; disable and enable across separate processes; remove from discovery while preserving the archived resource bundle.
- MCP: add a local HTTP server; receive explicit network approval; negotiate initialization; discover one advertised tool, one resource, and one prompt; show server identity/version; configure, disable, enable, inspect, and remove across separate processes. The server observed `initialize`, `notifications/initialized`, `tools/list`, `resources/list`, `prompts/list`, and liveness pings. The SDK also attempted `server/discover`, whose unsupported response did not prevent standard initialization.
- Guided and Deep: select the actual depth in readline setup, answer “What outcome should this installed company own?”, review the proposal “Ship the installed company journey through one reviewed patch.”, save and exit, restart setup, resume the saved proposal, approve it, and quit. The selected depth was present in durable state. Each depth used exactly **two local deterministic model requests**, for the question and proposal, with **no additional model request on revisit**.

The first installed proposal-revisit attempt exposed a real defect: `setupCompanyBlueprintV2` called `coordinator.advance()` even when a resumed run was already `proposed`; the coordinator correctly rejected that invalid transition, but users saw an unexpected failure instead of their saved proposal. The CLI now renders the stored proposal revision directly. Regression tests actually save/reopen/approve in both depths and assert that the model is not called again. All **28 guided-onboarding tests**, CLI TypeScript checking, and focused ESLint passed after the fix; the installed rerun above then passed.

The deterministic Guided/Deep cases establish depth selection, question/proposal wiring, persistence, and review authority. They do not establish the quality of depth-specific investigation: the fixture intentionally proposes after one answer and requests no research agents. Installed HTTP discovery does not constitute an interactive OAuth login test; OAuth remains separately covered by focused protocol/source tests. Remote GitHub skill acquisition likewise remains source-tested rather than proven by this local installed fixture. Neither extension nor formation fixtures measure model intelligence or spending.
