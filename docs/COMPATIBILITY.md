# Compatibility approval policy

“ParallelPlay compatible” is a maintainer-approved claim bound to one exact artifact digest.

Authors submit the artifact digest, source commit, SBOM, provenance/attestation, supported platforms, and machine-readable conformance report. Maintainers rerun the published suite from clean inputs and, if it passes, add a reviewed entry to `compatibility/registry.json`.

Approval means that the digest demonstrated protocol compatibility with the stated suite version. It does not mean the extension is trusted, endorsed, vulnerability-free, or authorized for a particular installation. A new artifact digest, incompatible dependency, evidence drift, or security finding requires review and may suspend an entry.

The release workflow emits one proposed first-party file per conformance platform. Each proposal must contain exactly the nine expected first-party extensions and bind the release tag, source commit, artifact, SBOM, attestation bundle, supported platforms, and conformance report.

After the stable candidate is frozen, the maintainer reviews both proposals and explicitly approves them with:

```sh
node scripts/compatibility/approve-first-party.mjs \
  <ISO-approval-time> \
  <linux-x64-proposal.json> \
  <linux-arm64-proposal.json>
```

`verify-approved.mjs` revalidates the registry against the frozen proposals. The stable workflow then rebuilds only the source archive from the allowed registry/readiness commit, proves every extension artifact digest unchanged, and refuses publication on any mismatch.
