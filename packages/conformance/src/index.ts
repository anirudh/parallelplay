import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExtensionManifestV1Schema, type ExtensionManifestV1 } from "@parallelplay/contracts";
import { z } from "zod";

export const ConformanceCheckV1Schema = z.strictObject({
  id: z.string().min(1).max(200),
  status: z.enum(["passed", "failed"]),
  detail: z.string().min(1).max(4000)
});
export const ConformanceReportV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteVersion: z.literal("0.1.0"),
  contract: z.enum([
    "agent-driver-v1",
    "workflow-extension-v1",
    "evaluator-extension-v1",
    "policy-extension-v1",
    "outbound-adapter-v1"
  ]),
  extensionId: z.string().min(1).max(100),
  extensionVersion: z.string().min(1).max(100),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  platform: z.strictObject({
    os: z.string().min(1),
    arch: z.string().min(1),
    node: z.string().min(1)
  }),
  checks: z.array(ConformanceCheckV1Schema).min(1),
  passed: z.boolean(),
  reportDigest: z.string().regex(/^[a-f0-9]{64}$/)
});
export type ConformanceReportV1 = z.infer<typeof ConformanceReportV1Schema>;
export const ConformanceEvidenceBundleV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteVersion: z.literal("0.1.0"),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reports: z.array(ConformanceReportV1Schema).min(1),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/)
});
export type ConformanceEvidenceBundleV1 = z.infer<typeof ConformanceEvidenceBundleV1Schema>;

export const CONFORMANCE_REQUIREMENTS_V1 = {
  "agent-driver-v1": [
    "lifecycle",
    "resume",
    "event-ordering",
    "usage",
    "cost-availability",
    "artifacts",
    "approvals",
    "cancellation",
    "timeout",
    "malformed-events",
    "missing-terminal-state",
    "duplicate-delivery",
    "crash-recovery",
    "containment",
    "secret-denial",
    "network-denial"
  ],
  "workflow-extension-v1": [
    "schema-validation",
    "dag-compilation",
    "cycle-rejection",
    "dependency-validation",
    "stale-revisions",
    "serial-lineage",
    "controlled-concurrency",
    "leases",
    "integration-ordering",
    "reverification-after-rebase"
  ],
  "evaluator-extension-v1": [
    "blinding",
    "partition-separation",
    "contamination",
    "abstention",
    "confidence-bounds",
    "drift",
    "invalid-output",
    "deterministic-scoring"
  ],
  "policy-extension-v1": [
    "classification-integrity",
    "promotion-binding",
    "expiry",
    "audit-suspension",
    "low-risk-allowlist",
    "global-authority-ceiling"
  ],
  "outbound-adapter-v1": [
    "exact-effects",
    "retry-reconciliation",
    "stale-preconditions",
    "duplicate-delivery",
    "forbidden-operations",
    "receipt-integrity",
    "content-filtering",
    "secret-handling"
  ]
} as const;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function conformanceDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function buildConformanceEvidenceBundle(
  reports: ConformanceReportV1[]
): ConformanceEvidenceBundleV1 {
  const parsed = reports.map((report) => ConformanceReportV1Schema.parse(report));
  const artifactDigests = new Set(parsed.map((report) => report.artifactDigest));
  if (artifactDigests.size !== 1)
    throw new Error("An evidence bundle must bind one extension artifact");
  const sorted = [...parsed].sort((left, right) => left.contract.localeCompare(right.contract));
  const first = sorted[0];
  if (!first) throw new Error("An evidence bundle requires one report");
  const unsigned = {
    schemaVersion: 1 as const,
    suiteVersion: "0.1.0" as const,
    artifactDigest: first.artifactDigest,
    reports: sorted
  };
  return ConformanceEvidenceBundleV1Schema.parse({
    ...unsigned,
    bundleDigest: conformanceDigest(unsigned)
  });
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function conformanceReportToJunit(report: ConformanceReportV1): string {
  const parsed = ConformanceReportV1Schema.parse(report);
  const failures = parsed.checks.filter((check) => check.status === "failed").length;
  const cases = parsed.checks
    .map((check) => {
      const failure =
        check.status === "failed"
          ? `<failure message="${xml(check.detail)}">${xml(check.detail)}</failure>`
          : "";
      return `<testcase classname="${xml(parsed.contract)}" name="${xml(check.id)}">${failure}</testcase>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(parsed.extensionId)}" tests="${String(parsed.checks.length)}" failures="${String(failures)}">${cases}</testsuite>\n`;
}

export function writeConformanceOutputs(
  report: ConformanceReportV1,
  outputDirectory: string
): { json: string; junit: string; evidenceBundle: string } {
  const parsed = ConformanceReportV1Schema.parse(report);
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const stem = `${parsed.extensionId}-${parsed.contract}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const jsonPath = join(directory, `${stem}.json`);
  const junitPath = join(directory, `${stem}.junit.xml`);
  const evidencePath = join(directory, `${stem}.evidence.json`);
  writeFileSync(jsonPath, `${canonical(parsed)}\n`, { mode: 0o644 });
  writeFileSync(junitPath, conformanceReportToJunit(parsed), { mode: 0o644 });
  writeFileSync(evidencePath, `${canonical(buildConformanceEvidenceBundle([parsed]))}\n`, {
    mode: 0o644
  });
  return { json: jsonPath, junit: junitPath, evidenceBundle: evidencePath };
}

class ReportBuilder {
  readonly #checks: z.infer<typeof ConformanceCheckV1Schema>[] = [];

  async checkAsync(id: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
      this.#checks.push({ id, status: "passed", detail: "Passed" });
    } catch (error) {
      this.#checks.push({
        id,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  finish(
    contract: ConformanceReportV1["contract"],
    manifest: z.infer<typeof ExtensionManifestV1Schema>,
    sourceCommit: string
  ): ConformanceReportV1 {
    const unsigned = {
      schemaVersion: 1 as const,
      suiteVersion: "0.1.0" as const,
      contract,
      extensionId: manifest.id,
      extensionVersion: manifest.extensionVersion,
      sourceCommit,
      artifactDigest: manifest.artifact.sha256,
      platform: { os: process.platform, arch: process.arch, node: process.version },
      checks: this.#checks,
      passed: this.#checks.every((entry) => entry.status === "passed")
    };
    return ConformanceReportV1Schema.parse({
      ...unsigned,
      reportDigest: conformanceDigest(unsigned)
    });
  }
}

export type ConformanceContractV1 = keyof typeof CONFORMANCE_REQUIREMENTS_V1;
export interface ConformanceSubjectV1 {
  readonly manifest: ExtensionManifestV1;
  close?(): Promise<void>;
}
export interface ConformanceCaseV1 {
  id: string;
  run(extension: ConformanceSubjectV1): Promise<void>;
}

export interface ConformanceHarnessV1 {
  contract: ConformanceContractV1;
  manifest: ExtensionManifestV1;
  sourceCommit: string;
  createExtension(requirementId: string): Promise<ConformanceSubjectV1> | ConformanceSubjectV1;
  cases: readonly ConformanceCaseV1[];
}

export async function runConformanceHarness(
  rawHarness: ConformanceHarnessV1
): Promise<ConformanceReportV1> {
  const manifest = ExtensionManifestV1Schema.parse(rawHarness.manifest);
  const sourceCommit = z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .parse(rawHarness.sourceCommit);
  if (manifest.contract.name !== rawHarness.contract) {
    throw new Error("Conformance harness contract does not match the extension manifest");
  }
  const requirements = CONFORMANCE_REQUIREMENTS_V1[rawHarness.contract] as readonly string[];
  const allowed = new Set(requirements);
  const cases = new Map<string, ConformanceCaseV1>();
  for (const testCase of rawHarness.cases) {
    if (!allowed.has(testCase.id)) {
      throw new Error(`Unknown ${rawHarness.contract} conformance case: ${testCase.id}`);
    }
    if (cases.has(testCase.id)) {
      throw new Error(`Duplicate ${rawHarness.contract} conformance case: ${testCase.id}`);
    }
    cases.set(testCase.id, testCase);
  }

  const builder = new ReportBuilder();
  for (const requirement of requirements) {
    const testCase = cases.get(requirement);
    await builder.checkAsync(requirement, async () => {
      if (!testCase) throw new Error(`Missing required conformance case: ${requirement}`);
      const extension = await rawHarness.createExtension(requirement);
      const extensionManifest = ExtensionManifestV1Schema.parse(extension.manifest);
      if (
        extensionManifest.id !== manifest.id ||
        extensionManifest.extensionVersion !== manifest.extensionVersion ||
        extensionManifest.artifact.sha256 !== manifest.artifact.sha256 ||
        extensionManifest.contract.name !== rawHarness.contract
      ) {
        throw new Error("Conformance case received an extension with a mismatched identity");
      }
      try {
        await testCase.run(extension);
      } finally {
        await extension.close?.();
      }
    });
  }
  return builder.finish(rawHarness.contract, manifest, sourceCommit);
}
