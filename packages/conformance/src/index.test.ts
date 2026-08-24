import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConformanceEvidenceBundle,
  CONFORMANCE_REQUIREMENTS_V1,
  conformanceReportToJunit,
  runConformanceHarness,
  writeConformanceOutputs,
  type ConformanceReportV1
} from "./index.js";
import type { ExtensionManifestV1 } from "@parallelplay/contracts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const sourceCommit = "a".repeat(40);

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
    const report: ConformanceReportV1 = await runConformanceHarness({
      contract: "policy-extension-v1",
      manifest,
      sourceCommit,
      createExtension: () => ({ manifest }),
      cases: CONFORMANCE_REQUIREMENTS_V1["policy-extension-v1"].map((id) => ({
        id,
        run: () => Promise.resolve()
      }))
    });
    expect(report.passed).toBe(true);
    expect(report.reportDigest).toMatch(/^[a-f0-9]{64}$/);
    const bundle = buildConformanceEvidenceBundle([report]);
    expect(bundle.artifactDigest).toBe(report.artifactDigest);
    expect(bundle.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(conformanceReportToJunit(report)).toContain('tests="6"');
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

  it("fails closed when a published case is missing", async () => {
    const report = await runConformanceHarness({
      contract: "policy-extension-v1",
      manifest,
      sourceCommit,
      createExtension: () => ({ manifest }),
      cases: CONFORMANCE_REQUIREMENTS_V1["policy-extension-v1"].slice(1).map((id) => ({
        id,
        run: () => Promise.resolve()
      }))
    });
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({
      id: "classification-integrity",
      status: "failed",
      detail: "Missing required conformance case: classification-integrity"
    });
  });

  it("rejects duplicate or unknown case identifiers", async () => {
    await expect(
      runConformanceHarness({
        contract: "policy-extension-v1",
        manifest,
        sourceCommit,
        createExtension: () => ({ manifest }),
        cases: [
          { id: "expiry", run: () => Promise.resolve() },
          { id: "expiry", run: () => Promise.resolve() }
        ]
      })
    ).rejects.toThrow(/Duplicate/);
    await expect(
      runConformanceHarness({
        contract: "policy-extension-v1",
        manifest,
        sourceCommit,
        createExtension: () => ({ manifest }),
        cases: [{ id: "not-a-case", run: () => Promise.resolve() }]
      })
    ).rejects.toThrow(/Unknown/);
  });

  it("creates and closes an isolated extension for every published case", async () => {
    let created = 0;
    let closed = 0;
    const report = await runConformanceHarness({
      contract: "policy-extension-v1",
      manifest,
      sourceCommit,
      createExtension: () => {
        created += 1;
        return {
          manifest,
          close: () => {
            closed += 1;
            return Promise.resolve();
          }
        };
      },
      cases: CONFORMANCE_REQUIREMENTS_V1["policy-extension-v1"].map((id) => ({
        id,
        run: () => Promise.resolve()
      }))
    });
    expect(report.passed).toBe(true);
    expect(created).toBe(CONFORMANCE_REQUIREMENTS_V1["policy-extension-v1"].length);
    expect(closed).toBe(created);
  });
});
