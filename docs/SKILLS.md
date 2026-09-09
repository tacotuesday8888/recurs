# Agent Skills

Skills give an agent reusable instructions and reference files without changing
Recurs's source. Start Recurs, then use `/skills` to see what is available.
Recurs reads the [Agent Skills format](https://agentskills.io/specification).

## Add a skill

Copy a local skill directory, including its reference files:

```text
/skills add "/path/to/release-check"
/skills inspect release-check
/skills use release-check Check this release
```

The source directory must contain `SKILL.md`, and its directory name must match
the `name` in that file. Add defaults to user scope and copies the bundle into
`$RECURS_HOME/skills`. The source is preserved. Recurs refuses to overwrite an
existing installation.

Install a specifically selected directory from a public GitHub repository:

```text
/skills install github:OWNER/REPOSITORY@REF:path/to/release-check
```

Replace the uppercase placeholders and path. `REF` is required and may name a
branch, tag, or commit. Recurs resolves it to a commit, downloads the selected
bundle through GitHub's public Git-object API, verifies each file's object
identity, and records the repository, requested ref, commit, and directory in
`$RECURS_HOME/skills/.sources/release-check.json`. It never runs Git hooks,
checkout filters, installation scripts, or dependency installers.

A direct public HTTPS URL is also supported:

```text
/skills install https://example.org/release-check/SKILL.md
```

This downloads **only `SKILL.md`**. Use a GitHub directory or local bundle when
the skill references other files. Direct URLs must not contain credentials;
redirects and private-network destinations are rejected. Private GitHub
repositories and authenticated downloads are not supported. For another Git
host, obtain the selected repository through your normal trusted workflow,
then use `/skills add` on its local skill directory.

## Project scope and precedence

Add `--scope project` to install for the current workspace:

```text
/skills add "/path/to/release-check" --scope project
/skills enable-project
```

Project installations live in `.recurs/skills`. They remain disabled until a
local, user-present CLI or desktop session explicitly trusts project skills.
Trust applies to the current Recurs process. Restarting or refreshing the
catalog requires trusting project skills again. Skill preferences do not grant
project trust.

Discovery follows these rules:

| Scope | Discovered directories | Precedence |
| --- | --- | --- |
| User | `~/.agents/skills`, `$RECURS_HOME/skills` | Recurs directory overrides `.agents` |
| Project | `.agents/skills`, `.recurs/skills` | Recurs directory overrides `.agents` |
| Across scopes | Enabled user and trusted project skills | Trusted project overrides user |

`/skills` shows the selected and shadowed entries. Use `--scope user` or
`--scope project` when managing duplicate names. Disabling a project skill
allows an enabled user skill of the same name to become effective.

## Manage and invoke

```text
/skills inspect release-check --scope project
/skills disable release-check --scope project
/skills enable release-check --scope project
/skills disable-project
/skills refresh
/skills remove release-check --scope project
```

Individual enable/disable choices persist privately in
`$RECURS_HOME/config/skills-state.json`; project preferences are keyed to the
canonical workspace. Removal moves Recurs-managed files into the matching
`removed-skills` directory and returns their location, so they can be recovered.
Skills discovered from another application's `.agents/skills` are not deleted
by Recurs: disable them here or manage them at their source.

Use `/skills use NAME [task]` to explicitly request a skill. The request enters
the normal agent loop and tells the model to call `activate_skill` before using
it. You can also request `$NAME` in an ordinary prompt. Automatic selection is
based on the advertised description; Recurs does not preload every skill body
or assert that a model followed a skill merely because it was listed.

The activation tool returns instructions and available resource paths. The
agent can request one listed text resource with `activate_skill` using the
`resource` field. Approved company roles can access only their bound skill
names; user invocation cannot override that capability boundary.

## Format and requirements

```yaml
---
name: release-check
description: Verify a package before preparing a release.
compatibility: Requires Node.js and git.
metadata:
  recurs-required-binaries: node git
allowed-tools: Read Bash
---

Read references/checklist.md and run the project's release checks.
```

The standard optional `compatibility`, `license`, `metadata`, and experimental
`allowed-tools` fields are supported. Inspection shows compatibility and
requested tools. The optional Recurs metadata field `recurs-required-binaries`
accepts a space- or comma-separated list of executable names. Inspection and
activation report names missing from `PATH`; they do not execute the programs
or install them. This checks presence, not executable versions or suitability.

Skill text and `allowed-tools` never widen permissions. Scripts are copied as
ordinary files and are not automatically executed. Reading references and
running commands still use the agent's normal permissions, workspace limits,
and supported tool surface. Text resources are supported; binary assets may be
copied but cannot be returned as text by `activate_skill`.

## Bounds and troubleshooting

- `SKILL.md`: at most 128 KiB; each resource: at most 256 KiB.
- Bundle installation: at most 65 files including `SKILL.md`, 8 MiB total,
  and three directory levels including the skill root.
- Discovery: at most 64 skills per scope. Duplicate names have explicit
  precedence; `/skills` reports discovery warnings.
- GitHub downloads: bounded to 128 API requests and 60 seconds. Large directory
  listings or public API rate limits may require using a local bundle.
- Symlinks, hard-linked resource files, credential paths, submodules, and
  special files are rejected during installation.

If a skill is disabled, inspect its scope and project trust. If a resource is
missing, use the complete bundle rather than a standalone Markdown URL. If an
installation conflicts, inspect the existing skill and remove it explicitly
before installing a replacement. Refresh after editing discovered files;
refresh also resets project trust.
