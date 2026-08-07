# Draft: Anthropic Claude Subscription Integration Approval

Status: **unsent**. Intended recipient: an official Anthropic support, developer relations, or partnership channel selected by the Recurs maintainer.

## Subject

Written confirmation request for a Recurs integration using Claude Agent SDK subscription authentication

## Draft message

Hello Anthropic team,

I maintain Recurs, an open-source TypeScript coding-agent orchestrator. I am evaluating an optional Claude subscription connection implemented only through the official Claude Agent SDK and its documented user login. Before enabling it, I would like written confirmation that this specific third-party integration is permitted and clarification of the applicable billing and usage disclosures.

The proposed integration would have these boundaries:

- local, user-present, manual activation only;
- authentication and credential storage owned by the official Anthropic runtime or SDK;
- no import of Claude Code configuration, browser cookies, tokens, or private credential files;
- no account sharing, pooling, or multi-user reuse;
- an exact account-bound connection with model discovery and a safe readiness probe before activation;
- streamed output, client tool calls, usage, and typed failures mapped into Recurs only after compatibility tests pass;
- explicit disclosure of subscription limits and any possible transition to usage credits or API billing; and
- fail-closed behavior when entitlement, identity, billing source, or runtime capabilities cannot be verified.

Could you confirm:

1. whether a third-party open-source coding orchestrator may authenticate an individual user's Claude subscription through the official Agent SDK;
2. which plan types and user-presence contexts are permitted;
3. whether any API credits or other paid fallback can occur and what user control or disclosure is required;
4. whether account identity, plan type, model availability, usage, and remaining limits are available through supported SDK interfaces; and
5. whether Anthropic requires a review, registration, attribution, rate-limit policy, or other conditions before distribution?

Recurs will keep this path disabled until the integration is supported by current official documentation and any required written approval is received.

Thank you.

## Facts to re-check before sending

- Anthropic's June 16, 2026 help article currently says its announced Agent SDK credit change is paused and third-party Agent SDK use still draws from subscription usage limits: [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- Claude Code subscription documentation distinguishes plan usage from optional API-credit billing and describes explicit user choice: [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).
- The current Recurs manifest remains blocked and no Claude subscription adapter is implemented.
