import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { EnvironmentSecretProvider } from "./secret-provider.js";

export type ProviderName = "openai" | "anthropic";

export interface ProviderBrokerGrant {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly runId: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly expiresAt: string;
  readonly endpoint: string;
  readonly grantDigest: string;
}

export interface ProviderBrokerOptions {
  secretProvider: EnvironmentSecretProvider;
  upstreams?: Partial<Record<ProviderName, string>>;
  fetch?: typeof globalThis.fetch;
  clock?: { now(): Date };
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxRequestsPerGrant?: number;
}

interface StoredGrant {
  runId: string;
  provider: ProviderName;
  model: string;
  secretHandleId: string;
  expiresAt: string;
  remainingRequests: number;
}

const PROVIDER_PATHS: Record<ProviderName, RegExp> = {
  openai: /^\/v1\/(?:responses|responses\/[A-Za-z0-9_-]+|models\/[A-Za-z0-9._-]+)$/,
  anthropic: /^\/v1\/(?:messages|messages\/batches|models\/[A-Za-z0-9._-]+)$/
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readRequest(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new Error("Provider broker request is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class ProviderEgressBroker {
  readonly #secretProvider: EnvironmentSecretProvider;
  readonly #upstreams: Record<ProviderName, string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: { now(): Date };
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxRequestsPerGrant: number;
  readonly #grants = new Map<string, StoredGrant>();
  #server: Server | null = null;

  constructor(options: ProviderBrokerOptions) {
    this.#secretProvider = options.secretProvider;
    this.#upstreams = {
      openai: options.upstreams?.openai ?? "https://api.openai.com",
      anthropic: options.upstreams?.anthropic ?? "https://api.anthropic.com"
    };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;
    this.#maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    this.#maxRequestsPerGrant = options.maxRequestsPerGrant ?? 128;
  }

  async start(): Promise<string> {
    if (this.#server) throw new Error("Provider broker is already running");
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : "Broker failure" })
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.#server;
      if (!server) return reject(new Error("Provider broker server disappeared"));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
  }

  issueGrant(options: {
    runId: string;
    provider: ProviderName;
    model: string;
    secretEnvironmentName: string;
    ttlMs?: number;
  }): ProviderBrokerGrant {
    if (!this.#server) throw new Error("Provider broker must be started before grants are issued");
    const now = this.#clock.now();
    const ttlMs = options.ttlMs ?? 15 * 60_000;
    if (ttlMs < 1_000 || ttlMs > 86_400_000) throw new TypeError("Grant TTL is invalid");
    const secretHandle = this.#secretProvider.issueHandle(
      {
        schemaVersion: 1,
        provider: "environment",
        name: options.secretEnvironmentName,
        purpose: "provider-api",
        allowedConsumer: "provider-broker"
      },
      { runId: options.runId, now: now.toISOString() }
    );
    const token = `broker-${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.#grants.set(token, {
      runId: options.runId,
      provider: options.provider,
      model: options.model,
      secretHandleId: secretHandle.handleId,
      expiresAt,
      remainingRequests: this.#maxRequestsPerGrant
    });
    const address = this.#server.address() as AddressInfo;
    const unsigned = {
      schemaVersion: 1 as const,
      runId: options.runId,
      provider: options.provider,
      model: options.model,
      expiresAt,
      endpoint: `http://127.0.0.1:${String(address.port)}/${options.provider}`
    };
    return { ...unsigned, token, grantDigest: sha256(JSON.stringify(unsigned)) };
  }

  revoke(token: string): void {
    const grant = this.#grants.get(token);
    if (grant) this.#secretProvider.revoke(grant.secretHandleId);
    this.#grants.delete(token);
  }

  async close(): Promise<void> {
    for (const token of [...this.#grants.keys()]) this.revoke(token);
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end('{"error":"method_not_allowed"}');
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const grant = this.#grants.get(token);
    if (
      !grant ||
      grant.expiresAt <= this.#clock.now().toISOString() ||
      grant.remainingRequests <= 0
    ) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"invalid_or_expired_grant"}');
      return;
    }
    const url = new URL(request.url ?? "/", "http://broker.invalid");
    const prefix = `/${grant.provider}`;
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"provider_not_allowed"}');
      return;
    }
    const providerPath = url.pathname.slice(prefix.length);
    if (!PROVIDER_PATHS[grant.provider].test(providerPath)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"endpoint_not_allowed"}');
      return;
    }
    const body = await readRequest(request, this.#maxRequestBytes);
    let bodyValue: unknown;
    try {
      bodyValue = JSON.parse(body.toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"invalid_json"}');
      return;
    }
    if (
      typeof bodyValue === "object" &&
      bodyValue !== null &&
      "model" in bodyValue &&
      (bodyValue as { model?: unknown }).model !== grant.model
    ) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"model_not_allowed"}');
      return;
    }
    grant.remainingRequests -= 1;
    const providerSecret = this.#secretProvider.consume(
      grant.secretHandleId,
      "provider-broker",
      grant.runId
    );
    const headers = new Headers({ "content-type": "application/json" });
    if (grant.provider === "openai") headers.set("authorization", `Bearer ${providerSecret}`);
    else {
      headers.set("x-api-key", providerSecret);
      const requestedVersion = request.headers["anthropic-version"];
      headers.set(
        "anthropic-version",
        typeof requestedVersion === "string" ? requestedVersion : "2023-06-01"
      );
    }
    const upstream = await this.#fetch(
      `${this.#upstreams[grant.provider]}${providerPath}${url.search}`,
      {
        method: "POST",
        headers,
        body,
        redirect: "manual"
      }
    );
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    if (!upstream.body) {
      response.end();
      return;
    }
    let responseBytes = 0;
    for await (const chunk of upstream.body) {
      const buffer = Buffer.from(chunk);
      responseBytes += buffer.byteLength;
      if (responseBytes > this.#maxResponseBytes)
        throw new Error("Provider broker response is too large");
      response.write(buffer);
    }
    response.end();
  }
}
