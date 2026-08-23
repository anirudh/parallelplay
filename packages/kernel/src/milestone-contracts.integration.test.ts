import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "./database.js";
import type { Clock, IdGenerator } from "./database.js";
import { sourceRevisionDigest } from "./evidence.js";
import { openKernelForTesting, openReadOnlyKernel } from "./sqlite-kernel.js";
import type { Kernel } from "./sqlite-kernel.js";
import type { ProgramApprovalBundleV1 } from "./schema.js";

const ids = {
  workflow: "10000000-0000-4000-8000-000000000001",
  program: "10000000-0000-4000-8000-000000000002",
  milestone: "10000000-0000-4000-8000-000000000003",
  repository: "10000000-0000-4000-8000-000000000004",
  revision: "10000000-0000-4000-8000-000000000005",
  run: "10000000-0000-4000-8000-000000000006",
  job: "10000000-0000-4000-8000-000000000007"
} as const;

const operator = { kind: "operator", id: "operator-1" } as const;
const system = { kind: "system", id: "supervisor-1" } as const;
const timestamp = "2026-08-20T12:00:00.000Z";

class FixedClock implements Clock {
  now(): Date {
    return new Date(timestamp);
  }
}

let generatedId = 1;

class SequenceIds implements IdGenerator {
  next(): string {
    const id = `20000000-0000-4000-8000-${String(generatedId).padStart(12, "0")}`;
    generatedId += 1;
    return id;
  }
}

const workflow = {
  schemaVersion: 2 as const,
  workflowId: ids.workflow,
  version: 1,
  name: "Single real step",
  steps: [
    {
      id: "implement",
      capability: "implementation",
      dependsOn: [],
      execution: {
        protocolVersion: 1 as const,
        image: `parallelplay-fixture@sha256:${"0".repeat(64)}`,
        argv: ["/bin/true"],
        workingDirectory: "/workspace" as const
      },
      capabilities: {
        schemaVersion: 1 as const,
        workspace: "read_write" as const,
        artifactOutput: "read_write" as const,
        scratch: "read_write" as const,
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

const approvalBundle: ProgramApprovalBundleV1 = {
  schemaVersion: 1,
  program: {
    programId: ids.program,
    name: "Walking skeleton",
    intent: {
      schemaVersion: 1,
      objective: "Prove one bounded milestone can run end to end.",
      nonGoals: ["No merge authority"],
      tenets: ["Replay is authoritative", "Evidence is immutable", "Authority stays bounded"],
      riskClass: "normal"
    }
  },
  milestone: {
    schemaVersion: 1,
    milestoneId: ids.milestone,
    title: "Change one tracked file",
    objective: "Produce and verify one candidate revision.",
    taskType: "feature",
    priority: "p1",
    tags: ["milestone", "walking-skeleton"],
    workflowId: ids.workflow,
    workflowVersion: 1,
    criteria: [
      {
        criterionId: "candidate-verifies",
        statement: "The candidate passes the registered verifier.",
        verificationStepId: "implement"
      }
    ]
  }
};

const directories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-milestone-contracts-"));
  directories.push(directory);
  const path = join(directory, "parallelplay.db");
  await migrateDatabase({ databasePath: path, clock: new FixedClock() });
  return path;
}

function kernel(path: string, faultInjector?: () => void): Kernel {
  return openKernelForTesting({
    databasePath: path,
    clock: new FixedClock(),
    idGenerator: new SequenceIds(),
    ...(faultInjector ? { faultInjector } : {})
  });
}

async function registerWorkflow(target: Kernel): Promise<void> {
  const result = await target.execute({
    type: "workflow.register",
    idempotencyKey: "workflow",
    actor: operator,
    payload: workflow
  });
  expect(result.ok).toBe(true);
}

async function registerRevision(target: Kernel): Promise<void> {
  const identity = {
    repositoryId: ids.repository,
    objectFormat: "sha1" as const,
    commitOid: "a".repeat(40),
    treeOid: "b".repeat(40)
  };
  const result = await target.execute({
    type: "source-revision.register",
    idempotencyKey: "revision",
    actor: operator,
    payload: {
      revisionId: ids.revision,
      ...identity,
      storageRef: `refs/parallelplay/revisions/${ids.revision}`,
      revisionDigest: sourceRevisionDigest(identity)
    }
  });
  expect(result.ok).toBe(true);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("milestone approval and start contracts", () => {
  it("approves one immutable milestone and atomically schedules its one real job", async () => {
    const path = await databasePath();
    const target = kernel(path);
    try {
      await registerWorkflow(target);
      await registerRevision(target);
      const approval = await target.execute({
        type: "program.approve",
        idempotencyKey: "approve",
        actor: operator,
        payload: approvalBundle
      });
      expect(approval.ok && approval.events.map((event) => event.type)).toEqual([
        "ProgramCreated",
        "ProgramApproved",
        "MilestoneApproved"
      ]);
      expect(approval.ok && approval.data).toMatchObject({
        kind: "milestone",
        milestoneId: ids.milestone,
        status: "approved",
        approvedBy: operator.id
      });

      const replay = await target.execute({
        type: "program.approve",
        idempotencyKey: "approve",
        actor: operator,
        payload: approvalBundle
      });
      expect(replay).toMatchObject({ ok: true, replayed: true });

      const start = await target.execute({
        type: "milestone.start",
        idempotencyKey: "start",
        actor: operator,
        payload: {
          schemaVersion: 1,
          milestoneId: ids.milestone,
          runId: ids.run,
          jobId: ids.job,
          sourceRevisionId: ids.revision,
          policy: { maxAttempts: 2, attemptTimeoutMs: 5_000, retryDelaysMs: [250] }
        }
      });
      expect(start.ok && start.events.map((event) => event.type)).toEqual([
        "MilestoneStarted",
        "MilestoneRunCreated",
        "JobScheduled",
        "RunScheduled"
      ]);
      expect(await target.getState({ kind: "milestone", id: ids.milestone })).toMatchObject({
        status: "running",
        runId: ids.run,
        jobId: ids.job,
        baseRevisionId: ids.revision
      });
      expect(await target.getState({ kind: "job", id: ids.job })).toMatchObject({
        status: "ready",
        sourceRevisionId: ids.revision,
        executionContract: workflow.steps[0]?.execution,
        capabilityManifest: workflow.steps[0]?.capabilities
      });

      const duplicate = await target.execute({
        type: "milestone.start",
        idempotencyKey: "start-again",
        actor: operator,
        payload: {
          schemaVersion: 1,
          milestoneId: ids.milestone,
          runId: "10000000-0000-4000-8000-000000000008",
          jobId: "10000000-0000-4000-8000-000000000009",
          sourceRevisionId: ids.revision,
          policy: { maxAttempts: 1, attemptTimeoutMs: 5_000, retryDelaysMs: [] }
        }
      });
      expect(duplicate).toMatchObject({
        ok: false,
        error: { code: "MILESTONE_NOT_STARTABLE" }
      });

      const cancellation = await target.execute({
        type: "run.cancel",
        idempotencyKey: "cancel",
        actor: operator,
        payload: { runId: ids.run, reason: "Operator stopped the milestone" }
      });
      expect(cancellation.ok && cancellation.events.map((event) => event.type)).toEqual([
        "JobCancelled",
        "RunCancelled",
        "OutcomePacketRecorded",
        "MilestoneOutcomeReady"
      ]);
      const packets = await target.listOutcomePackets(ids.program);
      expect(packets).toHaveLength(1);
      const packet = packets[0];
      if (!packet) throw new Error("outcome packet missing");
      expect(packet).toMatchObject({
        programId: ids.program,
        milestoneId: ids.milestone,
        runId: ids.run
      });
      expect(packet.packet).toMatchObject({
        recommendation: "investigate",
        candidateRevisionId: null,
        terminalReason: "Operator stopped the milestone"
      });
      expect(await target.verifyOutcomePacket(packet.outcomePacketId)).toMatchObject({
        valid: true,
        failures: []
      });
      expect(await target.getState({ kind: "milestone", id: ids.milestone })).toMatchObject({
        status: "outcome_ready",
        recommendation: "investigate",
        outcomePacketId: packet.outcomePacketId
      });
      expect(await target.verifyProjections()).toMatchObject({ valid: true, eventCount: 13 });

      const external = new Database(path, { fileMustExist: true });
      external
        .prepare("UPDATE source_revisions_projection SET revision_digest = ? WHERE revision_id = ?")
        .run("0".repeat(64), ids.revision);
      const sourceTampering = await target.verifyOutcomePacket(packet.outcomePacketId);
      expect(sourceTampering.valid).toBe(false);
      expect(sourceTampering.failures).toContain("base source revision digest mismatch");
      external
        .prepare(
          "UPDATE outcome_packets_projection SET packet_json = json_set(packet_json, '$.summary', 'tampered') WHERE outcome_packet_id = ?"
        )
        .run(packet.outcomePacketId);
      external.close();
      const packetTampering = await target.verifyOutcomePacket(packet.outcomePacketId);
      expect(packetTampering.valid).toBe(false);
      expect(packetTampering.failures).toContain(
        "Outcome packet projection digest does not match its content"
      );
    } finally {
      await target.close();
    }
  });

  it("rejects non-operator approval and an incorrect criterion binding", async () => {
    const path = await databasePath();
    const target = kernel(path);
    try {
      await registerWorkflow(target);
      expect(
        await target.execute({
          type: "program.approve",
          idempotencyKey: "system-approve",
          actor: system,
          payload: approvalBundle
        })
      ).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRES_OPERATOR" } });
      expect(
        await target.execute({
          type: "program.approve",
          idempotencyKey: "bad-binding",
          actor: operator,
          payload: {
            ...approvalBundle,
            milestone: {
              ...approvalBundle.milestone,
              criteria: [
                {
                  ...approvalBundle.milestone.criteria[0],
                  verificationStepId: "different-step"
                }
              ]
            }
          }
        })
      ).toMatchObject({ ok: false, error: { code: "SCHEDULE_MISMATCH" } });
      expect(await target.listPrograms()).toEqual([]);
      expect(await target.listMilestones()).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it("rolls approval and start back completely at the transaction fault boundary", async () => {
    const path = await databasePath();
    let target = kernel(path);
    await registerWorkflow(target);
    await registerRevision(target);
    await target.close();

    target = kernel(path, () => {
      throw new Error("injected transaction fault");
    });
    await expect(
      target.execute({
        type: "program.approve",
        idempotencyKey: "approve-fault",
        actor: operator,
        payload: approvalBundle
      })
    ).rejects.toThrow("injected transaction fault");
    await target.close();

    target = kernel(path);
    expect(await target.getState({ kind: "program", id: ids.program })).toBeNull();
    expect(await target.getState({ kind: "milestone", id: ids.milestone })).toBeNull();
    expect(
      await target.execute({
        type: "program.approve",
        idempotencyKey: "approve-fault",
        actor: operator,
        payload: approvalBundle
      })
    ).toMatchObject({ ok: true, replayed: false });
    await target.close();

    target = kernel(path, () => {
      throw new Error("injected transaction fault");
    });
    const startCommand = {
      type: "milestone.start" as const,
      idempotencyKey: "start-fault",
      actor: operator,
      payload: {
        schemaVersion: 1 as const,
        milestoneId: ids.milestone,
        runId: ids.run,
        jobId: ids.job,
        sourceRevisionId: ids.revision,
        policy: { maxAttempts: 1, attemptTimeoutMs: 5_000, retryDelaysMs: [] }
      }
    };
    await expect(target.execute(startCommand)).rejects.toThrow("injected transaction fault");
    await target.close();

    target = kernel(path);
    expect(await target.getState({ kind: "run", id: ids.run })).toBeNull();
    expect(await target.getState({ kind: "job", id: ids.job })).toBeNull();
    expect(await target.getState({ kind: "milestone", id: ids.milestone })).toMatchObject({
      status: "approved",
      runId: null
    });
    expect(await target.execute(startCommand)).toMatchObject({ ok: true, replayed: false });
    await target.close();
  });

  it("opens a query-only SQLite handle for public milestone snapshots", async () => {
    const path = await databasePath();
    const writable = kernel(path);
    await registerWorkflow(writable);
    expect(
      await writable.execute({
        type: "program.approve",
        idempotencyKey: "approve-read-only",
        actor: operator,
        payload: approvalBundle
      })
    ).toMatchObject({ ok: true });
    await writable.close();

    const readOnly = await openReadOnlyKernel({ databasePath: path });
    try {
      expect(await readOnly.getMilestoneSnapshot(ids.milestone)).toMatchObject({
        snapshotVersion: 1,
        program: { programId: ids.program },
        milestone: { milestoneId: ids.milestone, status: "approved" },
        run: null,
        outcomePacket: null
      });
      await expect(
        (readOnly as Kernel).execute({
          type: "program.create",
          idempotencyKey: "forbidden-write",
          actor: operator,
          payload: {
            programId: "10000000-0000-4000-8000-000000000099",
            name: "Forbidden"
          }
        })
      ).rejects.toThrow("Read-only kernel");
    } finally {
      await readOnly.close();
    }
  });
});
