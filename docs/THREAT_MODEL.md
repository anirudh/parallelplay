# Threat model and residual risk

## Protected assets

- operator authority and promoted policy;
- provider, GitHub App, and webhook credentials;
- event and receipt integrity;
- source and artifact confidentiality;
- human branches, text, repository settings, workflows, environments, and secrets; and
- the separation between Explorer reads and Attention writes.

## Adversaries and failures

ParallelPlay assumes model output, extension images, generated content, provider streams, external APIs, browser input, stale retries, duplicate delivery, compromised fixtures, and malformed evidence may be hostile. It tests container escape routes, arbitrary egress, host services, metadata, DNS, secret leakage, protocol truncation/reordering, forged receipts, stale preconditions, and authority escalation.

Controls include digest-pinned OCI artifacts, read-only roots, non-root users, dropped capabilities, resource limits, private workspaces, no Docker socket or host stores, run-bound egress grants, strict runtime schemas, append-only evidence, idempotency, fencing, exact preconditions, content filtering, loopback origins, CSRF/CSP/session controls, and fail-safe policy suspension.

## Residual risk

Local Docker, the host kernel, Node runtime, package supply chain, provider SDKs, GitHub, and configured webhook destinations remain trusted dependencies. A permitted model can still produce incorrect code within its workspace. Conformance proves protocol behavior, not absence of vulnerabilities or malicious logic. Desktop notifications are best-effort and do not prove operator attention. Cost values are provider estimates when available. Windows support depends on WSL and is experimental.

Paid provider and live GitHub pilots are release gates because offline tests cannot establish real API behavior or current credential/permission configuration.
