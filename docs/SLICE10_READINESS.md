# 0.1.0 readiness

Verdict: **NOT READY FOR PUBLIC RELEASE**.

## Implemented evidence

- The history-free public product and synthetic fixture repositories exist at `anirudh/parallelplay` and `anirudh/parallelplay-fixture`.
- Public V1 contracts, conformance output formats, fresh `001_initial.sql`, provider SDK drivers, host secret/egress broker, OCI extension runner, global authority ceiling, replayable outbound policy/effect evidence, GitHub/notification adapters, telemetry allowlist, and synthetic fixture are implemented.
- The complete local product suite passes 152 tests, including Docker containment, broker denial, replay/rebuild, crash boundaries, stale actions, duplicate effects, and UI-origin controls.
- The fixture passes five host tests, its object sanitization scan, a hardened offline Docker run, and its structured success protocol under a read-only-root, non-root, no-network container.
- Public product CI passed for commit `4e3cbf6e2314df389afabb4f08aa948c93f1e330`, including the full gate and two-build Linux x64 checksum comparison ([run 32669335683](https://github.com/anirudh/parallelplay/actions/runs/32669335683)).
- Public fixture CI passed for commit `0fce0c1ff9eebe8c6467e4dc433ff074e7ac182c`, including the deterministic-history audit and hardened Docker run ([run 32668635702](https://github.com/anirudh/parallelplay-fixture/actions/runs/32668635702)).
- The macOS arm64 CLI and SDK archives pass content inspection and two-build byte equality. The clean CLI archive starts and loads its packaged native SQLite dependency. Its license inventory contains 23 identified packages and no unknown license.

## Blocking release evidence

- The production container-to-provider-relay topology has not passed its stop/go proof. The SDK drivers' boundary assertion and host broker are necessary but not sufficient evidence.
- Real paid Codex and Claude brokered-container trials have not run.
- The live GitHub App effect/rejection/reconciliation trial has not run.
- Desktop and signed-webhook live delivery evidence is incomplete.
- The shared UI navigation/design-system shell and complete extension/conformance views are not yet implemented across Attention and Explorer.
- The conformance requirement catalogue exists, but every published driver, workflow, evaluator, policy, and adapter case does not yet have independent machine-runnable evidence.
- Linux arm64 release reproducibility and the three-platform aggregate checksum manifest require the pinned tag CI matrix; macOS arm64 is proven locally and Linux x64 in public CI only.
- GitHub artifact attestations cannot be generated or verified before the public tag workflow runs.
- The clean release-install walking skeleton still needs to drive the public fixture through program completion, outcome evidence, both UI views, and byte-identical projection rebuilds.

No mock or offline conformance result closes a live-evidence gate.
