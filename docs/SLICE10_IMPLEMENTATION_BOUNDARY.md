# ParallelPlay Slice 10 implementation boundary

Status: accepted for implementation on 2026-08-23.

Slice 10 extracts the provider-neutral control plane into a fresh public product. The append-only event history plus validated receipts remain authoritative. Workers, provider SDKs, extensions, model output, browser state, projections, conformance reports, and external-provider responses are untrusted until the host validates and records them.

## Public product boundary

- Product and CLI name: ParallelPlay.
- Target repositories: `anirudh/parallelplay` and the synthetic `anirudh/parallelplay-fixture`.
- License: MIT, copyright 2026 Anirudh C, without a separate patent grant.
- Release: GitHub Releases only; no npm, GitHub Packages, or GHCR publication.
- Supported hosts: macOS arm64 and Linux x64/arm64 with Node 22.17.1 or newer and a local Linux-container Docker daemon. Windows through WSL is experimental.
- Public state starts from a fresh initial database. Predecessor databases and private history are neither supported nor imported.

The public export contains no private product material, predecessor history or branding, prior private pilot evidence, databases, stores, logs, model transcripts, absolute user paths, credentials, or private identifiers.

## Authority ceiling

Profiles and extensions may narrow authority but cannot widen this ceiling. ParallelPlay has no automatic command path for merge, ready-for-review, release, deployment, scope or graph acceptance, outcome acceptance, policy promotion, p0/high/safety-critical/destructive actions, permission changes, secret changes, or capability expansion.

An exact human-promoted external-effect policy may authorize only bot-owned GitHub checks, labels, filtered generated comments, immutable candidate branches, and draft pull requests. It cannot alter human content or branches. Every effect is digest-bound, idempotent, receipt-backed, reconciled against live state, audited, and fail-safe suspended on a serious finding.

## Extension boundary

Published V1 contracts cover drivers, workflows, evaluators, policies, outbound adapters, secret references, and extension manifests. Incompatible changes create a side-by-side contract version; 0.1.x does not break a published V1 contract.

Third-party executable code runs only as a digest-pinned OCI extension with strict JSON input and output. It receives no database, event store, Docker socket, host home, credential value, or undeclared network route. Compatibility is a maintainer-approved, digest-bound conformance claim; it is not a security certification.

## Provider boundary

Codex and Claude use their structured SDK streams. Provider work executes inside the hardened local Docker boundary. Long-lived provider credentials remain in a host-trusted secret and egress broker; the extension receives only a short-lived run-bound broker handle. Resume may recover the same nonterminal session and digests after a crash. It cannot resume terminal, approval-required, or capability-violating work.

Failure to prove SDK event validation, cancellation, restart recovery, credential isolation, and network containment blocks the provider driver. Direct host execution and secrets inside the agent workspace are forbidden fallbacks.

## UI, telemetry, and notification boundary

Explorer remains loopback-only, GET-only, SQLite `readonly` plus `query_only`, and projection-only. Attention remains a separate secured loopback service with typed digest-bound actions. Shared presentation must not merge their authority boundaries.

OpenTelemetry export is disabled by default. Opt-in export uses an attribute allowlist and excludes prompts, source, packet bodies, model text, artifacts, credentials, sessions, and personal data.

Desktop notifications and signed webhooks carry identity and deep links only. Notification delivery is evidence, never decision authority.

## Closure

Slice 10 closes only after clean-install walking-skeleton evidence, public conformance evidence, real contained Codex and Claude smoke trials for 0.1.0, live GitHub App and notification trials, projection replay/rebuild evidence, sanitization audits, reproducible per-platform artifacts, SBOMs/checksums, GitHub attestations, and a direct readiness verdict.
