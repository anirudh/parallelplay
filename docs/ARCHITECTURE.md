# Architecture and authority model

ParallelPlay separates proposal, evidence, authority, and external effect.

1. A workflow compiler produces a deterministic DAG and compiler digest.
2. A worker runs inside a capability-bound container and emits structured events.
3. The host runtime validates ordering, identity, usage, artifacts, checkpoint, and terminal state.
4. The kernel rehydrates the validated append-only history, checks current preconditions and policy, appends authorized events, and writes a disposable projection in one transaction.
5. Explorer reads projections through a separate read-only/query-only service. Attention performs only typed, digest-bound operator actions.
6. An outbound adapter may write externally only after the outbound-authority kernel replays an exact human-promoted action/target policy. It records a digest-bound receipt or failure and reconciles observed state.

Projections, UIs, extensions, SDK types, model output, provider responses, and conformance claims are not authoritative. Command receipts make retries idempotent. Leases and fencing prevent stale workers from completing work. Integration ordering and re-verification preserve serial source lineage even when independent programs execute concurrently.

The global authority ceiling is applied after profile, policy, advisor, and adapter results. It cannot be configured or widened by an extension.
