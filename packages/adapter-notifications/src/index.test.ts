import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionManifestV1 } from "@parallelplay/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopNotificationAdapter,
  SignedWebhookAdapter,
  StdioDesktopNotificationBridge,
  notificationPayloadDigest,
  type DesktopNotificationBridgeV1
} from "./index.js";

const digest = (value: string): string =>
  createHmac("sha256", "parallelplay-test-manifest").update(value).digest("hex");
const manifest: ExtensionManifestV1 = {
  schemaVersion: 1,
  id: "signed-webhook",
  displayName: "Signed webhook",
  extensionVersion: "0.1.0",
  kind: "adapter",
  contract: { name: "outbound-adapter-v1", version: 1 },
  artifact: {
    mediaType: "application/vnd.parallelplay.builtin+json",
    reference: "builtin:signed-webhook",
    sha256: digest("artifact")
  },
  configurationSchemaDigest: digest("configuration"),
  capabilities: [],
  provenance: {
    sourceRepository: "https://github.com/anirudh/parallelplay",
    sourceRevision: digest("source"),
    sbomDigest: digest("sbom"),
    attestationDigest: digest("attestation")
  },
  conformance: {
    suiteVersion: "0.1.0",
    reportDigest: digest("report"),
    approvedRegistryDigest: null
  }
};

const authority = {
  authorize: () =>
    Promise.resolve({ status: "authorized" as const, authorizationDigest: "a".repeat(64) }),
  recordReceipt: () => Promise.resolve(),
  recordFailure: () => Promise.resolve()
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("signed webhook adapter", () => {
  it("signs one idempotent bounded payload without putting authority in the deep link", async () => {
    const secret = ["a-secret-with-at-least", "thirty-two-bytes"].join("-");
    let deliveries = 0;
    const receipts = new Map<string, unknown>();
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST") {
        deliveries += 1;
        const headers = new Headers(init.headers);
        const body = typeof init.body === "string" ? init.body : "";
        const timestamp = headers.get("x-parallelplay-timestamp");
        if (!timestamp) throw new Error("Missing webhook timestamp");
        const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
        expect(headers.get("x-parallelplay-signature")).toBe(`sha256=${expected}`);
        expect(body).not.toContain("csrf");
        expect(body).not.toContain("session");
        const value = JSON.parse(body) as {
          idempotencyKey: string;
          notification: Parameters<typeof notificationPayloadDigest>[0];
        };
        const receiptUrl = `${url}/receipts/${createHash("sha256").update(value.idempotencyKey).digest("hex")}`;
        const receipt = {
          schemaVersion: 1,
          idempotencyKey: value.idempotencyKey,
          payloadDigest: notificationPayloadDigest(value.notification),
          status: "accepted"
        };
        receipts.set(receiptUrl, receipt);
        return Promise.resolve(
          new Response(JSON.stringify(receipt), {
            status: 202,
            headers: { "x-request-id": "r-1", location: receiptUrl }
          })
        );
      }
      if (init?.method === "GET") {
        const receipt = receipts.get(url);
        if (!receipt) return Promise.resolve(new Response("{}", { status: 404 }));
        const headers = new Headers(init.headers);
        const timestamp = headers.get("x-parallelplay-timestamp");
        if (!timestamp) throw new Error("Missing reconciliation timestamp");
        const parsedUrl = new URL(url);
        const expected = createHmac("sha256", secret)
          .update(`${timestamp}.GET.${parsedUrl.pathname}${parsedUrl.search}.`)
          .digest("hex");
        expect(headers.get("x-parallelplay-signature")).toBe(`sha256=${expected}`);
        return Promise.resolve(new Response(JSON.stringify(receipt), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 405 }));
    };
    const adapter = new SignedWebhookAdapter({
      manifest,
      authority,
      endpoint: "https://hooks.example.test/parallelplay",
      signingSecret: secret,
      fetch
    });
    const payload = {
      schemaVersion: 1 as const,
      title: "Review required",
      body: "A bounded decision is waiting.",
      deepLink:
        "http://127.0.0.1:4318/decisions/10000000-0000-4000-8000-000000000001?revision=10000000-0000-4000-8000-000000000002",
      packetId: "10000000-0000-4000-8000-000000000001",
      packetRevisionId: "10000000-0000-4000-8000-000000000002",
      packetRevisionDigest: "a".repeat(64)
    };
    const request = {
      schemaVersion: 1 as const,
      adapterId: "signed-webhook",
      effectKey: "notification-1",
      action: "notification.webhook.deliver" as const,
      target: "hooks.example.test",
      payload,
      payloadDigest: notificationPayloadDigest(payload),
      preconditionDigest: "b".repeat(64),
      policyPromotionDigest: "c".repeat(64)
    };
    const first = await adapter.deliver(request);
    const second = await adapter.deliver(request);
    expect(first.receiptDigest).toBe(second.receiptDigest);
    expect(deliveries).toBe(1);
    expect(
      (await adapter.reconcile({ schemaVersion: 1, effect: request, priorReceipt: first })).status
    ).toBe("observed_exact");
    const restarted = new SignedWebhookAdapter({
      manifest,
      authority,
      endpoint: "https://hooks.example.test/parallelplay",
      signingSecret: secret,
      fetch
    });
    expect(
      (await restarted.reconcile({ schemaVersion: 1, effect: request, priorReceipt: first })).status
    ).toBe("observed_exact");
  });

  it("rejects credential-bearing or insecure remote endpoints", () => {
    expect(
      () =>
        new SignedWebhookAdapter({
          manifest,
          authority,
          endpoint: "https://user:password@example.test/hook",
          signingSecret: ["a-secret-with-at-least", "thirty-two-bytes"].join("-")
        })
    ).toThrow(/credentials/);
    expect(
      () =>
        new SignedWebhookAdapter({
          manifest,
          authority,
          endpoint: "http://example.test/hook",
          signingSecret: ["a-secret-with-at-least", "thirty-two-bytes"].join("-")
        })
    ).toThrow(/HTTPS/);
  });
});

describe("desktop notification adapter", () => {
  it("rejects a non-absolute macOS Applications directory before spawning", () => {
    expect(
      () =>
        new StdioDesktopNotificationBridge({
          executable: "/tmp/parallelplay-notification-bridge",
          applicationsDirectory: "Applications"
        })
    ).toThrow(/Applications directory must be an absolute path/);
  });

  it("rejects a closed bridge protocol without an unhandled pipe error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "parallelplay-closed-notification-bridge-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "closed-bridge");
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const bridge = new StdioDesktopNotificationBridge({ executable });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    await expect(bridge.query("a".repeat(64))).rejects.toThrow(
      /Notification bridge (?:closed its protocol|write failed)/
    );
    await bridge.close();
  });

  it("uses a stable bridge identity and reconciles delivered state after restart", async () => {
    const delivered = new Set<string>();
    const bridge = (): DesktopNotificationBridgeV1 => ({
      deliver: (notification) => {
        delivered.add(notification.identifier);
        return Promise.resolve({ systemId: notification.identifier });
      },
      query: (identifier) =>
        Promise.resolve({
          status: delivered.has(identifier) ? "delivered" : "not_delivered"
        }),
      close: () => Promise.resolve()
    });
    const desktopManifest: ExtensionManifestV1 = {
      ...manifest,
      id: "desktop-notification",
      displayName: "Desktop notification"
    };
    const payload = {
      schemaVersion: 1 as const,
      title: "Review required",
      body: "A bounded decision is waiting.",
      deepLink:
        "http://127.0.0.1:4318/decisions/10000000-0000-4000-8000-000000000001?revision=10000000-0000-4000-8000-000000000002",
      packetId: "10000000-0000-4000-8000-000000000001",
      packetRevisionId: "10000000-0000-4000-8000-000000000002",
      packetRevisionDigest: "a".repeat(64)
    };
    const request = {
      schemaVersion: 1 as const,
      adapterId: "desktop-notification",
      effectKey: "desktop-1",
      action: "notification.desktop.deliver" as const,
      target: "local-desktop",
      payload,
      payloadDigest: notificationPayloadDigest(payload),
      preconditionDigest: "b".repeat(64),
      policyPromotionDigest: "c".repeat(64)
    };
    const adapter = new DesktopNotificationAdapter({
      manifest: desktopManifest,
      authority,
      bridge: bridge()
    });
    const receipt = await adapter.deliver(request);
    const restarted = new DesktopNotificationAdapter({
      manifest: desktopManifest,
      authority,
      bridge: bridge()
    });
    expect(
      (await restarted.reconcile({ schemaVersion: 1, effect: request, priorReceipt: receipt }))
        .status
    ).toBe("observed_exact");
  });

  it("rejects a deep link that is not bound to the exact packet revision", async () => {
    const desktopManifest: ExtensionManifestV1 = {
      ...manifest,
      id: "desktop-notification",
      displayName: "Desktop notification"
    };
    const bridge: DesktopNotificationBridgeV1 = {
      deliver: () => Promise.resolve({ systemId: "unused" }),
      query: () => Promise.resolve({ status: "not_delivered" }),
      close: () => Promise.resolve()
    };
    const payload = {
      schemaVersion: 1 as const,
      title: "Review required",
      body: "A bounded decision is waiting.",
      deepLink: "http://127.0.0.1:4318/decisions/wrong?revision=wrong",
      packetId: "10000000-0000-4000-8000-000000000001",
      packetRevisionId: "10000000-0000-4000-8000-000000000002",
      packetRevisionDigest: "a".repeat(64)
    };
    const adapter = new DesktopNotificationAdapter({
      manifest: desktopManifest,
      authority,
      bridge
    });
    await expect(
      adapter.deliver({
        schemaVersion: 1,
        adapterId: "desktop-notification",
        effectKey: "desktop-wrong",
        action: "notification.desktop.deliver",
        target: "local-desktop",
        payload,
        payloadDigest: notificationPayloadDigest(payload),
        preconditionDigest: "b".repeat(64),
        policyPromotionDigest: "c".repeat(64)
      })
    ).rejects.toThrow(/exact packet revision/);
  });
});
