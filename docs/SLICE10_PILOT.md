# Slice 10 pilot record

Date: 2026-08-23

This record contains sanitized local evidence only. It records failed or incomplete gates explicitly and contains no provider text, credentials, database, packet body, external receipt, or private path.

## Environment

- Development host: macOS arm64
- Supported container runtime exercised: Linux arm64
- Fixture container runtime: Node 22.17.1 and pnpm 11.19.0
- Development runtime exercised: Node 23.11.0 and pnpm 11.19.0
- Fixture source head: `c65603e19a8d60d8bebe61f396bb1e5409752e92`
- Fixture image: `sha256:6db25901710721d907f6b345e53353bf8823dd8a10777cddcee4d17d3c735bca`

## Passing local evidence

| Gate                        | Evidence                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product tests               | 33 files, 152 tests passed in 119.24 seconds under the full release gate                                                                                    |
| Fixture tests               | 5 tests passed; canonical evidence digest `ab90b2107ef5e35a61a35e20a04796ee593b38fca6a395fd05454a15ea8abaaf`                                                |
| Fixture isolation           | Offline, read-only root, non-root UID, all capabilities dropped, no-new-privileges, 64 PIDs, 256 MiB, 1 CPU                                                 |
| Structured fixture protocol | Six ordered events, candidate workspace change, artifact digest `0fc7c8c357dfa2cc6116cdf1172b5734908a31644d6a807152023dd63d7f151a`                          |
| Fresh-history audit         | Initial export had one root commit and 178 unique scannable Git objects; no excluded identity, private path, credential, database, or secret artifact found |
| macOS arm64 packaging       | 14 archives and 32 checksum entries passed content inspection                                                                                               |
| Reproducibility             | Two clean macOS arm64 builds produced the same 33 release files byte for byte                                                                               |
| License evidence            | 23 runtime/SDK components identified; zero unknown licenses                                                                                                 |
| Clean CLI load              | Release archive started from a temporary directory and loaded its packaged native SQLite binding                                                            |

The source audit was rerun against the committed object database. Release checksums remain build outputs rather than tracked source and must be generated again by the tag workflow.

## Stop/go and live gates

The provider-containment increment remains **STOP**. The host secret provider, scoped grant broker, structured SDK mappings, resume binding, and direct-host refusal exist, but there is not yet end-to-end evidence that the production provider container can reach only its run-bound relay while arbitrary internet, host services, metadata, DNS, other runs, and other credentials remain unreachable.

The paid Codex trial, paid Claude trial, live GitHub App trial, desktop notification trial, signed-webhook trial, public clean-install walking skeleton, Linux reproducibility jobs, public object scans, and GitHub attestations have not run. They remain mandatory for 0.1.0.
