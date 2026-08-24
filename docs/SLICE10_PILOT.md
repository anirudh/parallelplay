# Slice 10 pilot record

Date: 2026-08-23

This tracked record is sanitized. It contains no provider text, prompts, credentials, database, packet body, raw external receipt, or private path. Public RC results replace local-development observations rather than being inferred from them.

## Current local evidence

| Gate                         | Result                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product verification         | 38 test files passed, 175 tests passed, one Linux-only test skipped on macOS; formatting, lint, typecheck, build, SDK locks, public audit, and archive inspection passed       |
| Public audit                 | 243 working-tree files and 185 committed Git objects scanned with no retained predecessor identity, private path, credential, database, key, or non-synthetic identity finding |
| Provider topology            | Relay reachable; wrong grant, arbitrary internet, metadata, host service, and other credential denied                                                                          |
| Provider OCI reproducibility | Two final Linux arm64 builds produced byte-identical relay, runner, and manifest files; relay archive `6388e914...e37ca`, runner archive `b4f0372d...b3488`                    |
| Conformance smoke            | Nine reports; 96 total isolated requirements; final local evidence archive `e5761041...5d89a`; detached JSON, JUnit, manifests, and proposed entries generated                 |
| Fixture verification         | Five tests plus deterministic inventory and public audit passed; evidence digest `cfe56727f13aac92be1fa7a3d0425d4f0b518196ed0557eb9212646fd39031b5`                            |
| Packaged keyless smoke       | Clean fixture `3c20718d`; two outcome packets; both UIs rendered; projection `87300cd1...0a66` rebuilt byte-identically; 12.142 seconds                                        |
| Local release inspection     | macOS arm64 CLI/SDK plus Linux arm64 OCI layouts passed content/SBOM/license inspection; 39 checksums before local conformance aggregation                                     |

The local conformance artifacts are not approval inputs: they bind the committed baseline rather than the final source commit and use a local non-GitHub provenance stand-in. The clean-fixture keyless smoke used an unreleased local CLI archive. Both must be repeated from public RC assets.

## Public RC evidence to append

- RC tag, source and fixture commits, workflow run links, aggregate artifact digests, and consumer attestation verification.
- Clean downloaded keyless-pilot result and byte-identical projection digest.
- Sanitized Codex and Claude model, SDK, usage/cost-status, termination, checkpoint, event-stream, and raw-stream digests for success/cancellation/restart.
- Public fixture links for every GitHub effect plus rejection and duplicate-convergence evidence.
- Desktop/webhook receipt digests, automated Linux D-Bus result, and the separately recorded human macOS display/click result.
- Stable candidate proposals, approval identity/time, unchanged post-approval artifact digests, and stable release consumer verification.

Until those rows exist, the release verdict remains NOT READY.
