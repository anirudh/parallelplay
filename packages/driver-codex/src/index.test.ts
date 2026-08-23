import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexSdkDriver } from "./index.js";

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

describe("Codex SDK driver", () => {
  it("refuses host execution", () => {
    expect(
      () =>
        new CodexSdkDriver({
          image: `codex@sha256:${"a".repeat(64)}`,
          brokerBaseUrl: "http://broker",
          brokerToken: "grant",
          environment: {}
        })
    ).toThrow(/OCI boundary/);
  });

  it("normalizes structured SDK events into a digest-bound receipt", async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "parallelplay-codex-"));
    const driver = new CodexSdkDriver({
      image: `codex@sha256:${"a".repeat(64)}`,
      brokerBaseUrl: "http://broker",
      brokerToken: "grant",
      sessionDirectory,
      environment: { PARALLELPLAY_OCI_BOUNDARY: "1" },
      clientFactory: () => ({
        startThread: () => ({
          id: null,
          runStreamed: () =>
            Promise.resolve({
              events: (async function* () {
                yield { type: "thread.started", thread_id: "thread-1" };
                yield { type: "turn.started" };
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 10,
                    cached_input_tokens: 2,
                    cache_write_input_tokens: 0,
                    output_tokens: 4,
                    reasoning_output_tokens: 1
                  }
                };
              })()
            })
        }),
        resumeThread: () => {
          throw new Error("not used");
        }
      })
    });
    const launch = {
      schemaVersion: 1 as const,
      effectKey: "codex-start",
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
        resources: {
          cpuLimit: 1,
          memoryLimitBytes: 268_435_456,
          pidsLimit: 64,
          wallTimeMs: 60_000
        },
        network: [
          {
            broker: "provider-broker",
            provider: "openai" as const,
            purpose: "provider_api" as const,
            allowedModels: ["codex-test"]
          }
        ],
        secretHandles: ["broker-grant"],
        git: []
      },
      capabilityManifestDigest: "c".repeat(64),
      prompt: "Make the small fixture change.",
      requestedModel: "codex-test"
    };
    const session = await driver.start(launch);
    const receipt = await eventually(() => driver.collectReceipt(session.sessionId));
    expect(receipt.outcome).toBe("succeeded");
    expect(receipt.sdkVersion).toBe("0.149.0");
    expect(receipt.checkpointDigest).toMatch(/^[a-f0-9]{64}$/);
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
});
