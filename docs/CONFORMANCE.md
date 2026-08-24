# Conformance

`@parallelplay/conformance` produces JSON, JUnit, and canonical evidence bundles tied to an extension artifact digest and suite version.

Driver cases cover lifecycle, resume binding, event ordering, usage and cost availability, artifacts, approvals, cancellation, timeout, malformed/missing/duplicate events, crash recovery, containment, and secret/network denial. Workflow cases cover schemas, cycles, dependencies, stale revisions, lineage, controlled concurrency, leases, integration ordering, and re-verification. Evaluator cases cover blinding, partition separation, contamination, abstention, confidence bounds, drift, invalid output, and deterministic scoring. Policy and adapter cases cover ceiling enforcement, promotion binding, expiry, audit/suspension, exact effects, retries, reconciliation, stale preconditions, duplicates, forbidden operations, receipt integrity, content filtering, and secrets.

Run the source suite with:

```sh
pnpm conformance
```

Release conformance uses a fresh extension instance for every requirement and fails on any missing, duplicated, skipped, or unexpected requirement ID. It emits exactly nine first-party reports: generic-command, Codex, Claude, workflow, deterministic evaluator, policy ceiling, GitHub, desktop notification, and signed webhook. The reports contain 96 isolated case results in total.

The release workflow runs `scripts/conformance/run-first-party.mjs` only after exact artifacts, per-artifact SBOMs, the source commit, platform, and the primary GitHub attestation bundle exist. Its detached manifests live outside the artifacts they describe, avoiding self-referential digests.

The canonical failure classifications are documented in [FAILURE_SEMANTICS.md](./FAILURE_SEMANTICS.md).
