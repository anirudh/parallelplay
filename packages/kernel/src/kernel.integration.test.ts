import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { getMigrationStatus, migrateDatabase } from "./database.js";
import type { Clock, IdGenerator } from "./database.js";
import { KernelSetupError } from "./errors.js";
import { sourceRevisionDigest } from "./evidence.js";
import type { Kernel } from "./sqlite-kernel.js";
import { openKernelForTesting } from "./sqlite-kernel.js";
import type { Command } from "./schema.js";

const programId = "00000000-0000-4000-8000-000000000001";
const workflowId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const attemptId = "00000000-0000-4000-8000-000000000004";
const planJobId = "00000000-0000-4000-8000-000000000005";
const buildJobId = "00000000-0000-4000-8000-000000000006";
const startOutboxId = "00000000-0000-4000-8000-000000000007";
const supervisorId = "00000000-0000-4000-8000-000000000008";
const actor = { kind: "operator", id: "integration-test" } as const;
const repositoryId = "00000000-0000-4000-8000-000000000009";
const sourceRevisionId = "00000000-0000-4000-8000-000000000010";
const revisionIdentity = {
  repositoryId,
  objectFormat: "sha1" as const,
  commitOid: "a".repeat(40),
  treeOid: "b".repeat(40)
};
const verification = {
  mode: "verify" as const,
  argv: ["./verify.sh"],
  cwd: "." as const,
  timeoutMs: 1_000,
  environment: {},
  toolProbes: []
};
const execution = {
  protocolVersion: 1 as const,
  image: `parallelplay-fixture@sha256:${"0".repeat(64)}`,
  argv: ["/bin/true"],
  workingDirectory: "/workspace" as const
};
const capabilities = {
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
const goldenProjection = JSON.parse(
  readFileSync(new URL("../test/fixtures/golden-projection.json", import.meta.url), "utf8")
) as unknown;

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-08-17T12:00:00.000Z");
  }
}

class SequenceIds implements IdGenerator {
  #next = 100;

  next(): string {
    const id = `00000000-0000-4000-8000-${String(this.#next).padStart(12, "0")}`;
    this.#next += 1;
    return id;
  }
}

const directories: string[] = [];

function temporaryDatabase(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-kernel-"));
  directories.push(directory);
  return { directory, databasePath: join(directory, "parallelplay.db") };
}

// ParallelPlay starts from a fresh squashed schema; predecessor migration fixtures are intentionally unsupported.

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function createKernel(
  faultInjector?: (point: "after-events-appended" | "after-projection-written") => void
): Promise<{ databasePath: string; kernel: Kernel }> {
  const { databasePath } = temporaryDatabase();
  const clock = new FixedClock();
  await migrateDatabase({ databasePath, clock });
  return {
    databasePath,
    kernel: openKernelForTesting({
      databasePath,
      clock,
      idGenerator: new SequenceIds(),
      ...(faultInjector ? { faultInjector } : {})
    })
  };
}

function baseCommands(): Command[] {
  return [
    {
      type: "program.create",
      idempotencyKey: "program-1",
      actor,
      payload: { programId, name: "Golden program" }
    },
    {
      type: "source-revision.register",
      idempotencyKey: "revision-1",
      actor,
      payload: {
        revisionId: sourceRevisionId,
        ...revisionIdentity,
        storageRef: `refs/parallelplay/revisions/${sourceRevisionId}`,
        revisionDigest: sourceRevisionDigest(revisionIdentity)
      }
    },
    {
      type: "workflow.register",
      idempotencyKey: "workflow-1",
      actor,
      payload: {
        workflowId,
        version: 1,
        name: "Golden workflow",
        schemaVersion: 2,
        steps: [
          {
            id: "plan",
            capability: "planning",
            dependsOn: [],
            execution,
            capabilities,
            verification
          },
          {
            id: "build",
            capability: "implementation",
            dependsOn: ["plan"],
            execution,
            capabilities,
            verification
          }
        ]
      }
    },
    {
      type: "run.create",
      idempotencyKey: "run-1",
      actor,
      payload: { runId, programId, workflowId, workflowVersion: 1 }
    }
  ];
}

async function executeBase(kernel: Kernel): Promise<void> {
  for (const command of baseCommands()) expect((await kernel.execute(command)).ok).toBe(true);
}

async function scheduleAndAcquire(kernel: Kernel): Promise<void> {
  expect(
    (
      await kernel.execute({
        type: "run.schedule",
        idempotencyKey: "schedule-1",
        actor,
        payload: {
          runId,
          jobs: [
            { jobId: planJobId, stepId: "plan", sourceRevisionId },
            { jobId: buildJobId, stepId: "build", sourceRevisionId }
          ]
        }
      })
    ).ok
  ).toBe(true);
  expect(
    (
      await kernel.execute({
        type: "job.lease.acquire",
        idempotencyKey: "lease-plan-1",
        actor: { kind: "system", id: supervisorId },
        correlationId: runId,
        payload: {
          jobId: planJobId,
          ownerId: supervisorId,
          leaseDurationMs: 30_000,
          attemptId,
          startOutboxId
        }
      })
    ).ok
  ).toBe(true);
}

describe("SQLite kernel", () => {
  it("schedules durable jobs and atomically cancels active execution with its run", async () => {
    const { kernel } = await createKernel();
    try {
      await executeBase(kernel);
      await scheduleAndAcquire(kernel);
      const cancellation = await kernel.execute({
        type: "run.cancel",
        idempotencyKey: "cancel-run-1",
        actor,
        payload: { runId, reason: "Stopped by operator" }
      });
      expect(cancellation.ok && cancellation.events.map((event) => event.type)).toEqual([
        "AttemptFinished",
        "OutboxObsoleted",
        "JobCancelled",
        "JobCancelled",
        "RunCancelled"
      ]);
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({
        status: "cancelled"
      });
      expect(await kernel.getState({ kind: "attempt", id: attemptId })).toMatchObject({
        status: "cancelled",
        terminationReason: "operator_cancelled"
      });
      expect(await kernel.getState({ kind: "outbox", id: startOutboxId })).toMatchObject({
        status: "obsolete"
      });
      expect(await kernel.verifyProjections()).toMatchObject({ valid: true, eventCount: 16 });
    } finally {
      await kernel.close();
    }
  });

  it("rejects incomplete, duplicate, and extra schedule mappings without appending events", async () => {
    const { kernel } = await createKernel();
    try {
      await executeBase(kernel);
      const cases = [
        [{ jobId: planJobId, stepId: "plan" }],
        [
          { jobId: planJobId, stepId: "plan" },
          { jobId: planJobId, stepId: "build" }
        ],
        [
          { jobId: planJobId, stepId: "plan" },
          { jobId: buildJobId, stepId: "build" },
          { jobId: startOutboxId, stepId: "extra" }
        ]
      ];
      for (const [index, jobs] of cases.entries()) {
        expect(
          await kernel.execute({
            type: "run.schedule",
            idempotencyKey: `invalid-schedule-${String(index)}`,
            actor,
            payload: { runId, jobs }
          })
        ).toMatchObject({ ok: false, error: { code: "SCHEDULE_MISMATCH" } });
      }
      expect((await kernel.listEvents({ limit: 100 })).events).toHaveLength(4);
      expect(await kernel.listJobs()).toEqual([]);
    } finally {
      await kernel.close();
    }
  });

  it("fails fast after retry exhaustion and cancels dependent work", async () => {
    const { kernel } = await createKernel();
    try {
      await executeBase(kernel);
      expect(
        await kernel.execute({
          type: "run.schedule",
          idempotencyKey: "fail-fast-schedule",
          actor,
          payload: {
            runId,
            jobs: [
              {
                jobId: planJobId,
                stepId: "plan",
                sourceRevisionId,
                policy: { maxAttempts: 1, attemptTimeoutMs: 300_000, retryDelaysMs: [] }
              },
              { jobId: buildJobId, stepId: "build", sourceRevisionId }
            ]
          }
        })
      ).toMatchObject({ ok: true });
      await kernel.execute({
        type: "job.lease.acquire",
        idempotencyKey: "fail-fast-lease",
        actor: { kind: "system", id: supervisorId },
        correlationId: runId,
        payload: {
          jobId: planJobId,
          ownerId: supervisorId,
          leaseDurationMs: 30_000,
          attemptId,
          startOutboxId
        }
      });
      await kernel.execute({
        type: "outbox.lease.acquire",
        idempotencyKey: "fail-fast-outbox-lease",
        actor: { kind: "system", id: supervisorId },
        correlationId: runId,
        payload: { outboxId: startOutboxId, ownerId: supervisorId, leaseDurationMs: 10_000 }
      });
      await kernel.execute({
        type: "outbox.delivery.succeed",
        idempotencyKey: "fail-fast-outbox-delivery",
        actor: { kind: "system", id: supervisorId },
        correlationId: runId,
        payload: {
          outboxId: startOutboxId,
          ownerId: supervisorId,
          fencingToken: 1,
          externalEffectId: "fake:failed-run"
        }
      });
      const failed = await kernel.execute({
        type: "attempt.observe",
        idempotencyKey: "fail-fast-completion",
        actor: { kind: "system", id: supervisorId },
        correlationId: runId,
        payload: {
          jobId: planJobId,
          attemptId,
          ownerId: supervisorId,
          fencingToken: 1,
          outcome: "failed",
          detail: "deterministic failure"
        }
      });
      expect(failed.ok && failed.events.map((event) => event.type)).toEqual([
        "AttemptFinished",
        "JobFailed",
        "JobCancelled",
        "RunFailed"
      ]);
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({
        status: "failed",
        failureReason: "deterministic failure"
      });
      expect(await kernel.getState({ kind: "job", id: buildJobId })).toMatchObject({
        status: "cancelled",
        failureReason: "run_failed"
      });
      expect(await kernel.getState({ kind: "attempt", id: attemptId })).toMatchObject({
        status: "failed",
        terminationReason: "driver_error"
      });
    } finally {
      await kernel.close();
    }
  });

  it("returns the original result for identical idempotent input and rejects key reuse", async () => {
    const { kernel } = await createKernel();
    try {
      const command = baseCommands()[0];
      if (!command) throw new Error("Missing command fixture");
      const first = await kernel.execute(command);
      const replayed = await kernel.execute(command);
      expect(first.ok).toBe(true);
      expect(replayed).toEqual({ ...first, replayed: true });
      const conflict = await kernel.execute({
        ...command,
        payload: { programId: "00000000-0000-4000-8000-000000000009", name: "Other" }
      });
      expect(conflict).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
      expect((await kernel.listEvents()).events).toHaveLength(1);
    } finally {
      await kernel.close();
    }
  });

  it("records domain rejections without appending events", async () => {
    const { kernel } = await createKernel();
    try {
      const rejected: Command = {
        type: "run.create",
        idempotencyKey: "missing-program",
        actor,
        payload: { runId, programId, workflowId, workflowVersion: 1 }
      };
      const first = await kernel.execute(rejected);
      const replayed = await kernel.execute(rejected);
      expect(first).toMatchObject({ ok: false, error: { code: "PROGRAM_NOT_FOUND" } });
      expect(replayed).toEqual({ ...first, replayed: true });
      expect((await kernel.listEvents()).events).toHaveLength(0);
    } finally {
      await kernel.close();
    }
  });

  it("rejects malformed commands before opening an authoritative transaction", async () => {
    const { databasePath, kernel } = await createKernel();
    try {
      expect(await kernel.execute({ type: "program.create" })).toMatchObject({
        ok: false,
        commandId: null,
        error: { code: "VALIDATION_ERROR" }
      });
      expect((await kernel.listEvents()).events).toHaveLength(0);
      const external = new Database(databasePath);
      const receiptCount = external
        .prepare("SELECT COUNT(*) AS count FROM command_receipts")
        .get() as {
        count: number;
      };
      external.close();
      expect(receiptCount.count).toBe(0);
    } finally {
      await kernel.close();
    }
  });

  it("keeps stream versions independent when entity UUIDs overlap across stream types", async () => {
    const { kernel } = await createKernel();
    try {
      expect((await kernel.execute(baseCommands()[0])).ok).toBe(true);
      const workflow = await kernel.execute({
        type: "workflow.register",
        idempotencyKey: "overlapping-workflow",
        actor,
        payload: {
          workflowId: programId,
          version: 1,
          name: "Overlapping UUID workflow",
          schemaVersion: 2,
          steps: [
            {
              id: "plan",
              capability: "planning",
              dependsOn: [],
              execution,
              capabilities,
              verification
            }
          ]
        }
      });
      expect(workflow).toMatchObject({ ok: true, events: [{ streamVersion: 1 }] });
    } finally {
      await kernel.close();
    }
  });

  it.each(["after-events-appended", "after-projection-written"] as const)(
    "rolls back a command when failure is injected %s",
    async (faultPoint) => {
      const { kernel } = await createKernel((point) => {
        if (point === faultPoint) throw new Error("Injected failure");
      });
      try {
        const command = baseCommands()[0];
        if (!command) throw new Error("Missing command fixture");
        await expect(kernel.execute(command)).rejects.toThrow("Injected failure");
        expect((await kernel.listEvents()).events).toHaveLength(0);
        expect(await kernel.getState({ kind: "program", id: programId })).toBeNull();
      } finally {
        await kernel.close();
      }
    }
  );

  it("detects projection drift and rebuilds disposable state", async () => {
    const { databasePath, kernel } = await createKernel();
    try {
      await executeBase(kernel);
      const before = await kernel.verifyProjections();
      const external = new Database(databasePath);
      external.prepare("UPDATE programs_projection SET name = 'Corrupted'").run();
      external.close();
      const drifted = await kernel.verifyProjections();
      expect(drifted.valid).toBe(false);
      expect(drifted.firstDivergence).toContain("programs");
      const rebuilt = await kernel.rebuildProjections();
      expect(rebuilt.previousDigest).not.toBe(before.currentDigest);
      expect(rebuilt.rebuiltDigest).toBe(before.replayedDigest);
      expect(await kernel.verifyProjections()).toMatchObject({ valid: true });

      const missing = new Database(databasePath);
      missing.exec(`
        DELETE FROM attempts_projection;
        DELETE FROM runs_projection;
        DELETE FROM workflows_projection;
        DELETE FROM programs_projection;
      `);
      missing.close();
      expect(await kernel.verifyProjections()).toMatchObject({ valid: false });
      expect((await kernel.rebuildProjections()).rebuiltDigest).toBe(before.replayedDigest);
      expect(await kernel.verifyProjections()).toMatchObject({ valid: true });
    } finally {
      await kernel.close();
    }
  });

  it("uses event history rather than a corrupted projection for command decisions", async () => {
    const { databasePath, kernel } = await createKernel();
    try {
      const command = baseCommands()[0];
      if (!command) throw new Error("Missing command fixture");
      expect((await kernel.execute(command)).ok).toBe(true);
      const external = new Database(databasePath);
      external.prepare("DELETE FROM programs_projection").run();
      external.close();

      const duplicate = await kernel.execute({ ...command, idempotencyKey: "program-duplicate" });
      expect(duplicate).toMatchObject({
        ok: false,
        error: { code: "PROGRAM_ALREADY_EXISTS" }
      });
      expect((await kernel.listEvents()).events).toHaveLength(1);
    } finally {
      await kernel.close();
    }
  });

  it("enforces append-only events and command receipts", async () => {
    const { databasePath, kernel } = await createKernel();
    try {
      const command = baseCommands()[0];
      if (!command) throw new Error("Missing command fixture");
      await kernel.execute(command);
      const external = new Database(databasePath);
      expect(() => external.prepare("UPDATE events SET occurred_at = occurred_at").run()).toThrow(
        "events are append-only"
      );
      expect(() => external.prepare("DELETE FROM command_receipts").run()).toThrow(
        "command receipts are append-only"
      );
      external.close();
    } finally {
      await kernel.close();
    }
  });

  it("reports migration state and checksum drift", async () => {
    const { databasePath } = temporaryDatabase();
    expect(await getMigrationStatus(databasePath)).toMatchObject({
      databaseExists: false,
      pendingVersions: [1]
    });
    await migrateDatabase({ databasePath, clock: new FixedClock() });
    const database = new Database(databasePath);
    database.exec("DROP TRIGGER schema_migrations_no_update");
    database
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
      .run("0".repeat(64));
    database.close();
    expect(await getMigrationStatus(databasePath)).toMatchObject({ driftedVersions: [1] });
  });

  it("reports and rejects migrations unknown to this build", async () => {
    const { databasePath } = temporaryDatabase();
    await migrateDatabase({ databasePath, clock: new FixedClock() });
    const database = new Database(databasePath);
    database.exec("DROP TRIGGER schema_migrations_no_update");
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
      )
      .run(999, "999_future.sql", "future", "2026-08-17T12:00:00.000Z");
    database.close();

    expect(await getMigrationStatus(databasePath)).toMatchObject({
      currentVersion: 999,
      latestVersion: 1,
      unknownAppliedVersions: [999]
    });
    try {
      openKernelForTesting({ databasePath });
      throw new Error("Expected the kernel to reject a database migrated by a newer build");
    } catch (error) {
      expect(error).toBeInstanceOf(KernelSetupError);
      expect(error).toMatchObject({
        code: "MIGRATION_AHEAD",
        details: { version: 999 }
      });
    }
    await expect(migrateDatabase({ databasePath })).rejects.toMatchObject({
      code: "MIGRATION_AHEAD",
      details: { version: 999 }
    });
  });

  it("matches the frozen golden event order and projection digest", async () => {
    const { kernel } = await createKernel();
    try {
      await executeBase(kernel);
      await scheduleAndAcquire(kernel);
      await kernel.execute({
        type: "run.cancel",
        idempotencyKey: "cancel-run-1",
        actor,
        payload: { runId, reason: "Stopped by operator" }
      });
      const events = (await kernel.listEvents({ limit: 100 })).events;
      expect(
        events.map(({ type, globalPosition, streamVersion }) => ({
          type,
          globalPosition,
          streamVersion
        }))
      ).toEqual([
        { type: "ProgramCreated", globalPosition: 1, streamVersion: 1 },
        { type: "SourceRevisionRegistered", globalPosition: 2, streamVersion: 1 },
        { type: "WorkflowDefinitionRegistered", globalPosition: 3, streamVersion: 1 },
        { type: "RunCreated", globalPosition: 4, streamVersion: 1 },
        { type: "JobScheduled", globalPosition: 5, streamVersion: 1 },
        { type: "JobScheduled", globalPosition: 6, streamVersion: 1 },
        { type: "RunScheduled", globalPosition: 7, streamVersion: 2 },
        { type: "RunStarted", globalPosition: 8, streamVersion: 3 },
        { type: "JobLeaseAcquired", globalPosition: 9, streamVersion: 2 },
        { type: "AttemptStarted", globalPosition: 10, streamVersion: 1 },
        { type: "OutboxEnqueued", globalPosition: 11, streamVersion: 1 },
        { type: "AttemptFinished", globalPosition: 12, streamVersion: 2 },
        { type: "OutboxObsoleted", globalPosition: 13, streamVersion: 2 },
        { type: "JobCancelled", globalPosition: 14, streamVersion: 3 },
        { type: "JobCancelled", globalPosition: 15, streamVersion: 2 },
        { type: "RunCancelled", globalPosition: 16, streamVersion: 4 }
      ]);
      expect((await kernel.verifyProjections()).replayedDigest).toBe(
        "9ced8b074af7949ed4249aef67fa41641917bfbdfc1801fade2ba6d3c8f010f3"
      );
      expect({
        projectionSchemaVersion: 1,
        programs: [await kernel.getState({ kind: "program", id: programId })],
        milestones: [],
        outcomePackets: [],
        workflows: [await kernel.getState({ kind: "workflow", id: workflowId, version: 1 })],
        runs: [await kernel.getState({ kind: "run", id: runId })],
        jobs: [
          await kernel.getState({ kind: "job", id: planJobId }),
          await kernel.getState({ kind: "job", id: buildJobId })
        ],
        attempts: [await kernel.getState({ kind: "attempt", id: attemptId })],
        outbox: [await kernel.getState({ kind: "outbox", id: startOutboxId })],
        lastAppliedPosition: events.at(-1)?.globalPosition
      }).toEqual(goldenProjection);
    } finally {
      await kernel.close();
    }
  });
});
