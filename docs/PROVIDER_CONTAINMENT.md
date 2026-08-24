# Provider containment and credentials

ParallelPlay 0.1.0 evaluates `@openai/codex-sdk` 0.149.0 and `@anthropic-ai/claude-agent-sdk` 0.3.241. Upgrading either version requires a fresh compatibility run.

Provider drivers refuse to construct unless `PARALLELPLAY_OCI_BOUNDARY=1` is supplied by the container runtime. They receive an explicit environment, prompt, model, tools, permissions, workspace, and disabled project/user setting sources. They use structured SDK streams and provider resume identities; terminal text is never scraped.

Long-lived values such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are resolved only by the host `SecretProviderV1`. The agent receives an opaque expiring handle and a run-bound relay token. The relay validates the run, provider, model, endpoint, request count, request/response size, output-token ceiling, budget, and expiry before injecting the provider credential in memory. For a budgeted request that omits its provider-specific output limit, the relay injects the grant's ceiling before reserving cost; an invalid or higher limit is rejected. Secrets never enter command arguments, URLs, events, configuration snapshots, logs, artifacts, or workspaces.

The production container must use a private workspace, read-only root, non-root user, dropped capabilities, `no-new-privileges`, CPU/memory/PID/wall-time bounds, no host socket/store/home mounts, and no direct internet route. Only the dedicated relay path is permitted. Containment tests must prove denial of arbitrary internet, host services, cloud metadata, DNS, other runs, and other secret handles.

Resume is allowed only for a stored nonterminal session with identical context, execution-contract, capability-manifest, and checkpoint digests. Terminal, approval-required, capability-violating, or digest-mismatched sessions cannot resume.

The CLI archive contains platform-matched OCI layouts, never registry references. `parallelplay-provider-trial` loads those local layouts, validates their archive and image digests, and runs success, immediate cancellation, and forced-runner-crash recovery within one provider budget. Example after extracting an RC CLI and its detached driver manifest:

```sh
bin/parallelplay-provider-trial \
  --provider openai \
  --model gpt-5.3-codex \
  --secret-ref OPENAI_API_KEY \
  --budget-usd 10 \
  --input-usd-per-million <current-price> \
  --output-usd-per-million <current-price> \
  --fixture <clean-parallelplay-fixture> \
  --manifest <codex-sdk.extension-manifest.json> \
  --output codex-pilot.json
```

The Claude trial uses `anthropic`, `claude-sonnet-5`, `ANTHROPIC_API_KEY`, and its detached manifest. Pricing is supplied explicitly from the provider's current public price rather than embedded in the release. Evidence contains normalized usage/cost status and digests only.
