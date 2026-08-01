# Privacy and local data

Recurs does not operate an analytics or telemetry service. The CLI does not
send usage events, repository contents, or account identifiers to a Recurs
server. Package registries, GitHub, model providers, and user-configured tools
have their own policies and may observe requests made directly to them.

## What leaves the machine

When you use a remote model, Recurs sends the conversation and the bounded
tool context needed for that turn to the provider you selected. A delegated
runtime such as Codex owns its login and transport. A BYOK adapter sends data
to its documented fixed provider origin. Local loopback models remain local
unless that model runtime has separate network behavior.

Approved commands, web tools, Skills, and MCP servers may communicate with
their own destinations. Recurs shows or enforces their authority through the
active permission and tool policies; it does not make their privacy promises.
Configured evaluations contact a provider only after explicit network opt-in.

## What Recurs stores

Recurs stores durable sessions, prompts, tool arguments and results,
checkpoints, provider-routing metadata, team journals, company blueprints, and
project knowledge below one private data directory. These records can contain
sensitive source context. Saved BYOK records contain an environment-variable
name and one-way credential fingerprint, never the credential value. Vendor
tokens remain owned by the delegated runtime.

Run this explicit, read-only command to locate the active directory:

```bash
recurs data path
```

The default is `~/.recurs`; `RECURS_HOME` selects a different path. Recurs does
not reveal the path in ordinary diagnostics or structured run output.

## Retention and deletion

Recurs retains durable state until you delete it. Uninstalling the executable
does not remove that state. To erase it, stop all Recurs processes, run
`recurs data path`, inspect the reported directory, and remove that directory
with your operating system only after confirming it contains no history or
checkpoints you need.

Disconnecting an account removes Recurs routing metadata. It does not revoke a
provider key or log out of a provider-owned runtime. Revoke credentials with
their issuer when required.

See [SECURITY.md](SECURITY.md) for the threat boundary and private
vulnerability-reporting path.
