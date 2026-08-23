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
import type { ProgramGraphRevisionV2, SourceRevisionState } from "./schema.js";

const operator = { kind: "operator", id: "integration-operator" } as const;
const system = { kind: "system", id: "80000000-0000-4000-8000-000000009999" } as const;
const directories: string[] = [];

function uuid(value: number): string {
  return `80000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

class MutableClock implements Clock {
  #value = new Date("2026-08-22T12:00:00.000Z");

  now(): Date {
    return new Date(this.#value);
  }

  advance(milliseconds: number): void {
    this.#value = new Date(this.#value.getTime() + milliseconds);
  }
}

class SequenceIds implements IdGenerator {
  #next = 50_000;

  next(): string {
    return uuid(this.#next++);
  }
}

interface Fixture {
  kernel: Kernel;
  clock: MutableClock;
  policyRef: { kind: "portfolio_policy"; id: string; digest: string };
  targetRef: { kind: "integration_target"; id: string; digest: string };
  initial: SourceRevisionState;
  workflowId: string;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function execute(
  kernel: Kernel,
  type: string,
  payload: unknown,
  key: string,
  actor: typeof operator | typeof system = operator
) {
  return kernel.execute({ type, payload, idempotencyKey: key, actor });
}

async function createFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-integration-kernel-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  const clock = new MutableClock();
  await migrateDatabase({ databasePath, clock });
  const kernel = openKernelForTesting({ databasePath, clock, idGenerator: new SequenceIds() });

  const repositoryId = uuid(1);
  const initialIdentity = {
    repositoryId,
    objectFormat: "sha1" as const,
    commitOid: "1".repeat(40),
    treeOid: "2".repeat(40)
  };
  const initial: SourceRevisionState = {
    kind: "source_revision",
    revisionId: uuid(2),
    ...initialIdentity,
    storageRef: `refs/parallelplay/revisions/${uuid(2)}`,
    revisionDigest: sourceRevisionDigest(initialIdentity),
    capturedAt: clock.now().toISOString(),
    version: 1
  };
  expect(
    await execute(
      kernel,
      "source-revision.register",
      {
        revisionId: initial.revisionId,
        repositoryId: initial.repositoryId,
        objectFormat: initial.objectFormat,
        commitOid: initial.commitOid,
        treeOid: initial.treeOid,
        storageRef: initial.storageRef,
        revisionDigest: initial.revisionDigest
      },
      "initial-source"
    )
  ).toMatchObject({ ok: true });

  const workflowId = uuid(3);
  expect(
    await execute(
      kernel,
      "workflow.register",
      {
        schemaVersion: 3,
        workflowId,
        version: 1,
        name: "integration local implementation",
        steps: [
          {
            id: "execute",
            capability: "implementation",
            dependsOn: [],
            execution: {
              protocolVersion: 2,
              image: `sha256:${"a".repeat(64)}`,
              argv: ["/bin/sh", "/fixture/success-v2.sh"],
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
              timeoutMs: 30_000,
              environment: {},
              toolProbes: []
            }
          }
        ]
      },
      "workflow"
    )
  ).toMatchObject({ ok: true });

  const attentionPolicyId = uuid(4);
  expect(
    await execute(
      kernel,
      "attention-policy.approve",
      {
        policy: {
          schemaVersion: 1,
          policyId: uuid(5),
          policyRevisionId: attentionPolicyId,
          revision: 1,
          priorPolicyRef: null,
          rules: [],
          defaultRoute: "queue",
          defaultUrgency: "p1",
          routinePageBudget: { maxPages: 0, windowMs: 86_400_000 },
          deduplicationWindowMs: 86_400_000,
          oneWayDoorActionKinds: [],
          defaultOnTimeout: null
        }
      },
      "attention-policy"
    )
  ).toMatchObject({ ok: true });
  const attentionPolicy = (await kernel.listAttentionPolicies())[0];
  if (!attentionPolicy) throw new Error("Missing attention policy");

  const policyRevisionId = uuid(6);
  expect(
    await execute(
      kernel,
      "portfolio-policy.approve",
      {
        policy: {
          schemaVersion: 1,
          policyId: uuid(7),
          policyRevisionId,
          revision: 1,
          priorPolicyRef: null,
          limits: {
            maxExecutingPrograms: 2,
            maxIntegrationReadyCandidates: 2,
            maxPipelineWip: 4,
            maxAttemptMs: 300_000,
            maxMergeQueueAgeMs: 600_000,
            maxTrialWallTimeMs: 900_000,
            maxActiveHumanTimeMs: 900_000
          },
          resources: [
            { resourceId: "schema-main", kind: "schema", capacity: 1 },
            {
              resourceId: "integration-main",
              kind: "integration_environment",
              capacity: 1
            },
            { resourceId: "device-a", kind: "device", capacity: 1 },
            { resourceId: "device-b", kind: "device", capacity: 1 },
            { resourceId: "merge-main", kind: "merge_lane", capacity: 1 }
          ],
          capabilityCapacities: [{ capability: "implementation", capacity: 2 }],
          attention: {
            policyRef: {
              kind: "attention_policy",
              id: attentionPolicy.policy.policyRevisionId,
              digest: attentionPolicy.policyDigest
            },
            maxRoutinePagesPer24Hours: 0,
            safetyCriticalUncapped: true
          },
          costMode: {
            kind: "unpriced_local_only",
            allowedDriver: "generic-command",
            unavailableReason: "Local Docker execution does not expose authoritative price data"
          }
        }
      },
      "portfolio-policy"
    )
  ).toMatchObject({ ok: true });
  const policy = (await kernel.listPortfolioPolicies())[0];
  if (!policy) throw new Error("Missing portfolio policy");

  const verifierContract = {
    mode: "verify" as const,
    argv: ["./verify.sh"],
    cwd: "." as const,
    timeoutMs: 30_000,
    environment: {},
    toolProbes: []
  };
  const targetRevisionId = uuid(8);
  expect(
    await execute(
      kernel,
      "integration-target.approve",
      {
        target: {
          schemaVersion: 1,
          targetId: uuid(9),
          targetRevisionId,
          revision: 1,
          priorTargetRef: null,
          repositoryId,
          initialHeadRef: {
            kind: "source_revision",
            id: initial.revisionId,
            digest: initial.revisionDigest
          },
          managedRef: `refs/parallelplay/integration/${uuid(9)}`,
          verifierContract,
          verifierContractDigest: canonicalDigest(verifierContract),
          mergeLaneResourceId: "merge-main"
        }
      },
      "integration-target"
    )
  ).toMatchObject({ ok: true });
  const target = (await kernel.listIntegrationTargets())[0];
  if (!target) throw new Error("Missing integration target");

  return {
    kernel,
    clock,
    initial,
    workflowId,
    policyRef: {
      kind: "portfolio_policy",
      id: policy.policy.policyRevisionId,
      digest: policy.policyDigest
    },
    targetRef: {
      kind: "integration_target",
      id: target.target.targetRevisionId,
      digest: target.targetDigest
    }
  };
}

async function approveAndQueueProgram(
  fixture: Fixture,
  ordinal: number,
  firstResource: "device-a" | "device-b",
  crossProgramDependencies: ProgramGraphRevisionV2["crossProgramDependencies"] = []
): Promise<{ programId: string; graph: ProgramGraphRevisionV2; graphDigest: string }> {
  const base = 100 + ordinal * 20;
  const programId = uuid(base);
  expect(
    await execute(
      fixture.kernel,
      "program.kickoff",
      {
        schemaVersion: 1,
        programId,
        name: `Concurrent program ${String(ordinal)}`,
        initialSourceRevisionId: fixture.initial.revisionId,
        initialSourceRevisionDigest: fixture.initial.revisionDigest
      },
      `kickoff-${String(ordinal)}`
    )
  ).toMatchObject({ ok: true });
  const transcript = [
    ["objective", "Deliver one controlled concurrent program."],
    ["desired", "Respect claims and integration authority."],
    ["non-goals", "Never mutate a live checkout."],
    ["edge", "Recover sticky expired leases."],
    ["owner", "Operator owns final integration."],
    ["success", "Verified managed-ref promotion only."],
    ["risk", "normal"],
    ["tenets", "Replay; fencing; evidence."]
  ].map(([questionId, answer]) => ({
    questionId: questionId ?? "missing",
    question: `Question ${questionId ?? "missing"}`,
    answer: answer ?? "missing"
  }));
  expect(
    await execute(
      fixture.kernel,
      "interview.capture",
      {
        schemaVersion: 1,
        interviewId: uuid(base + 1),
        playbackId: uuid(base + 2),
        programId,
        transcript,
        answers: {
          objective: "Deliver one controlled concurrent program.",
          desiredBehaviors: ["Respect claims and integration authority."],
          nonGoals: ["Never mutate a live checkout."],
          edgeCases: ["Recover sticky expired leases."],
          ownershipBoundaries: ["Operator owns final integration."],
          successMeasures: ["Verified managed-ref promotion only."],
          riskTolerance: "normal",
          tenets: ["Replay", "Fencing", "Evidence"]
        }
      },
      `interview-${String(ordinal)}`
    )
  ).toMatchObject({ ok: true });
  const interview = (await fixture.kernel.listProgramInterviews(programId))[0];
  if (!interview) throw new Error("Missing interview");
  const milestoneIds = [uuid(base + 3), uuid(base + 4)];
  const firstMilestoneId = milestoneIds[0];
  if (!firstMilestoneId) throw new Error("First milestone ID is missing");
  const graph: ProgramGraphRevisionV2 = {
    schemaVersion: 2,
    graphRevisionId: uuid(base + 5),
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
      id: fixture.initial.revisionId,
      digest: fixture.initial.revisionDigest
    },
    portfolioPolicyRef: fixture.policyRef,
    integrationTargetRef: fixture.targetRef,
    crossProgramDependencies,
    milestones: milestoneIds.map((milestoneId, index) => ({
      contract: {
        schemaVersion: 1,
        milestoneId,
        title: `Program ${String(ordinal)} milestone ${String(index + 1)}`,
        objective: "Produce one controlled candidate revision.",
        taskType: "feature",
        priority: "p1",
        tags: ["integration"],
        workflowId: fixture.workflowId,
        workflowVersion: 1,
        criteria: [
          {
            criterionId: `program-${String(ordinal)}-${String(index + 1)}`,
            statement: "The exact candidate passes verification.",
            verificationStepId: "execute"
          }
        ]
      },
      dependencies: index === 0 ? [] : [firstMilestoneId],
      sourcePredecessorMilestoneId: index === 0 ? null : firstMilestoneId,
      workSurfaces: [
        index === 0
          ? { kind: "file" as const, path: `program-${String(ordinal)}.txt` }
          : { kind: "file" as const, path: "shared.txt" }
      ],
      resourceClaims: index === 0 ? [firstResource] : ["schema-main", "integration-main"],
      capabilityClaims: ["implementation"],
      refs: []
    })),
    initialContext: {
      decisions: [],
      assumptions: [],
      risks: [],
      unresolvedQuestions: [],
      refs: [
        {
          kind: "source_revision",
          id: fixture.initial.revisionId,
          digest: fixture.initial.revisionDigest
        }
      ]
    }
  };
  expect(
    await execute(fixture.kernel, "program-graph.approve", graph, `graph-${String(ordinal)}`)
  ).toMatchObject({ ok: true });
  const graphState = await fixture.kernel.getState({
    kind: "program_graph",
    id: graph.graphRevisionId
  });
  if (graphState?.kind !== "program_graph") throw new Error("Missing graph");
  fixture.clock.advance(1);
  expect(
    await execute(
      fixture.kernel,
      "program.start",
      {
        schemaVersion: 2,
        requestId: uuid(base + 6),
        programId,
        graphRevisionId: graph.graphRevisionId,
        graphDigest: graphState.graphDigest,
        policy: { maxAttempts: 1, attemptTimeoutMs: 300_000, retryDelaysMs: [] }
      },
      `start-${String(ordinal)}`
    )
  ).toMatchObject({ ok: true, data: { phase: "eligible" } });
  return { programId, graph, graphDigest: graphState.graphDigest };
}

describe("integration controlled concurrency contracts", () => {
  it("queues V2 starts, admits exactly two disjoint programs, and keeps expiry sticky", async () => {
    const fixture = await createFixture();
    try {
      const first = await approveAndQueueProgram(fixture, 1, "device-a");
      const second = await approveAndQueueProgram(fixture, 2, "device-b");
      const third = await approveAndQueueProgram(fixture, 3, "device-a");

      expect(await fixture.kernel.listPortfolioAdmissions()).toEqual([]);
      expect(await fixture.kernel.coordinatePortfolio()).toMatchObject({
        ok: true,
        data: { admission: { programId: first.programId, executionSlot: 1 } }
      });
      expect(await fixture.kernel.coordinatePortfolio()).toMatchObject({
        ok: true,
        data: { admission: { programId: second.programId, executionSlot: 2 } }
      });
      expect(await fixture.kernel.coordinatePortfolio()).toBeNull();

      const admissions = await fixture.kernel.listPortfolioAdmissions();
      expect(admissions).toHaveLength(2);
      expect(admissions.map((entry) => entry.admission.admissionSequence)).toEqual([1, 2]);
      expect(
        (await fixture.kernel.listConcurrencyLeases()).filter((lease) => lease.status === "active")
      ).toHaveLength(8);
      expect(await fixture.kernel.getState({ kind: "program", id: third.programId })).toMatchObject(
        {
          phase: "eligible"
        }
      );

      fixture.clock.advance(60_001);
      expect((await fixture.kernel.getPortfolioSnapshot()).leaseRecovery).toHaveLength(8);
      expect(await fixture.kernel.coordinatePortfolio()).toBeNull();
      expect(await fixture.kernel.listPortfolioAdmissions()).toHaveLength(2);

      const firstAdmission = admissions[0];
      if (!firstAdmission) throw new Error("First admission is missing");
      const staleFence = await execute(
        fixture.kernel,
        "portfolio-admission.fence",
        {
          schemaVersion: 1,
          admissionId: firstAdmission.admission.admissionId,
          generationId: firstAdmission.admission.generationId,
          fencingToken: 999,
          reason: "stale owner"
        },
        "stale-admission-fence",
        system
      );
      expect(staleFence).toMatchObject({
        ok: false,
        error: { code: "PROGRAM_NOT_ADVANCEABLE" }
      });
      const fenced = await execute(
        fixture.kernel,
        "portfolio-admission.fence",
        {
          schemaVersion: 1,
          admissionId: firstAdmission.admission.admissionId,
          generationId: firstAdmission.admission.generationId,
          fencingToken: firstAdmission.admission.admissionSequence,
          reason: "expired owner reconciled"
        },
        "valid-admission-fence",
        system
      );
      expect(fenced).toMatchObject({ ok: true });
      expect(
        await fixture.kernel.getState({
          kind: "portfolio_admission",
          id: firstAdmission.admission.admissionId
        })
      ).toMatchObject({ status: "fenced" });
      expect(await fixture.kernel.verifyProjections()).toMatchObject({
        valid: true,
        projectionSchemaVersion: 1
      });
    } finally {
      await fixture.kernel.close();
    }
  });

  it("fails closed on stale graph claims and freezes admission after a wall-time incident", async () => {
    const fixture = await createFixture();
    try {
      const program = await approveAndQueueProgram(fixture, 1, "device-a");
      const replacement = {
        ...program.graph,
        graphRevisionId: uuid(900),
        revision: 2,
        priorGraphRef: {
          kind: "program_graph" as const,
          id: program.graph.graphRevisionId,
          digest: program.graphDigest
        },
        milestones: program.graph.milestones.map((milestone, index) =>
          index === 0 ? { ...milestone, resourceClaims: ["unknown-resource"] } : milestone
        )
      };
      expect(
        await execute(fixture.kernel, "program-graph.approve", replacement, "bad-graph")
      ).toMatchObject({ ok: false, error: { code: "MILESTONE_ALREADY_EXISTS" } });

      fixture.clock.advance(900_001);
      expect(await fixture.kernel.evaluatePortfolioSlo()).toMatchObject({
        ok: true,
        data: { incident: { kind: "trial_wall_time", admissionFrozen: true } }
      });
      expect(await fixture.kernel.coordinatePortfolio()).toBeNull();
      expect(await fixture.kernel.getPortfolioSnapshot()).toMatchObject({
        admissionFrozen: true,
        sloIncidents: [{ incident: { kind: "trial_wall_time", status: "open" } }]
      });
    } finally {
      await fixture.kernel.close();
    }
  });

  it("rebuilds a byte-equivalent portfolio view and compiles complete local-cost evidence", async () => {
    const fixture = await createFixture();
    try {
      await approveAndQueueProgram(fixture, 1, "device-a");
      expect(await fixture.kernel.coordinatePortfolio()).toMatchObject({ ok: true });
      const before = JSON.stringify(await fixture.kernel.getPortfolioSnapshot());
      expect(await fixture.kernel.rebuildProjections()).toMatchObject({
        projectionSchemaVersion: 1
      });
      expect(JSON.stringify(await fixture.kernel.getPortfolioSnapshot())).toBe(before);
      expect(await fixture.kernel.compilePortfolioMeasurementReport(uuid(950))).toMatchObject({
        ok: true,
        data: {
          report: {
            executingPrograms: 1,
            maxObservedConcurrentPrograms: 1,
            completeness: { admissions: true, integrations: true, attention: true, cost: true },
            cost: { status: "unavailable" }
          }
        }
      });
      expect(await fixture.kernel.verifyProjections()).toMatchObject({ valid: true });
    } finally {
      await fixture.kernel.close();
    }
  });
});
