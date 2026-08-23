import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "./canonical.js";
import { migrateDatabase } from "./database.js";
import type { Clock, IdGenerator } from "./database.js";
import { sourceRevisionDigest } from "./evidence.js";
import type { Kernel } from "./sqlite-kernel.js";
import { openKernelForTesting } from "./sqlite-kernel.js";
import type { DecisionOptionV1, ProgramGraphRevisionV1 } from "./schema.js";

const operator = { kind: "operator", id: "attention-action-operator" } as const;
const directories: string[] = [];
const image = `sha256:${"b".repeat(64)}`;

function id(value: number): string {
  return `73000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

class MutableClock implements Clock {
  #value = new Date("2026-08-21T18:00:00.000Z");

  now(): Date {
    return new Date(this.#value);
  }
}

class SequenceIds implements IdGenerator {
  #next = 5_000;

  next(): string {
    return id(this.#next++);
  }
}

interface GraphFixture {
  kernel: Kernel;
  programId: string;
  milestoneId: string;
  graph: ProgramGraphRevisionV1;
  graphDigest: string;
  initialRevisionId: string;
}

async function graphFixture(): Promise<GraphFixture> {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-attention-action-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  const clock = new MutableClock();
  await migrateDatabase({ databasePath, clock });
  const kernel = openKernelForTesting({ databasePath, clock, idGenerator: new SequenceIds() });
  const programId = id(1);
  const milestoneId = id(2);
  const secondMilestoneId = id(9);
  const workflowId = id(3);
  const initialRevisionId = id(4);
  const identity = {
    repositoryId: id(5),
    objectFormat: "sha1" as const,
    commitOid: "1".repeat(40),
    treeOid: "2".repeat(40)
  };
  const revisionDigest = sourceRevisionDigest(identity);
  expect(
    await kernel.execute({
      type: "source-revision.register",
      idempotencyKey: "action-source",
      actor: operator,
      payload: {
        revisionId: initialRevisionId,
        ...identity,
        storageRef: `refs/parallelplay/revisions/${initialRevisionId}`,
        revisionDigest
      }
    })
  ).toMatchObject({ ok: true });
  expect(
    await kernel.execute({
      type: "workflow.register",
      idempotencyKey: "action-workflow",
      actor: operator,
      payload: {
        schemaVersion: 3,
        workflowId,
        version: 1,
        name: "attention action workflow",
        steps: [
          {
            id: "implement",
            capability: "implementation",
            dependsOn: [],
            execution: {
              protocolVersion: 2,
              image,
              argv: ["/bin/true"],
              workingDirectory: "/workspace",
              context: { target: "/context/context.json" }
            },
            capabilities: {
              schemaVersion: 2,
              workspace: "read_write",
              artifactOutput: "read_write",
              scratch: "read_write",
              context: { access: "read_only" },
              cpuLimit: 1,
              memoryLimitBytes: 268_435_456,
              pidsLimit: 64,
              network: [],
              secrets: [],
              git: []
            },
            verification: {
              mode: "verify",
              argv: ["./verify.sh"],
              cwd: ".",
              timeoutMs: 1_000,
              environment: {},
              toolProbes: []
            }
          }
        ]
      }
    })
  ).toMatchObject({ ok: true });
  expect(
    await kernel.execute({
      type: "program.kickoff",
      idempotencyKey: "action-kickoff",
      actor: operator,
      payload: {
        schemaVersion: 1,
        programId,
        name: "attention bounded actions",
        initialSourceRevisionId: initialRevisionId,
        initialSourceRevisionDigest: revisionDigest
      }
    })
  ).toMatchObject({ ok: true });
  const transcript = [
    ["objective", "Prove bounded decision actions."],
    ["desired_behaviors", "Keep every action within one program."],
    ["non_goals", "No merge authority."],
    ["edge_cases", "Stale targets and restarts."],
    ["ownership_boundaries", "Only the operator resolves packets."],
    ["success_measures", "Every action replays."],
    ["risk_tolerance", "normal"],
    ["tenets", "Replay; evidence; bounded authority."]
  ].map(([questionId, answer]) => ({
    questionId: questionId ?? "missing",
    question: `Question ${questionId ?? "missing"}`,
    answer: answer ?? "missing"
  }));
  expect(
    await kernel.execute({
      type: "interview.capture",
      idempotencyKey: "action-interview",
      actor: operator,
      payload: {
        schemaVersion: 1,
        interviewId: id(6),
        playbackId: id(7),
        programId,
        transcript,
        answers: {
          objective: "Prove bounded decision actions.",
          desiredBehaviors: ["Keep every action within one program."],
          nonGoals: ["No merge authority."],
          edgeCases: ["Stale targets and restarts."],
          ownershipBoundaries: ["Only the operator resolves packets."],
          successMeasures: ["Every action replays."],
          riskTolerance: "normal",
          tenets: ["Replay", "Evidence", "Bounded authority"]
        }
      }
    })
  ).toMatchObject({ ok: true });
  const interview = (await kernel.listProgramInterviews(programId))[0];
  if (!interview) throw new Error("Action fixture interview is missing");
  const graph: ProgramGraphRevisionV1 = {
    schemaVersion: 1,
    graphRevisionId: id(8),
    programId,
    revision: 1,
    priorGraphRef: null,
    intentPlaybackRef: {
      kind: "intent_playback",
      id: interview.playback.playbackId,
      digest: interview.playbackDigest
    },
    initialSourceRef: { kind: "source_revision", id: initialRevisionId, digest: revisionDigest },
    milestones: [
      {
        contract: {
          schemaVersion: 1,
          milestoneId,
          title: "One bounded milestone",
          objective: "Exercise attention action authority.",
          taskType: "feature",
          priority: "p1",
          tags: ["attention"],
          workflowId,
          workflowVersion: 1,
          criteria: [
            {
              criterionId: "bounded",
              statement: "The action stays within the approved contract.",
              verificationStepId: "implement"
            }
          ]
        },
        dependencies: [],
        sourcePredecessorMilestoneId: null,
        allowedWorkSurfaces: ["README.md"],
        refs: []
      },
      {
        contract: {
          schemaVersion: 1,
          milestoneId: secondMilestoneId,
          title: "Second bounded milestone",
          objective: "Remain outside the first action scope.",
          taskType: "feature",
          priority: "p2",
          tags: ["attention"],
          workflowId,
          workflowVersion: 1,
          criteria: [
            {
              criterionId: "unaffected",
              statement: "The second milestone remains unaffected.",
              verificationStepId: "implement"
            }
          ]
        },
        dependencies: [milestoneId],
        sourcePredecessorMilestoneId: milestoneId,
        allowedWorkSurfaces: ["README.md"],
        refs: []
      }
    ],
    initialContext: {
      decisions: [],
      assumptions: [],
      risks: [],
      unresolvedQuestions: [],
      refs: [{ kind: "source_revision", id: initialRevisionId, digest: revisionDigest }]
    }
  };
  const graphResult = await kernel.execute({
    type: "program-graph.approve",
    idempotencyKey: "action-graph",
    actor: operator,
    payload: graph
  });
  if (!graphResult.ok) throw new Error(JSON.stringify(graphResult));
  const graphState = await kernel.getState({ kind: "program_graph", id: graph.graphRevisionId });
  if (graphState?.kind !== "program_graph") throw new Error("Action fixture graph is missing");
  expect(
    await kernel.execute({
      type: "program.start",
      idempotencyKey: "action-start",
      actor: operator,
      payload: {
        schemaVersion: 1,
        programId,
        graphRevisionId: graph.graphRevisionId,
        graphDigest: graphState.graphDigest,
        policy: { maxAttempts: 1, attemptTimeoutMs: 60_000, retryDelaysMs: [] }
      }
    })
  ).toMatchObject({ ok: true });
  return {
    kernel,
    programId,
    milestoneId,
    graph,
    graphDigest: graphState.graphDigest,
    initialRevisionId
  };
}

async function requestAction(fixture: GraphFixture, offset: number, option: DecisionOptionV1) {
  const requestId = id(100 + offset);
  const result = await fixture.kernel.execute({
    type: "decision.request",
    idempotencyKey: `action-request-${String(offset)}`,
    actor: operator,
    payload: {
      request: {
        schemaVersion: 1,
        requestId,
        programId: fixture.programId,
        milestoneId: fixture.milestoneId,
        originalQuestion: `Apply bounded ${option.action.kind} action?`,
        prompt: `Review ${option.action.kind} preconditions.`,
        context: "This focused fixture binds one exact target and immutable option.",
        riskClass: "high",
        safetyClass: "routine",
        reversibility: "costly",
        options: [option],
        refs: [],
        deadlineAt: null
      }
    }
  });
  expect(result).toMatchObject({ ok: true });
  const request = await fixture.kernel.getState({
    kind: "operator_decision_request",
    id: requestId
  });
  if (request?.kind !== "operator_decision_request") throw new Error("Decision request missing");
  const packet = (await fixture.kernel.listDecisionPackets(fixture.programId)).find((entry) => {
    const current =
      result.ok && result.data.kind === "decision_packet" ? result.data.packetId : null;
    return entry.packetId === current;
  });
  const revision = packet
    ? (await fixture.kernel.listDecisionPacketRevisions(packet.packetId)).at(-1)
    : undefined;
  if (!packet || !revision) throw new Error("Decision packet missing");
  return { packet, revision };
}

async function applyAction(
  fixture: GraphFixture,
  action: DecisionOptionV1["action"]["kind"],
  option: DecisionOptionV1,
  offset: number
) {
  const { packet, revision } = await requestAction(fixture, offset, option);
  return fixture.kernel.execute({
    type: `decision.${action}`,
    idempotencyKey: `action-apply-${String(offset)}`,
    actor: operator,
    payload: {
      schemaVersion: 1,
      packetId: packet.packetId,
      packetRevisionId: revision.revision.packetRevisionId,
      packetRevisionDigest: revision.revisionDigest,
      optionId: option.optionId,
      targetPreconditionDigest: canonicalDigest(option.action.target)
    }
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("attention bounded decision actions", () => {
  it("cancels exactly one fenced run and atomically records resolution evidence", async () => {
    const fixture = await graphFixture();
    try {
      const generation = (await fixture.kernel.listMilestoneGenerations(fixture.programId))[0];
      const run = generation
        ? await fixture.kernel.getState({ kind: "run", id: generation.runId })
        : null;
      if (run?.kind !== "run") throw new Error("Active run missing");
      const option: DecisionOptionV1 = {
        optionId: id(201),
        label: "Cancel this run",
        consequences: ["Only the exact active run is cancelled."],
        reversalCost: "A retry requires another decision.",
        action: {
          kind: "cancel",
          target: {
            kind: "run_cancel",
            runId: run.runId,
            expectedRunVersion: run.version,
            reason: "bounded_cancel_test"
          }
        }
      };
      const result = await applyAction(fixture, "cancel", option, 1);
      expect(result.ok && result.events.map((event) => event.type)).toContain("RunCancelled");
      expect(result.ok && result.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "DecisionActionApplied",
          "DecisionResolved",
          "DecisionPrecedentRecorded"
        ])
      );
      expect(await fixture.kernel.getState({ kind: "run", id: run.runId })).toMatchObject({
        status: "cancelled"
      });
      expect(await fixture.kernel.verifyProjections()).toMatchObject({ valid: true });
    } finally {
      await fixture.kernel.close();
    }
  });

  it("parks one program, blocks advance, then resumes only through a separate approve packet", async () => {
    const fixture = await graphFixture();
    try {
      const before = await fixture.kernel.getState({ kind: "program", id: fixture.programId });
      if (before?.kind !== "program") throw new Error("Program missing");
      const park: DecisionOptionV1 = {
        optionId: id(202),
        label: "Park the program",
        consequences: ["The active generation is cancelled and the program stops advancing."],
        reversalCost: "Resume requires another explicit packet.",
        action: {
          kind: "park",
          target: {
            kind: "program_park",
            programId: fixture.programId,
            expectedProgramVersion: before.version,
            expectedGraphDigest: fixture.graphDigest,
            reason: "bounded_park_test"
          }
        }
      };
      expect(await applyAction(fixture, "park", park, 2)).toMatchObject({ ok: true });
      const parked = await fixture.kernel.getState({ kind: "program", id: fixture.programId });
      if (parked?.kind !== "program") throw new Error("Parked program missing");
      expect(parked.phase).toBe("parked");
      expect(await fixture.kernel.advanceProgram(fixture.programId)).toBeNull();
      const resume: DecisionOptionV1 = {
        optionId: id(203),
        label: "Resume unchanged program",
        consequences: ["Execution eligibility returns without changing the graph."],
        reversalCost: "The program can be parked again.",
        action: {
          kind: "approve",
          target: {
            kind: "program_resume",
            programId: fixture.programId,
            expectedProgramVersion: parked.version,
            expectedGraphDigest: fixture.graphDigest
          }
        }
      };
      const resumed = await applyAction(fixture, "approve", resume, 3);
      expect(resumed.ok && resumed.events.map((event) => event.type)).toContain("ProgramResumed");
      expect(
        await fixture.kernel.getState({ kind: "program", id: fixture.programId })
      ).toMatchObject({
        phase: "running",
        activeGraphDigest: fixture.graphDigest
      });
    } finally {
      await fixture.kernel.close();
    }
  });

  it("retries only the unchanged graph, contract, dependency set, and source lineage", async () => {
    const fixture = await graphFixture();
    try {
      const generation = (await fixture.kernel.listMilestoneGenerations(fixture.programId))[0];
      if (!generation) throw new Error("Generation missing");
      expect(
        await fixture.kernel.execute({
          type: "run.cancel",
          idempotencyKey: "retry-fixture-cancel",
          actor: operator,
          payload: { runId: generation.runId, reason: "prepare_retry" }
        })
      ).toMatchObject({ ok: true });
      const milestone = await fixture.kernel.getState({
        kind: "milestone",
        id: fixture.milestoneId
      });
      if (milestone?.kind !== "milestone") throw new Error("Milestone missing");
      const option: DecisionOptionV1 = {
        optionId: id(204),
        label: "Retry unchanged milestone",
        consequences: ["Generation two uses the same graph, contract, and base revision."],
        reversalCost: "The new generation may require cancellation.",
        action: {
          kind: "retry",
          target: {
            kind: "milestone_retry",
            programId: fixture.programId,
            milestoneId: fixture.milestoneId,
            expectedMilestoneVersion: milestone.version,
            expectedGeneration: milestone.generation ?? 0,
            graphRevisionId: fixture.graph.graphRevisionId,
            graphDigest: fixture.graphDigest,
            contractDigest: milestone.contractDigest,
            baseRevisionId: generation.baseRevisionId,
            dependencyValidations: [],
            policy: { maxAttempts: 1, attemptTimeoutMs: 60_000, retryDelaysMs: [] }
          }
        }
      };
      const retried = await applyAction(fixture, "retry", option, 4);
      expect(retried.ok && retried.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "ContextPacketCompiled",
          "MilestoneGenerationStarted",
          "MilestoneRunCreated",
          "DecisionResolved"
        ])
      );
      const generations = await fixture.kernel.listMilestoneGenerations(fixture.programId);
      expect(generations).toHaveLength(2);
      expect(generations[1]).toMatchObject({
        generation: 2,
        baseRevisionId: generation.baseRevisionId,
        status: "running"
      });
    } finally {
      await fixture.kernel.close();
    }
  });

  it("records a no-scope-change approval and rejects a mismatched action command", async () => {
    const fixture = await graphFixture();
    try {
      const graph = await fixture.kernel.getState({
        kind: "program_graph",
        id: fixture.graph.graphRevisionId
      });
      if (graph?.kind !== "program_graph") throw new Error("Graph missing");
      const option: DecisionOptionV1 = {
        optionId: id(205),
        label: "Record without changing scope",
        consequences: ["No graph, run, or source authority changes."],
        reversalCost: "The descriptive record is immutable.",
        action: {
          kind: "approve",
          target: {
            kind: "record_only",
            targetRef: {
              kind: "program_graph",
              id: graph.graphRevisionId,
              digest: graph.graphDigest
            },
            text: "Reviewed with no scope change"
          }
        }
      };
      const requested = await requestAction(fixture, 5, option);
      const mismatched = await fixture.kernel.execute({
        type: "decision.cancel",
        idempotencyKey: "mismatched-action",
        actor: operator,
        payload: {
          schemaVersion: 1,
          packetId: requested.packet.packetId,
          packetRevisionId: requested.revision.revision.packetRevisionId,
          packetRevisionDigest: requested.revision.revisionDigest,
          optionId: option.optionId,
          targetPreconditionDigest: canonicalDigest(option.action.target)
        }
      });
      expect(mismatched).toMatchObject({
        ok: false,
        error: { code: "DECISION_ACTION_MISMATCH" }
      });
      const approved = await fixture.kernel.execute({
        type: "decision.approve",
        idempotencyKey: "record-only-approval",
        actor: operator,
        payload: {
          schemaVersion: 1,
          packetId: requested.packet.packetId,
          packetRevisionId: requested.revision.revision.packetRevisionId,
          packetRevisionDigest: requested.revision.revisionDigest,
          optionId: option.optionId,
          targetPreconditionDigest: canonicalDigest(option.action.target)
        }
      });
      expect(approved.ok && approved.events.map((event) => event.type)).toEqual([
        "DecisionActionApplied",
        "DecisionResolved",
        "DecisionPrecedentRecorded"
      ]);
    } finally {
      await fixture.kernel.close();
    }
  });

  it("compiles eligible authoritative sources after restart and skips record-only issues", async () => {
    const fixture = await graphFixture();
    const blockingIssueId = id(206);
    const recordOnlyIssueId = id(207);
    try {
      expect(
        await fixture.kernel.execute({
          type: "issue.raise",
          idempotencyKey: "compile-blocking-issue",
          actor: { kind: "system", id: "worker-router" },
          payload: {
            schemaVersion: 1,
            issueId: blockingIssueId,
            programId: fixture.programId,
            originalText: "The accepted result contradicts the active contract.",
            proposedClass: "contradiction",
            resultImpact: "may_change_accepted_result",
            affectedMilestoneIds: [fixture.milestoneId],
            refs: [],
            source: { kind: "command" }
          }
        })
      ).toMatchObject({ ok: true });
      expect(await fixture.kernel.compileAttention()).toMatchObject({ ok: true });
      expect(await fixture.kernel.compileAttention()).toMatchObject({ ok: true });
      const sources = (await fixture.kernel.listDecisionPacketRevisions()).map(
        (entry) => entry.revision.source.kind
      );
      expect(sources).toEqual(expect.arrayContaining(["outcome_packet", "routed_issue"]));

      expect(
        await fixture.kernel.execute({
          type: "issue.raise",
          idempotencyKey: "compile-record-only-issue",
          actor: { kind: "system", id: "worker-router" },
          payload: {
            schemaVersion: 1,
            issueId: recordOnlyIssueId,
            programId: fixture.programId,
            originalText: "Consider a future naming improvement.",
            proposedClass: "new_idea",
            resultImpact: "none",
            affectedMilestoneIds: [fixture.milestoneId],
            refs: [],
            source: { kind: "command" }
          }
        })
      ).toMatchObject({ ok: true });
      expect(await fixture.kernel.compileAttention()).toBeNull();
      expect(
        (await fixture.kernel.listDecisionPacketRevisions()).some(
          (entry) => entry.revision.source.id === recordOnlyIssueId
        )
      ).toBe(false);
    } finally {
      await fixture.kernel.close();
    }
  });
});
