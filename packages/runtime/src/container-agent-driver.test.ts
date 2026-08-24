import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExtensionManifestV1 } from "@parallelplay/contracts";
import { buildProviderRunnerDockerArgs, ContainerAgentDriver } from "./container-agent-driver.js";
import { EnvironmentSecretProvider } from "./secret-provider.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const imageDigest = "a".repeat(64);
const runnerImage = `parallelplay-provider-runner@sha256:${imageDigest}`;
const manifest: ExtensionManifestV1 = {
  schemaVersion: 1,
  id: "codex-sdk",
  displayName: "Codex SDK",
  extensionVersion: "0.1.0",
  kind: "driver",
  contract: { name: "agent-driver-v1", version: 1 },
  artifact: {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    reference: runnerImage,
    sha256: imageDigest
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

describe("provider container runtime", () => {
  it("builds a hardened agent boundary without credentials or a direct egress network", () => {
    const args = buildProviderRunnerDockerArgs({
      name: "runner",
      network: "run-internal",
      image: runnerImage,
      workspace: "/private/run/workspace",
      session: "/private/run/session"
    });
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("no-new-privileges");
    const user = args[args.indexOf("--user") + 1];
    expect(user).toMatch(/^[0-9]+:[0-9]+$/);
    expect(user).not.toBe("0:0");
    expect(args).toContain("run-internal");
    expect(args.join(" ")).not.toContain("OPENAI_API_KEY");
    expect(args.join(" ")).not.toContain("ANTHROPIC_API_KEY");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("host.docker.internal");
  });

  it("accepts a verified local image ID without accepting a mutable tag", () => {
    const localImageId = `sha256:${"d".repeat(64)}`;
    expect(
      buildProviderRunnerDockerArgs({
        name: "runner",
        network: "run-internal",
        image: localImageId,
        workspace: "/private/run/workspace",
        session: "/private/run/session"
      }).at(-1)
    ).toBe(localImageId);
    expect(() =>
      buildProviderRunnerDockerArgs({
        name: "runner",
        network: "run-internal",
        image: "parallelplay-provider-runner:latest",
        workspace: "/private/run/workspace",
        session: "/private/run/session"
      })
    ).toThrow();
  });

  it("requires the public manifest to bind the exact runner image", () => {
    expect(
      () =>
        new ContainerAgentDriver({
          manifest: {
            ...manifest,
            artifact: { ...manifest.artifact, sha256: "b".repeat(64) }
          },
          provider: "openai",
          runnerImage,
          relayImage: `parallelplay-provider-relay@sha256:${"c".repeat(64)}`,
          workspaceRoot: "/private/workspaces",
          sessionRoot: "/private/sessions",
          secretEnvironmentName: "OPENAI_API_KEY",
          secretProvider: new EnvironmentSecretProvider({ environment: {} }),
          maxBudgetUsd: 10,
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 20
        })
    ).toThrow(/bind the runner image/);
  });
});
