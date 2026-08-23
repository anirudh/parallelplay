# 0.1.0 readiness

Verdict: **NOT READY FOR PUBLIC RELEASE**.

## Implemented evidence

- Fresh history-free product and fixture workspaces exist locally.
- Public V1 contracts, conformance output formats, fresh `001_initial.sql`, provider SDK drivers, host secret/egress broker, OCI extension runner, global authority ceiling, replayable outbound policy/effect evidence, GitHub/notification adapters, telemetry allowlist, and synthetic fixture are implemented.
- The complete local product suite passes 152 tests, including Docker containment, broker denial, replay/rebuild, crash boundaries, stale actions, duplicate effects, and UI-origin controls.
- The fixture passes five host tests, its object sanitization scan, a hardened offline Docker run, and its structured success protocol under a read-only-root, non-root, no-network container.
- The macOS arm64 CLI and SDK archives pass content inspection and two-build byte equality. The clean CLI archive starts and loads its packaged native SQLite dependency. Its license inventory contains 23 identified packages and no unknown license.
- Both GitHub target names are currently absent and authentication is valid, so creation may proceed after the final committed-object scans.

## Blocking release evidence

- The target GitHub repositories have not yet been created, pushed, and rescanned as public objects.
- The production container-to-provider-relay topology has not passed its stop/go proof. The SDK drivers' boundary assertion and host broker are necessary but not sufficient evidence.
- Real paid Codex and Claude brokered-container trials have not run. An OpenAI secret reference is available locally; an Anthropic reference is not.
- The live GitHub App effect/rejection/reconciliation trial has not run.
- Desktop and signed-webhook live delivery evidence is incomplete.
- Linux x64 and Linux arm64 reproducible archives and the three-platform aggregate checksum manifest require the pinned public CI matrix.
- GitHub artifact attestations cannot be generated or verified before the public tag workflow runs.
- The clean release-install walking skeleton still needs to drive the public fixture through program completion, outcome evidence, both UI views, and byte-identical projection rebuilds.

No mock or offline conformance result closes a live-evidence gate.
