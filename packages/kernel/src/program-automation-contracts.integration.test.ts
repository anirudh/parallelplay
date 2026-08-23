import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandResult } from "./api.js";
import { canonicalDigest } from "./canonical.js";
import { migrateDatabase } from "./database.js";
import type { Clock, IdGenerator } from "./database.js";
import {
  artifactManifestDigest,
  driverReceiptDigest,
  receiptIdentity,
  sourceRevisionDigest,
  verificationReceiptDigest,
  verificationResultDigest
} from "./evidence.js";
import type { Kernel } from "./sqlite-kernel.js";
import { openKernelForTesting } from "./sqlite-kernel.js";
import { CommandSchema, DriverReceiptV2Schema } from "./schema.js";
import type {
  MilestoneGenerationState,
  ProgramGraphRevisionV1,
  SourceRevisionState
} from "./schema.js";

const operator = { kind: "operator", id: "program-operator" } as const;
const system = { kind: "system", id: "70000000-0000-4000-8000-000000000099" } as const;
const image = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];

function uuid(value: number): string {
  return `70000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

class MutableClock implements Clock {
  #value = new Date("2026-08-21T12:00:00.000Z");

  now(): Date {
    return new Date(this.#value);
  }

  advance(milliseconds: number): void {
    this.#value = new Date(this.#value.getTime() + milliseconds);
  }
}

class SequenceIds implements IdGenerator {
  #next = 8_000;

  next(): string {
    const value = uuid(this.#next);
    this.#next += 1;
    return value;
  }
}

interface ProgramFixture {
  kernel: Kernel;
  clock: MutableClock;
  programId: string;
  graph: ProgramGraphRevisionV1;
  graphDigest: string;
  milestoneIds: string[];
  initialRevision: SourceRevisionState;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function expectAccepted(
  result: CommandResult
): asserts result is Extract<CommandResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`
    );
  }
  expect(result).toMatchObject({ ok: true, replayed: false });
}

async function execute(
  kernel: Kernel,
  type: string,
  payload: unknown,
  idempotencyKey: string,
  actor: typeof operator | typeof system = operator
): Promise<CommandResult> {
  return kernel.execute({ type, payload, idempotencyKey, actor });
}

function sourceRevision(revisionId: string, digit: string): SourceRevisionState {
  const identity = {
    repositoryId: uuid(2),
    objectFormat: "sha1" as const,
    commitOid: digit.repeat(40),
    treeOid: (digit === "f" ? "e" : "f").repeat(40)
  };
  return {
    kind: "source_revision",
    revisionId,
    ...identity,
    storageRef: `refs/parallelplay/revisions/${revisionId}`,
    revisionDigest: sourceRevisionDigest(identity),
    capturedAt: "2026-08-21T12:00:00.000Z",
    version: 1
  };
}

function workflow(workflowId: string, stepId: string) {
  return {
    schemaVersion: 3 as const,
    workflowId,
    version: 1,
    name: `Workflow ${stepId}`,
    steps: [
      {
        id: stepId,
        capability: "implementation",
        dependsOn: [],
        execution: {
          protocolVersion: 2 as const,
          image,
          argv: ["/bin/sh", "/fixture/success-v2.sh"],
          workingDirectory: "/workspace" as const,
          context: { target: "/context/context.json" as const }
        },
        capabilities: {
          schemaVersion: 2 as const,
          workspace: "read_write" as const,
          artifactOutput: "read_write" as const,
          scratch: "read_write" as const,
          context: { access: "read_only" as const },
          cpuLimit: 1,
          memoryLimitBytes: 268_435_456,
          pidsLimit: 64,
          network: [] as [],
          secrets: [] as [],
          git: [] as []
        },
        verification: {
          mode: "verify" as const,
          argv: ["./verify.sh"],
          cwd: "." as const,
          timeoutMs: 1_000,
          environment: {},
          toolProbes: []
        }
      }
    ]
  };
}

async function prepareStartedProgram(startAttention = true): Promise<ProgramFixture> {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-program-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  const clock = new MutableClock();
  await migrateDatabase({ databasePath, clock });
  const kernel = openKernelForTesting({ databasePath, clock, idGenerator: new SequenceIds() });
  const programId = uuid(1);
  const initialRevision = sourceRevision(uuid(3), "1");
  expectAccepted(
    await execute(
      kernel,
      "source-revision.register",
      {
        revisionId: initialRevision.revisionId,
        repositoryId: initialRevision.repositoryId,
        objectFormat: initialRevision.objectFormat,
        commitOid: initialRevision.commitOid,
        treeOid: initialRevision.treeOid,
        storageRef: initialRevision.storageRef,
        revisionDigest: initialRevision.revisionDigest
      },
      "source-initial"
    )
  );
  const workflowIds = [uuid(10), uuid(11), uuid(12)];
  const milestoneIds = [uuid(20), uuid(21), uuid(22)];
  for (const [index, workflowId] of workflowIds.entries()) {
    const definition = workflow(workflowId, `step-${String(index + 1)}`);
    const parsed = CommandSchema.safeParse({
      type: "workflow.register",
      idempotencyKey: `workflow-${String(index + 1)}`,
      actor: operator,
      payload: definition
    });
    if (!parsed.success) throw new Error(parsed.error.message);
    expectAccepted(
      await execute(kernel, "workflow.register", definition, `workflow-${String(index + 1)}`)
    );
  }
  expectAccepted(
    await execute(
      kernel,
      "program.kickoff",
      {
        schemaVersion: 1,
        programId,
        name: "program serial program",
        initialSourceRevisionId: initialRevision.revisionId,
        initialSourceRevisionDigest: initialRevision.revisionDigest
      },
      "kickoff"
    )
  );
  const transcript = [
    ["objective", "Deliver a reconstructable serial program."],
    ["desired_behaviors", "Advance only after validated evidence."],
    ["non_goals", "No merge authority."],
    ["edge_cases", "Restarts and stale commands."],
    ["ownership_boundaries", "The operator owns graph approval."],
    ["success_measures", "Three verified candidate revisions."],
    ["risk_tolerance", "normal"],
    ["tenets", "Replay; evidence; least authority."]
  ].map(([questionId, answer]) => ({
    questionId: questionId ?? "missing",
    question: `Question ${questionId ?? "missing"}`,
    answer: answer ?? "missing"
  }));
  expectAccepted(
    await execute(
      kernel,
      "interview.capture",
      {
        schemaVersion: 1,
        interviewId: uuid(30),
        playbackId: uuid(31),
        programId,
        transcript,
        answers: {
          objective: "Deliver a reconstructable serial program.",
          desiredBehaviors: ["Advance only after validated evidence."],
          nonGoals: ["No merge authority."],
          edgeCases: ["Restarts and stale commands."],
          ownershipBoundaries: ["The operator owns graph approval."],
          successMeasures: ["Three verified candidate revisions."],
          riskTolerance: "normal",
          tenets: ["Replay", "Evidence", "Least authority"]
        }
      },
      "interview"
    )
  );
  const interview = (await kernel.listProgramInterviews(programId))[0];
  if (!interview) throw new Error("missing interview playback");
  const graph: ProgramGraphRevisionV1 = {
    schemaVersion: 1,
    graphRevisionId: uuid(40),
    programId,
    revision: 1,
    priorGraphRef: null,
    intentPlaybackRef: {
      kind: "intent_playback",
      id: interview.playback.playbackId,
      digest: interview.playbackDigest
    },
    initialSourceRef: {
      kind: "source_revision",
      id: initialRevision.revisionId,
      digest: initialRevision.revisionDigest
    },
    milestones: milestoneIds.map((milestoneId, index) => ({
      contract: {
        schemaVersion: 1,
        milestoneId,
        title: `Milestone ${String(index + 1)}`,
        objective: `Produce serial candidate ${String(index + 1)}.`,
        taskType: "feature",
        priority: "p1",
        tags: ["program"],
        workflowId: workflowIds[index] ?? workflowIds[0] ?? uuid(10),
        workflowVersion: 1,
        criteria: [
          {
            criterionId: `criterion-${String(index + 1)}`,
            statement: `Candidate ${String(index + 1)} passes verification.`,
            verificationStepId: `step-${String(index + 1)}`
          }
        ]
      },
      dependencies: index === 0 ? [] : [milestoneIds[index - 1] ?? milestoneIds[0] ?? uuid(20)],
      sourcePredecessorMilestoneId:
        index === 0 ? null : (milestoneIds[index - 1] ?? milestoneIds[0] ?? uuid(20)),
      allowedWorkSurfaces: ["README.md"],
      refs: []
    })),
    initialContext: {
      decisions: [
        {
          entryId: uuid(50),
          scope: { kind: "program" },
          text: "Use one serial source lineage.",
          refs: []
        }
      ],
      assumptions: [],
      risks: [],
      unresolvedQuestions: [],
      refs: [
        {
          kind: "source_revision",
          id: initialRevision.revisionId,
          digest: initialRevision.revisionDigest
        }
      ]
    }
  };
  expect(
    await execute(kernel, "program-graph.approve", graph, "graph-system", system)
  ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRES_OPERATOR" } });
  expectAccepted(await execute(kernel, "program-graph.approve", graph, "graph-approve"));
  const graphState = await kernel.getState({ kind: "program_graph", id: graph.graphRevisionId });
  if (graphState?.kind !== "program_graph") throw new Error("missing graph state");
  expect(
    await execute(
      kernel,
      "milestone.start",
      {
        schemaVersion: 1,
        milestoneId: milestoneIds[0] ?? uuid(20),
        runId: uuid(61),
        jobId: uuid(62),
        sourceRevisionId: initialRevision.revisionId,
        policy: { maxAttempts: 1, attemptTimeoutMs: 60_000, retryDelaysMs: [] }
      },
      "manual-graph-milestone-start"
    )
  ).toMatchObject({ ok: false, error: { code: "MILESTONE_NOT_STARTABLE" } });
  if (startAttention) {
    expectAccepted(
      await execute(
        kernel,
        "attention.start",
        { schemaVersion: 1, attentionSpanId: uuid(60), programId, label: "Pilot oversight" },
        "attention-start"
      )
    );
  }
  expectAccepted(
    await execute(
      kernel,
      "program.start",
      {
        schemaVersion: 1,
        programId,
        graphRevisionId: graph.graphRevisionId,
        graphDigest: graphState.graphDigest,
        policy: { maxAttempts: 1, attemptTimeoutMs: 60_000, retryDelaysMs: [] }
      },
      "program-start"
    )
  );
  return {
    kernel,
    clock,
    programId,
    graph,
    graphDigest: graphState.graphDigest,
    milestoneIds,
    initialRevision
  };
}

async function completeGeneration(
  fixture: ProgramFixture,
  generation: MilestoneGenerationState,
  ordinal: number
): Promise<{ candidate: SourceRevisionState; outcomePacketId: string }> {
  const { kernel } = fixture;
  const job = await kernel.getState({ kind: "job", id: generation.jobId });
  const context = await kernel.getState({ kind: "context_packet", id: generation.contextPacketId });
  const base = await kernel.getState({ kind: "source_revision", id: generation.baseRevisionId });
  if (
    job?.kind !== "job" ||
    context?.kind !== "context_packet" ||
    base?.kind !== "source_revision"
  ) {
    throw new Error("generation authority is incomplete");
  }
  const attemptId = uuid(100 + ordinal * 20);
  const startOutboxId = uuid(101 + ordinal * 20);
  expectAccepted(
    await execute(
      kernel,
      "job.lease.acquire",
      {
        jobId: job.jobId,
        ownerId: system.id,
        leaseDurationMs: 30_000,
        attemptId,
        startOutboxId
      },
      `job-acquire-${String(ordinal)}`,
      system
    )
  );
  expectAccepted(
    await execute(
      kernel,
      "outbox.lease.acquire",
      { outboxId: startOutboxId, ownerId: system.id, leaseDurationMs: 10_000 },
      `start-outbox-acquire-${String(ordinal)}`,
      system
    )
  );
  const externalRunId = `docker:program-${String(ordinal)}`;
  expectAccepted(
    await execute(
      kernel,
      "outbox.delivery.succeed",
      {
        outboxId: startOutboxId,
        ownerId: system.id,
        fencingToken: 1,
        externalEffectId: externalRunId
      },
      `start-outbox-deliver-${String(ordinal)}`,
      system
    )
  );
  const driverEvents = [
    { schemaVersion: 2 as const, sequence: 1, type: "started" as const },
    {
      schemaVersion: 2 as const,
      sequence: 2,
      type: "usage" as const,
      cpuMillis: 100 * ordinal,
      memoryPeakBytes: 1_000 * ordinal
    },
    {
      schemaVersion: 2 as const,
      sequence: 3,
      type: "terminal" as const,
      outcome: "succeeded" as const
    }
  ];
  expectAccepted(
    await execute(
      kernel,
      "attempt.driver-events.observe",
      {
        jobId: job.jobId,
        attemptId,
        ownerId: system.id,
        fencingToken: 1,
        afterSequence: 0,
        events: driverEvents
      },
      `events-${String(ordinal)}`,
      system
    )
  );
  const candidate = sourceRevision(uuid(107 + ordinal * 20), String(ordinal + 1));
  const receiptWithoutDigest = {
    schemaVersion: 2 as const,
    driver: "trusted-cost-adapter-v1",
    driverVersion: "program-test",
    protocolVersion: 2 as const,
    runId: generation.runId,
    jobId: job.jobId,
    attemptId,
    externalRunId,
    image: job.executionContract?.image ?? image,
    baseRevisionId: base.revisionId,
    baseRevisionDigest: base.revisionDigest,
    candidateRevisionId: candidate.revisionId,
    candidateRevisionDigest: candidate.revisionDigest,
    executionContractDigest: job.executionContractDigest ?? "",
    capabilityManifestDigest: job.capabilityManifestDigest ?? "",
    contextPacketId: context.contextPacketId,
    contextPacketDigest: context.packetDigest,
    eventStreamDigest: canonicalDigest(driverEvents),
    eventCount: driverEvents.length,
    usage: {
      cpuMillis: 100 * ordinal,
      memoryPeakBytes: 1_000 * ordinal,
      monetaryCost: {
        status: "known" as const,
        amount: String(ordinal),
        currency: ordinal === 2 ? "EUR" : "USD",
        pricingSource: "program-test-pricing",
        pricingVersion: "v1"
      }
    },
    approvals: [],
    capabilitiesUsed: [],
    artifacts: [],
    outcome: "succeeded" as const,
    terminalReason: "completed",
    receiptDigest: "0".repeat(64)
  };
  const receipt = DriverReceiptV2Schema.parse({
    ...receiptWithoutDigest,
    receiptDigest: driverReceiptDigest(receiptWithoutDigest)
  });
  const verificationId = uuid(104 + ordinal * 20);
  const verificationOutboxId = uuid(105 + ordinal * 20);
  if (ordinal === 1) {
    const tampered = DriverReceiptV2Schema.parse({
      ...receipt,
      contextPacketDigest: "b".repeat(64),
      receiptDigest: driverReceiptDigest({
        ...receipt,
        contextPacketDigest: "b".repeat(64)
      })
    });
    expect(
      await execute(
        kernel,
        "driver.receipt.record",
        {
          driverReceiptId: uuid(199),
          artifactManifestId: uuid(198),
          verificationId: uuid(197),
          verificationOutboxId: uuid(196),
          jobId: job.jobId,
          attemptId,
          ownerId: system.id,
          fencingToken: 1,
          receipt: tampered,
          candidateRevision: {
            revisionId: candidate.revisionId,
            repositoryId: candidate.repositoryId,
            objectFormat: candidate.objectFormat,
            commitOid: candidate.commitOid,
            treeOid: candidate.treeOid,
            storageRef: candidate.storageRef,
            revisionDigest: candidate.revisionDigest
          },
          entries: []
        },
        "tampered-context-receipt",
        system
      )
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_DIGEST_MISMATCH" } });
  }
  expectAccepted(
    await execute(
      kernel,
      "driver.receipt.record",
      {
        driverReceiptId: uuid(102 + ordinal * 20),
        artifactManifestId: uuid(103 + ordinal * 20),
        verificationId,
        verificationOutboxId,
        jobId: job.jobId,
        attemptId,
        ownerId: system.id,
        fencingToken: 1,
        receipt,
        candidateRevision: {
          revisionId: candidate.revisionId,
          repositoryId: candidate.repositoryId,
          objectFormat: candidate.objectFormat,
          commitOid: candidate.commitOid,
          treeOid: candidate.treeOid,
          storageRef: candidate.storageRef,
          revisionDigest: candidate.revisionDigest
        },
        entries: []
      },
      `receipt-${String(ordinal)}`,
      system
    )
  );
  expectAccepted(
    await execute(
      kernel,
      "outbox.lease.acquire",
      { outboxId: verificationOutboxId, ownerId: system.id, leaseDurationMs: 10_000 },
      `verification-outbox-${String(ordinal)}`,
      system
    )
  );
  const verification = await kernel.getState({ kind: "verification", id: verificationId });
  if (verification?.kind !== "verification") throw new Error("missing verification authority");
  const verificationManifestId = uuid(106 + ordinal * 20);
  const entries: [] = [];
  const manifestDigest = artifactManifestDigest(entries);
  const cleanDigest = createHash("sha256").update("").digest("hex");
  const environmentDigest = canonicalDigest({ verifier: ordinal });
  const result = {
    outcome: "passed" as const,
    exitCode: 0,
    failureReason: null,
    environmentDigest,
    sourceStatusBeforeDigest: cleanDigest,
    sourceStatusAfterDigest: cleanDigest,
    contractDigestBefore: environmentDigest,
    contractDigestAfter: environmentDigest,
    artifactManifestDigest: manifestDigest
  };
  const resultDigest = verificationResultDigest(result);
  const verificationDigest = verificationReceiptDigest(
    receiptIdentity(verification, verificationManifestId, manifestDigest, resultDigest)
  );
  expectAccepted(
    await execute(
      kernel,
      "verification.complete",
      {
        verificationId,
        outboxId: verificationOutboxId,
        artifactManifestId: verificationManifestId,
        jobId: job.jobId,
        attemptId,
        ownerId: system.id,
        jobFencingToken: 1,
        outboxFencingToken: 1,
        result,
        resultDigest,
        receiptDigest: verificationDigest,
        entries
      },
      `verification-complete-${String(ordinal)}`,
      system
    )
  );
  const finished = await kernel.getState({
    kind: "milestone_generation",
    id: generation.generationId
  });
  if (finished?.kind !== "milestone_generation" || !finished.outcomePacketId) {
    throw new Error("generation did not derive an outcome packet");
  }
  expect(await kernel.verifyOutcomePacket(finished.outcomePacketId)).toMatchObject({
    valid: true,
    failures: []
  });
  return { candidate, outcomePacketId: finished.outcomePacketId };
}

describe("program program graph authority", () => {
  it("forms, serially advances, validates lineage, and compiles a complete report", async () => {
    const fixture = await prepareStartedProgram();
    const { kernel, clock, milestoneIds, programId } = fixture;
    try {
      expect(await kernel.advanceProgram(programId)).toBeNull();
      const outcomeIds: string[] = [];
      let expectedBase = fixture.initialRevision.revisionId;
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        const generation = (await kernel.listMilestoneGenerations(programId)).find(
          (candidate) => candidate.status === "running"
        );
        if (!generation) throw new Error("missing active generation");
        expect(generation).toMatchObject({
          milestoneId: milestoneIds[ordinal - 1],
          generation: 1,
          baseRevisionId: expectedBase
        });
        const context = await kernel.getState({
          kind: "context_packet",
          id: generation.contextPacketId
        });
        const job = await kernel.getState({ kind: "job", id: generation.jobId });
        expect(context).toMatchObject({
          kind: "context_packet",
          packet: {
            graphRevisionRef: { id: fixture.graph.graphRevisionId, digest: fixture.graphDigest },
            sourceRevisionRef: { id: expectedBase },
            dependencyOutcomeRefs: ordinal === 1 ? [] : [{ id: outcomeIds[ordinal - 2] }]
          }
        });
        expect(job).toMatchObject({
          kind: "job",
          contextPacketId: generation.contextPacketId,
          executionContract: {
            protocolVersion: 2,
            context: { contextPacketId: generation.contextPacketId }
          },
          capabilityManifest: {
            schemaVersion: 2,
            context: { access: "read_only", contextPacketId: generation.contextPacketId }
          }
        });
        const completed = await completeGeneration(fixture, generation, ordinal);
        outcomeIds.push(completed.outcomePacketId);
        expectedBase = completed.candidate.revisionId;
        clock.advance(1_000);
        const advanced = await kernel.advanceProgram(programId, {
          maxAttempts: 1,
          attemptTimeoutMs: 60_000,
          retryDelaysMs: []
        });
        expect(advanced).toMatchObject({ ok: true });
      }
      expect(await kernel.getState({ kind: "program", id: programId })).toMatchObject({
        kind: "program",
        phase: "completed"
      });
      for (const [index, outcomePacketId] of outcomeIds.entries()) {
        expectAccepted(
          await execute(
            kernel,
            "outcome-packet.disposition",
            {
              schemaVersion: 1,
              outcomePacketId,
              disposition: "accepted",
              reason: `Accepted milestone ${String(index + 1)}`
            },
            `disposition-${String(index + 1)}`
          )
        );
      }
      clock.advance(2_000);
      expectAccepted(
        await execute(
          kernel,
          "attention.stop",
          { schemaVersion: 1, attentionSpanId: uuid(60) },
          "attention-stop"
        )
      );
      const events = await kernel.listEvents({ limit: 1_000 });
      expectAccepted(
        await execute(
          kernel,
          "measurement-report.compile",
          {
            schemaVersion: 1,
            reportId: uuid(61),
            programId,
            expectedThroughPosition: events.events.at(-1)?.globalPosition ?? 0
          },
          "report"
        )
      );
      const reportState = await kernel.getState({ kind: "measurement_report", id: uuid(61) });
      expect(reportState).toMatchObject({
        kind: "measurement_report",
        report: {
          observationWindow: { status: "complete" },
          activeHumanTime: { status: "available", closedSpanCount: 1 },
          resources: { status: "available", receiptCount: 3 },
          monetaryCost: {
            status: "unavailable",
            reasons: ["mixed_currency"]
          },
          quality: { passedCriteria: 3, totalCriteria: 3, acceptedOutcomes: 3 },
          completeness: {
            attention: true,
            resources: true,
            cost: false,
            quality: true,
            window: true
          }
        }
      });
      if (reportState?.kind !== "measurement_report") throw new Error("missing report state");
      expect(reportState.report.monetaryCost).toMatchObject({ status: "unavailable" });
      if (reportState.report.monetaryCost.status !== "unavailable") {
        throw new Error("mixed cost should be unavailable");
      }
      expect(reportState.report.monetaryCost.knownLineItems.map((line) => line.currency)).toEqual(
        expect.arrayContaining(["USD", "EUR"])
      );
      expect(await kernel.verifyProjections()).toMatchObject({
        valid: true,
        projectionSchemaVersion: 1
      });
      expect(await kernel.rebuildProjections()).toMatchObject({ projectionSchemaVersion: 1 });
      expect(await kernel.verifyProjections()).toMatchObject({ valid: true });
    } finally {
      await kernel.close();
    }
  });

  it("routes scoped issues without granting new authority and retries an unchanged contract", async () => {
    const fixture = await prepareStartedProgram();
    const { kernel, programId, milestoneIds } = fixture;
    try {
      const [firstMilestoneId, secondMilestoneId, thirdMilestoneId] = milestoneIds;
      if (!firstMilestoneId || !secondMilestoneId || !thirdMilestoneId) {
        throw new Error("three milestone IDs are required");
      }
      expectAccepted(
        await execute(
          kernel,
          "issue.raise",
          {
            schemaVersion: 1,
            issueId: uuid(70),
            programId,
            originalText: "Consider a later dashboard idea exactly as written.",
            proposedClass: "new_idea",
            resultImpact: "none",
            affectedMilestoneIds: [secondMilestoneId],
            refs: []
          },
          "issue-new-idea"
        )
      );
      expect(await kernel.getState({ kind: "routed_issue", id: uuid(70) })).toMatchObject({
        issue: {
          route: "record_only",
          originalText: "Consider a later dashboard idea exactly as written."
        }
      });
      expectAccepted(
        await execute(
          kernel,
          "issue.raise",
          {
            schemaVersion: 1,
            issueId: uuid(71),
            programId,
            originalText: "The accepted lineage conflicts with milestone two.",
            proposedClass: "contradiction",
            resultImpact: "may_change_accepted_result",
            affectedMilestoneIds: [secondMilestoneId],
            refs: []
          },
          "issue-contradiction"
        )
      );
      expect(await kernel.getState({ kind: "milestone", id: firstMilestoneId })).toMatchObject({
        status: "running"
      });
      expect(await kernel.getState({ kind: "milestone", id: secondMilestoneId })).toMatchObject({
        status: "paused",
        pauseReason: uuid(71)
      });
      expect(await kernel.getState({ kind: "milestone", id: thirdMilestoneId })).toMatchObject({
        status: "paused",
        pauseReason: uuid(71)
      });
      expect(await kernel.advanceProgram(programId)).toBeNull();
      expectAccepted(
        await execute(
          kernel,
          "issue.resolve",
          {
            schemaVersion: 1,
            issueId: uuid(71),
            action: "resume_unchanged_contract",
            text: "The accepted contract remains unchanged."
          },
          "issue-resolve"
        )
      );
      expect(await kernel.getState({ kind: "milestone", id: secondMilestoneId })).toMatchObject({
        status: "approved",
        pauseReason: null
      });
      expect(await kernel.getState({ kind: "routed_issue", id: uuid(70) })).toMatchObject({
        issue: { status: "open", route: "record_only" }
      });
      expectAccepted(
        await execute(
          kernel,
          "issue.raise",
          {
            schemaVersion: 1,
            issueId: uuid(72),
            programId,
            originalText: "Clarify whether the accepted root result may change.",
            proposedClass: "clarification",
            resultImpact: "may_change_accepted_result",
            affectedMilestoneIds: [firstMilestoneId],
            refs: []
          },
          "issue-active-clarification"
        )
      );
      expect(await kernel.getState({ kind: "milestone", id: firstMilestoneId })).toMatchObject({
        status: "paused",
        generation: 1,
        recommendation: "investigate",
        pauseReason: uuid(72)
      });
      expect(await kernel.advanceProgram(programId)).toBeNull();
      expectAccepted(
        await execute(
          kernel,
          "issue.resolve",
          {
            schemaVersion: 1,
            issueId: uuid(72),
            action: "resume_unchanged_contract",
            text: "The accepted root contract is unchanged."
          },
          "issue-active-resolve"
        )
      );
      expect(
        await kernel.advanceProgram(programId, {
          maxAttempts: 1,
          attemptTimeoutMs: 60_000,
          retryDelaysMs: []
        })
      ).toMatchObject({ ok: true, data: { kind: "run" } });
      expect(
        (await kernel.listMilestoneGenerations(programId)).filter(
          (generation) => generation.milestoneId === firstMilestoneId
        )
      ).toEqual([
        expect.objectContaining({ generation: 1, status: "paused", recommendation: "investigate" }),
        expect.objectContaining({ generation: 2, status: "running" })
      ]);
      expectAccepted(
        await execute(
          kernel,
          "issue.raise",
          {
            schemaVersion: 1,
            issueId: uuid(73),
            programId,
            originalText: "The requested scope crosses an operator authority boundary.",
            proposedClass: "authority_boundary",
            resultImpact: "may_change_accepted_result",
            affectedMilestoneIds: [firstMilestoneId],
            refs: []
          },
          "issue-authority-boundary"
        )
      );
      expectAccepted(
        await execute(
          kernel,
          "issue.resolve",
          {
            schemaVersion: 1,
            issueId: uuid(73),
            action: "requires_graph_revision",
            text: "A replacement graph must carry the changed scope."
          },
          "issue-requires-graph"
        )
      );
      expect(await kernel.advanceProgram(programId)).toBeNull();
      const replacementMilestoneIds = [uuid(81), uuid(82), uuid(83)];
      const replacementGraph: ProgramGraphRevisionV1 = {
        ...fixture.graph,
        graphRevisionId: uuid(84),
        revision: 2,
        priorGraphRef: {
          kind: "program_graph",
          id: fixture.graph.graphRevisionId,
          digest: fixture.graphDigest
        },
        milestones: fixture.graph.milestones.map((node, index) => {
          const milestoneId = replacementMilestoneIds[index];
          let predecessor: string | null = null;
          if (index > 0) predecessor = replacementMilestoneIds[index - 1] ?? null;
          if (!milestoneId || (index > 0 && predecessor === null)) {
            throw new Error("replacement milestone identity is missing");
          }
          return {
            ...node,
            contract: {
              ...node.contract,
              milestoneId,
              title: `${node.contract.title} replacement`
            },
            dependencies: predecessor ? [predecessor] : [],
            sourcePredecessorMilestoneId: predecessor
          };
        })
      };
      expectAccepted(
        await execute(kernel, "program-graph.approve", replacementGraph, "replacement-graph")
      );
      expect(await kernel.getState({ kind: "routed_issue", id: uuid(73) })).toMatchObject({
        issue: {
          status: "resolved",
          resolution: { satisfiedByGraphRevisionId: replacementGraph.graphRevisionId }
        }
      });
      expect(
        await kernel.advanceProgram(programId, {
          maxAttempts: 1,
          attemptTimeoutMs: 60_000,
          retryDelaysMs: []
        })
      ).toMatchObject({ ok: true, data: { kind: "run" } });
      expect(
        await kernel.getState({ kind: "milestone", id: replacementMilestoneIds[0] ?? "" })
      ).toMatchObject({ status: "running", generation: 1 });
    } finally {
      await kernel.close();
    }
  });

  it("rejects cyclic and branching source graphs before authority is appended", async () => {
    const fixture = await prepareStartedProgram();
    const { kernel, graph } = fixture;
    try {
      const invalid = {
        ...graph,
        graphRevisionId: uuid(80),
        revision: 2,
        priorGraphRef: {
          kind: "program_graph",
          id: graph.graphRevisionId,
          digest: fixture.graphDigest
        },
        milestones: graph.milestones.map((node, index) =>
          index === 0
            ? {
                ...node,
                dependencies: [graph.milestones[1]?.contract.milestoneId],
                sourcePredecessorMilestoneId: graph.milestones[1]?.contract.milestoneId
              }
            : node
        )
      };
      expect(
        await execute(kernel, "program-graph.approve", invalid, "invalid-graph")
      ).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" }
      });
      expect(await kernel.getState({ kind: "program_graph", id: uuid(80) })).toBeNull();
    } finally {
      await kernel.close();
    }
  });

  it("routes structured Protocol V2 issue events with deterministic immutable identity", async () => {
    const fixture = await prepareStartedProgram();
    const { kernel, programId, milestoneIds } = fixture;
    try {
      const generation = (await kernel.listMilestoneGenerations(programId))[0];
      const firstMilestoneId = milestoneIds[0];
      const secondMilestoneId = milestoneIds[1];
      if (!generation || !firstMilestoneId || !secondMilestoneId) {
        throw new Error("active pilot generation is missing");
      }
      const attemptId = uuid(300);
      const outboxId = uuid(301);
      expectAccepted(
        await execute(
          kernel,
          "job.lease.acquire",
          {
            jobId: generation.jobId,
            ownerId: system.id,
            leaseDurationMs: 30_000,
            attemptId,
            startOutboxId: outboxId
          },
          "issue-driver-job",
          system
        )
      );
      expectAccepted(
        await execute(
          kernel,
          "outbox.lease.acquire",
          { outboxId, ownerId: system.id, leaseDurationMs: 10_000 },
          "issue-driver-outbox",
          system
        )
      );
      expectAccepted(
        await execute(
          kernel,
          "outbox.delivery.succeed",
          { outboxId, ownerId: system.id, fencingToken: 1, externalEffectId: "docker:issue-v2" },
          "issue-driver-started",
          system
        )
      );
      expectAccepted(
        await execute(
          kernel,
          "attempt.driver-events.observe",
          {
            jobId: generation.jobId,
            attemptId,
            ownerId: system.id,
            fencingToken: 1,
            afterSequence: 0,
            events: [
              { schemaVersion: 2, sequence: 1, type: "started" },
              {
                schemaVersion: 2,
                sequence: 2,
                type: "issue.raised",
                originalText: "Keep this new idea verbatim.",
                proposedClass: "new_idea",
                resultImpact: "none",
                affectedMilestoneIds: [secondMilestoneId]
              },
              {
                schemaVersion: 2,
                sequence: 3,
                type: "issue.raised",
                originalText: "The worker found a contract contradiction.",
                proposedClass: "contradiction",
                resultImpact: "may_change_accepted_result",
                affectedMilestoneIds: [firstMilestoneId]
              }
            ]
          },
          "issue-driver-events",
          system
        )
      );
      const issues = await kernel.listRoutedIssues(programId);
      const newIdea = issues.find(
        (issue) => issue.issue.originalText === "Keep this new idea verbatim."
      );
      const contradiction = issues.find(
        (issue) => issue.issue.originalText === "The worker found a contract contradiction."
      );
      expect(newIdea?.issue).toMatchObject({
        route: "record_only",
        source: { kind: "driver_event", attemptId, sequence: 2 }
      });
      expect(contradiction?.issue).toMatchObject({
        route: "pause_affected",
        source: { kind: "driver_event", attemptId, sequence: 3 }
      });
      expect(await kernel.getState({ kind: "milestone", id: firstMilestoneId })).toMatchObject({
        status: "paused",
        recommendation: "investigate"
      });
      const identities = issues.map((issue) => issue.issue.issueId);
      expect(await kernel.rebuildProjections()).toMatchObject({ projectionSchemaVersion: 1 });
      expect(
        (await kernel.listRoutedIssues(programId)).map((issue) => issue.issue.issueId)
      ).toEqual(identities);
    } finally {
      await kernel.close();
    }
  });

  it("reports missing and open measurement inputs explicitly rather than as zero", async () => {
    const noAttention = await prepareStartedProgram(false);
    try {
      const noAttentionEvents = await noAttention.kernel.listEvents({ limit: 1_000 });
      expectAccepted(
        await execute(
          noAttention.kernel,
          "measurement-report.compile",
          {
            schemaVersion: 1,
            reportId: uuid(400),
            programId: noAttention.programId,
            expectedThroughPosition: noAttentionEvents.events.at(-1)?.globalPosition ?? 0
          },
          "report-no-attention"
        )
      );
      expect(
        await noAttention.kernel.getState({ kind: "measurement_report", id: uuid(400) })
      ).toMatchObject({
        report: {
          observationWindow: { status: "open" },
          activeHumanTime: { status: "unavailable", reason: "no_attention_spans" },
          resources: { status: "unavailable", reason: "no_driver_receipts" },
          monetaryCost: {
            status: "unavailable",
            knownLineItems: [],
            reasons: ["no_cost_receipts"]
          }
        }
      });
    } finally {
      await noAttention.kernel.close();
    }

    const openAttention = await prepareStartedProgram();
    try {
      const openEvents = await openAttention.kernel.listEvents({ limit: 1_000 });
      expectAccepted(
        await execute(
          openAttention.kernel,
          "measurement-report.compile",
          {
            schemaVersion: 1,
            reportId: uuid(401),
            programId: openAttention.programId,
            expectedThroughPosition: openEvents.events.at(-1)?.globalPosition ?? 0
          },
          "report-open-attention"
        )
      );
      expect(
        await openAttention.kernel.getState({ kind: "measurement_report", id: uuid(401) })
      ).toMatchObject({
        report: {
          activeHumanTime: { status: "unavailable", reason: "attention_span_open" }
        }
      });
    } finally {
      await openAttention.kernel.close();
    }
  });
});
