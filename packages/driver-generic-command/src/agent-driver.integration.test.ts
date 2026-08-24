import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverLaunchV1, ExtensionManifestV1 } from "@parallelplay/contracts";
import { describe, expect, it } from "vitest";
import { GenericCommandAgentDriver, buildGenericCommandDockerArgs } from "./agent-driver.js";

const image =
  "node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854";
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
};
const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
const manifest: ExtensionManifestV1 = {
  schemaVersion: 1,
  id: "generic-command",
  displayName: "Generic command",
  extensionVersion: "0.1.0",
  kind: "driver",
  contract: { name: "agent-driver-v1", version: 1 },
  artifact: {
    mediaType: "application/vnd.parallelplay.builtin+json",
    reference: "builtin:generic-command",
    sha256: digest("artifact")
  },
  configurationSchemaDigest: digest("configuration"),
  capabilities: [],
  provenance: {
    sourceRepository: "https://github.com/anirudh/parallelplay",
    sourceRevision: digest("source"),
    sbomDigest: digest("sbom"),
    attestationDigest: digest("attestation")
  },
  conformance: {
    suiteVersion: "0.1.0",
    reportDigest: digest("report"),
    approvedRegistryDigest: null
  }
};

function launch(runId = "10000000-0000-4000-8000-000000000001"): DriverLaunchV1 {
  const capabilityManifest = {
    schemaVersion: 3 as const,
    workspace: "read_write" as const,
    artifactOutput: "read_write" as const,
    scratch: "read_write" as const,
    context: { access: "read_only" as const, digest: digest("context-packet") },
    resources: {
      cpuLimit: 1,
      memoryLimitBytes: 268_435_456,
      pidsLimit: 64,
      wallTimeMs: 10_000
    },
    network: [],
    secretHandles: [],
    git: []
  };
  return {
    schemaVersion: 1,
    effectKey: `generic:${runId}`,
    runId,
    jobId: "10000000-0000-4000-8000-000000000002",
    attemptId: "10000000-0000-4000-8000-000000000003",
    contextDigest: digest("context"),
    executionContractDigest: digest("execution"),
    capabilityManifest,
    capabilityManifestDigest: digest(capabilityManifest),
    prompt: "Complete the deterministic fixture task.",
    requestedModel: null
  };
}

async function terminal(driver: GenericCommandAgentDriver, sessionId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const batch = await driver.inspect({ schemaVersion: 1, sessionId, afterSequence: 0 });
    if (batch.status !== "running") return batch;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("Generic command fixture did not terminate");
}

describe("generic command AgentDriverV1", () => {
  it("runs a credential-free structured lifecycle and emits a digest-bound receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "parallelplay-generic-driver-"));
    const command = [
      "node",
      "-e",
      `const fs=require('node:fs');fs.writeFileSync('/artifacts/result.txt','fixture artifact\\n');for(const e of [{schemaVersion:1,sequence:1,type:'started'},{schemaVersion:1,sequence:2,type:'capability.used',capability:'artifact.write'},{schemaVersion:1,sequence:3,type:'artifact.declared',path:'result.txt',role:'agent.output'},{schemaVersion:1,sequence:4,type:'usage'},{schemaVersion:1,sequence:5,type:'terminal',outcome:'succeeded'}])console.log(JSON.stringify(e));`
    ];
    const driver = new GenericCommandAgentDriver({
      manifest,
      image,
      command,
      workspaceRoot: join(root, "workspaces"),
      sessionRoot: join(root, "sessions")
    });
    const request = launch();
    const session = await driver.start(request);
    expect((await driver.start(request)).sessionId).toBe(session.sessionId);
    const batch = await terminal(driver, session.sessionId);
    expect(batch.status).toBe("succeeded");
    expect(batch.events.map((event) => event.type)).toEqual([
      "started",
      "capability.used",
      "artifact.declared",
      "usage",
      "terminal"
    ]);
    const receipt = await driver.collectReceipt(session.sessionId);
    expect(receipt.outcome).toBe("succeeded");
    expect(receipt.rawStreamDigest).toMatch(/^[a-f0-9]{64}$/);
    await driver.close();
  }, 20_000);

  it("reattaches a nonterminal digest-matched session after host restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "parallelplay-generic-restart-"));
    const options = {
      manifest,
      image,
      command: [
        "node",
        "-e",
        "console.log(JSON.stringify({schemaVersion:1,sequence:1,type:'started'}));setTimeout(()=>{},30000)"
      ],
      workspaceRoot: join(root, "workspaces"),
      sessionRoot: join(root, "sessions")
    };
    const first = new GenericCommandAgentDriver(options);
    const request = launch("20000000-0000-4000-8000-000000000001");
    const session = await first.start(request);
    const restarted = new GenericCommandAgentDriver(options);
    expect(
      (
        await restarted.resume({
          schemaVersion: 1,
          effectKey: "resume",
          sessionId: session.sessionId,
          checkpointDigest: session.checkpointDigest ?? "",
          contextDigest: request.contextDigest,
          executionContractDigest: request.executionContractDigest,
          capabilityManifestDigest: request.capabilityManifestDigest
        })
      ).sessionId
    ).toBe(session.sessionId);
    await restarted.cancel({
      schemaVersion: 1,
      effectKey: "cancel",
      sessionId: session.sessionId,
      reason: "operator_cancelled"
    });
    expect((await terminal(restarted, session.sessionId)).status).toBe("operator_cancelled");
    await restarted.close();
  }, 20_000);

  it("publishes Docker arguments with no network, secret, home, or socket inheritance", () => {
    const request = launch();
    const args = buildGenericCommandDockerArgs({
      name: "pp-generic-test",
      image,
      command: ["node", "fixture.js"],
      workspace: "/private/workspace",
      artifacts: "/private/artifacts",
      scratch: "/private/scratch",
      context: "/private/context",
      capabilityManifest: request.capabilityManifest
    });
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("no-new-privileges");
    expect(args.join(" ")).not.toMatch(/API_KEY|TOKEN|docker\.sock|host\.docker\.internal/);
  });
});
