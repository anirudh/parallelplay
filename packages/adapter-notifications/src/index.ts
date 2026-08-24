import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
  OutboundEffectRequestV1Schema,
  OutboundEffectReceiptV1Schema,
  OutboundReconcileRequestV1Schema,
  ExtensionManifestV1Schema,
  type ExtensionManifestV1,
  type OutboundAdapterV1,
  type OutboundAuthorityV1,
  type OutboundEffectReceiptV1,
  type OutboundEffectRequestV1,
  type OutboundReconcileRequestV1,
  type OutboundReconciliationV1
} from "@parallelplay/contracts";
import { z } from "zod";

export const NotificationPayloadV1Schema = z.strictObject({
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
const WebhookReceiptRepresentationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(500),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal("accepted")
});
const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

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
  manifest: ExtensionManifestV1;
  authority: OutboundAuthorityV1;
  bridge: DesktopNotificationBridgeV1;
  clock?: { now(): Date };
}

export interface DesktopNotificationBridgeV1 {
  deliver(notification: {
    identifier: string;
    title: string;
    body: string;
    deepLink: string;
  }): Promise<{ systemId: string }>;
  query(identifier: string): Promise<{ status: "delivered" | "not_delivered" }>;
  close(): Promise<void>;
}

const BridgeResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  ok: z.boolean(),
  result: z
    .union([
      z.strictObject({ systemId: z.string().min(1).max(1000) }),
      z.strictObject({ status: z.enum(["delivered", "not_delivered"]) }),
      z.strictObject({ closed: z.literal(true) })
    ])
    .optional(),
  error: z.strictObject({ code: z.string().min(1).max(100) }).optional()
});

export class StdioDesktopNotificationBridge implements DesktopNotificationBridgeV1 {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: Interface;
  readonly #iterator: AsyncIterator<string>;
  #chain: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: {
    executable: string;
    spawn?: typeof spawn;
    environment?: Partial<
      Record<"DBUS_SESSION_BUS_ADDRESS" | "XDG_RUNTIME_DIR" | "DISPLAY" | "WAYLAND_DISPLAY", string>
    >;
    applicationsDirectory?: string;
  }) {
    if (!options.executable.startsWith("/")) {
      throw new Error("Desktop notification bridge path must be absolute");
    }
    const applicationsDirectory =
      options.applicationsDirectory ??
      (process.platform === "darwin" ? join(homedir(), "Applications") : undefined);
    if (
      applicationsDirectory !== undefined &&
      (!isAbsolute(applicationsDirectory) ||
        applicationsDirectory.includes("\0") ||
        applicationsDirectory.includes("\n"))
    ) {
      throw new Error("Desktop notification Applications directory must be an absolute path");
    }
    this.#child = (options.spawn ?? spawn)(options.executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        ...(applicationsDirectory
          ? { PARALLELPLAY_NOTIFICATION_APPS_DIR: applicationsDirectory }
          : {}),
        ...Object.fromEntries(
          Object.entries(options.environment ?? {}).filter(
            ([, value]) => typeof value === "string" && value.length > 0
          )
        )
      }
    });
    this.#child.stderr.resume();
    this.#child.stdin.on("error", () => undefined);
    this.#lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    this.#iterator = this.#lines[Symbol.asyncIterator]();
  }

  async deliver(notification: {
    identifier: string;
    title: string;
    body: string;
    deepLink: string;
  }): Promise<{ systemId: string }> {
    const result = await this.#command("deliver", notification);
    return z.strictObject({ systemId: z.string().min(1).max(1000) }).parse(result);
  }

  async query(identifier: string): Promise<{ status: "delivered" | "not_delivered" }> {
    const result = await this.#command("query", { identifier });
    return z.strictObject({ status: z.enum(["delivered", "not_delivered"]) }).parse(result);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#command("close", {});
    } catch {
      // The bridge process may already have exited; cleanup is still mandatory.
    }
    this.#lines.close();
    this.#child.kill("SIGTERM");
  }

  async #command(operation: string, input: unknown): Promise<unknown> {
    const requestId = randomUUID();
    const execute = async (): Promise<unknown> => {
      if (this.#closed && operation !== "close") throw new Error("Notification bridge is closed");
      if (this.#child.exitCode !== null || this.#child.stdin.destroyed) {
        throw new Error("Notification bridge closed its protocol");
      }
      await new Promise<void>((resolvePromise, reject) => {
        this.#child.stdin.write(
          `${JSON.stringify({ schemaVersion: 1, requestId, operation, input })}\n`,
          (error) => {
            if (error) reject(new Error("Notification bridge write failed"));
            else resolvePromise();
          }
        );
      });
      let timeout: NodeJS.Timeout | undefined;
      let response: IteratorResult<string>;
      try {
        response = await Promise.race([
          this.#iterator.next(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Notification bridge timed out")), 10_000);
          })
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (response.done) throw new Error("Notification bridge closed its protocol");
      const parsed = BridgeResponseSchema.parse(JSON.parse(response.value) as unknown);
      if (parsed.requestId !== requestId) throw new Error("Notification bridge response reordered");
      if (!parsed.ok || parsed.result === undefined) {
        throw new Error(`Notification bridge rejected ${operation}`);
      }
      return parsed.result;
    };
    const result = this.#chain.then(execute, execute);
    this.#chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export class DesktopNotificationAdapter implements OutboundAdapterV1 {
  readonly manifest: ExtensionManifestV1;
  readonly #authority: OutboundAuthorityV1;
  readonly #bridge: DesktopNotificationBridgeV1;
  readonly #clock: { now(): Date };
  readonly #receipts = new Map<string, StoredReceipt>();

  constructor(options: DesktopNotificationAdapterOptions) {
    this.manifest = parseAdapterManifest(options.manifest, "desktop-notification");
    this.#authority = options.authority;
    this.#bridge = options.bridge;
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
    try {
      const identifier = sha256(request.effectKey);
      const prior = await this.#bridge.query(identifier);
      await this.#authority.authorize(request);
      if (prior.status === "delivered") {
        const recovered = receiptFor(
          this.manifest.id,
          request,
          `desktop:${identifier}`,
          null,
          { delivered: true, packetRevisionDigest: payload.packetRevisionDigest },
          this.#clock.now().toISOString()
        );
        await this.#authority.recordReceipt(request, recovered);
        this.#receipts.set(request.effectKey, { receipt: recovered });
        return recovered;
      }
      const delivered = await this.#bridge.deliver({
        identifier,
        title: payload.title,
        body: payload.body,
        deepLink: payload.deepLink
      });
      if (delivered.systemId !== identifier) {
        throw new Error("Desktop notification bridge returned an unstable identifier");
      }
      const receipt = receiptFor(
        this.manifest.id,
        request,
        `desktop:${delivered.systemId}`,
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

  async reconcile(rawRequest: OutboundReconcileRequestV1): Promise<OutboundReconciliationV1> {
    const request = OutboundReconcileRequestV1Schema.parse(rawRequest);
    const effectKey = request.effect.effectKey;
    const payload = NotificationPayloadV1Schema.parse(request.effect.payload);
    const observed = await this.#bridge.query(sha256(effectKey));
    if (observed.status === "not_delivered") {
      return {
        schemaVersion: 1,
        effectKey,
        status: "not_observed",
        externalId: null,
        observedStateDigest: null
      };
    }
    const stateDigest = sha256(
      canonical({ delivered: true, packetRevisionDigest: payload.packetRevisionDigest })
    );
    const prior = this.#receipts.get(effectKey)?.receipt ?? request.priorReceipt;
    const exact = prior === null || prior.observedStateDigest === stateDigest;
    return {
      schemaVersion: 1,
      effectKey,
      status: exact ? "observed_exact" : "observed_conflict",
      externalId: `desktop:${sha256(effectKey)}`,
      observedStateDigest: stateDigest
    };
  }

  async close(): Promise<void> {
    this.#receipts.clear();
    await this.#bridge.close();
  }
}

export interface SignedWebhookAdapterOptions {
  manifest: ExtensionManifestV1;
  endpoint: string;
  signingSecret: string;
  authority: OutboundAuthorityV1;
  fetch?: typeof globalThis.fetch;
  clock?: { now(): Date };
}

export class SignedWebhookAdapter implements OutboundAdapterV1 {
  readonly manifest: ExtensionManifestV1;
  readonly #endpoint: URL;
  readonly #authority: OutboundAuthorityV1;
  readonly #signingSecret: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: { now(): Date };
  readonly #receipts = new Map<string, StoredReceipt>();

  constructor(options: SignedWebhookAdapterOptions) {
    this.manifest = parseAdapterManifest(options.manifest, "signed-webhook");
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
      const expectedReceiptUrl = this.#receiptUrl(request.effectKey);
      const location = response.headers.get("location");
      if (!location || new URL(location, this.#endpoint).href !== expectedReceiptUrl.href) {
        throw new Error("Webhook receiver returned an invalid receipt location");
      }
      const observed = WebhookReceiptRepresentationV1Schema.parse(await readBoundedJson(response));
      if (
        observed.idempotencyKey !== request.effectKey ||
        observed.payloadDigest !== request.payloadDigest
      ) {
        throw new Error("Webhook receiver returned a conflicting receipt");
      }
      const receipt = receiptFor(
        this.manifest.id,
        request,
        expectedReceiptUrl.href,
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

  async reconcile(rawRequest: OutboundReconcileRequestV1): Promise<OutboundReconciliationV1> {
    const request = OutboundReconcileRequestV1Schema.parse(rawRequest);
    const effectKey = request.effect.effectKey;
    const receiptUrl = this.#receiptUrl(effectKey);
    const timestamp = this.#clock.now().toISOString();
    const signature = createHmac("sha256", this.#signingSecret)
      .update(`${timestamp}.GET.${receiptUrl.pathname}${receiptUrl.search}.`)
      .digest("hex");
    const response = await this.#fetch(receiptUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-parallelplay-idempotency-key": effectKey,
        "x-parallelplay-timestamp": timestamp,
        "x-parallelplay-signature": `sha256=${signature}`
      },
      redirect: "manual"
    });
    if (response.status === 404) {
      return {
        schemaVersion: 1,
        effectKey,
        status: "not_observed",
        externalId: null,
        observedStateDigest: null
      };
    }
    if (!response.ok) {
      throw new Error(`Webhook reconciliation failed with ${String(response.status)}`);
    }
    const observed = WebhookReceiptRepresentationV1Schema.parse(await readBoundedJson(response));
    const exact =
      observed.idempotencyKey === effectKey &&
      observed.payloadDigest === request.effect.payloadDigest;
    return {
      schemaVersion: 1,
      effectKey,
      status: exact ? "observed_exact" : "observed_conflict",
      externalId: receiptUrl.href,
      observedStateDigest: sha256(canonical(observed))
    };
  }

  async close(): Promise<void> {
    this.#receipts.clear();
  }

  #receiptUrl(effectKey: string): URL {
    const receipt = new URL(this.#endpoint);
    receipt.search = "";
    receipt.pathname = `${receipt.pathname.replace(/\/$/, "")}/receipts/${sha256(effectKey)}`;
    return receipt;
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
  const expectedPath = `/decisions/${payload.packetId}`;
  if (
    url.pathname !== expectedPath ||
    url.searchParams.get("revision") !== payload.packetRevisionId
  ) {
    throw new Error("Notification deep link does not bind the exact packet revision");
  }
  const allowedKeys = new Set(["revision"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key))
      throw new Error("Notification deep link may contain identity fields only");
  }
}

function parseAdapterManifest(manifest: ExtensionManifestV1, id: string): ExtensionManifestV1 {
  const parsed = ExtensionManifestV1Schema.parse(manifest);
  if (
    parsed.id !== id ||
    parsed.kind !== "adapter" ||
    parsed.contract.name !== "outbound-adapter-v1"
  ) {
    throw new Error(`${id} requires a matching outbound-adapter-v1 manifest`);
  }
  return parsed;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_WEBHOOK_RESPONSE_BYTES) {
    throw new Error("Webhook response exceeds the size limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_WEBHOOK_RESPONSE_BYTES) {
    throw new Error("Webhook response exceeds the size limit");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
