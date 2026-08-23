# Telemetry and privacy

OpenTelemetry export is disabled unless explicitly enabled. Enabling export requires an operator-configured OTLP destination and a reviewed attribute allowlist.

Allowed attributes describe identifiers/digests, outcomes, durations, queue depth, retries, usage/cost availability, conformance results, and adapter-effect classes. Prompts, source, diffs, packet bodies, model text, artifact content, generated comments, personal data, credentials, secret handles, provider sessions, CSRF material, and filesystem paths are excluded.

Unknown attributes are dropped rather than exported. Operators are responsible for the retention, access, and privacy policy of their OTLP backend.
