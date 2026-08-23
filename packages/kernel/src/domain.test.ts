import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "./domain.js";
import { emptyProjectionState, evolve, replayEvents, serializeProjectionState } from "./model.js";
import type { ProjectionState } from "./model.js";
import type { Command, DomainEventInput, StoredEvent } from "./schema.js";

const actor = { kind: "system", id: "property-test" } as const;
const programId = "00000000-0000-4000-8000-000000000001";
const workflowId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
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

function uuid(counter: number): string {
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function materialize(
  inputs: DomainEventInput[],
  events: StoredEvent[],
  streamVersions: Map<string, number>
): StoredEvent[] {
  return inputs.map((input) => {
    const version = (streamVersions.get(input.streamId) ?? 0) + 1;
    streamVersions.set(input.streamId, version);
    return {
      ...input,
      eventId: uuid(10_000 + events.length),
      commandId: uuid(20_000 + events.length),
      globalPosition: events.length + 1,
      streamVersion: version,
      schemaVersion: 1,
      occurredAt: "2026-08-17T12:00:00.000Z",
      metadata: { actor }
    };
  });
}

function apply(
  state: ProjectionState,
  events: StoredEvent[],
  versions: Map<string, number>,
  command: Command
): ProjectionState {
  const decision = decide(state, command, { now: "2026-08-17T12:00:00.000Z" });
  if (!decision.ok) throw new Error(decision.error.code);
  const stored = materialize(decision.events, events, versions);
  events.push(...stored);
  return stored.reduce(evolve, state);
}

describe("domain model", () => {
  it("produces the same state incrementally and from replay for generated valid sequences", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 30 }), (actions) => {
        const events: StoredEvent[] = [];
        const versions = new Map<string, number>();
        let state = emptyProjectionState();
        state = apply(state, events, versions, {
          type: "program.create",
          idempotencyKey: "program",
          actor,
          payload: { programId, name: "Program" }
        });
        state = apply(state, events, versions, {
          type: "workflow.register",
          idempotencyKey: "workflow",
          actor,
          payload: {
            workflowId,
            version: 1,
            name: "Workflow",
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
        for (const [index, shouldCancel] of actions.entries()) {
          const generatedRunId = uuid(100 + index);
          state = apply(state, events, versions, {
            type: "run.create",
            idempotencyKey: `run-${String(index)}`,
            actor,
            payload: { runId: generatedRunId, programId, workflowId, workflowVersion: 1 }
          });
          if (shouldCancel) {
            state = apply(state, events, versions, {
              type: "run.cancel",
              idempotencyKey: `cancel-${String(index)}`,
              actor,
              payload: { runId: generatedRunId, reason: "Generated cancellation" }
            });
          }
        }

        expect(serializeProjectionState(state)).toEqual(
          serializeProjectionState(replayEvents(events))
        );
      }),
      { numRuns: 100 }
    );
  });

  it("cancels an active attempt before cancelling its run", () => {
    const state = emptyProjectionState();
    state.runs.set(runId, {
      kind: "run",
      runId,
      programId,
      workflowId,
      workflowVersion: 1,
      milestoneId: null,
      status: "created",
      createdAt: "2026-08-17T12:00:00.000Z",
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      failureReason: null,
      version: 1
    });
    const attemptId = uuid(4);
    state.attempts.set(attemptId, {
      kind: "attempt",
      attemptId,
      runId,
      jobId: null,
      ordinal: 1,
      status: "allocated",
      allocatedAt: "2026-08-17T12:00:00.000Z",
      startedAt: null,
      deadlineAt: null,
      externalRunId: null,
      driverCursor: 0,
      cumulativeUsage: null,
      candidateRevisionId: null,
      driverReceiptId: null,
      finishedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      terminationReason: null,
      version: 1
    });
    const decision = decide(
      state,
      {
        type: "run.cancel",
        idempotencyKey: "cancel-run",
        actor,
        payload: { runId, reason: "Operator cancellation" }
      },
      { now: "2026-08-17T12:00:00.000Z" }
    );
    expect(decision.ok && decision.events.map((event) => event.type)).toEqual([
      "AttemptCancelled",
      "RunCancelled"
    ]);
  });

  it("finishes already-scheduled legacy jobs under legacy success semantics", () => {
    const state = emptyProjectionState();
    const jobId = uuid(30);
    const attemptId = uuid(31);
    const ownerId = uuid(32);
    state.workflows.set(`${workflowId}:1`, {
      kind: "workflow",
      workflowId,
      version: 1,
      name: "Legacy workflow",
      definition: {
        workflowId,
        version: 1,
        name: "Legacy workflow",
        steps: [{ id: "plan", capability: "planning", dependsOn: [] }]
      },
      definitionDigest: "a".repeat(64),
      registeredAt: "2026-08-17T11:00:00.000Z",
      streamVersion: 1
    });
    state.runs.set(runId, {
      kind: "run",
      runId,
      programId,
      workflowId,
      workflowVersion: 1,
      milestoneId: null,
      status: "running",
      createdAt: "2026-08-17T11:00:00.000Z",
      scheduledAt: "2026-08-17T11:01:00.000Z",
      startedAt: "2026-08-17T11:02:00.000Z",
      completedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      failureReason: null,
      version: 3
    });
    state.jobs.set(jobId, {
      kind: "job",
      jobId,
      runId,
      stepId: "plan",
      capability: "planning",
      dependencyJobIds: [],
      status: "active",
      policy: { maxAttempts: 3, attemptTimeoutMs: 300_000, retryDelaysMs: [1_000, 5_000] },
      sourceRevisionId: null,
      executionContract: null,
      executionContractDigest: null,
      capabilityManifest: null,
      capabilityManifestDigest: null,
      verifierContract: null,
      verifierContractDigest: null,
      candidateRevisionId: null,
      attemptCount: 1,
      activeAttemptId: attemptId,
      availableAt: "2026-08-17T11:01:00.000Z",
      leaseOwnerId: ownerId,
      leaseFencingToken: 1,
      leaseAcquiredAt: "2026-08-17T11:02:00.000Z",
      leaseExpiresAt: "2026-08-17T12:01:00.000Z",
      createdAt: "2026-08-17T11:01:00.000Z",
      completedAt: null,
      failureReason: null,
      version: 2
    });
    state.attempts.set(attemptId, {
      kind: "attempt",
      attemptId,
      runId,
      jobId,
      ordinal: 1,
      status: "running",
      allocatedAt: "2026-08-17T11:02:00.000Z",
      startedAt: "2026-08-17T11:02:00.000Z",
      deadlineAt: "2026-08-17T12:05:00.000Z",
      externalRunId: "legacy-external-run",
      driverCursor: 0,
      cumulativeUsage: null,
      candidateRevisionId: null,
      driverReceiptId: null,
      finishedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      terminationReason: null,
      version: 2
    });
    const decision = decide(
      state,
      {
        type: "attempt.observe",
        idempotencyKey: "legacy-job-success",
        actor,
        payload: {
          jobId,
          attemptId,
          ownerId,
          fencingToken: 1,
          outcome: "succeeded"
        }
      },
      { now: "2026-08-17T12:00:00.000Z" }
    );
    expect(decision.ok && decision.events.map((event) => event.type)).toEqual([
      "AttemptFinished",
      "JobSucceeded",
      "RunSucceeded"
    ]);
  });
});
