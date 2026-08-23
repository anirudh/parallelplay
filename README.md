# ParallelPlay

ParallelPlay is a local-first, policy-first control plane for autonomous software delivery. Workers propose work; the host validates current history, capabilities, evidence, and policy before appending any authoritative result.

ParallelPlay 0.1.0 includes:

- an append-only SQLite event kernel with disposable, rebuildable projections;
- deterministic workflow, evaluator, policy, driver, and adapter contracts;
- hardened Docker execution with no host store, socket, home-directory, or direct-internet access;
- keyless `generic-command` plus Codex SDK and Claude Agent SDK driver implementations gated on the contained-provider release check;
- separate loopback Explorer (read-only) and Attention (typed writes) services;
- controlled concurrency, integration ordering, evidence packets, policy audits, and fail-safe suspension;
- authority-gated GitHub App, desktop-notification, and signed-webhook adapters; and
- disabled-by-default, metadata-only OpenTelemetry instrumentation.

The hard global ceiling is not configurable. ParallelPlay never automates merge, ready-for-review, release, deployment, graph or scope acceptance, outcome acceptance, policy promotion, high-risk or destructive action, permission or secret changes, or capability expansion.

## Requirements

- Node.js 22.17.1 or newer
- pnpm 11.19.0 for source development
- a local Linux-container Docker daemon reached through a Unix socket
- macOS arm64 or Linux x64/arm64; Windows through WSL is experimental
- system Git with support for the target repository's object format

Remote Docker contexts are rejected. ParallelPlay 0.1.0 supports fresh databases only.

## Clean source checkout

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm sandbox:prepare
pnpm verify
pnpm build
```

The Docker preflight fails closed if the daemon is remote, the runtime lacks seccomp/private cgroup namespaces, or the digest-pinned fixture image is unavailable.

## Fresh local state

All stores and database paths are explicit. Migrations never run implicitly.

```sh
pnpm --silent parallelplay db migrate --db /tmp/parallelplay.db
pnpm --silent parallelplay source-store init --source-root /tmp/parallelplay-source
pnpm --silent parallelplay artifact-store init --artifact-root /tmp/parallelplay-artifacts
pnpm --silent parallelplay driver-store init --driver-root /tmp/parallelplay-driver
```

Explorer and Attention remain different services and origins:

```sh
pnpm --silent parallelplay explorer serve --db /tmp/parallelplay.db --port 0
pnpm --silent parallelplay attention-app serve \
  --db /tmp/parallelplay.db \
  --operator-id local-operator \
  --port 0
```

Explorer opens SQLite read-only with `query_only` and exposes GET routes only. Attention validates Host, Origin, an in-memory session, SameSite-Strict cookie, CSRF token, CSP, operator binding, packet revision, and target preconditions before a typed action.

## Keyless walking skeleton

The separate [`parallelplay-fixture`](https://github.com/anirudh/parallelplay-fixture) repository is synthetic and credential-free. Its fixed commits, milestones, candidate manifests, and failure cases are the public conformance target. A clean release install must complete the generic-command program, verify the candidate, produce an outcome packet, render both UI views, and rebuild byte-identical projections without provider access.

## Provider drivers

The Codex and Claude drivers use pinned SDK versions and structured SDK streams. They refuse to initialize unless the contained-runner boundary is asserted. A host-trusted broker resolves named environment secrets, issues short-lived run-bound handles, restricts provider/model/path/rate/body/budget, and injects the long-lived provider credential only at the outbound relay.

The required production boundary gives the agent container a private workspace, read-only root, non-root user, dropped capabilities, bounded CPU/memory/PIDs/time, and no direct internet route. Resume is accepted only for the same nonterminal provider session and unchanged context, execution, and capability digests. Approval or undeclared capability requests terminate and route to Attention. The 0.1.0 readiness file remains `NOT READY` until the container-to-relay topology and both paid provider trials prove these properties end to end.

See [provider containment](./docs/PROVIDER_CONTAINMENT.md) before configuring `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

## Extensions and compatibility

Published packages include `@parallelplay/contracts`, `@parallelplay/kernel`, `@parallelplay/runtime`, `@parallelplay/conformance`, first-party drivers/adapters, the generic-software profile, and telemetry helpers. Third-party code is never loaded into the authoritative Node process; it runs as a digest-pinned OCI process with strict JSON input/output and only declared capabilities.

“ParallelPlay compatible” is a maintainer-approved, artifact-digest-bound protocol claim—not a trust or vulnerability certification. See [extension authoring](./docs/EXTENSIONS.md), [conformance](./docs/CONFORMANCE.md), and the [compatibility policy](./docs/COMPATIBILITY.md).

## Distribution

ParallelPlay is distributed only through GitHub Releases. The planned `v0.1.0` contains npm-compatible package tarballs inside an SDK bundle, platform CLI archives, source/fixture manifests, checksums, per-artifact SBOMs, a license inventory, a build manifest, conformance-suite metadata, and GitHub build-provenance attestations. Nothing is published to npm, GitHub Packages, or GHCR. No release is published while [the readiness verdict](./docs/SLICE10_READINESS.md) is `NOT READY`.

See [reproducible builds](./docs/REPRODUCIBLE_BUILDS.md) and the [release policy](./docs/RELEASE_POLICY.md).

## Security and privacy

OpenTelemetry export is off by default. Its allowlist excludes prompts, source, packet bodies, model text, artifact content, personal data, and secrets. Generated GitHub content is rejected before authority or network access if it contains secret-like values, mentions, slash commands, active HTML, images, or non-allowlisted links.

Report vulnerabilities through GitHub private vulnerability reporting as described in [SECURITY.md](./SECURITY.md). ParallelPlay is MIT licensed; contributions are submitted under MIT without a CLA or DCO sign-off requirement.
