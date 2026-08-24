import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { NotificationPayloadV1Schema, notificationPayloadDigest } from "./index.js";

const DeliverySchema = z.strictObject({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(500),
  occurredAt: z.iso.datetime({ offset: true }),
  notification: NotificationPayloadV1Schema
});
const ReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(500),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal("accepted")
});
const LedgerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  receipts: z.record(z.string().regex(/^[a-f0-9]{64}$/), ReceiptSchema)
});
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface LoopbackWebhookReceiver {
  url: string;
  close(): Promise<void>;
}

export interface LoopbackWebhookReceiverOptions {
  signingSecret: string;
  ledgerPath: string;
  port?: number;
  clock?: { now(): Date };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function send(response: ServerResponse, status: number, value: unknown, headers = {}): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    throw new Error("body_too_large");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : null;
    if (!bytes) throw new Error("body_malformed");
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validSignature(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("sha256=")) return false;
  const supplied = actual.slice(7);
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

export async function startLoopbackWebhookReceiver(
  options: LoopbackWebhookReceiverOptions
): Promise<LoopbackWebhookReceiver> {
  if (options.signingSecret.length < 32) throw new Error("Webhook signing secret is too short");
  const ledgerPath = resolve(options.ledgerPath);
  const clock = options.clock ?? { now: () => new Date() };
  await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  let ledger: z.infer<typeof LedgerSchema>;
  try {
    ledger = LedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    ledger = { schemaVersion: 1, receipts: {} };
  }
  const replay = new Map<string, number>();
  let baseUrl = "";

  const persist = async (): Promise<void> => {
    const temporary = `${ledgerPath}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    await rename(temporary, ledgerPath);
  };

  const authenticate = (
    request: IncomingMessage,
    signingInput: string
  ): { timestamp: string; idempotencyKey: string } => {
    const timestamp = request.headers["x-parallelplay-timestamp"];
    const idempotencyKey = request.headers["x-parallelplay-idempotency-key"];
    const signature = request.headers["x-parallelplay-signature"];
    if (
      typeof timestamp !== "string" ||
      typeof idempotencyKey !== "string" ||
      typeof signature !== "string"
    ) {
      throw new Error("authentication_required");
    }
    const occurredAt = new Date(timestamp).getTime();
    const now = clock.now().getTime();
    if (!Number.isFinite(occurredAt) || Math.abs(now - occurredAt) > MAX_CLOCK_SKEW_MS) {
      throw new Error("timestamp_expired");
    }
    const expected = createHmac("sha256", options.signingSecret).update(signingInput).digest("hex");
    if (!validSignature(signature, expected)) throw new Error("signature_invalid");
    const replayKey = sha256(`${timestamp}:${signature}`);
    for (const [key, expires] of replay) if (expires <= now) replay.delete(key);
    if (replay.has(replayKey)) throw new Error("timestamp_replayed");
    replay.set(replayKey, now + MAX_CLOCK_SKEW_MS);
    return { timestamp, idempotencyKey };
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", baseUrl);
        if (request.method === "POST" && url.pathname === "/parallelplay") {
          const rawBody = await body(request);
          const timestampHeader = singleHeader(request.headers["x-parallelplay-timestamp"]);
          const auth = authenticate(request, `${timestampHeader}.${rawBody}`);
          const delivery = DeliverySchema.parse(JSON.parse(rawBody) as unknown);
          if (
            delivery.idempotencyKey !== auth.idempotencyKey ||
            delivery.occurredAt !== auth.timestamp
          ) {
            throw new Error("binding_invalid");
          }
          const key = sha256(delivery.idempotencyKey);
          const receipt = ReceiptSchema.parse({
            schemaVersion: 1,
            idempotencyKey: delivery.idempotencyKey,
            payloadDigest: notificationPayloadDigest(delivery.notification),
            status: "accepted"
          });
          const existing = ledger.receipts[key];
          if (existing && existing.payloadDigest !== receipt.payloadDigest) {
            send(response, 409, { ok: false, error: "idempotency_conflict" });
            return;
          }
          if (!existing) {
            ledger.receipts[key] = receipt;
            await persist();
          }
          send(response, 202, receipt, {
            location: `${baseUrl}/parallelplay/receipts/${key}`,
            "x-request-id": `loopback-${key.slice(0, 24)}`
          });
          return;
        }
        const match = /^\/parallelplay\/receipts\/([a-f0-9]{64})$/.exec(url.pathname);
        if (request.method === "GET" && match) {
          const timestampHeader = singleHeader(request.headers["x-parallelplay-timestamp"]);
          const auth = authenticate(
            request,
            `${timestampHeader}.GET.${url.pathname}${url.search}.`
          );
          const receipt = ledger.receipts[match[1] ?? ""];
          if (receipt?.idempotencyKey !== auth.idempotencyKey) {
            send(response, 404, { ok: false, error: "receipt_not_found" });
            return;
          }
          send(response, 200, receipt);
          return;
        }
        send(response, 404, { ok: false, error: "not_found" });
      } catch (error) {
        const code = error instanceof Error ? error.message : "invalid_request";
        const status = code === "body_too_large" ? 413 : code === "timestamp_replayed" ? 409 : 400;
        send(response, status, { ok: false, error: code });
      }
    })();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolvePromise);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  return {
    url: `${baseUrl}/parallelplay`,
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise()))
      )
  };
}

function singleHeader(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
