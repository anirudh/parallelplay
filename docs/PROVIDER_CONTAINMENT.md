# Provider containment and credentials

ParallelPlay 0.1.0 evaluates `@openai/codex-sdk` 0.149.0 and `@anthropic-ai/claude-agent-sdk` 0.3.241. Upgrading either version requires a fresh compatibility run.

Provider drivers refuse to construct unless `PARALLELPLAY_OCI_BOUNDARY=1` is supplied by the container runtime. They receive an explicit environment, prompt, model, tools, permissions, workspace, and disabled project/user setting sources. They use structured SDK streams and provider resume identities; terminal text is never scraped.

Long-lived values such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are resolved only by the host `SecretProviderV1`. The agent receives an opaque expiring handle and a run-bound relay token. The relay validates the run, provider, model, endpoint, request count, request/response size, and expiry before injecting the provider credential in memory. Secrets never enter command arguments, URLs, events, configuration snapshots, logs, artifacts, or workspaces.

The production container must use a private workspace, read-only root, non-root user, dropped capabilities, `no-new-privileges`, CPU/memory/PID/wall-time bounds, no host socket/store/home mounts, and no direct internet route. Only the dedicated relay path is permitted. Containment tests must prove denial of arbitrary internet, host services, cloud metadata, DNS, other runs, and other secret handles.

Resume is allowed only for a stored nonterminal session with identical context, execution-contract, capability-manifest, and checkpoint digests. Terminal, approval-required, capability-violating, or digest-mismatched sessions cannot resume.
