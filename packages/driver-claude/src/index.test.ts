import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSdkDriver } from "./index.js";

async function eventually<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let index = 0; index < 100; index += 1) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw last;
}

function fakeQuery(
  messages: unknown[]
): AsyncIterable<unknown> & { interrupt(): Promise<undefined> } {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
    async interrupt() {
      return undefined;
    }
  };
}

const launch = {
  schemaVersion: 1 as const,
  effectKey: "claude-start",
  runId: "10000000-0000-4000-8000-000000000001",
  jobId: "10000000-0000-4000-8000-000000000002",
  attemptId: "10000000-0000-4000-8000-000000000003",
  contextDigest: "a".repeat(64),
  executionContractDigest: "b".repeat(64),
  capabilityManifest: {
    schemaVersion: 3 as const,
    workspace: "read_write" as const,
    artifactOutput: "read_write" as const,
    scratch: "read_write" as const,
    context: { access: "read_only" as const, digest: "a".repeat(64) },
    resources: { cpuLimit: 1, memoryLimitBytes: 268_435_456, pidsLimit: 64, wallTimeMs: 60_000 },
    network: [
      {
        broker: "provider-broker",
        provider: "anthropic" as const,
        purpose: "provider_api" as const,
        allowedModels: ["claude-test"]
      }
    ],
    secretHandles: ["broker-grant"],
    git: []
  },
  capabilityManifestDigest: "c".repeat(64),
  prompt: "Make the small fixture change.",
  requestedModel: "claude-test"
};

describe("Claude Agent SDK driver", () => {
  it("refuses host execution", () => {
    expect(
      () =>
        new ClaudeSdkDriver({
          image: `claude@sha256:${"a".repeat(64)}`,
          brokerBaseUrl: "http://broker",
          brokerToken: "grant",
          environment: {}
        })
    ).toThrow(/OCI boundary/);
  });

  it("normalizes structured SDK messages into a digest-bound receipt", async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "parallelplay-claude-"));
    const driver = new ClaudeSdkDriver({
      image: `claude@sha256:${"a".repeat(64)}`,
      brokerBaseUrl: "http://broker",
      brokerToken: "grant",
      sessionDirectory,
      environment: { PARALLELPLAY_OCI_BOUNDARY: "1" },
      queryFactory: () =>
        fakeQuery([
          { type: "system", subtype: "init", session_id: "session-1", model: "claude-test" },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.001,
            modelUsage: {
              "claude-test": {
                inputTokens: 12,
                outputTokens: 5,
                cacheReadInputTokens: 2,
                cacheCreationInputTokens: 0,
                webSearchRequests: 0,
                costUSD: 0.001,
                contextWindow: 100_000,
                maxOutputTokens: 8_192
              }
            },
            permission_denials: [],
            session_id: "session-1"
          }
        ])
    });
    const session = await driver.start(launch);
    const receipt = await eventually(() => driver.collectReceipt(session.sessionId));
    expect(receipt.outcome).toBe("succeeded");
    expect(receipt.sdkVersion).toBe("0.3.241");
    expect(receipt.observedModels).toEqual(["claude-test"]);
    const inspection = await driver.inspect({
      schemaVersion: 1,
      sessionId: session.sessionId,
      afterSequence: 0
    });
    expect(inspection.events.map((event) => event.type)).toEqual([
      "started",
      "checkpoint",
      "usage",
      "terminal"
    ]);
  });

  it("routes permission denials to an authority-required terminal", async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "parallelplay-claude-denied-"));
    const driver = new ClaudeSdkDriver({
      image: `claude@sha256:${"b".repeat(64)}`,
      brokerBaseUrl: "http://broker",
      brokerToken: "grant",
      sessionDirectory,
      environment: { PARALLELPLAY_OCI_BOUNDARY: "1" },
      queryFactory: () =>
        fakeQuery([
          { type: "system", subtype: "init", session_id: "session-2", model: "claude-test" },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0,
            modelUsage: {},
            permission_denials: [{ tool_name: "WebFetch" }],
            session_id: "session-2"
          }
        ])
    });
    const session = await driver.start(launch);
    const receipt = await eventually(() => driver.collectReceipt(session.sessionId));
    expect(receipt.outcome).toBe("approval_required");
    const inspection = await driver.inspect({
      schemaVersion: 1,
      sessionId: session.sessionId,
      afterSequence: 0
    });
    expect(inspection.events.map((event) => event.type)).toContain("approval.requested");
  });
});
