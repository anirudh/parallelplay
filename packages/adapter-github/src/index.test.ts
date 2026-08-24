import { createHash } from "node:crypto";
import type { ExtensionManifestV1 } from "@parallelplay/contracts";
import { describe, expect, it } from "vitest";
import { GitHubAppAdapter, githubPayloadDigest, validateGeneratedGitHubText } from "./index.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const manifest: ExtensionManifestV1 = {
  schemaVersion: 1,
  id: "github-app",
  displayName: "GitHub App",
  extensionVersion: "0.1.0",
  kind: "adapter",
  contract: { name: "outbound-adapter-v1", version: 1 },
  artifact: {
    mediaType: "application/vnd.parallelplay.builtin+json",
    reference: "builtin:github-app",
    sha256: digest("github-app:artifact")
  },
  configurationSchemaDigest: digest("github-app:configuration"),
  capabilities: [],
  provenance: {
    sourceRepository: "https://github.com/anirudh/parallelplay",
    sourceRevision: digest("source"),
    sbomDigest: digest("github-app:sbom"),
    attestationDigest: digest("github-app:attestation")
  },
  conformance: {
    suiteVersion: "0.1.0",
    reportDigest: digest("github-app:report"),
    approvedRegistryDigest: null
  }
};
const authority = {
  authorize: () =>
    Promise.resolve({ status: "authorized" as const, authorizationDigest: "a".repeat(64) }),
  recordReceipt: () => Promise.resolve(),
  recordFailure: () => Promise.resolve()
};

describe("GitHub App adapter", () => {
  it("blocks secret, trigger, mention, HTML, image, and unapproved-link text", () => {
    expect(() => validateGeneratedGitHubText("@release-bot deploy", [])).toThrow(/mention/);
    expect(() => validateGeneratedGitHubText("/deploy now", [])).toThrow(/slash command/);
    expect(() => validateGeneratedGitHubText("<img src=x>", [])).toThrow(/HTML/);
    expect(() =>
      validateGeneratedGitHubText("![x](https://example.com/x.png)", ["example.com"])
    ).toThrow(/image/);
    expect(() =>
      validateGeneratedGitHubText(["github_", "pat_abcdefghijklmnopqrstuvwxyz"].join(""), [])
    ).toThrow(/secret/);
    expect(() =>
      validateGeneratedGitHubText("See https://evil.example/run", ["github.com"])
    ).toThrow(/non-allowlisted/);
    expect(validateGeneratedGitHubText("Review the retained evidence.", [])).toBe(
      "Review the retained evidence."
    );
  });

  it("creates one idempotent filtered comment and reconciles it", async () => {
    let posts = 0;
    let stored: { id: number; url: string; body: string } | null = null;
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "GET" && url.includes("/issues/7/comments?")) {
        return Promise.resolve(
          new Response(JSON.stringify(stored ? [stored] : []), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
      if (init?.method === "POST" && url.endsWith("/comments")) {
        posts += 1;
        expect(new Headers(init.headers).get("authorization")).not.toContain("private");
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        const request = JSON.parse(init.body) as { body: string };
        stored = { id: 42, url: "https://api.github.test/comments/42", body: request.body };
        return Promise.resolve(
          new Response(JSON.stringify(stored), {
            status: 201,
            headers: { "content-type": "application/json", "x-github-request-id": "request-1" }
          })
        );
      }
      if (url === stored?.url) {
        return Promise.resolve(new Response(JSON.stringify(stored), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    };
    const adapter = new GitHubAppAdapter({
      manifest,
      authority,
      tokenProvider: { getToken: () => Promise.resolve("installation-token") },
      apiBaseUrl: "https://api.github.test",
      fetch
    });
    const payload = {
      action: "github.comment.create" as const,
      issueNumber: 7,
      body: "The candidate passed the public fixture.",
      allowedLinkHosts: []
    };
    const request = {
      schemaVersion: 1 as const,
      adapterId: "github-app",
      effectKey: "effect-1",
      action: payload.action,
      target: "anirudh/parallelplay-fixture",
      payload,
      payloadDigest: githubPayloadDigest(payload),
      preconditionDigest: digest("precondition"),
      policyPromotionDigest: digest("promotion")
    };
    const first = await adapter.deliver(request);
    const second = await adapter.deliver(request);
    expect(first.receiptDigest).toBe(second.receiptDigest);
    expect(posts).toBe(1);
    expect(
      (await adapter.reconcile({ schemaVersion: 1, effect: request, priorReceipt: first })).status
    ).toBe("observed_exact");

    const restarted = new GitHubAppAdapter({
      manifest,
      authority,
      tokenProvider: { getToken: () => Promise.resolve("installation-token") },
      apiBaseUrl: "https://api.github.test",
      fetch
    });
    expect(
      (await restarted.reconcile({ schemaVersion: 1, effect: request, priorReceipt: first })).status
    ).toBe("observed_exact");
    const recovered = await restarted.deliver(request);
    expect(recovered.externalId).toBe(first.externalId);
    expect(posts).toBe(1);
  });

  it("rejects merge before any external call", async () => {
    let calls = 0;
    const adapter = new GitHubAppAdapter({
      manifest,
      authority,
      tokenProvider: { getToken: () => Promise.resolve("installation-token") },
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
    });
    await expect(
      adapter.deliver({
        schemaVersion: 1,
        adapterId: "github-app",
        effectKey: "forbidden",
        action: "merge",
        target: "anirudh/parallelplay-fixture",
        payload: {},
        payloadDigest: digest("payload"),
        preconditionDigest: digest("precondition"),
        policyPromotionDigest: digest("promotion")
      })
    ).rejects.toThrow(/authority ceiling/);
    expect(calls).toBe(0);
  });
});
