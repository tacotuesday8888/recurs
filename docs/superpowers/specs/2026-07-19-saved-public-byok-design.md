# Saved Public BYOK

Status: implemented for reviewed OpenAI Chat-compatible and Anthropic Messages profiles.

## Outcome

Recurs can save a public provider/model connection without saving its API or
coding-plan key. Setup names an existing process environment variable, shows
the current endpoint and billing disclosure, and persists only non-secret
connection metadata plus a provider-bound credential fingerprint. A later
process must supply the exact credential through that same variable.

This is a cross-platform convenience path. It does not replace the stronger
signed macOS authority, which captures and stores supported credentials in a
broker-private Data Protection Keychain and keeps reusable bytes outside
TypeScript.

## Admission policy

A manifest is admitted only when it is a supported model provider using an
implemented OpenAI Chat Completions or Anthropic Messages adapter, has at least one reviewed fixed HTTPS origin, uses an
API or coding-plan key, has a current unconditional allowed usage policy, and
has known billing fallback behavior. Conditional, expired, unknown-billing,
blocked, Responses, cloud-identity, and arbitrary URL paths remain
unavailable.

The transport resolves its origin from the bundled reviewed manifest. Neither
CLI input nor stored registry data can supply or override a remote URL.

## Setup and persistence

`recurs setup byok` is local, interactive, and manual. Provider, model,
environment-variable, duplicate flag, policy, and billing validation happen
before commit. The user must accept the fixed-origin, credential-storage, and
billing disclosure.

Anthropic setup uses the named environment credential to fetch the bounded
official model list from the reviewed fixed origin. It fails closed on
authentication, redirect, malformed data, transport failure, or a selected
model absent from that credential-visible list. `recurs provider models` exposes
the same read-only discovery in text or JSON. Other admitted environment-BYOK
profiles still use public metadata or an exact user-supplied ID.

The schema-v1 non-secret registry records:

- provider, adapter, model, and stable connection identity;
- credential environment-variable name and provider-bound SHA-256 fingerprint;
- current provider usage-policy and billing-policy revisions;
- exact acknowledged billing sources and timestamps.

It never records the credential value. The first connection in an empty
registry becomes primary; updates to the same provider/environment binding keep
the same connection ID and primary status.

## Runtime and lifecycle

Standalone startup rereads the registry and current catalog. The saved policy
and billing snapshot must still match, and the named environment variable must
contain the credential used during setup. Missing or changed values leave the
agent in its sessionless workspace shell and name only the required variable.

Each new session receives an immutable provider/model/policy/billing/account
pin. Every turn re-resolves the connection and compares the complete pin before
provider work. Credentials remain private fields in the provider instance and
are removed from managed tool and MCP child environments.

`account verify` checks only presence and fingerprint equality. It performs no
network request and cannot claim that the vendor currently accepts or has
credit for the key. `account disconnect` removes Recurs metadata only.

## Intentional limits

- No key capture, Keychain storage, OAuth, token import, or provider-login flow.
- No arbitrary base URLs, redirects, custom headers, or proxy environment
  configuration.
- Authenticated provider-specific model discovery is implemented only for the
  fixed Anthropic API profile; other providers validate the selected ID on the
  first generation request.
- No OpenAI Responses transport through this path.
- A fingerprint is a change detector for high-entropy provider keys, not
  encryption or a password hashing scheme.
