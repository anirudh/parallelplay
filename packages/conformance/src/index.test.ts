import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runPolicyConformance,
  buildConformanceEvidenceBundle,
  CONFORMANCE_REQUIREMENTS_V1,
  conformanceReportToJunit,
  writeConformanceOutputs,
  type ConformanceReportV1
} from "./index.js";
import type {
  ExtensionManifestV1,
  PolicyExtensionRequestV1,
  PolicyExtensionResultV1,
  PolicyExtensionV1
} from "@parallelplay/contracts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const manifest: ExtensionManifestV1 = {
  schemaVersion: 1,
  id: "fixture-policy",
  displayName: "Fixture policy",
  extensionVersion: "0.1.0",
  kind: "policy",
  contract: { name: "policy-extension-v1", version: 1 },
  artifact: {
    mediaType: "application/vnd.parallelplay.builtin+json",
    reference: "builtin:fixture-policy",
    sha256: digest("artifact")
  },
  configurationSchemaDigest: digest("config"),
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

class CeilingPolicy implements PolicyExtensionV1 {
  readonly manifest = manifest;

  async decide(request: PolicyExtensionRequestV1): Promise<PolicyExtensionResultV1> {
    return Promise.resolve({
      schemaVersion: 1,
      decision: request.proposedAction.startsWith("github.")
        ? "allow_within_global_ceiling"
        : "deny",
      policyDigest: request.policyDigest,
      evidenceDigest: request.evidenceDigest,
      proposedAction: request.proposedAction,
      rationale: "Fixture policy preserves the global ceiling"
    });
  }
}

describe("public conformance", () => {
  it("publishes the complete V1 requirement inventory", () => {
    expect(CONFORMANCE_REQUIREMENTS_V1["agent-driver-v1"]).toContain("network-denial");
    expect(CONFORMANCE_REQUIREMENTS_V1["workflow-extension-v1"]).toContain(
      "reverification-after-rebase"
    );
    expect(CONFORMANCE_REQUIREMENTS_V1["evaluator-extension-v1"]).toContain("contamination");
    expect(CONFORMANCE_REQUIREMENTS_V1["policy-extension-v1"]).toContain(
      "global-authority-ceiling"
    );
    expect(CONFORMANCE_REQUIREMENTS_V1["outbound-adapter-v1"]).toContain("receipt-integrity");
  });

  it("publishes a digest-bound passing policy report", async () => {
    const report: ConformanceReportV1 = await runPolicyConformance(new CeilingPolicy(), {
      schemaVersion: 1,
      policyDigest: digest("policy"),
      evidenceDigest: digest("evidence"),
      proposedAction: "github.comment.create",
      risk: "low",
      irreversible: false,
      externalEffect: true
    });
    expect(report.passed).toBe(true);
    expect(report.reportDigest).toMatch(/^[a-f0-9]{64}$/);
    const bundle = buildConformanceEvidenceBundle([report]);
    expect(bundle.artifactDigest).toBe(report.artifactDigest);
    expect(bundle.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(conformanceReportToJunit(report)).toContain('tests="1"');
    const output = writeConformanceOutputs(
      report,
      mkdtempSync(join(tmpdir(), "parallelplay-conformance-"))
    );
    expect(JSON.parse(readFileSync(output.json, "utf8"))).toMatchObject({
      reportDigest: report.reportDigest
    });
    expect(readFileSync(output.junit, "utf8")).toContain("<testsuite");
    expect(JSON.parse(readFileSync(output.evidenceBundle, "utf8"))).toMatchObject({
      artifactDigest: report.artifactDigest
    });
  });
});
