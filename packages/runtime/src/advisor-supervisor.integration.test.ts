import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest, migrateDatabase, openKernel } from "@parallelplay/kernel";
import { ConformanceAdvisorDriver, type AdvisorAdapter } from "./advisor-driver.js";
import { AdvisorSupervisor } from "./advisor-supervisor.js";

const ids = {
  subject: "90000000-0000-4000-8000-000000000001",
  case: "90000000-0000-4000-8000-000000000002",
  input: "90000000-0000-4000-8000-000000000003",
  packet: "90000000-0000-4000-8000-000000000004",
  revision: "90000000-0000-4000-8000-000000000005",
  program: "90000000-0000-4000-8000-000000000006",
  option: "90000000-0000-4000-8000-000000000007",
  invocation: "90000000-0000-4000-8000-000000000008",
  supervisor: "90000000-0000-4000-8000-000000000009"
} as const;

const directories: string[] = [];
const clock = { now: () => new Date("2026-08-22T18:00:00.000Z") };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-advisor-supervisor-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  await migrateDatabase({ databasePath, clock });
  const kernel = await openKernel({ databasePath, clock });
  const subject = {
    schemaVersion: 1 as const,
    subjectId: ids.subject,
    revision: 1,
    priorSubjectRef: null,
    name: "Conformance subject",
    subjectKind: "conformance" as const,
    driverProtocolVersion: 1 as const,
    adapter: {
      adapterId: "conformance-advisor",
      adapterDigest: "1".repeat(64),
      image: `parallelplay-advisor@sha256:${"2".repeat(64)}`,
      argv: ["/advisor"]
    },
    model: null,
    systemPromptDigest: "3".repeat(64),
    taskPromptDigest: "4".repeat(64),
    responseSchemaVersion: 1 as const,
    inference: { temperature: 0, maxOutputBytes: 65_536, timeoutMs: 10_000 },
    contextCompilerVersion: "advisor-context-v1" as const,
    capabilities: {
      network: false as const,
      secrets: false as const,
      git: false as const,
      database: false as const,
      source: false as const,
      artifacts: false as const
    },
    maxInputBytes: 65_536
  };
  expect(
    await kernel.execute({
      type: "advisor-subject.approve",
      idempotencyKey: "approve-subject",
      actor: { kind: "operator", id: "advisor-test" },
      payload: { subject }
    })
  ).toMatchObject({ ok: true });
  const input = {
    schemaVersion: 1 as const,
    inputId: ids.input,
    packetId: ids.packet,
    packetRevisionRef: {
      kind: "decision_packet_revision" as const,
      id: ids.revision,
      digest: "5".repeat(64)
    },
    programId: ids.program,
    milestoneId: null,
    sourceRef: {
      kind: "operator_decision_request" as const,
      id: ids.packet,
      digest: "6".repeat(64)
    },
    originalQuestion: "Select the fixture option?",
    prompt: "Choose only when bounded.",
    context: "Contained conformance case",
    classification: {
      riskClass: "low" as const,
      safetyClass: "routine" as const,
      reversibility: "reversible" as const,
      sourceKind: "operator_decision_request",
      actionKinds: ["approve"],
      targetKinds: ["record_only"],
      promotionEligible: true,
      exclusionReasons: []
    },
    options: [
      {
        optionId: ids.option,
        label: "Record approval",
        consequences: ["Records only"],
        reversalCost: "None",
        actionKind: "approve",
        targetKind: "record_only",
        targetParameters: { kind: "record_only" as const },
        targetPreconditionDigest: "7".repeat(64)
      }
    ],
    policyRefs: [],
    precedentRefs: [],
    evidenceRefs: [],
    compiledAt: clock.now().toISOString()
  };
  expect(
    await kernel.execute({
      type: "advisor-case.record",
      idempotencyKey: "record-case",
      actor: { kind: "operator", id: "advisor-test" },
      payload: {
        case: {
          schemaVersion: 1,
          caseId: ids.case,
          input,
          inputDigest: canonicalDigest(input),
          provenance: "fixture",
          sourceFamily: "runtime-conformance",
          adversarialCategories: [],
          label: {
            selectedOptionId: ids.option,
            actionResultRef: null,
            labeledBy: "advisor-test",
            labeledAt: clock.now().toISOString()
          }
        }
      }
    })
  ).toMatchObject({ ok: true });
  expect(
    await kernel.execute({
      type: "advisor-invocation.queue",
      idempotencyKey: "queue-invocation",
      actor: { kind: "system", id: "advisor-test" },
      payload: {
        schemaVersion: 1,
        invocationId: ids.invocation,
        subjectId: ids.subject,
        purpose: "holdout",
        caseId: ids.case,
        packetId: null,
        packetRevisionId: null,
        packetRevisionDigest: null
      }
    })
  ).toMatchObject({ ok: true });
  return { kernel };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("advisor supervisor", () => {
  it("leases a contained invocation and records a digest-bound recommendation receipt", async () => {
    const { kernel } = await fixture();
    const adapter = new ConformanceAdvisorDriver({
      clock,
      select: () => ({
        kind: "recommend",
        optionId: ids.option,
        summary: "The bounded record-only option matches.",
        policyCitations: [],
        precedentCitations: [],
        evidenceCitations: []
      })
    });
    const supervisor = new AdvisorSupervisor({
      kernel,
      adapter,
      supervisorId: ids.supervisor,
      clock,
      leaseDurationMs: 1_000
    });
    try {
      expect(await supervisor.tick()).toMatchObject({ action: "invocation_acquired" });
      expect(await supervisor.tick()).toMatchObject({ action: "invocation_succeeded" });
      expect((await kernel.listAdvisorInvocations())[0]).toMatchObject({
        invocation: { status: "succeeded", fencingToken: 1 }
      });
      const invocation = (await kernel.listAdvisorInvocations())[0];
      const recommendation = (await kernel.listAdvisorRecommendations())[0];
      if (!invocation || !recommendation) throw new Error("Advisor result was not projected");
      expect(recommendation).toMatchObject({
        recommendation: {
          purpose: "holdout",
          output: { kind: "recommend", optionId: ids.option },
          driverReceipt: { inputDigest: canonicalDigest(invocation.invocation.input) }
        }
      });
      expect(await kernel.verifyProjections()).toMatchObject({
        valid: true,
        projectionSchemaVersion: 1
      });
    } finally {
      await kernel.close();
    }
  });

  it("persists a retry instead of accepting a failed adapter call", async () => {
    const { kernel } = await fixture();
    const adapter: AdvisorAdapter = {
      name: "failing-advisor",
      invoke: () => Promise.reject(new Error("transient provider failure"))
    };
    const supervisor = new AdvisorSupervisor({
      kernel,
      adapter,
      supervisorId: ids.supervisor,
      clock,
      leaseDurationMs: 1_000
    });
    try {
      expect(await supervisor.tick()).toMatchObject({ action: "invocation_acquired" });
      expect(await supervisor.tick()).toMatchObject({
        action: "invocation_retry_scheduled",
        error: "transient provider failure"
      });
      expect((await kernel.listAdvisorInvocations())[0]).toMatchObject({
        invocation: { status: "pending", attempt: 1, lastError: "transient provider failure" }
      });
      expect(await kernel.listAdvisorRecommendations()).toEqual([]);
    } finally {
      await kernel.close();
    }
  });

  it("fails closed when a syntactically valid adapter selects an unknown option", async () => {
    const { kernel } = await fixture();
    const adapter = new ConformanceAdvisorDriver({
      clock,
      select: () => ({
        kind: "recommend",
        optionId: "90000000-0000-4000-8000-000000000099",
        summary: "Forged selection",
        policyCitations: [],
        precedentCitations: [],
        evidenceCitations: []
      })
    });
    const supervisor = new AdvisorSupervisor({
      kernel,
      adapter,
      supervisorId: ids.supervisor,
      clock,
      leaseDurationMs: 1_000
    });
    try {
      expect(await supervisor.tick()).toMatchObject({ action: "invocation_acquired" });
      expect(await supervisor.tick()).toMatchObject({ action: "invocation_failed" });
      expect((await kernel.listAdvisorInvocations())[0]).toMatchObject({
        invocation: { status: "failed", lastError: "Advisor output or receipt is invalid" }
      });
      expect(await kernel.listAdvisorRecommendations()).toEqual([]);
    } finally {
      await kernel.close();
    }
  });

  it("makes cancellation durable before an adapter receives authority", async () => {
    const { kernel } = await fixture();
    try {
      expect(
        await kernel.execute({
          type: "advisor-invocation.cancel",
          idempotencyKey: "cancel-invocation",
          actor: { kind: "operator", id: "advisor-test" },
          payload: {
            schemaVersion: 1,
            invocationId: ids.invocation,
            reason: "Operator cancelled the shadow evaluation"
          }
        })
      ).toMatchObject({ ok: true });
      const supervisor = new AdvisorSupervisor({
        kernel,
        adapter: new ConformanceAdvisorDriver({ clock }),
        supervisorId: ids.supervisor,
        clock,
        leaseDurationMs: 1_000
      });
      expect(await supervisor.tick()).toMatchObject({ action: "idle" });
      expect((await kernel.listAdvisorInvocations())[0]).toMatchObject({
        invocation: { status: "cancelled", recommendationId: null }
      });
    } finally {
      await kernel.close();
    }
  });
});
