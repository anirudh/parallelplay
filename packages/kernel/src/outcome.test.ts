import { describe, expect, it } from "vitest";
import { buildOutcomePacket, outcomePacketId } from "./outcome.js";
import { emptyProjectionState } from "./model.js";
import type { ProjectionState } from "./model.js";

const programId = "40000000-0000-4000-8000-000000000001";
const milestoneId = "40000000-0000-4000-8000-000000000002";
const workflowId = "40000000-0000-4000-8000-000000000003";
const runId = "40000000-0000-4000-8000-000000000004";
const jobId = "40000000-0000-4000-8000-000000000005";
const revisionId = "40000000-0000-4000-8000-000000000006";
const candidateId = "40000000-0000-4000-8000-000000000007";
const verificationId = "40000000-0000-4000-8000-000000000008";
const attemptId = "40000000-0000-4000-8000-000000000009";
const timestamp = "2026-08-20T12:00:00.000Z";

function stateFor(
  verificationStatus: "passed" | "failed" | "invalid" | "missing",
  candidateRevisionId: string | null,
  runStatus: "succeeded" | "failed"
): ProjectionState {
  const state = emptyProjectionState();
  state.programs.set(programId, {
    kind: "program",
    programId,
    name: "Outcome program",
    status: "active",
    intent: {
      schemaVersion: 1,
      objective: "Derive an outcome.",
      nonGoals: [],
      tenets: ["Replay", "Evidence", "Bounded authority"],
      riskClass: "normal"
    },
    intentDigest: "a".repeat(64),
    approvedBy: "operator-1",
    approvedAt: timestamp,
    createdAt: timestamp,
    version: 2
  });
  state.milestones.set(milestoneId, {
    kind: "milestone",
    milestoneId,
    programId,
    contract: {
      schemaVersion: 1,
      milestoneId,
      title: "Derive packet",
      objective: "Derive a deterministic packet.",
      taskType: "feature",
      priority: "p1",
      tags: [],
      workflowId,
      workflowVersion: 1,
      criteria: [
        {
          criterionId: "verified",
          statement: "The verifier proves the criterion.",
          verificationStepId: "implement"
        }
      ]
    },
    contractDigest: "b".repeat(64),
    workflowDigest: "c".repeat(64),
    status: "running",
    runId,
    jobId,
    baseRevisionId: revisionId,
    outcomePacketId: null,
    recommendation: null,
    approvedBy: "operator-1",
    approvedAt: timestamp,
    startedAt: timestamp,
    completedAt: null,
    version: 2
  });
  state.runs.set(runId, {
    kind: "run",
    runId,
    programId,
    workflowId,
    workflowVersion: 1,
    milestoneId,
    status: runStatus,
    createdAt: timestamp,
    scheduledAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    cancelledAt: null,
    cancellationReason: null,
    failureReason: runStatus === "failed" ? "verification failed" : null,
    version: 4
  });
  state.jobs.set(jobId, {
    kind: "job",
    jobId,
    runId,
    stepId: "implement",
    capability: "implementation",
    dependencyJobIds: [],
    status: runStatus === "succeeded" ? "succeeded" : "failed",
    policy: { maxAttempts: 1, attemptTimeoutMs: 5_000, retryDelaysMs: [] },
    sourceRevisionId: revisionId,
    executionContract: null,
    executionContractDigest: null,
    capabilityManifest: null,
    capabilityManifestDigest: null,
    verifierContract: null,
    verifierContractDigest: null,
    candidateRevisionId,
    attemptCount: 1,
    activeAttemptId: null,
    availableAt: timestamp,
    leaseOwnerId: null,
    leaseFencingToken: 1,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
    createdAt: timestamp,
    completedAt: timestamp,
    failureReason: runStatus === "failed" ? "verification failed" : null,
    version: 4
  });
  if (verificationStatus !== "missing") {
    state.verifications.set(verificationId, {
      kind: "verification",
      verificationId,
      runId,
      jobId,
      attemptId,
      workflowId,
      workflowVersion: 1,
      workflowDigest: "c".repeat(64),
      sourceRevisionId: candidateRevisionId ?? revisionId,
      verifierContractDigest: "d".repeat(64),
      artifactManifestId: null,
      status: verificationStatus,
      result: null,
      resultDigest: null,
      receiptDigest: verificationStatus === "invalid" ? "e".repeat(64) : "f".repeat(64),
      exitCode: verificationStatus === "passed" ? 0 : 1,
      failureReason: verificationStatus === "passed" ? null : "verification failed",
      requestedAt: timestamp,
      completedAt: timestamp,
      version: 2
    });
  }
  return state;
}

describe("outcome packet derivation", () => {
  it.each([
    ["passed", candidateId, "succeeded", "pass", "merge"],
    ["failed", candidateId, "failed", "fail", "reject"],
    ["invalid", candidateId, "failed", "unverified", "investigate"],
    ["missing", null, "failed", "unverified", "investigate"]
  ] as const)(
    "maps %s verification to %s",
    (verification, candidateRevisionId, runStatus, criterion, recommendation) => {
      const packet = buildOutcomePacket(
        stateFor(verification, candidateRevisionId, runStatus),
        milestoneId
      );
      expect(packet.outcomePacketId).toBe(outcomePacketId(milestoneId, runId));
      expect(packet.criteriaResults[0]?.result).toBe(criterion);
      expect(packet.recommendation).toBe(recommendation);
      expect(
        buildOutcomePacket(stateFor(verification, candidateRevisionId, runStatus), milestoneId)
      ).toEqual(packet);
    }
  );
});
