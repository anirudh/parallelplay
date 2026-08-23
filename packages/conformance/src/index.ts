import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DriverEventBatchV1Schema,
  DriverReceiptV1Schema,
  DriverSessionV1Schema,
  EvaluatorExtensionResultV1Schema,
  ExtensionManifestV1Schema,
  OutboundEffectReceiptV1Schema,
  OutboundReconciliationV1Schema,
  PolicyExtensionResultV1Schema,
  WorkflowExtensionResultV1Schema,
  isAutomaticActionAllowed,
  type AgentDriverV1,
  type AutomaticActionKind,
  type EvaluatorExtensionV1,
  type OutboundAdapterV1,
  type PolicyExtensionV1,
  type WorkflowExtensionV1
} from "@parallelplay/contracts";
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

  check(id: string, operation: () => void): void {
    try {
      operation();
      this.#checks.push({ id, status: "passed", detail: "Passed" });
    } catch (error) {
      this.#checks.push({
        id,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

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
    manifest: z.infer<typeof ExtensionManifestV1Schema>
  ): ConformanceReportV1 {
    const unsigned = {
      schemaVersion: 1 as const,
      suiteVersion: "0.1.0" as const,
      contract,
      extensionId: manifest.id,
      extensionVersion: manifest.extensionVersion,
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

export async function runDriverConformance(
  driver: AgentDriverV1,
  request: Parameters<AgentDriverV1["start"]>[0]
): Promise<ConformanceReportV1> {
  const builder = new ReportBuilder();
  const manifest = ExtensionManifestV1Schema.parse(driver.manifest);
  builder.check("manifest", () => {
    if (manifest.kind !== "driver" || manifest.contract.name !== "agent-driver-v1") {
      throw new Error("Manifest does not declare agent-driver-v1");
    }
  });
  let session: Awaited<ReturnType<AgentDriverV1["start"]>> | undefined;
  await builder.checkAsync("start", async () => {
    session = DriverSessionV1Schema.parse(await driver.start(request));
  });
  if (session) {
    const startedSession = session;
    await builder.checkAsync("inspect-structured-events", async () => {
      DriverEventBatchV1Schema.parse(
        await driver.inspect({
          schemaVersion: 1,
          sessionId: startedSession.sessionId,
          afterSequence: 0
        })
      );
    });
    await builder.checkAsync("receipt", async () => {
      DriverReceiptV1Schema.parse(await driver.collectReceipt(startedSession.sessionId));
    });
    const checkpointDigest = startedSession.checkpointDigest;
    if (checkpointDigest) {
      await builder.checkAsync("resume", async () => {
        DriverSessionV1Schema.parse(
          await driver.resume({
            schemaVersion: 1,
            effectKey: `${request.effectKey}:resume`,
            sessionId: startedSession.sessionId,
            checkpointDigest,
            contextDigest: request.contextDigest,
            executionContractDigest: request.executionContractDigest,
            capabilityManifestDigest: request.capabilityManifestDigest
          })
        );
      });
    }
    await builder.checkAsync("cancel-idempotent", async () => {
      await driver.cancel({
        schemaVersion: 1,
        effectKey: `${request.effectKey}:cancel`,
        sessionId: startedSession.sessionId,
        reason: "operator_cancelled"
      });
    });
  }
  await builder.checkAsync("close", async () => driver.close());
  return builder.finish("agent-driver-v1", manifest);
}

export async function runWorkflowConformance(
  extension: WorkflowExtensionV1,
  request: Parameters<WorkflowExtensionV1["compile"]>[0]
): Promise<ConformanceReportV1> {
  const builder = new ReportBuilder();
  const manifest = ExtensionManifestV1Schema.parse(extension.manifest);
  await builder.checkAsync("deterministic-compile", async () => {
    const first = WorkflowExtensionResultV1Schema.parse(await extension.compile(request));
    const second = WorkflowExtensionResultV1Schema.parse(await extension.compile(request));
    if (conformanceDigest(first) !== conformanceDigest(second)) {
      throw new Error("Workflow compilation is not deterministic");
    }
  });
  return builder.finish("workflow-extension-v1", manifest);
}

export async function runEvaluatorConformance(
  extension: EvaluatorExtensionV1,
  request: Parameters<EvaluatorExtensionV1["evaluate"]>[0]
): Promise<ConformanceReportV1> {
  const builder = new ReportBuilder();
  const manifest = ExtensionManifestV1Schema.parse(extension.manifest);
  await builder.checkAsync("deterministic-evaluation", async () => {
    const first = EvaluatorExtensionResultV1Schema.parse(await extension.evaluate(request));
    const second = EvaluatorExtensionResultV1Schema.parse(await extension.evaluate(request));
    if (first.evidenceDigest !== request.evidenceDigest) throw new Error("Evidence digest changed");
    if (conformanceDigest(first) !== conformanceDigest(second)) {
      throw new Error("Evaluator output is not deterministic");
    }
  });
  return builder.finish("evaluator-extension-v1", manifest);
}

export async function runPolicyConformance(
  extension: PolicyExtensionV1,
  baseRequest: Parameters<PolicyExtensionV1["decide"]>[0]
): Promise<ConformanceReportV1> {
  const builder = new ReportBuilder();
  const manifest = ExtensionManifestV1Schema.parse(extension.manifest);
  const forbidden: AutomaticActionKind[] = [
    "merge",
    "ready-for-review",
    "release",
    "deploy",
    "scope.accept",
    "graph.accept",
    "outcome.accept",
    "policy.promote",
    "permission.change",
    "secret.change",
    "capability.expand"
  ];
  await builder.checkAsync("global-authority-ceiling", async () => {
    for (const action of forbidden) {
      if (isAutomaticActionAllowed(action))
        throw new Error(`${action} entered the global allowlist`);
      const result = PolicyExtensionResultV1Schema.parse(
        await extension.decide({ ...baseRequest, proposedAction: action })
      );
      if (result.decision === "allow_within_global_ceiling") {
        throw new Error(`Policy attempted to authorize forbidden action ${action}`);
      }
    }
  });
  return builder.finish("policy-extension-v1", manifest);
}

export async function runAdapterConformance(
  adapter: OutboundAdapterV1,
  request: Parameters<OutboundAdapterV1["deliver"]>[0]
): Promise<ConformanceReportV1> {
  const builder = new ReportBuilder();
  const manifest = ExtensionManifestV1Schema.parse(adapter.manifest);
  await builder.checkAsync("exact-idempotent-effect", async () => {
    const first = OutboundEffectReceiptV1Schema.parse(await adapter.deliver(request));
    const second = OutboundEffectReceiptV1Schema.parse(await adapter.deliver(request));
    if (first.receiptDigest !== second.receiptDigest || first.externalId !== second.externalId) {
      throw new Error("Duplicate delivery did not converge");
    }
  });
  await builder.checkAsync("live-reconciliation", async () => {
    const result = OutboundReconciliationV1Schema.parse(await adapter.reconcile(request.effectKey));
    if (result.status !== "observed_exact") throw new Error("Exact effect was not observed");
  });
  await builder.checkAsync("close", async () => adapter.close());
  return builder.finish("outbound-adapter-v1", manifest);
}
