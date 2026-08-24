import { createHash } from "node:crypto";
import {
  EvaluatorExtensionRequestV1Schema,
  EvaluatorExtensionResultV1Schema,
  ExtensionManifestV1Schema,
  type EvaluatorExtensionResultV1,
  type EvaluatorExtensionV1,
  type ExtensionManifestV1
} from "@parallelplay/contracts";
import { z } from "zod";

const EvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  partition: z.literal("holdout"),
  blinded: z.literal(true),
  contaminated: z.boolean(),
  scores: z.array(z.number().min(0).max(1)).max(10_000),
  abstentionReason: z.string().trim().min(1).max(1000).nullable(),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  currentCorpusDigest: z.string().regex(/^[a-f0-9]{64}$/)
});

export interface DeterministicEvaluatorConfigurationV1 {
  schemaVersion: 1;
  minimumMeanScore: number;
  minimumSamples: number;
  allowedCorpusDigest: string;
}

const ConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  minimumMeanScore: z.number().min(0).max(1),
  minimumSamples: z.number().int().positive().max(10_000),
  allowedCorpusDigest: z.string().regex(/^[a-f0-9]{64}$/)
});

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function deterministicEvaluatorConfigurationDigest(
  configuration: DeterministicEvaluatorConfigurationV1
): string {
  return digest(ConfigurationSchema.parse(configuration));
}

export class DeterministicEvidenceEvaluator implements EvaluatorExtensionV1 {
  readonly manifest: ExtensionManifestV1;
  readonly #configuration: DeterministicEvaluatorConfigurationV1;
  readonly #configurationDigest: string;

  constructor(manifest: ExtensionManifestV1, configuration: DeterministicEvaluatorConfigurationV1) {
    const parsed = ExtensionManifestV1Schema.parse(manifest);
    if (
      parsed.id !== "deterministic-evaluator" ||
      parsed.kind !== "evaluator" ||
      parsed.contract.name !== "evaluator-extension-v1"
    ) {
      throw new Error(
        "Deterministic evaluator requires a deterministic-evaluator evaluator-extension-v1 manifest"
      );
    }
    this.manifest = parsed;
    this.#configuration = ConfigurationSchema.parse(configuration);
    this.#configurationDigest = deterministicEvaluatorConfigurationDigest(this.#configuration);
    if (this.manifest.configurationSchemaDigest !== digest(ConfigurationSchema.toJSONSchema())) {
      throw new Error("Evaluator manifest does not bind the configuration schema");
    }
  }

  async evaluate(
    rawRequest: Parameters<EvaluatorExtensionV1["evaluate"]>[0]
  ): Promise<EvaluatorExtensionResultV1> {
    const request = EvaluatorExtensionRequestV1Schema.parse(rawRequest);
    if (request.evaluatorConfigurationDigest !== this.#configurationDigest) {
      throw new Error("Evaluator configuration digest does not match");
    }
    if (digest(request.evidence) !== request.evidenceDigest) {
      throw new Error("Frozen evaluator evidence digest does not match");
    }
    const evidence = EvidenceSchema.parse(request.evidence);
    const drifted =
      evidence.baselineDigest !== this.#configuration.allowedCorpusDigest ||
      evidence.currentCorpusDigest !== this.#configuration.allowedCorpusDigest;
    const abstained = evidence.abstentionReason !== null;
    const sufficient = evidence.scores.length >= this.#configuration.minimumSamples;
    const mean =
      evidence.scores.length === 0
        ? null
        : evidence.scores.reduce((total, score) => total + score, 0) / evidence.scores.length;
    const confidenceRadius =
      mean === null ? null : Math.sqrt(Math.log(40) / (2 * evidence.scores.length));
    const lowerConfidenceBound =
      mean === null || confidenceRadius === null ? null : Math.max(0, mean - confidenceRadius);
    const passed =
      !evidence.contaminated &&
      !drifted &&
      !abstained &&
      sufficient &&
      lowerConfidenceBound !== null &&
      lowerConfidenceBound >= this.#configuration.minimumMeanScore;
    const report = {
      schemaVersion: 1,
      subjectDigest: request.subjectDigest,
      partition: evidence.partition,
      blinded: evidence.blinded,
      contaminated: evidence.contaminated,
      drifted,
      abstained,
      samples: evidence.scores.length,
      mean,
      lowerConfidenceBound,
      minimumMeanScore: this.#configuration.minimumMeanScore,
      minimumSamples: this.#configuration.minimumSamples,
      reasons: [
        ...(evidence.contaminated ? ["contaminated"] : []),
        ...(drifted ? ["corpus-drift"] : []),
        ...(abstained ? ["abstained"] : []),
        ...(!sufficient ? ["insufficient-samples"] : []),
        ...(sufficient &&
        lowerConfidenceBound !== null &&
        lowerConfidenceBound < this.#configuration.minimumMeanScore
          ? ["confidence-bound-below-threshold"]
          : [])
      ]
    };
    return EvaluatorExtensionResultV1Schema.parse({
      schemaVersion: 1,
      evaluatorDigest: digest({
        artifact: this.manifest.artifact.sha256,
        configuration: this.#configurationDigest
      }),
      evidenceDigest: request.evidenceDigest,
      passed,
      report,
      reportDigest: digest(report)
    });
  }
}

export const DETERMINISTIC_EVALUATOR_CONFIGURATION_SCHEMA_DIGEST = digest(
  ConfigurationSchema.toJSONSchema()
);
