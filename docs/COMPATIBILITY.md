# Compatibility approval policy

“ParallelPlay compatible” is a maintainer-approved claim bound to one exact artifact digest.

Authors submit the artifact digest, source commit, SBOM, provenance/attestation, supported platforms, and machine-readable conformance report. Maintainers rerun the published suite from clean inputs and, if it passes, add a reviewed entry to `compatibility/registry.json`.

Approval means that the digest demonstrated protocol compatibility with the stated suite version. It does not mean the extension is trusted, endorsed, vulnerability-free, or authorized for a particular installation. A new artifact digest, incompatible dependency, evidence drift, or security finding requires review and may suspend an entry.
