import { createHash, createSign } from "node:crypto";
import {
  OutboundEffectRequestV1Schema,
  OutboundEffectReceiptV1Schema,
  OutboundReconcileRequestV1Schema,
  ExtensionManifestV1Schema,
  isAutomaticActionAllowed,
  type ExtensionManifestV1,
  type OutboundAdapterV1,
  type OutboundAuthorityV1,
  type OutboundEffectReceiptV1,
  type OutboundEffectRequestV1,
  type OutboundReconcileRequestV1,
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

export interface GitHubAppAdapterOptions {
  manifest: ExtensionManifestV1;
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

interface LiveObservation {
  status: "not_observed" | "observed_exact" | "observed_conflict";
  externalId: string | null;
  observedStateDigest: string | null;
  resourceUrl: string | null;
  requestId: string | null;
}

export class GitHubAppAdapter implements OutboundAdapterV1 {
  readonly manifest: ExtensionManifestV1;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #authority: OutboundAuthorityV1;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBaseUrl: string;
  readonly #clock: { now(): Date };
  readonly #effects = new Map<string, ObservedEffect>();

  constructor(options: GitHubAppAdapterOptions) {
    const manifest = ExtensionManifestV1Schema.parse(options.manifest);
    if (
      manifest.id !== "github-app" ||
      manifest.kind !== "adapter" ||
      manifest.contract.name !== "outbound-adapter-v1"
    ) {
      throw new Error("GitHub adapter requires a github-app outbound-adapter-v1 manifest");
    }
    this.manifest = manifest;
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
    try {
      const token = await this.#tokenProvider.getToken();
      const observation = await this.#observe(owner, repo, payload, request.effectKey, token);
      if (observation.status === "observed_conflict") {
        throw new Error("GitHub live state conflicts with the requested idempotent effect");
      }
      await this.#authority.authorize(request);
      if (
        observation.status === "observed_exact" &&
        observation.externalId &&
        observation.observedStateDigest &&
        observation.resourceUrl
      ) {
        const receipt = this.#receipt(
          request,
          observation.externalId,
          observation.requestId,
          observation.observedStateDigest
        );
        await this.#authority.recordReceipt(request, receipt);
        this.#effects.set(request.effectKey, {
          receipt,
          resourceUrl: observation.resourceUrl
        });
        return receipt;
      }
      const effect = await this.#perform(owner, repo, payload, request.effectKey, token);
      const postState = await this.#observe(owner, repo, payload, request.effectKey, token);
      if (
        postState.status !== "observed_exact" ||
        !postState.externalId ||
        !postState.observedStateDigest ||
        !postState.resourceUrl
      ) {
        throw new Error("GitHub post-effect state did not match the exact requested effect");
      }
      const receipt = this.#receipt(
        request,
        postState.externalId,
        effect.requestId,
        postState.observedStateDigest
      );
      await this.#authority.recordReceipt(request, receipt);
      this.#effects.set(request.effectKey, { receipt, resourceUrl: postState.resourceUrl });
      return receipt;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const status = /with ([0-9]{3})/.exec(reason)?.[1];
      const retryable =
        !/conflicts|Only a ParallelPlay-managed|authority ceiling|payload|secret|mention|slash command|active HTML|image|non-allowlisted/i.test(
          reason
        ) &&
        (status === undefined ||
          status === "408" ||
          status === "409" ||
          status === "429" ||
          status.startsWith("5"));
      await this.#authority.recordFailure(request, { retryable, reason });
      throw error;
    }
  }

  async reconcile(rawRequest: OutboundReconcileRequestV1): Promise<OutboundReconciliationV1> {
    const request = OutboundReconcileRequestV1Schema.parse(rawRequest);
    const effectKey = request.effect.effectKey;
    const target = RepositoryTargetSchema.parse(request.effect.target);
    const [owner, repo] = target.split("/") as [string, string];
    const payload = GitHubPayloadSchema.parse(request.effect.payload);
    if (payload.action !== request.effect.action)
      throw new Error("GitHub reconciliation payload action does not match request");
    const token = await this.#tokenProvider.getToken();
    const observation = await this.#observe(owner, repo, payload, effectKey, token);
    return {
      schemaVersion: 1,
      effectKey,
      status: observation.status,
      externalId: observation.externalId,
      observedStateDigest: observation.observedStateDigest
    };
  }

  async close(): Promise<void> {
    this.#effects.clear();
  }

  #receipt(
    request: OutboundEffectRequestV1,
    externalId: string,
    requestId: string | null,
    observedStateDigest: string
  ): OutboundEffectReceiptV1 {
    const unsigned = {
      schemaVersion: 1 as const,
      adapterId: this.manifest.id,
      effectKey: request.effectKey,
      action: request.action,
      payloadDigest: request.payloadDigest,
      externalId,
      requestId,
      observedStateDigest,
      acceptedAt: this.#clock.now().toISOString()
    };
    return OutboundEffectReceiptV1Schema.parse({
      ...unsigned,
      receiptDigest: sha256(canonical(unsigned))
    });
  }

  async #observe(
    owner: string,
    repo: string,
    payload: GitHubEffectPayload,
    effectKey: string,
    token: string
  ): Promise<LiveObservation> {
    const root = `${this.#apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const marker = `<!-- parallelplay-effect:${effectKey} -->`;
    const managedMarker = "<!-- parallelplay-managed -->";
    switch (payload.action) {
      case "github.check.upsert": {
        const response = await this.#request(
          `${root}/commits/${encodeURIComponent(payload.headSha)}/check-runs?per_page=100`,
          token,
          { method: "GET" }
        );
        if (response.status === 404) return this.#notObserved();
        if (!response.ok)
          throw new Error(`GitHub check reconciliation failed with ${String(response.status)}`);
        const result = z
          .looseObject({
            check_runs: z.array(
              z.looseObject({
                url: z.url(),
                external_id: z.string().nullable(),
                name: z.string(),
                head_sha: z.string(),
                status: z.string(),
                conclusion: z.string().nullable(),
                output: z
                  .looseObject({ title: z.string().nullable(), summary: z.string().nullable() })
                  .optional()
              })
            )
          })
          .parse(await response.json());
        const check = result.check_runs.find((entry) => entry.external_id === effectKey);
        if (!check) return this.#notObserved();
        const state = {
          externalId: check.external_id,
          name: check.name,
          headSha: check.head_sha,
          status: check.status,
          conclusion: check.conclusion,
          title: check.output?.title ?? null,
          summary: check.output?.summary ?? null
        };
        const exact =
          check.name === payload.name &&
          check.head_sha === payload.headSha &&
          check.status === payload.status &&
          (payload.status !== "completed" || check.conclusion === payload.conclusion) &&
          check.output?.title === payload.title &&
          check.output.summary === payload.summary;
        return this.#observed(exact, check.url, state, response);
      }
      case "github.label.upsert": {
        const labelUrl = `${root}/labels/${encodeURIComponent(payload.label)}`;
        const labelResponse = await this.#request(labelUrl, token, { method: "GET" });
        if (labelResponse.status === 404) return this.#notObserved();
        if (!labelResponse.ok)
          throw new Error(
            `GitHub label reconciliation failed with ${String(labelResponse.status)}`
          );
        const label = z
          .looseObject({ name: z.string(), color: z.string(), url: z.url() })
          .parse(await labelResponse.json());
        if (
          label.name !== payload.label ||
          label.color.toLowerCase() !== payload.color.toLowerCase()
        ) {
          return this.#observed(false, label.url, { label }, labelResponse);
        }
        const issueLabels = await this.#list(
          `${root}/issues/${String(payload.issueNumber)}/labels?per_page=100`,
          token
        );
        const associated = issueLabels.values.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as Record<string, unknown>)["name"] === payload.label
        );
        if (!associated) return this.#notObserved();
        const state = {
          label: payload.label,
          color: label.color.toLowerCase(),
          issueNumber: payload.issueNumber,
          associated
        };
        return this.#observed(true, label.url, state, labelResponse);
      }
      case "github.comment.create": {
        const expectedBody = `${validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts)}\n\n${marker}`;
        const comments = await this.#list(
          `${root}/issues/${String(payload.issueNumber)}/comments?per_page=100`,
          token
        );
        const comment = comments.values
          .map((value) => z.looseObject({ url: z.url(), body: z.string() }).safeParse(value))
          .find((result) => result.success && result.data.body.includes(marker));
        if (!comment?.success) return this.#notObserved();
        return this.#observed(
          comment.data.body === expectedBody,
          comment.data.url,
          { issueNumber: payload.issueNumber, body: comment.data.body },
          null,
          comments.requestId
        );
      }
      case "github.candidate-branch.create": {
        const branch = `parallelplay/candidate/${payload.revisionDigest}`;
        const encodedRef = `heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
        const response = await this.#request(`${root}/git/ref/${encodedRef}`, token, {
          method: "GET"
        });
        if (response.status === 404) return this.#notObserved();
        if (!response.ok)
          throw new Error(`GitHub branch reconciliation failed with ${String(response.status)}`);
        const ref = z
          .looseObject({
            ref: z.string(),
            url: z.url(),
            object: z.looseObject({ sha: z.string() })
          })
          .parse(await response.json());
        const state = { ref: ref.ref, commitSha: ref.object.sha };
        return this.#observed(ref.object.sha === payload.commitSha, ref.url, state, response);
      }
      case "github.draft-pr.create": {
        const branch = `parallelplay/candidate/${payload.revisionDigest}`;
        const query = new URLSearchParams({
          state: "all",
          head: `${owner}:${branch}`,
          base: payload.base,
          per_page: "100"
        });
        const pulls = await this.#list(`${root}/pulls?${query.toString()}`, token);
        const parsed = pulls.values
          .map((value) =>
            z
              .looseObject({
                url: z.url(),
                title: z.string(),
                body: z.string().nullable(),
                draft: z.boolean(),
                merged_at: z.string().nullable().optional(),
                head: z.looseObject({ ref: z.string() }),
                base: z.looseObject({ ref: z.string() })
              })
              .safeParse(value)
          )
          .filter((result) => result.success);
        const pull = parsed.find((result) => result.data.body?.includes(marker));
        const sameHead = parsed.find(
          (result) => result.data.head.ref === branch && result.data.base.ref === payload.base
        );
        if (!pull && !sameHead) return this.#notObserved();
        const candidate = (pull ?? sameHead)?.data;
        if (!candidate) return this.#notObserved();
        const expectedBody = `${validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts)}\n\n${managedMarker}\n${marker}`;
        const exact =
          candidate.title === payload.title &&
          candidate.body === expectedBody &&
          candidate.draft &&
          !candidate.merged_at &&
          candidate.head.ref === branch &&
          candidate.base.ref === payload.base;
        return this.#observed(
          exact,
          candidate.url,
          { title: candidate.title, body: candidate.body, draft: candidate.draft, branch },
          null,
          pulls.requestId
        );
      }
      case "github.draft-pr.update": {
        const response = await this.#request(`${root}/pulls/${String(payload.pullNumber)}`, token, {
          method: "GET"
        });
        if (response.status === 404) return this.#notObserved();
        if (!response.ok)
          throw new Error(`GitHub pull reconciliation failed with ${String(response.status)}`);
        const pull = z
          .looseObject({
            url: z.url(),
            title: z.string(),
            body: z.string().nullable(),
            draft: z.boolean(),
            merged: z.boolean(),
            head: z.looseObject({ ref: z.string() })
          })
          .parse(await response.json());
        if (
          !pull.body?.includes(managedMarker) ||
          !pull.head.ref.startsWith("parallelplay/candidate/")
        ) {
          return this.#observed(false, pull.url, pull, response);
        }
        const expectedBody = `${validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts)}\n\n${managedMarker}\n${marker}`;
        if (!pull.body.includes(marker)) return this.#notObserved();
        const exact =
          pull.title === payload.title && pull.body === expectedBody && pull.draft && !pull.merged;
        return this.#observed(exact, pull.url, pull, response);
      }
    }
  }

  #notObserved(): LiveObservation {
    return {
      status: "not_observed",
      externalId: null,
      observedStateDigest: null,
      resourceUrl: null,
      requestId: null
    };
  }

  #observed(
    exact: boolean,
    externalId: string,
    state: unknown,
    response: Response | null,
    requestId = response?.headers.get("x-github-request-id") ?? null
  ): LiveObservation {
    return {
      status: exact ? "observed_exact" : "observed_conflict",
      externalId,
      observedStateDigest: sha256(canonical(state)),
      resourceUrl: externalId,
      requestId
    };
  }

  async #list(
    initialUrl: string,
    token: string
  ): Promise<{ values: unknown[]; requestId: string | null }> {
    const values: unknown[] = [];
    let url: string | null = initialUrl;
    let requestId: string | null = null;
    for (let page = 0; url && page < 10; page += 1) {
      const response = await this.#request(url, token, { method: "GET" });
      if (!response.ok)
        throw new Error(`GitHub list reconciliation failed with ${String(response.status)}`);
      requestId ??= response.headers.get("x-github-request-id");
      const body = z.array(z.unknown()).parse(await response.json());
      values.push(...body);
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
      if (next) {
        const candidate = new URL(next);
        const base = new URL(this.#apiBaseUrl);
        if (candidate.origin !== base.origin)
          throw new Error("GitHub pagination escaped the API origin");
        url = candidate.href;
      } else {
        url = null;
      }
    }
    if (url) throw new Error("GitHub reconciliation exceeded the pagination bound");
    return { values, requestId };
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
        const body = `${validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts)}\n\n<!-- parallelplay-managed -->\n<!-- parallelplay-effect:${effectKey} -->`;
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
          .looseObject({
            draft: z.boolean(),
            merged: z.boolean(),
            body: z.string().nullable(),
            head: z.looseObject({ ref: z.string() })
          })
          .parse(await current.json());
        if (
          !currentValue.draft ||
          currentValue.merged ||
          !currentValue.body?.includes("<!-- parallelplay-managed -->") ||
          !currentValue.head.ref.startsWith("parallelplay/candidate/")
        ) {
          throw new Error("Only a ParallelPlay-managed open draft pull request may be updated");
        }
        const body = `${validateGeneratedGitHubText(payload.body, payload.allowedLinkHosts)}\n\n<!-- parallelplay-managed -->\n<!-- parallelplay-effect:${effectKey} -->`;
        response = await this.#request(`${root}/pulls/${String(payload.pullNumber)}`, token, {
          method: "PATCH",
          body: { title: payload.title, body }
        });
        break;
      }
    }
    if (!response.ok) throw new Error(`GitHub effect failed with ${String(response.status)}`);
    const observed = (await response.json()) as Record<string, unknown>;
    const resourceUrl =
      typeof observed["url"] === "string"
        ? observed["url"]
        : payload.action === "github.label.upsert"
          ? `${root}/labels/${encodeURIComponent(payload.label)}`
          : root;
    return {
      externalId: resourceUrl,
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
