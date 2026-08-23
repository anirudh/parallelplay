# Notifications

The macOS and Linux desktop adapters send a title, short body, and identity-only loopback deep link. Notifications contain no authority; the operator must authenticate to Attention and act on the current packet revision.

The webhook adapter accepts an operator-configured HTTPS destination, or loopback HTTP for tests. It uses a strict bounded JSON payload, timestamp, idempotency key, and `HMAC-SHA256(timestamp + "." + body)`. Redirects, URL credentials/fragments, unknown deep-link fields, secret-like text, and oversized content are rejected.

Webhook signing keys remain host-only. Payloads do not contain CSRF/session material, provider checkpoints, packet bodies, source, artifacts, or credentials. Slack and email adapters are not included in 0.1.0.
