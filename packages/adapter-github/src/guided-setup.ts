import { randomBytes } from "node:crypto";
import { z } from "zod";
import { GitHubAppTokenProvider } from "./index.js";

const ConversionSchema = z.strictObject({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(32),
  pem: z.string().min(1),
  html_url: z.url()
});
const RepositoriesSchema = z.strictObject({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(
    z.looseObject({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) })
  )
});

interface PendingLaunch {
  state: string;
  launchToken: string;
  manifest: Record<string, unknown>;
  expiresAt: number;
  consumed: boolean;
}

interface ConvertedApp {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  htmlUrl: string;
  installationId: string | null;
}

export interface GuidedGitHubAppSetupOptions {
  repository?: string;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  clock?: { now(): Date };
}

export interface GuidedGitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
  webhookSecret: string;
}

export class GuidedGitHubAppSetup {
  readonly #repository: string;
  readonly #apiBaseUrl: string;
  readonly #webBaseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: { now(): Date };
  #pending: PendingLaunch | null = null;
  #app: ConvertedApp | null = null;

  constructor(options: GuidedGitHubAppSetupOptions = {}) {
    this.#repository = options.repository ?? "anirudh/parallelplay-fixture";
    if (this.#repository !== "anirudh/parallelplay-fixture") {
      throw new Error("Guided GitHub App setup is restricted to anirudh/parallelplay-fixture");
    }
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.#webBaseUrl = options.webBaseUrl ?? "https://github.com";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  createLaunch(attentionBaseUrl: string): { launchToken: string; launchPath: string } {
    const base = new URL(attentionBaseUrl);
    if (
      base.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(base.hostname) ||
      base.username ||
      base.password
    ) {
      throw new Error("GitHub App callback must use a credential-free loopback Attention URL");
    }
    const state = randomBytes(32).toString("base64url");
    const launchToken = randomBytes(32).toString("base64url");
    const redirect = new URL("/api/github/setup/callback", base);
    redirect.searchParams.set("state", state);
    this.#pending = {
      state,
      launchToken,
      expiresAt: this.#clock.now().getTime() + 10 * 60_000,
      consumed: false,
      manifest: {
        name: `ParallelPlay Fixture ${state.slice(0, 8)}`,
        url: "https://github.com/anirudh/parallelplay",
        redirect_url: redirect.href,
        public: false,
        default_permissions: {
          metadata: "read",
          contents: "write",
          pull_requests: "write",
          issues: "write",
          checks: "write"
        },
        default_events: [],
        hook_attributes: { active: false }
      }
    };
    return { launchToken, launchPath: `/github/setup/launch?token=${launchToken}` };
  }

  consumeLaunch(launchToken: string): {
    action: string;
    manifest: string;
  } {
    const pending = this.#pending;
    if (
      !pending ||
      pending.consumed ||
      pending.launchToken !== launchToken ||
      pending.expiresAt <= this.#clock.now().getTime()
    ) {
      throw new Error("GitHub App launch token is invalid, expired, or consumed");
    }
    pending.consumed = true;
    return {
      action: `${this.#webBaseUrl}/settings/apps/new?state=${encodeURIComponent(pending.state)}`,
      manifest: JSON.stringify(pending.manifest)
    };
  }

  async completeCallback(
    state: string,
    code: string
  ): Promise<{
    appId: string;
    slug: string;
    htmlUrl: string;
    installationUrl: string;
  }> {
    const pending = this.#pending;
    if (
      !pending ||
      !pending.consumed ||
      pending.state !== state ||
      pending.expiresAt <= this.#clock.now().getTime()
    ) {
      throw new Error("GitHub App callback state is invalid or expired");
    }
    if (!/^[A-Za-z0-9_-]{8,500}$/.test(code))
      throw new Error("GitHub App manifest code is invalid");
    const response = await this.#fetch(
      `${this.#apiBaseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2026-03-10"
        },
        redirect: "manual"
      }
    );
    if (!response.ok) {
      throw new Error(`GitHub App manifest conversion failed with ${String(response.status)}`);
    }
    const converted = ConversionSchema.parse(await response.json());
    this.#app = {
      appId: String(converted.id),
      slug: converted.slug,
      privateKey: converted.pem,
      webhookSecret: converted.webhook_secret,
      clientId: converted.client_id,
      clientSecret: converted.client_secret,
      htmlUrl: converted.html_url,
      installationId: null
    };
    this.#pending = null;
    return {
      appId: this.#app.appId,
      slug: this.#app.slug,
      htmlUrl: this.#app.htmlUrl,
      installationUrl: `${this.#webBaseUrl}/apps/${encodeURIComponent(this.#app.slug)}/installations/new`
    };
  }

  async verifyFixtureInstallation(installationId: string): Promise<{ repository: string }> {
    const app = this.#app;
    if (!app) throw new Error("GitHub App must be converted before installation verification");
    if (!/^[1-9][0-9]{0,30}$/.test(installationId)) {
      throw new Error("GitHub App installation ID is invalid");
    }
    const tokenProvider = new GitHubAppTokenProvider({
      appId: app.appId,
      installationId,
      privateKey: app.privateKey,
      fetch: this.#fetch,
      apiBaseUrl: this.#apiBaseUrl,
      clock: this.#clock
    });
    const token = await tokenProvider.getToken();
    const response = await this.#fetch(
      `${this.#apiBaseUrl}/installation/repositories?per_page=100`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2026-03-10"
        },
        redirect: "manual"
      }
    );
    if (!response.ok) {
      throw new Error(
        `GitHub installation repository check failed with ${String(response.status)}`
      );
    }
    const repositories = RepositoriesSchema.parse(await response.json());
    if (
      repositories.total_count !== 1 ||
      repositories.repositories.length !== 1 ||
      repositories.repositories[0]?.full_name !== this.#repository
    ) {
      throw new Error("GitHub App installation must have access only to the fixture repository");
    }
    app.installationId = installationId;
    return { repository: this.#repository };
  }

  hostCredentials(): GuidedGitHubAppCredentials {
    const app = this.#app;
    if (!app?.installationId) throw new Error("GitHub App fixture installation is not verified");
    return {
      appId: app.appId,
      installationId: app.installationId,
      privateKey: app.privateKey,
      webhookSecret: app.webhookSecret
    };
  }

  hostTokenProvider(): GitHubAppTokenProvider {
    const credentials = this.hostCredentials();
    return new GitHubAppTokenProvider({
      appId: credentials.appId,
      installationId: credentials.installationId,
      privateKey: credentials.privateKey,
      fetch: this.#fetch,
      apiBaseUrl: this.#apiBaseUrl,
      clock: this.#clock
    });
  }
}
