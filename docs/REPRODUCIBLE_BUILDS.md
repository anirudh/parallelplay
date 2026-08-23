# Reproducible builds and provenance

Release builds use clean inputs, `SOURCE_DATE_EPOCH`, UTC, `C` locale, fixed archive ordering, normalized ownership/mode, and deterministic compression. Each artifact is built twice for the same platform and its checksum must match.

Workspace dependencies remain `workspace:*` in tracked manifests. The release packer copies packages to a temporary directory, replaces internal dependencies with exact 0.1.0 release-asset references, runs package-content inspection, and creates npm-compatible tarballs. Test files, source-only internals, private documentation, workspace references, absolute build paths, and unexpected licenses fail the build.

The release includes `SHA256SUMS`, per-artifact SPDX SBOMs, license inventory, build manifest, and conformance evidence. GitHub Actions generates build-provenance attestations. Consumers verify an artifact with:

```sh
sha256sum -c SHA256SUMS
gh attestation verify <artifact> --repo anirudh/parallelplay
```
