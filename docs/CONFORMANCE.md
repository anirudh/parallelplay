# Conformance

`@parallelplay/conformance` produces JSON, JUnit, and canonical evidence bundles tied to an extension artifact digest and suite version.

Driver cases cover lifecycle, resume binding, event ordering, usage and cost availability, artifacts, approvals, cancellation, timeout, malformed/missing/duplicate events, crash recovery, containment, and secret/network denial. Workflow cases cover schemas, cycles, dependencies, stale revisions, lineage, controlled concurrency, leases, integration ordering, and re-verification. Evaluator cases cover blinding, partition separation, contamination, abstention, confidence bounds, drift, invalid output, and deterministic scoring. Policy and adapter cases cover ceiling enforcement, promotion binding, expiry, audit/suspension, exact effects, retries, reconciliation, stale preconditions, duplicates, forbidden operations, receipt integrity, content filtering, and secrets.

Run the source suite with:

```sh
pnpm conformance
```

The canonical failure classifications are documented in [FAILURE_SEMANTICS.md](./FAILURE_SEMANTICS.md).
