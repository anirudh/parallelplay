import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignedWebhookAdapter, notificationPayloadDigest } from "./index.js";

const authority = {
  authorize: () =>
    Promise.resolve({ status: "authorized" as const, authorizationDigest: "a".repeat(64) }),
  recordReceipt: () => Promise.resolve(),
  recordFailure: () => Promise.resolve()
};

describe("signed webhook adapter", () => {
  it("signs one idempotent bounded payload without putting authority in the deep link", async () => {
    const secret = ["a-secret-with-at-least", "thirty-two-bytes"].join("-");
    let deliveries = 0;
    const adapter = new SignedWebhookAdapter({
      authority,
      endpoint: "https://hooks.example.test/parallelplay",
      signingSecret: secret,
      fetch: (_input, init) => {
        deliveries += 1;
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? init.body : "";
        const timestamp = headers.get("x-parallelplay-timestamp");
        if (!timestamp) throw new Error("Missing webhook timestamp");
        const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
        expect(headers.get("x-parallelplay-signature")).toBe(`sha256=${expected}`);
        expect(body).not.toContain("csrf");
        expect(body).not.toContain("session");
        return Promise.resolve(
          new Response("accepted", { status: 202, headers: { "x-request-id": "r-1" } })
        );
      }
    });
    const payload = {
      schemaVersion: 1 as const,
      title: "Review required",
      body: "A bounded decision is waiting.",
      deepLink: "http://127.0.0.1:4318/attention?packet=1",
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
    expect((await adapter.reconcile(request.effectKey)).status).toBe("observed_exact");
  });

  it("rejects credential-bearing or insecure remote endpoints", () => {
    expect(
      () =>
        new SignedWebhookAdapter({
          authority,
          endpoint: "https://user:password@example.test/hook",
          signingSecret: ["a-secret-with-at-least", "thirty-two-bytes"].join("-")
        })
    ).toThrow(/credentials/);
    expect(
      () =>
        new SignedWebhookAdapter({
          authority,
          endpoint: "http://example.test/hook",
          signingSecret: ["a-secret-with-at-least", "thirty-two-bytes"].join("-")
        })
    ).toThrow(/HTTPS/);
  });
});
