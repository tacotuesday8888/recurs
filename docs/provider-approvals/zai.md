# Draft: Z.ai GLM Coding Plan Tool Approval

Status: **unsent**. Intended recipient: an official Z.ai support, developer relations, or partnership channel selected by the Recurs maintainer.

## Subject

Request to approve Recurs as a supported GLM Coding Plan tool

## Draft message

Hello Z.ai team,

I maintain Recurs, an open-source TypeScript coding-agent orchestrator. Z.ai's published GLM Coding Plan policy limits subscription benefits to officially supported tools, and Recurs is not currently listed. I am requesting written guidance on whether Recurs may integrate the plan and what review is required before activation.

The proposed integration would have these boundaries:

- local, user-present setup with a user-supplied GLM Coding Plan API key;
- the dedicated documented coding endpoint, never the general metered API endpoint by accident;
- no account sharing, pooling, or multi-user credential reuse;
- no credential scraping or import from another tool;
- model discovery and a safe non-generating readiness probe before activation;
- streamed output, client function tools, usage, rate limits, and typed provider failures covered by compatibility tests;
- explicit subscription, renewal, concurrency, and endpoint disclosures; and
- fail-closed behavior if provider approval, identity, model availability, or billing behavior cannot be verified.

Could you confirm:

1. whether Recurs can be added to the officially supported tool list for GLM Coding Plan;
2. whether the OpenAI Chat Completions endpoint, Anthropic Messages endpoint, or both are approved for Recurs;
3. the supported authentication, model-discovery, streaming, tool-calling, usage, and error interfaces;
4. any required concurrency limits, client identification, telemetry, attribution, review, or distribution conditions; and
5. the official process and contact for approval and ongoing compatibility changes?

Recurs will keep GLM Coding Plan blocked pending written approval.

Thank you.

## Facts to re-check before sending

- Z.ai's current policy prohibits account sharing and limits plan use to officially supported tools: [GLM Coding Plan Usage Policy](https://docs.z.ai/devpack/usage-policy).
- Z.ai currently lists supported products and publishes separate Anthropic and OpenAI-compatible coding endpoints; Recurs is not listed: [Tool Integration](https://docs.z.ai/devpack/tool/others).
- Recurs's general metered Z.ai API manifest is distinct from the blocked GLM Coding Plan manifest.
