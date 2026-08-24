import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionManifestV1 } from "@parallelplay/contracts";
import { describe, expect, it } from "vitest";
import { CodexSdkDriver } from "./index.js";

const codexManifest: ExtensionManifestV1 = {
  schemaVersion: 1,
  id: "codex-sdk",
  displayName: "Codex SDK",
  extensionVersion: "0.1.0",
  kind: "driver",
  contract: { name: "agent-driver-v1", version: 1 },
  artifact: {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    reference: `codex@sha256:${"a".repeat(64)}`,
    sha256: "a".repeat(64)
  },
  configurationSchemaDigest: "b".repeat(64),
  capabilities: [],
  provenance: {
    sourceRepository: "https://github.com/anirudh/parallelplay",
    sourceRevision: "c".repeat(64),
    sbomDigest: "d".repeat(64),
    attestationDigest: "e".repeat(64)
  },
  conformance: {
    suiteVersion: "0.1.0",
    reportDigest: "f".repeat(64),
    approvedRegistryDigest: null
  }
};

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
          manifest: codexManifest,
          brokerBaseUrl: "http://broker",
          brokerToken: "grant",
          environment: {}
        })
    ).toThrow(/OCI boundary/);
  });

  it("normalizes structured SDK events into a digest-bound receipt", async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "parallelplay-codex-"));
    const driver = new CodexSdkDriver({
      manifest: codexManifest,
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
                  type: "item.started",
                  item: {
                    id: "command-1",
                    type: "command_execution",
                    command: "true",
                    aggregated_output: "",
                    exit_code: null,
                    status: "in_progress"
                  }
                };
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

  it("fails closed on malformed provider events without retaining provider text", async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "parallelplay-codex-malformed-"));
    const driver = new CodexSdkDriver({
      manifest: codexManifest,
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
                yield {
                  type: "thread.started",
                  thread_id: "thread-1",
                  secret: ["do", "not", "retain"].join("-")
                };
              })()
            })
        }),
        resumeThread: () => {
          throw new Error("not used");
        }
      })
    });
    const session = await driver.start({
      schemaVersion: 1,
      effectKey: "codex-malformed",
      runId: "10000000-0000-4000-8000-000000000001",
      jobId: "10000000-0000-4000-8000-000000000002",
      attemptId: "10000000-0000-4000-8000-000000000003",
      contextDigest: "a".repeat(64),
      executionContractDigest: "b".repeat(64),
      capabilityManifest: {
        schemaVersion: 3,
        workspace: "read_only",
        artifactOutput: "read_write",
        scratch: "read_write",
        context: { access: "read_only", digest: "a".repeat(64) },
        resources: {
          cpuLimit: 1,
          memoryLimitBytes: 268_435_456,
          pidsLimit: 64,
          wallTimeMs: 60_000
        },
        network: [],
        secretHandles: [],
        git: []
      },
      capabilityManifestDigest: "c".repeat(64),
      prompt: "test malformed event",
      requestedModel: "codex-test"
    });
    const receipt = await eventually(() => driver.collectReceipt(session.sessionId));
    expect(receipt.outcome).toBe("protocol_invalid");
    expect(receipt.terminalReason).toBe(
      "provider_event_protocol_invalid_thread_started_unrecognized_keys_root"
    );
    expect(JSON.stringify(receipt)).not.toContain("do-not-retain");
  });
});
