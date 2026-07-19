# Linux Process Containment Evidence Context

This analysis was prepared against Recurs commit
`8a3ba6cb4268c905a1b52d0e016ab422e18e0d14` in
`/Users/langqi/Documents/subagents_ide/.worktrees/linux-workspace-sandbox`.
The external reference is OpenAI Codex commit
`0fb559f0f6e231a88ac02ea002d3ecd248e2b515` cloned under
`/tmp/recurs-codex-reference`.

The ten-file evidence collection hashes to
`071a5a99329df7b25e5e47ad9e9b6fe2db2e1a2d93df9364ccdb01afa7fe3dd5`.
It was computed over each path, a NUL separator, the exact file bytes, and a
second NUL separator in the order below.

| ID | Evidence | What it establishes |
| --- | --- | --- |
| E001 | `packages/tools/src/process.ts` | Recurs has bounded process lifecycle and a macOS Seatbelt launcher, but rejects workspace sandboxing on Linux. |
| E002 | `packages/tools/src/process-environment.ts` | Every child already receives a private temporary home and filtered environment. |
| E003 | `packages/tools/src/registry.ts` | Approved permission intents already select deny-network or allow-network sandbox context. |
| E004 | `packages/cli/src/assembly.ts` | Linux currently defaults to `local_guarded`; only macOS defaults to `workspace_sandboxed`. |
| E005 | `docs/CLI.md` | Published behavior accurately discloses the missing Linux OS boundary. |
| E006 | `SECURITY.md` | The security model does not currently claim Linux process containment. |
| E007 | `.github/workflows/ci.yml` | Linux verification installs ripgrep but no sandbox runtime. |
| E008 | Codex `codex-rs/linux-sandbox/src/bwrap.rs` | Current Codex composes Bubblewrap filesystem/user/PID/network namespaces with a separate seccomp layer. |
| E009 | Vendored Bubblewrap `README.md` in Codex | Bubblewrap arguments, not the binary alone, define sandbox policy; `--new-session` is required without a TIOCSTI seccomp rule. |
| E010 | Vendored Bubblewrap `SECURITY.md` in Codex | Bubblewrap is a policy toolkit and does not by itself provide a user-to-OS privilege boundary. |

No exploit report or sealed Codex Security scan supplied this evidence. The
opportunity follows from the documented ambient Linux child authority and the
project's explicit parity objective. Source drift is `none` for the recorded
Recurs revision; the external reference is separately pinned.
