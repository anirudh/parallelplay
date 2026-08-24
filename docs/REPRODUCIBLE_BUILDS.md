# Reproducible builds and provenance

Release builds use clean inputs, `SOURCE_DATE_EPOCH`, UTC, `C` locale, fixed archive ordering, normalized ownership/mode, and deterministic compression. Each artifact is built twice for the same platform and its checksum must match.

Workspace dependencies remain `workspace:*` in tracked manifests. The release packer copies packages to a temporary directory, replaces internal dependencies with exact 0.1.0 release-asset references, runs package-content inspection, and creates npm-compatible tarballs. Test files, source-only internals, private documentation, workspace references, absolute build paths, and unexpected licenses fail the build.

The release includes `SHA256SUMS`, per-artifact SPDX SBOMs, license inventory, build manifest, and conformance evidence. GitHub Actions generates build-provenance attestations. Consumers verify an artifact with:

```sh
sha256sum -c SHA256SUMS
gh attestation verify <artifact> --repo anirudh/parallelplay
```

Tags matching `v0.1.0-rc.*` run the full three-platform matrix and publish a GitHub prerelease. A manual `release` workflow run for `0.1.0` creates—but does not publish—a frozen stable candidate. After compatibility approval and a READY evidence commit, `publish-stable.yml` accepts that candidate run ID, permits only the registry/readiness/changelog delta, proves approved package and OCI digests unchanged, attests the final set, publishes `v0.1.0`, and verifies every asset as a consumer.

RC package manifests are rewritten only in temporary pack directories to `0.1.0-rc.N` and exact RC asset URLs. Stable candidates use `0.1.0` and stable asset URLs. Tracked manifests always retain `workspace:*`.
