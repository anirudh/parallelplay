# Public export policy

ParallelPlay is built from an explicit allowlist, not from a denylist applied to private Git history.

## Included

- Production TypeScript, strict schemas, migrations, tests, sandbox fixtures, build scripts, public documentation, and intentionally synthetic examples.
- Public package manifests, lockfiles, CI, release definitions, license metadata, and compatibility registry.

## Excluded

- Source Git history and all old slice design, pilot, and readiness records.
- Databases, SQLite journals, artifact/source/driver stores, Docker image markers, generated `dist`, dependency stores, caches, logs, receipts, transcripts, and evaluation corpora.
- Private product material, private project names, absolute user paths, email addresses, access tokens, API keys, cookies, private keys, and retained provider responses.

`pnpm public:audit` scans the candidate tree and release archives. Any match blocks publication. The audit result is retained with the release evidence.
