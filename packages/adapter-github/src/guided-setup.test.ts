import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GuidedGitHubAppSetup } from "./guided-setup.js";

describe("guided GitHub App setup", () => {
  it("keeps conversion credentials host-only and verifies fixture-only installation", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem"
    }) as string;
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url.endsWith("/app-manifests/manifest-code/conversions")) {
        return Promise.resolve(
          Response.json({
            id: 123,
            slug: "parallelplay-fixture-test",
            client_id: "client-id",
            client_secret: ["client", "secret", "value"].join("-"),
            webhook_secret: ["webhook", "secret", "with-more-than-thirty-two-bytes"].join("-"),
            pem: privateKey,
            html_url: "https://github.com/apps/parallelplay-fixture-test"
          })
        );
      }
      if (url.endsWith("/app/installations/456/access_tokens")) {
        return Promise.resolve(
          Response.json({
            token: ["installation", "token"].join("-"),
            expires_at: "2026-08-23T13:00:00.000Z"
          })
        );
      }
      if (url.endsWith("/installation/repositories?per_page=100")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer installation-token");
        return Promise.resolve(
          Response.json({
            total_count: 1,
            repositories: [{ full_name: "anirudh/parallelplay-fixture" }]
          })
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    };
    const setup = new GuidedGitHubAppSetup({
      fetch,
      clock: { now: () => new Date("2026-08-23T12:00:00.000Z") }
    });
    const launch = setup.createLaunch("http://127.0.0.1:4318");
    const form = setup.consumeLaunch(launch.launchToken);
    const manifest = JSON.parse(form.manifest) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      public: false,
      default_permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "write"
      }
    });
    expect(form.manifest).not.toContain(privateKey);
    const state = new URL(form.action).searchParams.get("state");
    const converted = await setup.completeCallback(state ?? "", "manifest-code");
    expect(JSON.stringify(converted)).not.toContain(privateKey);
    expect(JSON.stringify(converted)).not.toContain("client-secret-value");
    await setup.verifyFixtureInstallation("456");
    expect(setup.hostCredentials()).toMatchObject({
      appId: "123",
      installationId: "456",
      privateKey
    });
    expect(requests).toHaveLength(3);
  });

  it("rejects a broader installation", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem"
    }) as string;
    const fetch: typeof globalThis.fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/conversions")) {
        return Promise.resolve(
          Response.json({
            id: 123,
            slug: "parallelplay-fixture-test",
            client_id: "client-id",
            client_secret: ["client", "secret", "value"].join("-"),
            webhook_secret: ["webhook", "secret", "with-more-than-thirty-two-bytes"].join("-"),
            pem: privateKey,
            html_url: "https://github.com/apps/parallelplay-fixture-test"
          })
        );
      }
      if (url.includes("/access_tokens")) {
        return Promise.resolve(
          Response.json({
            token: ["installation", "token"].join("-"),
            expires_at: "2026-08-23T13:00:00.000Z"
          })
        );
      }
      return Promise.resolve(
        Response.json({
          total_count: 2,
          repositories: [
            { full_name: "anirudh/parallelplay-fixture" },
            { full_name: "anirudh/another-repository" }
          ]
        })
      );
    };
    const setup = new GuidedGitHubAppSetup({
      fetch,
      clock: { now: () => new Date("2026-08-23T12:00:00.000Z") }
    });
    const launch = setup.createLaunch("http://127.0.0.1:4318");
    const form = setup.consumeLaunch(launch.launchToken);
    await setup.completeCallback(
      new URL(form.action).searchParams.get("state") ?? "",
      "manifest-code"
    );
    await expect(setup.verifyFixtureInstallation("456")).rejects.toThrow(/only/);
  });
});
