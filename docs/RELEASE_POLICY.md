# Release policy

ParallelPlay uses semantic versions. Public V1 contracts remain backward-compatible for all 0.1.x releases; breaking behavior requires a side-by-side contract version and migration period.

Releases are published only as GitHub Release assets. npm, GitHub Packages, GHCR, runtime-controlled merge/release, and deployment are outside the 0.1 authority boundary. The maintainer release workflow may publish a frozen candidate under the standing publication approval only after the READY and compatibility gates pass.

A release requires all continuous gates, clean package inspection, two-build checksum equality per platform, SBOM/license/provenance output, a keyless clean-install walking skeleton, current compatibility evidence, byte-identical projection rebuilds, and a direct readiness verdict. The initial 0.1.0 additionally requires paid contained Codex and Claude trials, a live least-privilege GitHub App trial, desktop/webhook trials, and public-repository sanitization scans.
