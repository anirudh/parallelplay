import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import {
  OutboundEffectRequestV1Schema,
  OutboundEffectReceiptV1Schema,
  type ExtensionManifestV1,
  type OutboundAdapterV1,
  type OutboundAuthorityV1,
  type OutboundEffectReceiptV1,
  type OutboundEffectRequestV1,
  type OutboundReconciliationV1
} from "@parallelplay/contracts";
import { z } from "zod";

const NotificationPayloadV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  deepLink: z
    .url()
    .max(2000)
    .refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        url.username === "" &&
        url.password === ""
      );
    }, "Deep link must be a credential-free loopback URL"),
  packetId: z.uuid(),
  packetRevisionId: z.uuid(),
  packetRevisionDigest: z.string().regex(/^[a-f0-9]{64}$/)
});
export type NotificationPayloadV1 = z.infer<typeof NotificationPayloadV1Schema>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function manifest(id: string, displayName: string): ExtensionManifestV1 {
  return {
    schemaVersion: 1,
    id,
    displayName,
    extensionVersion: "0.1.0",
    kind: "adapter",
    contract: { name: "outbound-adapter-v1", version: 1 },
    artifact: {
      mediaType: "application/vnd.parallelplay.builtin+json",
      reference: `builtin:${id}`,
      sha256: sha256(`parallelplay:${id}:0.1.0`)
    },
    configurationSchemaDigest: sha256(`${id}:config:v1`),
    capabilities: [],
    provenance: {
      sourceRepository: "https://github.com/anirudh/parallelplay",
      sourceRevision: sha256("parallelplay-v0.1.0"),
      sbomDigest: sha256(`${id}:sbom:v1`),
      attestationDigest: sha256(`${id}:attestation:v1`)
    },
    conformance: {
      suiteVersion: "0.1.0",
      reportDigest: sha256(`${id}:conformance:pending`),
      approvedRegistryDigest: null
    }
  };
}

interface StoredReceipt {
  receipt: OutboundEffectReceiptV1;
}

function receiptFor(
  adapterId: string,
  request: OutboundEffectRequestV1,
  externalId: string,
  requestId: string | null,
  observed: unknown,
  acceptedAt: string
): OutboundEffectReceiptV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    adapterId,
    effectKey: request.effectKey,
    action: request.action,
    payloadDigest: request.payloadDigest,
    externalId,
    requestId,
    observedStateDigest: sha256(canonical(observed)),
    acceptedAt
  };
  return OutboundEffectReceiptV1Schema.parse({
    ...unsigned,
    receiptDigest: sha256(canonical(unsigned))
  });
}

export interface DesktopNotificationAdapterOptions {
  authority: OutboundAuthorityV1;
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  clock?: { now(): Date };
}

export class DesktopNotificationAdapter implements OutboundAdapterV1 {
  readonly manifest = manifest("desktop-notification", "Desktop notification");
  readonly #platform: NodeJS.Platform;
  readonly #authority: OutboundAuthorityV1;
  readonly #spawn: typeof spawn;
  readonly #clock: { now(): Date };
  readonly #receipts = new Map<string, StoredReceipt>();

  constructor(options: DesktopNotificationAdapterOptions) {
    this.#authority = options.authority;
    this.#platform = options.platform ?? process.platform;
    this.#spawn = options.spawn ?? spawn;
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async deliver(rawRequest: OutboundEffectRequestV1): Promise<OutboundEffectReceiptV1> {
    const request = OutboundEffectRequestV1Schema.parse(rawRequest);
    if (request.action !== "notification.desktop.deliver") {
      throw new Error("Desktop adapter accepts only notification.desktop.deliver");
    }
    const existing = this.#receipts.get(request.effectKey);
    if (existing) return existing.receipt;
    const payload = NotificationPayloadV1Schema.parse(request.payload);
    if (sha256(canonical(payload)) !== request.payloadDigest)
      throw new Error("Notification payload digest mismatch");
    validateNotificationPayload(payload);
    await this.#authority.authorize(request);
    const command = this.#platform === "darwin" ? "/usr/bin/osascript" : "/usr/bin/notify-send";
    const args =
      this.#platform === "darwin"
        ? [
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            payload.title,
            payload.body
          ]
        : ["--app-name=ParallelPlay", payload.title, payload.body];
    try {
      await new Promise<void>((resolve, reject) => {
        const child = this.#spawn(command, args, {
          stdio: "ignore",
          env: { PATH: "/usr/bin:/bin" }
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`Desktop notification exited ${String(code)}`))
        );
      });
      const receipt = receiptFor(
        this.manifest.id,
        request,
        `desktop:${sha256(request.effectKey)}`,
        null,
        { delivered: true, packetRevisionDigest: payload.packetRevisionDigest },
        this.#clock.now().toISOString()
      );
      await this.#authority.recordReceipt(request, receipt);
      this.#receipts.set(request.effectKey, { receipt });
      return receipt;
    } catch (error) {
      await this.#authority.recordFailure(request, {
        retryable: true,
        reason: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  reconcile(effectKey: string): Promise<OutboundReconciliationV1> {
    const effect = this.#receipts.get(effectKey);
    return Promise.resolve(
      effect
        ? {
            schemaVersion: 1,
            effectKey,
            status: "observed_exact",
            externalId: effect.receipt.externalId,
            observedStateDigest: effect.receipt.observedStateDigest
          }
        : {
            schemaVersion: 1,
            effectKey,
            status: "not_observed",
            externalId: null,
            observedStateDigest: null
          }
    );
  }

  async close(): Promise<void> {
    this.#receipts.clear();
  }
}

export interface SignedWebhookAdapterOptions {
  endpoint: string;
  signingSecret: string;
  authority: OutboundAuthorityV1;
  fetch?: typeof globalThis.fetch;
  clock?: { now(): Date };
}

export class SignedWebhookAdapter implements OutboundAdapterV1 {
  readonly manifest = manifest("signed-webhook", "Signed webhook");
  readonly #endpoint: URL;
  readonly #authority: OutboundAuthorityV1;
  readonly #signingSecret: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: { now(): Date };
  readonly #receipts = new Map<string, StoredReceipt>();

  constructor(options: SignedWebhookAdapterOptions) {
    this.#authority = options.authority;
    this.#endpoint = new URL(options.endpoint);
    if (this.#endpoint.username || this.#endpoint.password || this.#endpoint.hash) {
      throw new Error("Webhook endpoint cannot contain credentials or a fragment");
    }
    const local =
      this.#endpoint.hostname === "127.0.0.1" || this.#endpoint.hostname === "localhost";
    if (this.#endpoint.protocol !== "https:" && !(local && this.#endpoint.protocol === "http:")) {
      throw new Error("Webhook endpoint must use HTTPS or loopback HTTP");
    }
    if (options.signingSecret.length < 32)
      throw new Error("Webhook signing secret must be at least 32 characters");
    this.#signingSecret = options.signingSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async deliver(rawRequest: OutboundEffectRequestV1): Promise<OutboundEffectReceiptV1> {
    const request = OutboundEffectRequestV1Schema.parse(rawRequest);
    if (request.action !== "notification.webhook.deliver") {
      throw new Error("Webhook adapter accepts only notification.webhook.deliver");
    }
    const existing = this.#receipts.get(request.effectKey);
    if (existing) return existing.receipt;
    const payload = NotificationPayloadV1Schema.parse(request.payload);
    if (sha256(canonical(payload)) !== request.payloadDigest)
      throw new Error("Notification payload digest mismatch");
    validateNotificationPayload(payload);
    await this.#authority.authorize(request);
    const timestamp = this.#clock.now().toISOString();
    const body = JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: request.effectKey,
      occurredAt: timestamp,
      notification: payload
    });
    const signature = createHmac("sha256", this.#signingSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-parallelplay-idempotency-key": request.effectKey,
          "x-parallelplay-timestamp": timestamp,
          "x-parallelplay-signature": `sha256=${signature}`
        },
        body,
        redirect: "manual"
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Webhook delivery failed with ${String(response.status)}`);
      }
      const observed = { status: response.status, responseDigest: sha256(await response.text()) };
      const receipt = receiptFor(
        this.manifest.id,
        request,
        response.headers.get("location") ?? `webhook:${sha256(request.effectKey)}`,
        response.headers.get("x-request-id"),
        observed,
        timestamp
      );
      await this.#authority.recordReceipt(request, receipt);
      this.#receipts.set(request.effectKey, { receipt });
      return receipt;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const status = /with ([0-9]{3})/.exec(reason)?.[1];
      await this.#authority.recordFailure(request, {
        retryable:
          status === undefined ||
          status === "408" ||
          status === "409" ||
          status === "429" ||
          status.startsWith("5"),
        reason
      });
      throw error;
    }
  }

  reconcile(effectKey: string): Promise<OutboundReconciliationV1> {
    const effect = this.#receipts.get(effectKey);
    return Promise.resolve(
      effect
        ? {
            schemaVersion: 1,
            effectKey,
            status: "observed_exact",
            externalId: effect.receipt.externalId,
            observedStateDigest: effect.receipt.observedStateDigest
          }
        : {
            schemaVersion: 1,
            effectKey,
            status: "not_observed",
            externalId: null,
            observedStateDigest: null
          }
    );
  }

  async close(): Promise<void> {
    this.#receipts.clear();
  }
}

export function notificationPayloadDigest(payload: NotificationPayloadV1): string {
  return sha256(canonical(NotificationPayloadV1Schema.parse(payload)));
}

function validateNotificationPayload(payload: NotificationPayloadV1): void {
  const combined = `${payload.title}\n${payload.body}`;
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(combined) ||
    /\b(?:github_pat_|gh[pousr]_|sk-(?:proj-)?|sk-ant-)[A-Za-z0-9_-]{20,}\b/.test(combined)
  ) {
    throw new Error("Notification contains a secret-like value");
  }
  const url = new URL(payload.deepLink);
  const allowedKeys = new Set(["packet", "revision"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key))
      throw new Error("Notification deep link may contain identity fields only");
  }
}
