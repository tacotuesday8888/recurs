# MCP OAuth client identifier hash review

CodeQL alert 6 (`js/insufficient-password-hash`) at
`packages/cli/src/mcp-auth.ts:60` is a confirmed false positive for the reviewed
dataflow. No source suppression or hashing change is required.

The sole production caller is `McpServerCatalog.#oauthProvider()` in
`packages/cli/src/mcp-client.ts:881`. It passes this complete hash input:

```ts
JSON.stringify([
  server.source,
  server.source === "project" ? this.#workspace : null,
  server.id,
  server.url,
  server.oauthClientId,
])
```

These values are the configuration scope, optional project directory, stable
server identifier, validated endpoint, and optional pre-registered public OAuth
client identifier. Configuration parsing accepts no password, client-secret, or
token field; endpoint validation rejects URL credentials, queries, and
fragments. `clientInformation()` maps `oauthClientId` to the OAuth `client_id`
field. It is not used as a client password.

The SHA-256 digest selects a deterministic directory under `auth/mcp`; it is
not a password verifier, password-derived key, authentication proof, or token
hash. The constructor fixes that directory before loading credential state.
Access/refresh tokens and server-issued client information are stored separately
in `#document` by `saveTokens()` and `saveClientInformation()`. Those values,
including any returned client secret, never flow back into the directory key.
The authorization code, PKCE verifier, and state also do not enter this hash.

[RFC 6749 §2.2](https://www.rfc-editor.org/rfc/rfc6749#section-2.2) explicitly
states: “The client identifier is not a secret”. The same section says it is
exposed to the resource owner and cannot authenticate a client by itself.
SHA-256 is appropriate for this deterministic connection namespace; a password
hashing algorithm would not address a defect here because no password is being
hashed. This conclusion concerns the implemented dataflow, not a guarantee
that arbitrary user-entered strings cannot be mislabeled as client IDs.

Disposition: dismiss this individual alert as **false positive**, recording the
dataflow and RFC rationale in GitHub. Keep CodeQL and its rule enabled. GitHub
alert dismissal and resulting CI status are verified separately by the release
owner. Review changed documentation only; existing MCP integration checks are
recorded in `docs/research/release-mcp-acceptance-2026-09.md`.
