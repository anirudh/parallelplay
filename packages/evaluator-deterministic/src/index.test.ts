import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExtensionManifestV1 } from "@parallelplay/contracts";
import {
  DETERMINISTIC_EVALUATOR_CONFIGURATION_SCHEMA_DIGEST,
  DeterministicEvidenceEvaluator,
  deterministicEvaluatorConfigurationDigest
} from "./index.js";

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
const corpus = digest("holdout-corpus");
const configuration = {
  schemaVersion: 1 as const,
  minimumMeanScore: 0.5,
  minimumSamples: 20,
  allowedCorpusDigest: corpus
};
const manifest: ExtensionManifestV1 = {
  schemaVersion: 1,
  id: "deterministic-evaluator",
  displayName: "Deterministic evaluator",
  extensionVersion: "0.1.0",
  kind: "evaluator",
  contract: { name: "evaluator-extension-v1", version: 1 },
  artifact: {
    mediaType: "application/vnd.parallelplay.builtin+json",
    reference: "builtin:deterministic-evaluator",
    sha256: digest("artifact")
  },
  configurationSchemaDigest: DETERMINISTIC_EVALUATOR_CONFIGURATION_SCHEMA_DIGEST,
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

describe("deterministic evidence evaluator", () => {
  it("is deterministic and binds frozen blinded holdout evidence", async () => {
    const evidence = {
      schemaVersion: 1,
      partition: "holdout",
      blinded: true,
      contaminated: false,
      scores: Array.from({ length: 20 }, () => 1),
      abstentionReason: null,
      baselineDigest: corpus,
      currentCorpusDigest: corpus
    };
    const evaluator = new DeterministicEvidenceEvaluator(manifest, configuration);
    const request = {
      schemaVersion: 1 as const,
      subjectDigest: digest("subject"),
      evidenceDigest: digest(evidence),
      evidence,
      evaluatorConfigurationDigest: deterministicEvaluatorConfigurationDigest(configuration)
    };
    const first = await evaluator.evaluate(request);
    const second = await evaluator.evaluate(request);
    expect(first).toEqual(second);
    expect(first.passed).toBe(true);
  });

  it("fails closed for contamination, drift, abstention, and inadequate confidence", async () => {
    const evaluator = new DeterministicEvidenceEvaluator(manifest, configuration);
    const evidence = {
      schemaVersion: 1,
      partition: "holdout",
      blinded: true,
      contaminated: true,
      scores: [0.9],
      abstentionReason: "insufficient independent evidence",
      baselineDigest: corpus,
      currentCorpusDigest: digest("changed")
    };
    const result = await evaluator.evaluate({
      schemaVersion: 1,
      subjectDigest: digest("subject"),
      evidenceDigest: digest(evidence),
      evidence,
      evaluatorConfigurationDigest: deterministicEvaluatorConfigurationDigest(configuration)
    });
    expect(result.passed).toBe(false);
    expect(result.report).toMatchObject({
      contaminated: true,
      drifted: true,
      abstained: true,
      samples: 1
    });
  });
});
