import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase, openKernel } from "@parallelplay/kernel";
import type { Clock, IdGenerator, Kernel } from "@parallelplay/kernel";
import { SqliteFakeAgentDriver, migrateFakeAgentDatabase } from "./fake-agent.js";
import { Supervisor } from "./supervisor.js";
import type { AgentDriver } from "./driver.js";
import { FileArtifactStore, initializeArtifactStore } from "./artifact-store.js";
import { ManagedGitRevisionStore, initializeSourceStore } from "./source-store.js";
import { TrustedCommandVerifier } from "./verifier.js";
import { verifyEvidence } from "./evidence.js";

const programId = "00000000-0000-4000-8000-000000000001";
const workflowId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const jobId = "00000000-0000-4000-8000-000000000004";
const supervisorA = "00000000-0000-4000-8000-000000000005";
const supervisorB = "00000000-0000-4000-8000-000000000006";
const secondJobId = "00000000-0000-4000-8000-000000000009";
const actor = { kind: "operator", id: "runtime-test" } as const;
const repositoryId = "00000000-0000-4000-8000-000000000011";
const sourceRevisionId = "00000000-0000-4000-8000-000000000012";
const milestoneId = "00000000-0000-4000-8000-000000000013";
const verificationContract = {
  mode: "verify" as const,
  argv: ["./verify.sh"],
  cwd: "." as const,
  timeoutMs: 5_000,
  environment: {},
  toolProbes: []
};
const executionContract = {
  protocolVersion: 1 as const,
  image: `parallelplay-fixture@sha256:${"0".repeat(64)}`,
  argv: ["/bin/true"],
  workingDirectory: "/workspace" as const
};
const capabilityManifest = {
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
};

class ManualClock implements Clock {
  #milliseconds = Date.parse("2026-08-18T12:00:00.000Z");

  now(): Date {
    return new Date(this.#milliseconds);
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }
}

class SequenceIds implements IdGenerator {
  #next: number;

  constructor(start = 100) {
    this.#next = start;
  }

  next(): string {
    const value = `00000000-0000-4000-8000-${String(this.#next).padStart(12, "0")}`;
    this.#next += 1;
    return value;
  }
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(
  capability = "fake.immediate-success",
  maxAttempts = 3,
  secondCapability?: string,
  verifierScript = "#!/bin/sh\nexit 0\n",
  milestone = false,
  verifierTimeoutMs = 5_000
): Promise<{
  clock: ManualClock;
  kernel: Kernel;
  databasePath: string;
  driverPath: string;
  verifier: TrustedCommandVerifier;
  sourceStore: ManagedGitRevisionStore;
  artifactStore: FileArtifactStore;
}> {
  const fixtureVerificationContract = { ...verificationContract, timeoutMs: verifierTimeoutMs };
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-runtime-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  const driverPath = join(directory, "fake-agent.db");
  const sourceRoot = join(directory, "source-store");
  const artifactRoot = join(directory, "artifact-store");
  const repositoryPath = join(directory, "fixture-repo");
  execFileSync("git", ["init", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "ParallelPlay Test"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "parallelplay@example.test"]);
  const verifierPath = join(repositoryPath, "verify.sh");
  writeFileSync(verifierPath, verifierScript);
  chmodSync(verifierPath, 0o755);
  execFileSync("git", ["-C", repositoryPath, "add", "verify.sh"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-m", "fixture"]);
  initializeSourceStore(sourceRoot);
  initializeArtifactStore(artifactRoot);
  const sourceStore = new ManagedGitRevisionStore(sourceRoot);
  const captured = await sourceStore.capture({
    repositoryId,
    revisionId: sourceRevisionId,
    captureKey: "runtime-fixture-revision",
    repositoryPath,
    ref: "HEAD"
  });
  const artifactStore = new FileArtifactStore(artifactRoot);
  const verifier = new TrustedCommandVerifier({ sourceStore, artifactStore });
  const clock = new ManualClock();
  await migrateDatabase({ databasePath, clock });
  await migrateFakeAgentDatabase({ databasePath: driverPath, clock });
  const kernel = await openKernel({ databasePath, clock, idGenerator: new SequenceIds() });
  for (const command of [
    {
      type: "source-revision.register" as const,
      idempotencyKey: "revision",
      actor,
      payload: captured
    },
    {
      type: "workflow.register" as const,
      idempotencyKey: "workflow",
      actor,
      payload: {
        workflowId,
        version: 1,
        name: "Workflow",
        schemaVersion: 2,
        steps: [
          {
            id: "execute",
            capability,
            dependsOn: [],
            execution: executionContract,
            capabilities: capabilityManifest,
            verification: fixtureVerificationContract
          },
          ...(secondCapability
            ? [
                {
                  id: "other",
                  capability: secondCapability,
                  dependsOn: [],
                  execution: executionContract,
                  capabilities: capabilityManifest,
                  verification: fixtureVerificationContract
                }
              ]
            : [])
        ]
      }
    }
  ]) {
    expect((await kernel.execute(command)).ok).toBe(true);
  }
  if (milestone) {
    expect(
      await kernel.execute({
        type: "program.approve",
        idempotencyKey: "program-approval",
        actor,
        payload: {
          schemaVersion: 1,
          program: {
            programId,
            name: "Milestone recovery program",
            intent: {
              schemaVersion: 1,
              objective: "Prove milestone recovery across every supervisor boundary.",
              nonGoals: ["No Git authority"],
              tenets: ["Replay is authoritative", "Evidence is immutable", "Recovery converges"],
              riskClass: "normal"
            }
          },
          milestone: {
            schemaVersion: 1,
            milestoneId,
            title: "Recover one milestone",
            objective: "Reach one valid terminal outcome after a supervisor restart.",
            taskType: "chore",
            priority: "p1",
            tags: ["milestone", "recovery"],
            workflowId,
            workflowVersion: 1,
            criteria: [
              {
                criterionId: "verification-completes",
                statement: "The immutable source revision passes verification.",
                verificationStepId: "execute"
              }
            ]
          }
        }
      })
    ).toMatchObject({ ok: true });
    expect(
      await kernel.execute({
        type: "milestone.start",
        idempotencyKey: "milestone-start",
        actor,
        payload: {
          schemaVersion: 1,
          milestoneId,
          runId,
          jobId,
          sourceRevisionId,
          policy: {
            maxAttempts,
            attemptTimeoutMs: 300_000,
            retryDelaysMs: Array.from({ length: maxAttempts - 1 }, () => 0)
          }
        }
      })
    ).toMatchObject({ ok: true });
  } else {
    for (const command of [
      {
        type: "program.create" as const,
        idempotencyKey: "program",
        actor,
        payload: { programId, name: "Program" }
      },
      {
        type: "run.create" as const,
        idempotencyKey: "run",
        actor,
        payload: { runId, programId, workflowId, workflowVersion: 1 }
      },
      {
        type: "run.schedule" as const,
        idempotencyKey: "schedule",
        actor,
        payload: {
          runId,
          jobs: [
            {
              jobId,
              stepId: "execute",
              sourceRevisionId,
              policy: {
                maxAttempts,
                attemptTimeoutMs: 300_000,
                retryDelaysMs: Array.from({ length: maxAttempts - 1 }, () => 0)
              }
            },
            ...(secondCapability
              ? [
                  {
                    jobId: secondJobId,
                    stepId: "other",
                    sourceRevisionId,
                    policy: {
                      maxAttempts,
                      attemptTimeoutMs: 300_000,
                      retryDelaysMs: Array.from({ length: maxAttempts - 1 }, () => 0)
                    }
                  }
                ]
              : [])
          ]
        }
      }
    ]) {
      expect((await kernel.execute(command)).ok).toBe(true);
    }
  }
  return { clock, kernel, databasePath, driverPath, verifier, sourceStore, artifactStore };
}

describe("durable runtime", () => {
  it("runs a scheduled job to success and derives an execution trace", async () => {
    const { clock, kernel, databasePath, driverPath, verifier, sourceStore, artifactStore } =
      await fixture();
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const supervisor = new Supervisor({
      kernel,
      driver,
      verifier,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    try {
      expect((await supervisor.tick()).action).toBe("job_acquired");
      expect((await supervisor.tick()).action).toBe("outbox_acquired");
      expect((await supervisor.tick()).action).toBe("outbox_delivered");
      const activeJob = await kernel.getState({ kind: "job", id: jobId });
      if (activeJob?.kind !== "job" || !activeJob.activeAttemptId) {
        throw new Error("missing active attempt");
      }
      expect((await supervisor.tick()).action).toBe("verification_requested");
      const competingSupervisor = new Supervisor({
        kernel,
        driver,
        verifier,
        supervisorId: supervisorB,
        clock,
        idGenerator: new SequenceIds(900)
      });
      expect((await competingSupervisor.tick()).action).toBe("idle");
      expect((await supervisor.tick()).action).toBe("outbox_acquired");
      expect((await supervisor.tick()).action).toBe("verification_passed");
      const recordedVerification = (await kernel.listVerifications())[0];
      const verificationOutbox = (await kernel.listOutbox()).find(
        (message) => message.effect.effectType === "verification.run"
      );
      if (!recordedVerification || !verificationOutbox) throw new Error("missing verification");
      const completion = {
        type: "attempt.observe" as const,
        idempotencyKey: `attempt-succeeded:${activeJob.activeAttemptId}:${String(activeJob.leaseFencingToken)}:${supervisorA}`,
        actor: { kind: "system" as const, id: supervisorA },
        correlationId: runId,
        payload: {
          jobId,
          attemptId: activeJob.activeAttemptId,
          ownerId: supervisorA,
          fencingToken: activeJob.leaseFencingToken,
          outcome: "succeeded" as const,
          verificationId: recordedVerification.verificationId,
          verificationOutboxId: verificationOutbox.outboxId
        }
      };
      const eventCount = (await kernel.listEvents({ limit: 1000 })).events.length;
      expect(await kernel.execute(completion)).toMatchObject({ ok: true, replayed: true });
      expect(
        await kernel.execute({ ...completion, idempotencyKey: "delayed-terminal-completion" })
      ).toMatchObject({ ok: false, error: { code: "JOB_LEASE_CONFLICT" } });
      const deliveredOutbox = (await kernel.listOutbox())[0];
      if (!deliveredOutbox) throw new Error("missing delivered outbox");
      expect(
        await kernel.execute({
          type: "outbox.lease.acquire",
          idempotencyKey: "terminal-outbox-reacquire",
          actor: { kind: "system", id: supervisorB },
          correlationId: runId,
          payload: {
            outboxId: deliveredOutbox.outboxId,
            ownerId: supervisorB,
            leaseDurationMs: 10_000
          }
        })
      ).toMatchObject({ ok: false, error: { code: "OUTBOX_NOT_CLAIMABLE" } });
      expect((await kernel.listEvents({ limit: 1000 })).events).toHaveLength(eventCount);
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({
        status: "succeeded"
      });
      const trace = await kernel.getExecutionTrace(runId);
      expect(trace?.traceId).toBe(runId);
      expect(trace?.records.map((record) => record.type)).toEqual(
        expect.arrayContaining(["AttemptStarted", "OutboxDelivered", "RunSucceeded"])
      );
      expect(trace?.records.find((record) => record.type === "OutboxDelivered")?.jobId).toBe(jobId);
      expect(trace?.records.find((record) => record.type === "RunSucceeded")?.status).toBe(
        "succeeded"
      );
      const primaryRunPositions = (await kernel.listEvents({ limit: 1000 })).events
        .filter((event) => (event.data as { runId?: string }).runId === runId)
        .map((event) => event.globalPosition);
      expect(trace?.records.map((record) => record.globalPosition)).toEqual(primaryRunPositions);
      expect(await kernel.verifyProjections()).toMatchObject({
        valid: true,
        projectionSchemaVersion: 1
      });
      const external = new Database(databasePath, { fileMustExist: true });
      external.exec(`
        DELETE FROM verifications_projection;
        DELETE FROM artifact_manifests_projection;
        DELETE FROM outbox_projection;
        DELETE FROM attempts_projection;
        DELETE FROM job_dependencies_projection;
        DELETE FROM jobs_projection;
        DELETE FROM runs_projection;
        DELETE FROM workflows_projection;
        DELETE FROM programs_projection;
        DELETE FROM source_revisions_projection;
      `);
      external.close();
      expect(await kernel.verifyProjections()).toMatchObject({ valid: false });
      expect(await kernel.rebuildProjections()).toMatchObject({
        projectionSchemaVersion: 1
      });
      expect(await kernel.verifyProjections()).toMatchObject({ valid: true });
      expect(
        await verifyEvidence({
          kernel,
          sourceStore,
          artifactStore,
          verificationId: recordedVerification.verificationId
        })
      ).toMatchObject({ valid: true, failures: [] });
      const recordedManifest = await kernel.getState({
        kind: "artifact_manifest",
        id: recordedVerification.artifactManifestId ?? ""
      });
      if (recordedManifest?.kind !== "artifact_manifest" || !recordedManifest.entries[0]) {
        throw new Error("missing artifact manifest");
      }
      const completedJob = await kernel.getState({ kind: "job", id: jobId });
      if (
        completedJob?.kind !== "job" ||
        !recordedVerification.result ||
        !recordedVerification.resultDigest ||
        !recordedVerification.receiptDigest
      ) {
        throw new Error("missing terminal verification evidence");
      }
      const verificationCompletion = {
        type: "verification.complete" as const,
        idempotencyKey: `verification-complete:${recordedVerification.verificationId}:${String(verificationOutbox.leaseFencingToken)}:${supervisorA}`,
        actor: { kind: "system" as const, id: supervisorA },
        correlationId: runId,
        payload: {
          verificationId: recordedVerification.verificationId,
          outboxId: verificationOutbox.outboxId,
          artifactManifestId: recordedManifest.artifactManifestId,
          jobId,
          attemptId: recordedVerification.attemptId,
          ownerId: supervisorA,
          jobFencingToken: completedJob.leaseFencingToken,
          outboxFencingToken: verificationOutbox.leaseFencingToken,
          result: recordedVerification.result,
          resultDigest: recordedVerification.resultDigest,
          receiptDigest: recordedVerification.receiptDigest,
          entries: recordedManifest.entries
        }
      };
      expect(await kernel.execute(verificationCompletion)).toMatchObject({
        ok: true,
        replayed: true
      });
      const terminalEventCount = (await kernel.listEvents({ limit: 1000 })).events.length;
      expect(
        await kernel.execute({
          ...verificationCompletion,
          idempotencyKey: "delayed-verification-completion"
        })
      ).toMatchObject({ ok: false, error: { code: "VERIFICATION_NOT_ACTIVE" } });
      expect((await kernel.listEvents({ limit: 1000 })).events).toHaveLength(terminalEventCount);
      const evidenceDatabase = new Database(databasePath, { fileMustExist: true });
      const changedEntries = recordedManifest.entries.map((entry, index) =>
        index === 0 ? { ...entry, size: entry.size + 1 } : entry
      );
      evidenceDatabase
        .prepare(
          "UPDATE artifact_manifests_projection SET entries_json = ? WHERE artifact_manifest_id = ?"
        )
        .run(JSON.stringify(changedEntries), recordedManifest.artifactManifestId);
      expect(
        await verifyEvidence({
          kernel,
          sourceStore,
          artifactStore,
          verificationId: recordedVerification.verificationId
        })
      ).toMatchObject({ valid: false });
      evidenceDatabase
        .prepare(
          "UPDATE artifact_manifests_projection SET entries_json = ? WHERE artifact_manifest_id = ?"
        )
        .run(JSON.stringify(recordedManifest.entries), recordedManifest.artifactManifestId);
      evidenceDatabase
        .prepare("UPDATE verifications_projection SET receipt_digest = ? WHERE verification_id = ?")
        .run("0".repeat(64), recordedVerification.verificationId);
      const receiptIntegrity = await verifyEvidence({
        kernel,
        sourceStore,
        artifactStore,
        verificationId: recordedVerification.verificationId
      });
      expect(receiptIntegrity.valid).toBe(false);
      expect(receiptIntegrity.failures).toContain("receipt digest mismatch");
      evidenceDatabase
        .prepare("UPDATE verifications_projection SET receipt_digest = ? WHERE verification_id = ?")
        .run(recordedVerification.receiptDigest, recordedVerification.verificationId);
      const recordedRevision = await kernel.getState({
        kind: "source_revision",
        id: sourceRevisionId
      });
      if (recordedRevision?.kind !== "source_revision") throw new Error("missing source revision");
      for (const [column, original] of [
        ["commit_oid", recordedRevision.commitOid],
        ["tree_oid", recordedRevision.treeOid]
      ] as const) {
        evidenceDatabase
          .prepare(`UPDATE source_revisions_projection SET ${column} = ? WHERE revision_id = ?`)
          .run("0".repeat(original.length), sourceRevisionId);
        expect(
          await verifyEvidence({
            kernel,
            sourceStore,
            artifactStore,
            verificationId: recordedVerification.verificationId
          })
        ).toMatchObject({ valid: false });
        evidenceDatabase
          .prepare(`UPDATE source_revisions_projection SET ${column} = ? WHERE revision_id = ?`)
          .run(original, sourceRevisionId);
      }
      evidenceDatabase.close();
      writeFileSync(artifactStore.objectPath(recordedManifest.entries[0].sha256), "tampered");
      expect(
        await verifyEvidence({
          kernel,
          sourceStore,
          artifactStore,
          verificationId: recordedVerification.verificationId
        })
      ).toMatchObject({ valid: false });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("adopts one active attempt with a higher fence and rejects the old owner", async () => {
    const { clock, kernel, driverPath } = await fixture("fake.success-after-2");
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const first = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    const second = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorB,
      clock,
      idGenerator: new SequenceIds(800)
    });
    try {
      await first.tick();
      await first.tick();
      await first.tick();
      const before = await kernel.getState({ kind: "job", id: jobId });
      expect(before?.kind === "job" && before.activeAttemptId).toBeTruthy();
      if (before?.kind !== "job" || !before.activeAttemptId) throw new Error("fixture");
      clock.advance(30_001);
      expect((await second.tick()).action).toBe("job_reclaimed");
      const adopted = await kernel.getState({ kind: "job", id: jobId });
      expect(adopted).toMatchObject({
        activeAttemptId: before.activeAttemptId,
        leaseOwnerId: supervisorB,
        leaseFencingToken: before.leaseFencingToken + 1
      });
      const stale = await kernel.execute({
        type: "attempt.observe",
        idempotencyKey: "stale-completion",
        actor: { kind: "system", id: supervisorA },
        correlationId: runId,
        payload: {
          jobId,
          attemptId: before.activeAttemptId,
          ownerId: supervisorA,
          fencingToken: before.leaseFencingToken,
          outcome: "succeeded"
        }
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "JOB_LEASE_CONFLICT" } });
      const eventCount = (await kernel.listEvents({ limit: 1000 })).events.length;
      expect(
        await kernel.execute({
          type: "attempt.observe",
          idempotencyKey: "stale-completion-2",
          actor: { kind: "system", id: supervisorA },
          correlationId: runId,
          payload: {
            jobId,
            attemptId: before.activeAttemptId,
            ownerId: supervisorA,
            fencingToken: before.leaseFencingToken,
            outcome: "succeeded"
          }
        })
      ).toMatchObject({ ok: false });
      expect((await kernel.listEvents({ limit: 1000 })).events).toHaveLength(eventCount);
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("fails valid nonzero verification without consuming retry attempts", async () => {
    const { clock, kernel, driverPath, verifier } = await fixture(
      "fake.immediate-success",
      3,
      undefined,
      "#!/bin/sh\nexit 12\n"
    );
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const supervisor = new Supervisor({
      kernel,
      driver,
      verifier,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    try {
      for (let tick = 0; tick < 5; tick += 1) await supervisor.tick();
      expect((await supervisor.tick()).action).toBe("verification_failed");
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      expect(await kernel.getState({ kind: "job", id: jobId })).toMatchObject({
        status: "failed",
        attemptCount: 1
      });
      expect((await kernel.listVerifications())[0]).toMatchObject({
        status: "failed",
        exitCode: 12,
        failureReason: "verifier_exit_12"
      });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("turns a verifier timeout into a retryable timed-out attempt", async () => {
    const { clock, kernel, driverPath, verifier } = await fixture(
      "fake.immediate-success",
      2,
      undefined,
      "#!/bin/sh\n/bin/sleep 2\nexit 0\n",
      false,
      1_000
    );
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const supervisor = new Supervisor({
      kernel,
      driver,
      verifier,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    try {
      for (let tick = 0; tick < 5; tick += 1) await supervisor.tick();
      expect((await supervisor.tick()).action).toBe("attempt_timed_out");
      expect(await kernel.getState({ kind: "job", id: jobId })).toMatchObject({
        status: "retry_wait",
        attemptCount: 1
      });
      expect((await kernel.listVerifications())[0]).toMatchObject({ status: "cancelled" });
      expect(
        (await kernel.listOutbox()).find(
          (message) => message.effect.effectType === "verification.run"
        )
      ).toMatchObject({ status: "obsolete" });
      expect((await supervisor.tick()).action).toBe("outbox_acquired");
      expect((await supervisor.tick()).action).toBe("outbox_delivered");
      expect((await supervisor.tick()).action).toBe("job_acquired");
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("obsoletes pending verification evidence when an operator cancels", async () => {
    const { clock, kernel, driverPath, verifier } = await fixture();
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const supervisor = new Supervisor({
      kernel,
      driver,
      verifier,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    try {
      for (let tick = 0; tick < 3; tick += 1) await supervisor.tick();
      expect((await supervisor.tick()).action).toBe("verification_requested");
      expect(
        await kernel.execute({
          type: "run.cancel",
          idempotencyKey: "cancel-pending-verification",
          actor,
          correlationId: runId,
          payload: { runId, reason: "stop before grading" }
        })
      ).toMatchObject({ ok: true, data: { status: "cancelled" } });
      expect((await kernel.listVerifications())[0]).toMatchObject({ status: "cancelled" });
      expect(
        (await kernel.listOutbox()).find(
          (message) => message.effect.effectType === "verification.run"
        )
      ).toMatchObject({ status: "obsolete" });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("retries deterministic failures and fails fast when attempts are exhausted", async () => {
    const { clock, kernel, driverPath } = await fixture("fake.retryable-failure", 2);
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const supervisor = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    try {
      for (let tick = 0; tick < 20; tick += 1) {
        await supervisor.tick();
        const run = await kernel.getState({ kind: "run", id: runId });
        if (run?.kind === "run" && run.status === "failed") break;
      }
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      expect(await kernel.getState({ kind: "job", id: jobId })).toMatchObject({
        status: "failed",
        attemptCount: 2
      });
      const attempts = (await kernel.listEvents({ limit: 1000 })).events.filter(
        (event) => event.type === "AttemptStarted"
      );
      expect(attempts).toHaveLength(2);
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("fails fast across active jobs and dispatches cancellation for the surviving external run", async () => {
    const { clock, kernel, driverPath } = await fixture("fake.hang", 1, "fake.retryable-failure");
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const first = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    const second = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorB,
      clock,
      idGenerator: new SequenceIds(800)
    });
    try {
      await first.tick();
      await first.tick();
      await first.tick();
      const hangingJob = await kernel.getState({ kind: "job", id: jobId });
      if (hangingJob?.kind !== "job" || !hangingJob.activeAttemptId) {
        throw new Error("missing hanging attempt");
      }
      const hangingAttempt = await kernel.getState({
        kind: "attempt",
        id: hangingJob.activeAttemptId
      });
      if (hangingAttempt?.kind !== "attempt" || !hangingAttempt.externalRunId) {
        throw new Error("missing hanging external run");
      }
      expect((await second.tick()).action).toBe("job_acquired");
      expect((await second.tick()).action).toBe("outbox_acquired");
      expect((await second.tick()).action).toBe("outbox_delivered");
      expect((await second.tick()).action).toBe("attempt_failed");
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      expect(await kernel.getState({ kind: "job", id: jobId })).toMatchObject({
        status: "cancelled"
      });
      expect(await kernel.getState({ kind: "job", id: secondJobId })).toMatchObject({
        status: "failed"
      });
      expect(await kernel.listOutbox({ statuses: ["pending"] })).toMatchObject([
        {
          effect: {
            effectType: "agent.cancel",
            externalRunId: hangingAttempt.externalRunId
          }
        }
      ]);
      expect((await second.tick()).action).toBe("outbox_acquired");
      expect((await second.tick()).action).toBe("outbox_delivered");
      expect(await driver.inspect(hangingAttempt.externalRunId)).toMatchObject({
        status: "operator_cancelled"
      });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("deduplicates start and cancel effects across driver connections", async () => {
    const { clock, kernel, driverPath } = await fixture();
    const request = { capability: "fake.hang", attemptId: jobId, jobId, runId };
    const first = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const externalRunId = await first.start(jobId, request);
    await first.close();
    const second = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    try {
      expect(await second.start(jobId, request)).toBe(externalRunId);
      expect(await second.cancel(runId, externalRunId)).toBe("cancelled");
      expect(await second.cancel(runId, externalRunId)).toBe("cancelled");
    } finally {
      await second.close();
      await kernel.close();
    }
  });

  it("fences competing kernel connections for both jobs and outbox messages", async () => {
    const { clock, kernel, databasePath } = await fixture("fake.hang");
    const competitor = await openKernel({
      databasePath,
      clock,
      idGenerator: new SequenceIds(900)
    });
    try {
      const firstLease = await kernel.execute({
        type: "job.lease.acquire",
        idempotencyKey: "first-job-owner",
        actor: { kind: "system", id: supervisorA },
        correlationId: runId,
        payload: {
          jobId,
          ownerId: supervisorA,
          leaseDurationMs: 30_000,
          attemptId: "00000000-0000-4000-8000-000000000500",
          startOutboxId: "00000000-0000-4000-8000-000000000501"
        }
      });
      expect(firstLease).toMatchObject({ ok: true });
      expect(
        await competitor.execute({
          type: "job.lease.acquire",
          idempotencyKey: "second-job-owner",
          actor: { kind: "system", id: supervisorB },
          correlationId: runId,
          payload: {
            jobId,
            ownerId: supervisorB,
            leaseDurationMs: 30_000,
            attemptId: "00000000-0000-4000-8000-000000000600",
            startOutboxId: "00000000-0000-4000-8000-000000000601"
          }
        })
      ).toMatchObject({ ok: false, error: { code: "JOB_LEASE_CONFLICT" } });
      expect(
        await kernel.execute({
          type: "outbox.lease.acquire",
          idempotencyKey: "first-outbox-owner",
          actor: { kind: "system", id: supervisorA },
          correlationId: runId,
          payload: {
            outboxId: "00000000-0000-4000-8000-000000000501",
            ownerId: supervisorA,
            leaseDurationMs: 10_000
          }
        })
      ).toMatchObject({ ok: true });
      expect(
        await competitor.execute({
          type: "outbox.lease.acquire",
          idempotencyKey: "second-outbox-owner",
          actor: { kind: "system", id: supervisorB },
          correlationId: runId,
          payload: {
            outboxId: "00000000-0000-4000-8000-000000000501",
            ownerId: supervisorB,
            leaseDurationMs: 10_000
          }
        })
      ).toMatchObject({ ok: false, error: { code: "OUTBOX_NOT_CLAIMABLE" } });
    } finally {
      await competitor.close();
      await kernel.close();
    }
  });

  it("recovers after a crash following fake start without duplicating the logical effect", async () => {
    const { clock, kernel, driverPath } = await fixture("fake.hang");
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const crashing = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500),
      faultInjector: (point) => {
        if (point === "after-effect-call") throw new Error("simulated process crash");
      }
    });
    try {
      await crashing.tick();
      await crashing.tick();
      await expect(crashing.tick()).rejects.toThrow("simulated process crash");
      expect(await kernel.listOutbox()).toMatchObject([{ status: "leased" }]);
      clock.advance(10_001);
      const recovered = new Supervisor({
        kernel,
        driver,
        supervisorId: supervisorB,
        clock,
        idGenerator: new SequenceIds(800)
      });
      expect((await recovered.tick()).action).toBe("outbox_reclaimed");
      expect((await recovered.tick()).action).toBe("outbox_delivered");
      const database = new Database(driverPath, { fileMustExist: true });
      const logicalStarts = database
        .prepare("SELECT COUNT(*) AS count FROM fake_effects WHERE effect_type = 'agent.start'")
        .get() as { count: number };
      const physicalCalls = database
        .prepare("SELECT call_count AS count FROM fake_effects WHERE effect_type = 'agent.start'")
        .get() as { count: number };
      database.close();
      expect(logicalStarts.count).toBe(1);
      expect(physicalCalls.count).toBe(2);
      expect(
        await kernel.getState({
          kind: "attempt",
          id: (await kernel.listJobs())[0]?.activeAttemptId ?? ""
        })
      ).toMatchObject({
        status: "running"
      });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it.each([
    "after-job-lease",
    "before-effect-call",
    "after-effect-call",
    "after-outbox-receipt",
    "after-inspect-call",
    "after-attempt-result",
    "before-verifier-call",
    "after-verifier-call",
    "after-verification-receipt"
  ] as const)(
    "reconstructs the milestone and its one outcome after a crash at %s",
    async (faultPoint) => {
      const { clock, kernel, databasePath, driverPath, verifier } = await fixture(
        "fake.immediate-success",
        3,
        undefined,
        "#!/bin/sh\nexit 0\n",
        true
      );
      const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
      const crashing = new Supervisor({
        kernel,
        driver,
        verifier,
        supervisorId: supervisorA,
        clock,
        idGenerator: new SequenceIds(500),
        faultInjector: (point) => {
          if (point === faultPoint) throw new Error(`crash:${faultPoint}`);
        }
      });
      let crashed = false;
      try {
        for (let tick = 0; tick < 20; tick += 1) {
          try {
            await crashing.tick();
            clock.advance(250);
          } catch (error) {
            expect(error).toMatchObject({ message: `crash:${faultPoint}` });
            crashed = true;
            break;
          }
        }
        expect(crashed).toBe(true);
      } finally {
        await driver.close();
        await kernel.close();
      }

      clock.advance(30_001);
      const recoveredKernel = await openKernel({
        databasePath,
        clock,
        idGenerator: new SequenceIds(900)
      });
      const recoveredDriver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
      const recovered = new Supervisor({
        kernel: recoveredKernel,
        driver: recoveredDriver,
        verifier,
        supervisorId: supervisorB,
        clock,
        idGenerator: new SequenceIds(800)
      });
      try {
        for (let tick = 0; tick < 20; tick += 1) {
          const run = await recoveredKernel.getState({ kind: "run", id: runId });
          if (run?.kind === "run" && run.status === "succeeded") break;
          await recovered.tick();
        }
        expect(await recoveredKernel.getState({ kind: "run", id: runId })).toMatchObject({
          status: "succeeded"
        });
        expect(
          await recoveredKernel.getState({ kind: "milestone", id: milestoneId })
        ).toMatchObject({
          status: "outcome_ready",
          recommendation: "investigate"
        });
        const packets = await recoveredKernel.listOutcomePackets(programId);
        expect(packets).toHaveLength(1);
        const packet = packets[0];
        if (!packet) throw new Error("missing recovered outcome packet");
        expect(await recoveredKernel.verifyOutcomePacket(packet.outcomePacketId)).toMatchObject({
          valid: true,
          failures: []
        });
        expect(await recoveredKernel.verifyProjections()).toMatchObject({ valid: true });
        const outcomeEvents = (await recoveredKernel.listEvents({ limit: 1_000 })).events.filter(
          (event) => event.type === "OutcomePacketRecorded"
        );
        expect(outcomeEvents).toHaveLength(1);
        const database = new Database(driverPath, { fileMustExist: true });
        const starts = database
          .prepare("SELECT COUNT(*) AS count FROM fake_effects WHERE effect_type = 'agent.start'")
          .get() as { count: number };
        database.close();
        expect(starts.count).toBe(1);
      } finally {
        await recoveredDriver.close();
        await recoveredKernel.close();
      }
    }
  );

  it("times out a hanging attempt after a sleep jump and enqueues external cancellation", async () => {
    const { clock, kernel, driverPath } = await fixture("fake.hang", 1);
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const first = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    const recovered = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorB,
      clock,
      idGenerator: new SequenceIds(800)
    });
    try {
      await first.tick();
      await first.tick();
      await first.tick();
      clock.advance(300_001);
      expect((await recovered.tick()).action).toBe("job_reclaimed");
      expect((await recovered.tick()).action).toBe("attempt_timed_out");
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      const attempts = (await kernel.listEvents({ limit: 1000 })).events.filter(
        (event) => event.type === "AttemptFinished"
      );
      expect(attempts.at(-1)?.data).toMatchObject({
        status: "timed_out",
        terminationReason: "timed_out"
      });
      expect(await kernel.listOutbox({ statuses: ["pending"] })).toMatchObject([
        { effect: { effectType: "agent.cancel" } }
      ]);
      expect((await recovered.tick()).action).toBe("outbox_acquired");
      expect((await recovered.tick()).action).toBe("outbox_delivered");
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("times out before dispatching a start effect whose deadline passed during sleep", async () => {
    const { clock, kernel, driverPath } = await fixture("fake.hang", 1);
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    const first = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500)
    });
    const recovered = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorB,
      clock,
      idGenerator: new SequenceIds(800)
    });
    try {
      expect((await first.tick()).action).toBe("job_acquired");
      clock.advance(300_001);
      expect((await recovered.tick()).action).toBe("job_reclaimed");
      expect((await recovered.tick()).action).toBe("attempt_timed_out");
      expect((await kernel.listOutbox())[0]).toMatchObject({ status: "obsolete" });
      const database = new Database(driverPath, { fileMustExist: true });
      const effects = database.prepare("SELECT COUNT(*) AS count FROM fake_effects").get() as {
        count: number;
      };
      database.close();
      expect(effects.count).toBe(0);
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("turns operator cancellation into a durable idempotent agent.cancel effect", async () => {
    const { clock, kernel, driverPath } = await fixture("fake.hang");
    const driver = new SqliteFakeAgentDriver({ databasePath: driverPath, clock });
    let crashAfterCancel = false;
    const supervisor = new Supervisor({
      kernel,
      driver,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500),
      faultInjector: (point) => {
        if (crashAfterCancel && point === "after-effect-call") {
          throw new Error("crash after fake cancel");
        }
      }
    });
    try {
      await supervisor.tick();
      await supervisor.tick();
      await supervisor.tick();
      const job = await kernel.getState({ kind: "job", id: jobId });
      if (job?.kind !== "job" || !job.activeAttemptId) throw new Error("missing attempt");
      const attempt = await kernel.getState({ kind: "attempt", id: job.activeAttemptId });
      if (attempt?.kind !== "attempt" || !attempt.externalRunId) {
        throw new Error("missing external run");
      }
      expect(
        await kernel.execute({
          type: "run.cancel",
          idempotencyKey: "operator-cancel",
          actor,
          correlationId: runId,
          payload: { runId, reason: "operator stopped the run" }
        })
      ).toMatchObject({ ok: true, data: { status: "cancelled" } });
      expect(await kernel.listOutbox({ statuses: ["pending"] })).toMatchObject([
        { effect: { effectType: "agent.cancel", externalRunId: attempt.externalRunId } }
      ]);
      expect((await supervisor.tick()).action).toBe("outbox_acquired");
      crashAfterCancel = true;
      await expect(supervisor.tick()).rejects.toThrow("crash after fake cancel");
      clock.advance(10_001);
      const recovered = new Supervisor({
        kernel,
        driver,
        supervisorId: supervisorB,
        clock,
        idGenerator: new SequenceIds(800)
      });
      expect((await recovered.tick()).action).toBe("outbox_reclaimed");
      expect((await recovered.tick()).action).toBe("outbox_delivered");
      expect(await driver.inspect(attempt.externalRunId)).toMatchObject({
        status: "operator_cancelled"
      });
      expect(await kernel.getState({ kind: "attempt", id: attempt.attemptId })).toMatchObject({
        status: "cancelled",
        terminationReason: "operator_cancelled"
      });
      const database = new Database(driverPath, { fileMustExist: true });
      const cancels = database
        .prepare(
          "SELECT COUNT(*) AS logicalCount, MAX(call_count) AS physicalCalls FROM fake_effects WHERE effect_type = 'agent.cancel'"
        )
        .get() as { logicalCount: number; physicalCalls: number };
      database.close();
      expect(cancels).toEqual({ logicalCount: 1, physicalCalls: 2 });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("dead-letters an effect after eight deliveries and fails the run once", async () => {
    const { clock, kernel } = await fixture("fake.hang", 1);
    const throwingDriver: AgentDriver = {
      name: "fake",
      async start() {
        throw new Error("driver unavailable");
      },
      async inspect() {
        return { afterSequence: 0, events: [], status: "running", exitCode: null };
      },
      async cancel() {
        return "cancelled";
      },
      async collectReceipt() {
        throw new Error("receipt unavailable");
      },
      close() {
        return Promise.resolve();
      }
    };
    const supervisor = new Supervisor({
      kernel,
      driver: throwingDriver,
      supervisorId: supervisorA,
      clock,
      idGenerator: new SequenceIds(500),
      jobLeaseMs: 3_600_000
    });
    try {
      expect((await supervisor.tick()).action).toBe("job_acquired");
      for (let delivery = 1; delivery <= 8; delivery += 1) {
        expect((await supervisor.tick()).action).toMatch(/outbox_(acquired|reclaimed)/);
        expect((await supervisor.tick()).action).toBe("outbox_delivery_failed");
        const message = (await kernel.listOutbox())[0];
        if (!message) throw new Error("missing outbox message");
        if (delivery < 8) {
          const wait = new Date(message.availableAt).getTime() - clock.now().getTime();
          clock.advance(Math.max(0, wait));
        }
      }
      expect((await kernel.listOutbox())[0]).toMatchObject({
        status: "dead_letter",
        deliveryAttempts: 8
      });
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      expect(
        (await kernel.listEvents({ limit: 1000 })).events.filter(
          (event) => event.type === "RunFailed"
        )
      ).toHaveLength(1);
    } finally {
      await kernel.close();
    }
  });
});
