import { createHash, createSign } from "node:crypto";
import {
  OutboundEffectRequestV1Schema,
  OutboundEffectReceiptV1Schema,
  isAutomaticActionAllowed,
  type ExtensionManifestV1,
  type OutboundAdapterV1,
  type OutboundAuthorityV1,
  type OutboundEffectReceiptV1,
  type OutboundEffectRequestV1,
  type OutboundReconciliationV1
} from "@parallelplay/contracts";
import { z } from "zod";

const RepositoryTargetSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const RevisionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SafeTextSchema = z.string().min(1).max(65_536);

const GitHubPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("github.check.upsert"),
    headSha: GitObjectIdSchema,
    name: z.string().trim().min(1).max(100),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z
      .enum([
        "action_required",
        "cancelled",
        "failure",
        "neutral",
        "success",
        "skipped",
        "stale",
        "timed_out"
      ])
      .nullable(),
    title: z.string().trim().min(1).max(255),
    summary: SafeTextSchema
  }),
  z.strictObject({
    action: z.literal("github.label.upsert"),
    issueNumber: z.number().int().positive(),
    label: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^parallelplay:[a-z0-9._-]+$/),
    color: z.string().regex(/^[a-fA-F0-9]{6}$/)
  }),
  z.strictObject({
    action: z.literal("github.comment.create"),
    issueNumber: z.number().int().positive(),
    body: SafeTextSchema,
    allowedLinkHosts: z.array(z.string().min(1).max(253)).max(32)
  }),
  z.strictObject({
    action: z.literal("github.candidate-branch.create"),
    revisionDigest: RevisionDigestSchema,
    commitSha: GitObjectIdSchema
  }),
  z.strictObject({
    action: z.literal("github.draft-pr.create"),
    revisionDigest: RevisionDigestSchema,
    base: z
      .string()
      .regex(/^[A-Za-z0-9._/-]+$/)
      .max(200),
    title: z.string().trim().min(1).max(256),
    body: SafeTextSchema,
    allowedLinkHosts: z.array(z.string().min(1).max(253)).max(32)
  }),
  z.strictObject({
    action: z.literal("github.draft-pr.update"),
    pullNumber: z.number().int().positive(),
    title: z.string().trim().min(1).max(256),
    body: SafeTextSchema,
    allowedLinkHosts: z.array(z.string().min(1).max(253)).max(32)
  })
]);
export type GitHubEffectPayload = z.infer<typeof GitHubPayloadSchema>;

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

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/
];

export function validateGeneratedGitHubText(text: string, allowedLinkHosts: string[]): string {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error("Generated GitHub text contains a secret-like value");
  }
  if (/(^|\s)@[A-Za-z0-9_-]+/m.test(text))
    throw new Error("Generated GitHub text contains a mention");
  if (/^\s*\/[A-Za-z][A-Za-z0-9_-]*(?:\s|$)/m.test(text)) {
    throw new Error("Generated GitHub text contains a slash command");
  }
  if (/<\/?[A-Za-z][^>]*>/.test(text))
    throw new Error("Generated GitHub text contains active HTML");
  if (/!\[[^\]]*\]\([^)]*\)/.test(text)) throw new Error("Generated GitHub text contains an image");
  const allowed = new Set(allowedLinkHosts.map((host) => host.toLowerCase()));
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>]+/g)) {
    const url = new URL(match[0]);
    if (!allowed.has(url.hostname.toLowerCase())) {
      throw new Error(
        `Generated GitHub text contains a non-allowlisted link host: ${url.hostname}`
      );
    }
  }
  return text;
}

export interface GitHubInstallationTokenProvider {
  getToken(): Promise<string>;
}

export interface GitHubAppTokenProviderOptions {
  appId: string;
  installationId: string;
  privateKey: string;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  clock?: { now(): Date };
}

export class GitHubAppTokenProvider implements GitHubInstallationTokenProvider {
  readonly #appId: string;
  readonly #installationId: string;
  readonly #privateKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBaseUrl: string;
  readonly #clock: { now(): Date };
  #cached: { token: string; expiresAt: string } | null = null;

  constructor(options: GitHubAppTokenProviderOptions) {
    this.#appId = options.appId;
    this.#installationId = options.installationId;
    this.#privateKey = options.privateKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async getToken(): Promise<string> {
    const now = this.#clock.now();
    if (this.#cached && this.#cached.expiresAt > new Date(now.getTime() + 60_000).toISOString()) {
      return this.#cached.token;
    }
    const issuedAt = Math.floor(now.getTime() / 1000) - 30;
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: this.#appId })
    ).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    const jwt = `${header}.${payload}.${signer.sign(this.#privateKey, "base64url")}`;
    const response = await this.#fetch(
      `${this.#apiBaseUrl}/app/installations/${encodeURIComponent(this.#installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2026-03-10"
        },
        redirect: "manual"
      }
    );
    if (!response.ok)
      throw new Error(`GitHub App token request failed with ${String(response.status)}`);
    const result = z
      .strictObject({ token: z.string().min(1), expires_at: z.string().min(1) })
      .parse(await response.json());
    this.#cached = { token: result.token, expiresAt: result.expires_at };
    return result.token;
  }
}

function builtinManifest(): ExtensionManifestV1 {
  return {
    schemaVersion: 1,
    id: "github-app",
    displayName: "GitHub App",
    extensionVersion: "0.1.0",
    kind: "adapter",
    contract: { name: "outbound-adapter-v1", version: 1 },
    artifact: {
      mediaType: "application/vnd.parallelplay.builtin+json",
      reference: "builtin:github-app",
      sha256: sha256("parallelplay-github-app-0.1.0")
    },
    configurationSchemaDigest: sha256("github-app-config-v1"),
    capabilities: [
      { name: "github-api", required: true, detail: "Least-privilege GitHub App installation" }
    ],
    provenance: {
      sourceRepository: "https://github.com/anirudh/parallelplay",
      sourceRevision: sha256("parallelplay-v0.1.0"),
      sbomDigest: sha256("github-app-sbom-v1"),
      attestationDigest: sha256("github-app-attestation-v1")
    },
    conformance: {
      suiteVersion: "0.1.0",
      reportDigest: sha256("github-app-conformance-pending"),
      approvedRegistryDigest: null
    }
  };
}

export interface GitHubAppAdapterOptions {
  tokenProvider: GitHubInstallationTokenProvider;
  authority: OutboundAuthorityV1;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  clock?: { now(): Date };
}

interface ObservedEffect {
  receipt: OutboundEffectReceiptV1;
  resourceUrl: string;
}

export class GitHubAppAdapter implements OutboundAdapterV1 {
  readonly manifest = builtinManifest();
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #authority: OutboundAuthorityV1;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBaseUrl: string;
  readonly #clock: { now(): Date };
  readonly #effects = new Map<string, ObservedEffect>();

  constructor(options: GitHubAppAdapterOptions) {
    this.#tokenProvider = options.tokenProvider;
    this.#authority = options.authority;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async deliver(rawRequest: OutboundEffectRequestV1): Promise<OutboundEffectReceiptV1> {
    const request = OutboundEffectRequestV1Schema.parse(rawRequest);
    const existing = this.#effects.get(request.effectKey);
    if (existing) {
      if (existing.receipt.payloadDigest !== request.payloadDigest) {
        throw new Error("GitHub effect key was reused with a different payload");
      }
      return existing.receipt;
    }
    if (!request.action.startsWith("github.") || !isAutomaticActionAllowed(request.action)) {
      throw new Error(`GitHub action ${request.action} is outside the global authority ceiling`);
    }
    const target = RepositoryTargetSchema.parse(request.target);
    const [owner, repo] = target.split("/") as [string, string];
    const payload = GitHubPayloadSchema.parse(request.payload);
    if (payload.action !== request.action)
      throw new Error("GitHub payload action does not match request");
    const expectedPayloadDigest = sha256(canonical(payload));
    if (expectedPayloadDigest !== request.payloadDigest)
      throw new Error("GitHub payload digest does not match");
    this.#validatePayloadContent(payload);
    await this.#authority.authorize(request);
    try {
      const token = await this.#tokenProvider.getToken();
      const effect = await this.#perform(owner, repo, payload, request.effectKey, token);
      const acceptedAt = this.#clock.now().toISOString();
      const unsigned = {
        schemaVersion: 1 as const,
        adapterId: this.manifest.id,
        effectKey: request.effectKey,
        action: request.action,
        payloadDigest: request.payloadDigest,
        externalId: effect.externalId,
        requestId: effect.requestId,
        observedStateDigest: effect.observedStateDigest,
        acceptedAt
      };
      const receipt = OutboundEffectReceiptV1Schema.parse({
        ...unsigned,
        receiptDigest: sha256(canonical(unsigned))
      });
      await this.#authority.recordReceipt(request, receipt);
      this.#effects.set(request.effectKey, { receipt, resourceUrl: effect.resourceUrl });
      return receipt;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const status = /with ([0-9]{3})/.exec(reason)?.[1];
      const retryable =
        status === undefined ||
        status === "408" ||
        status === "409" ||
        status === "429" ||
        status.startsWith("5");
      await this.#authority.recordFailure(request, { retryable, reason });
      throw error;
    }
  }

  async reconcile(effectKey: string): Promise<OutboundReconciliationV1> {
    const effect = this.#effects.get(effectKey);
    if (!effect) {
      return {
        schemaVersion: 1,
        effectKey,
        status: "not_observed",
        externalId: null,
        observedStateDigest: null
      };
    }
    const token = await this.#tokenProvider.getToken();
    const response = await this.#request(effect.resourceUrl, token, { method: "GET" });
    if (response.status === 404) {
      return {
        schemaVersion: 1,
        effectKey,
        status: "not_observed",
        externalId: null,
        observedStateDigest: null
      };
    }
    if (!response.ok)
      throw new Error(`GitHub reconciliation failed with ${String(response.status)}`);
    const observedStateDigest = sha256(canonical(await response.json()));
    return {
      schemaVersion: 1,
      effectKey,
      status: "observed_exact",
      externalId: effect.receipt.externalId,
      observedStateDigest
    };
  }

  async close(): Promise<void> {
    this.#effects.clear();
  }

  async #perform(
    owner: string,
    repo: string,
    payload: GitHubEffectPayload,
    effectKey: string,
    token: string
  ): Promise<{
    externalId: string;
    requestId: string | null;
    observedStateDigest: string;
    resourceUrl: string;
  }> {
    const root = `${this.#apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    let response: Response;
    switch (payload.action) {
      case "github.check.upsert":
        response = await this.#request(`${root}/check-runs`, token, {
          method: "POST",
          body: {
            name: payload.name,
            head_sha: payload.headSha,
            status: payload.status,
            ...(payload.status === "completed" ? { conclusion: payload.conclusion } : {}),
            external_id: effectKey,
            output: { title: payload.title, summary: payload.summary }
          }
        });
        break;
      case "github.label.upsert": {
        await this.#request(`${root}/labels`, token, {
          method: "POST",
          body: {
            name: payload.label,
            color: payload.color,
            description: "Managed by ParallelPlay"
          },
          acceptedStatuses: [201, 422]
        });
        response = await this.#request(
          `${root}/issues/${String(payload.issueNumber)}/labels`,
          token,
          {
            method: "POST",
            body: { labels: [payload.label] }
          }
        );
        break;
      }
      case "github.comment.create": {
        const body = `${validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts)}\n\n<!-- parallelplay-effect:${effectKey} -->`;
        response = await this.#request(
          `${root}/issues/${String(payload.issueNumber)}/comments`,
          token,
          {
            method: "POST",
            body: { body }
          }
        );
        break;
      }
      case "github.candidate-branch.create": {
        const branch = `parallelplay/candidate/${payload.revisionDigest}`;
        response = await this.#request(`${root}/git/refs`, token, {
          method: "POST",
          body: { ref: `refs/heads/${branch}`, sha: payload.commitSha }
        });
        break;
      }
      case "github.draft-pr.create": {
        const body = `${validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts)}\n\n<!-- parallelplay-effect:${effectKey} -->`;
        response = await this.#request(`${root}/pulls`, token, {
          method: "POST",
          body: {
            title: payload.title,
            head: `parallelplay/candidate/${payload.revisionDigest}`,
            base: payload.base,
            body,
            draft: true,
            maintainer_can_modify: false
          }
        });
        break;
      }
      case "github.draft-pr.update": {
        const current = await this.#request(`${root}/pulls/${String(payload.pullNumber)}`, token, {
          method: "GET"
        });
        if (!current.ok)
          throw new Error(`GitHub pull lookup failed with ${String(current.status)}`);
        const currentValue = z
          .looseObject({ draft: z.boolean(), merged: z.boolean() })
          .parse(await current.json());
        if (!currentValue.draft || currentValue.merged)
          throw new Error("Only an open draft pull request may be updated");
        const body = `${validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts)}\n\n<!-- parallelplay-effect:${effectKey} -->`;
        response = await this.#request(`${root}/pulls/${String(payload.pullNumber)}`, token, {
          method: "PATCH",
          body: { title: payload.title, body }
        });
        break;
      }
    }
    if (!response.ok) throw new Error(`GitHub effect failed with ${String(response.status)}`);
    const observed = (await response.json()) as Record<string, unknown>;
    const externalIdValue = observed["id"] ?? observed["node_id"] ?? observed["ref"];
    const externalId =
      typeof externalIdValue === "string" || typeof externalIdValue === "number"
        ? String(externalIdValue)
        : effectKey;
    const resourceUrl = typeof observed["url"] === "string" ? observed["url"] : root;
    return {
      externalId,
      requestId: response.headers.get("x-github-request-id"),
      observedStateDigest: sha256(canonical(observed)),
      resourceUrl
    };
  }

  #validatePayloadContent(payload: GitHubEffectPayload): void {
    switch (payload.action) {
      case "github.check.upsert":
        validateGeneratedGitHubText(payload.title, []);
        validateGeneratedGitHubText(payload.summary, []);
        break;
      case "github.comment.create":
        validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts);
        break;
      case "github.draft-pr.create":
      case "github.draft-pr.update":
        validateGeneratedGitHubText(payload.title, []);
        validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts);
        break;
      case "github.label.upsert":
      case "github.candidate-branch.create":
        break;
    }
  }

  async #request(
    url: string,
    token: string,
    options: {
      method: "GET" | "POST" | "PATCH";
      body?: unknown;
      acceptedStatuses?: number[];
    }
  ): Promise<Response> {
    const response = await this.#fetch(url, {
      method: options.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "parallelplay/0.1.0",
        "x-github-api-version": "2026-03-10"
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "manual"
    });
    if (options.acceptedStatuses?.includes(response.status)) return response;
    return response;
  }
}

export function githubPayloadDigest(payload: GitHubEffectPayload): string {
  return sha256(canonical(GitHubPayloadSchema.parse(payload)));
}
