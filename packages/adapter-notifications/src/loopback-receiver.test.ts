import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionManifestV1 } from "@parallelplay/contracts";
import { describe, expect, it } from "vitest";
import { SignedWebhookAdapter, notificationPayloadDigest } from "./index.js";
import { startLoopbackWebhookReceiver } from "./loopback-receiver.js";

const digest = (value: string): string =>
  createHmac("sha256", "parallelplay-loopback-test").update(value).digest("hex");
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

describe("loopback webhook receiver", () => {
  it("persists only an idempotency receipt and reconciles after both processes restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "parallelplay-webhook-ledger-"));
    const ledgerPath = join(directory, "ledger.json");
    const signingMaterial = ["loopback", "pilot", "secret", "with-more-than-32-bytes"].join("-");
    let tick = 0;
    const clock = {
      now: () => new Date(Date.UTC(2026, 7, 23, 12, 0, tick++))
    };
    const receiver = await startLoopbackWebhookReceiver({
      signingSecret: signingMaterial,
      ledgerPath,
      clock
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
      effectKey: "loopback-effect",
      action: "notification.webhook.deliver" as const,
      target: "loopback",
      payload,
      payloadDigest: notificationPayloadDigest(payload),
      preconditionDigest: "b".repeat(64),
      policyPromotionDigest: "c".repeat(64)
    };
    const adapter = new SignedWebhookAdapter({
      manifest,
      endpoint: receiver.url,
      signingSecret: signingMaterial,
      authority,
      clock
    });
    const receipt = await adapter.deliver(request);
    expect(
      (await adapter.reconcile({ schemaVersion: 1, effect: request, priorReceipt: receipt })).status
    ).toBe("observed_exact");
    const ledger = readFileSync(ledgerPath, "utf8");
    expect(ledger).not.toContain(payload.title);
    expect(ledger).not.toContain(payload.body);
    expect(ledger).not.toContain(payload.deepLink);
    await adapter.close();
    await receiver.close();

    const restartedReceiver = await startLoopbackWebhookReceiver({
      signingSecret: signingMaterial,
      ledgerPath,
      clock
    });
    const restartedAdapter = new SignedWebhookAdapter({
      manifest,
      endpoint: restartedReceiver.url,
      signingSecret: signingMaterial,
      authority,
      clock
    });
    expect(
      (
        await restartedAdapter.reconcile({
          schemaVersion: 1,
          effect: request,
          priorReceipt: receipt
        })
      ).status
    ).toBe("observed_exact");
    await restartedAdapter.close();
    await restartedReceiver.close();
  });
});
