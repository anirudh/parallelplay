import { describe, expect, it } from "vitest";
import { EnvironmentSecretProvider } from "./secret-provider.js";

describe("environment secret provider", () => {
  it("returns only an opaque run-bound handle and supports revocation", () => {
    const provider = new EnvironmentSecretProvider({
      environment: { TEST_PROVIDER_KEY: "do-not-serialize" },
      clock: { now: () => new Date("2026-08-23T00:00:00.000Z") }
    });
    const handle = provider.issueHandle(
      {
        schemaVersion: 1,
        provider: "environment",
        name: "TEST_PROVIDER_KEY",
        purpose: "provider-api",
        allowedConsumer: "provider-broker"
      },
      { runId: "run-1", now: "2026-08-23T00:00:00.000Z" }
    );
    expect(JSON.stringify(handle)).not.toContain("do-not-serialize");
    expect(provider.consume(handle.handleId, "provider-broker", "run-1")).toBe("do-not-serialize");
    expect(() => provider.consume(handle.handleId, "wrong", "run-1")).toThrow(/binding/);
    provider.revoke(handle.handleId);
    expect(() => provider.consume(handle.handleId, "provider-broker", "run-1")).toThrow(/revoked/);
  });
});
