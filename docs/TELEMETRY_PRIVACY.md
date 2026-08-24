# Telemetry and privacy

OpenTelemetry export is disabled unless explicitly enabled. Enabling export requires an operator-configured OTLP destination and a reviewed attribute allowlist.

Allowed attributes describe identifiers/digests, outcomes, durations, queue depth, retries, usage/cost availability, conformance results, and adapter-effect classes. Prompts, source, diffs, packet bodies, model text, artifact content, generated comments, personal data, credentials, secret handles, provider sessions, CSRF material, and filesystem paths are excluded.

Unknown attributes are dropped rather than exported. Operators are responsible for the retention, access, and privacy policy of their OTLP backend.

Use `startOtlpTelemetry` for actual export. Export remains disabled unless `enabled: true`; enabling requires an explicit HTTPS OTLP origin, or loopback HTTP origin, without URL credentials, query parameters, fragments, or a path. ParallelPlay posts to `/v1/traces` and `/v1/metrics`. It does not inherit exporter headers or a destination from ambient environment configuration.

Allowed keys are still value-validated: digests must be SHA-256, durations/usage/retries must be finite and nonnegative, versions must be version-shaped, and identifiers/statuses must be bounded tokens. Content hidden under an allowed key is dropped.
