# Contributing

Open an issue before a large protocol, authority, or storage change. Keep changes testable as command or input, authoritative state, and observable evidence. Include an adversarial test for security boundaries and exact exit evidence for behavior changes.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm sandbox:prepare
pnpm verify
```

Do not commit databases, stores, logs, transcripts, credentials, absolute user paths, private examples, or generated release artifacts. Public V1 contracts remain backward-compatible throughout 0.1.x; breaking changes require a side-by-side version and migration period.

By submitting a contribution, you agree that it is provided under the repository's MIT license. ParallelPlay does not require a CLA or DCO sign-off.
