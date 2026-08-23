# Extension authoring

Public V1 boundaries are defined in `@parallelplay/contracts`: `AgentDriverV1`, `WorkflowExtensionV1`, `EvaluatorExtensionV1`, `PolicyExtensionV1`, `OutboundAdapterV1`, `SecretProviderV1`, and `ExtensionManifestV1`.

An extension manifest binds identifier, version, contract version, artifact digest, declared capabilities, configuration-schema digest, provenance, SBOM/attestation references, and conformance identity. Identifiers are extensible validated strings, not a closed driver-name union.

Third-party executable extensions run as digest-pinned OCI processes with strict JSON input/output. They receive no database, event store, Docker socket, home directory, host stores, or undeclared network/secret access. ParallelPlay does not load third-party JavaScript into the authoritative Node process.

Workflow output is a deterministic DAG proposal. Evaluator output is a deterministic, schema-validated report over frozen evidence. Policy output may narrow authority only. Adapter output is external evidence. The host always rehydrates current history and revalidates before appending authority.

Do not widen an existing digest contract. Introduce a side-by-side contract version, keep the previous version executable, and document migration. V1 remains backward-compatible throughout 0.1.x.
