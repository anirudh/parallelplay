# Notifications

The macOS and Linux desktop adapters send a title, short body, and identity-only loopback deep link. Notifications contain no authority; the operator must authenticate to Attention and act on the current packet revision.

The webhook adapter accepts an operator-configured HTTPS destination, or loopback HTTP for tests. It uses a strict bounded JSON payload, timestamp, idempotency key, and `HMAC-SHA256(timestamp + "." + body)`. Redirects, URL credentials/fragments, unknown deep-link fields, secret-like text, and oversized content are rejected.

Webhook signing keys remain host-only. Payloads do not contain CSRF/session material, provider checkpoints, packet bodies, source, artifacts, or credentials. Slack and email adapters are not included in 0.1.0.

The macOS CLI archive includes an owner-only local bridge. It derives a stable notification identifier from the effect key, reconciles delivered state, and opens the exact Attention packet and revision. Linux uses the real D-Bus notifications protocol; replacement IDs and action invocation run against an isolated CI receiver.

The signed-webhook receiver accepts the timestamped HMAC POST, persists a bounded idempotency receipt, returns its location, and supports authenticated GET reconciliation after either process restarts. It rejects redirects, replayed timestamps, oversized/malformed bodies, and content that resembles a secret.

Run the combined RC pilot with detached manifests and an existing exact Attention decision link:

```sh
bin/parallelplay-notification-trial \
  --attention-url 'http://127.0.0.1:<port>/decisions/<packet>?revision=<revision>' \
  --packet-revision-digest <sha256> \
  --desktop-manifest <desktop-notification.extension-manifest.json> \
  --webhook-manifest <signed-webhook.extension-manifest.json> \
  --output notification-pilot.json
```

Receipt evidence proves protocol acceptance. The pilot record separately records the required human macOS display and click observation.
