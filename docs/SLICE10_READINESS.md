# 0.1.0 readiness

Verdict: **NOT READY FOR PUBLIC RELEASE**.

## Implemented and locally verified

- The V1 reconcile request binds the exact effect and prior receipt, and the host rejects mismatched adapter identity, effect key, action, payload, precondition, policy, or receipt digest before adapter code runs.
- First-party factories require host-validated detached manifests. Release manifests bind exact package or OCI, SBOM, attestation-bundle, source, suite, and conformance-report digests; placeholder provenance is rejected.
- The Docker provider boundary uses separate per-run internal and egress networks, host-to-relay and host-to-runner initialization pipes, memory-only credentials, digest-pinned runner/relay images, hardened containers, brokered endpoints/models/rates/sizes/output ceilings/budgets, and restart-bound host checkpoints.
- The local adversarial containment proof denies a wrong grant, arbitrary internet, cloud metadata, host services, and another credential. Two clean Linux arm64 OCI builds produced identical runner, relay, and manifest files.
- Nine isolated first-party conformance reports pass all published inventories: 16 cases for each of three drivers, 10 workflow cases, eight evaluator cases, six policy cases, and eight cases for each of three adapters. Local detached JSON, JUnit, evidence, manifest, and proposed-registry artifacts were generated.
- GitHub effects reconcile checks, labels, comments, immutable candidate refs, and App-owned draft pull requests before writes and after conflicts/timeouts. Attention provides guided App creation, fixture-only installation verification, exact one-hour policy promotion/suspension, and the live pilot action.
- macOS, Linux D-Bus, and signed-webhook implementations are restart-safe. The local webhook receiver uses a durable idempotency ledger; Linux D-Bus replacement/action behavior has an isolated integration test.
- Attention and Explorer use the shared private UI package while preserving separate origins and authority. Explorer remains query-only; Attention retains Host, Origin, session, actor, CSRF, CSP, and stale-action validation.
- OTLP traces and metrics are disabled by default. Explicit startup validates the destination and applies both key- and value-level metadata filtering.
- The full local product gate passes 175 tests with one Linux-only D-Bus test skipped on macOS. The fixture gate passes five tests plus its inventory and public audit.
- A packaged-CLI development smoke against clean fixture commit `3c20718d1326b70e65e35cdbd48579f39b81946f` completed a two-milestone keyless program, verified two outcome packets, rendered both UI shells, and rebuilt public projections byte-for-byte.
- A provider-inclusive local macOS arm64 release passes archive, SBOM, license, workspace-reference, path, identity, and content inspection with 39 checksums. Its final Linux arm64 relay and runner OCI archives reproduced byte-for-byte after the output-ceiling change.

Local conformance used a non-GitHub provenance stand-in, and the clean-fixture keyless run used an unreleased local CLI archive. They prove implementation behavior but are not public release evidence.

## Blocking release evidence

1. Publish the clean product and fixture heads, restore valid GitHub CLI authentication, and obtain green CI for both repositories.
2. Build and publish `v0.1.0-rc.1`; require all three CLI platforms, both provider OCI platforms, aggregate checksums, SBOMs, license inventory, complete conformance evidence, and verified GitHub attestations.
3. Run the keyless walking skeleton from the downloaded public prerelease against a clean public fixture checkout.
4. Configure both host-only provider references and run the capped contained `gpt-5.3-codex` and `claude-sonnet-5` success, cancellation, and restart trials. No local mock closes this gate.
5. Complete the guided fixture-only GitHub App install, exact policy promotion, and public live-effect/rejection/reconciliation matrix.
6. Run the notification pilot and record one human macOS display/click observation; retain the automated Linux D-Bus and local webhook receipts.
7. Generate stable candidate artifacts, present the exact first-party proposals, and obtain human compatibility-registry approval.
8. Rebuild after only the allowed registry/readiness changes, prove all approved artifact digests unchanged, set this verdict to READY with public evidence, and publish/consumer-verify `v0.1.0`.

No mock, local-only provenance, uncommitted fixture build, or offline conformance result closes a public or human evidence gate.
