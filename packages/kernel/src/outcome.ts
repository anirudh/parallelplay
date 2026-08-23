import { createHash } from "node:crypto";
import { canonicalDigest, canonicalJson } from "./canonical.js";
import {
  artifactManifestDigest,
  driverReceiptDigest,
  receiptIdentity,
  sourceRevisionDigest,
  sourceRevisionIdentity,
  verificationReceiptDigest,
  verificationResultDigest
} from "./evidence.js";
import type { ProjectionState } from "./model.js";
import { OutcomePacketV1Schema, OutcomePacketV2Schema } from "./schema.js";
import type {
  DomainEventInput,
  OutcomePacketState,
  OutcomePacketV1,
  OutcomePacketV2
} from "./schema.js";

function deterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hash[12] = "5";
  hash[16] = "8";
  const value = hash.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function requireValue<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

export function outcomePacketId(milestoneId: string, runId: string): string {
  return deterministicUuid(`parallelplay:outcome-packet:v1:${milestoneId}:${runId}`);
}

export function buildOutcomePacket(
  state: ProjectionState,
  milestoneId: string,
  selectedRunId?: string
): OutcomePacketV1 | OutcomePacketV2 {
  const milestone = requireValue(state.milestones.get(milestoneId), "Milestone is missing");
  const program = requireValue(state.programs.get(milestone.programId), "Program is missing");
  const runId = selectedRunId ?? requireValue(milestone.runId, "Milestone has not started");
  const run = requireValue(state.runs.get(runId), "Milestone run is missing");
  const generation = [...state.milestoneGenerations.values()].find(
    (candidate) => candidate.runId === runId
  );
  const jobId = generation?.jobId ?? requireValue(milestone.jobId, "Milestone job is missing");
  const job = requireValue(state.jobs.get(jobId), "Milestone job is missing");
  const baseRevisionId = requireValue(
    generation?.baseRevisionId ?? milestone.baseRevisionId,
    "Milestone base revision is missing"
  );
  const generatedAt = requireValue(run.completedAt, "Milestone run is not terminal");
  const graph = generation ? state.programGraphs.get(generation.graphRevisionId) : undefined;
  const intentDigest =
    graph?.graph.intentPlaybackRef.digest ??
    requireValue(program.intentDigest, "Approved program intent is missing");

  const attempts = [...state.attempts.values()]
    .filter((attempt) => attempt.runId === runId && attempt.jobId === jobId)
    .sort(
      (left, right) => left.ordinal - right.ordinal || left.attemptId.localeCompare(right.attemptId)
    );
  const driverReceipts = [...state.driverReceipts.values()]
    .filter((receipt) => receipt.runId === runId && receipt.jobId === jobId)
    .sort(
      (left, right) =>
        left.recordedAt.localeCompare(right.recordedAt) ||
        left.driverReceiptId.localeCompare(right.driverReceiptId)
    );
  const verifications = [...state.verifications.values()]
    .filter((verification) => verification.runId === runId && verification.jobId === jobId)
    .sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.verificationId.localeCompare(right.verificationId)
    );
  const artifactManifests = [...state.artifactManifests.values()]
    .filter((manifest) => manifest.runId === runId && manifest.jobId === jobId)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.artifactManifestId.localeCompare(right.artifactManifestId)
    );
  const finalVerification = verifications.at(-1);
  const criterionResult =
    finalVerification?.status === "passed"
      ? "pass"
      : finalVerification?.status === "failed"
        ? "fail"
        : "unverified";
  const primaryEvidence =
    finalVerification?.receiptDigest === null || finalVerification === undefined
      ? []
      : [
          {
            kind: "verification" as const,
            id: finalVerification.verificationId,
            digest: finalVerification.receiptDigest
          }
        ];
  const criteriaResults = milestone.contract.criteria.map((criterion) => ({
    criterionId: criterion.criterionId,
    statement: criterion.statement,
    result: criterionResult,
    evidenceRefs: primaryEvidence
  }));

  const anyFailed = criteriaResults.some((criterion) => criterion.result === "fail");
  const allPassed = criteriaResults.every((criterion) => criterion.result === "pass");
  const recommendation = anyFailed
    ? ("reject" as const)
    : allPassed && run.status === "succeeded" && job.candidateRevisionId !== null
      ? ("merge" as const)
      : ("investigate" as const);
  const deviationReasons = new Set<string>();
  if (job.candidateRevisionId === null) deviationReasons.add("candidate_missing");
  if (finalVerification === undefined) deviationReasons.add("verification_missing");
  if (finalVerification?.status === "invalid") deviationReasons.add("verification_invalid");
  if (finalVerification?.status === "cancelled" || finalVerification?.status === "requested") {
    deviationReasons.add("verification_incomplete");
  }
  if (anyFailed) deviationReasons.add("criterion_failed");
  for (const receipt of driverReceipts) {
    if (receipt.outcome !== "succeeded") deviationReasons.add(receipt.outcome);
  }
  for (const attempt of attempts) {
    if (attempt.terminationReason) deviationReasons.add(attempt.terminationReason);
  }
  if (run.status === "cancelled") deviationReasons.add("operator_cancelled");
  if (run.status === "failed" && !anyFailed) deviationReasons.add("run_failed");

  const failedCount = criteriaResults.filter((criterion) => criterion.result === "fail").length;
  const summary =
    recommendation === "merge"
      ? `All ${String(criteriaResults.length)} milestone criteria passed verification.`
      : recommendation === "reject"
        ? `${String(failedCount)} of ${String(criteriaResults.length)} milestone criteria failed verification.`
        : "Milestone ended without complete trustworthy verification; operator investigation is required.";
  const humanEvidenceFocus =
    recommendation === "merge"
      ? ["Review the candidate diff and verification receipt before merging."]
      : recommendation === "reject"
        ? ["Review the failed verification receipt and candidate diff before rejecting."]
        : [
            "Review the terminal reason, attempt history, and available receipts before deciding next steps."
          ];
  const terminalReason =
    run.status === "succeeded"
      ? "verified_success"
      : run.status === "failed"
        ? (run.failureReason ?? "run_failed")
        : (run.cancellationReason ?? "operator_cancelled");

  const v1 = OutcomePacketV1Schema.parse({
    schemaVersion: 1,
    packetVersion: 1,
    outcomePacketId: outcomePacketId(milestone.milestoneId, runId),
    programId: program.programId,
    milestoneId: milestone.milestoneId,
    runId,
    baseRevisionId,
    candidateRevisionId: job.candidateRevisionId,
    intentDigest,
    milestoneContractDigest: milestone.contractDigest,
    workflowDigest: milestone.workflowDigest,
    criteriaResults,
    attemptHistory: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      jobId,
      ordinal: attempt.ordinal,
      status: attempt.status,
      terminationReason: attempt.terminationReason,
      usage: attempt.cumulativeUsage
    })),
    driverReceipts: driverReceipts.map((receipt) => ({
      kind: "driver_receipt",
      id: receipt.driverReceiptId,
      digest: receipt.receiptDigest
    })),
    verificationReceipts: verifications.flatMap((verification) =>
      verification.receiptDigest === null
        ? []
        : [
            {
              kind: "verification" as const,
              id: verification.verificationId,
              digest: verification.receiptDigest
            }
          ]
    ),
    artifactManifests: artifactManifests.map((manifest) => ({
      kind: "artifact_manifest",
      id: manifest.artifactManifestId,
      digest: manifest.manifestDigest
    })),
    capabilitiesUsed: uniqueSorted(
      driverReceipts.flatMap((receipt) => receipt.receipt.capabilitiesUsed)
    ),
    terminalReason,
    summary,
    deviationReasons: uniqueSorted(deviationReasons),
    recommendation,
    humanEvidenceFocus,
    generatedAt
  });
  if (!generation || !graph) return v1;
  const context = requireValue(
    state.contextPackets.get(generation.contextPacketId),
    "Milestone context packet is missing"
  );
  const dependencyValidations = [...state.outcomeValidations.values()]
    .filter((validation) =>
      context.packet.dependencyOutcomeRefs.some(
        (reference) => reference.id === validation.outcomePacketId
      )
    )
    .sort((left, right) => left.validationId.localeCompare(right.validationId));
  return OutcomePacketV2Schema.parse({
    ...v1,
    schemaVersion: 2,
    packetVersion: 2,
    generationId: generation.generationId,
    generation: generation.generation,
    graphRevisionId: graph.graphRevisionId,
    graphDigest: graph.graphDigest,
    contextPacketId: context.contextPacketId,
    contextPacketDigest: context.packetDigest,
    dependencyOutcomeRefs: context.packet.dependencyOutcomeRefs,
    dependencyValidationRefs: dependencyValidations.map((validation) => ({
      kind: "outcome_validation",
      id: validation.validationId,
      digest: validation.validationDigest
    }))
  });
}

export function deriveOutcomeEvents(
  state: ProjectionState,
  terminalRunIds: Iterable<string>
): DomainEventInput[] {
  const events: DomainEventInput[] = [];
  for (const runId of uniqueSorted(terminalRunIds)) {
    const run = state.runs.get(runId);
    if (!run?.milestoneId) continue;
    const milestone = state.milestones.get(run.milestoneId);
    if (
      !milestone ||
      (milestone.status !== "running" && milestone.status !== "paused") ||
      milestone.outcomePacketId !== null
    ) {
      continue;
    }
    const packet = buildOutcomePacket(state, milestone.milestoneId, runId);
    if (state.outcomePackets.has(packet.outcomePacketId)) continue;
    events.push(
      {
        type: "OutcomePacketRecorded",
        streamType: "outcome_packet",
        streamId: packet.outcomePacketId,
        data: { packet, packetDigest: canonicalDigest(packet) }
      },
      {
        type: "MilestoneOutcomeReady",
        streamType: "milestone",
        streamId: milestone.milestoneId,
        data: {
          milestoneId: milestone.milestoneId,
          runId,
          outcomePacketId: packet.outcomePacketId,
          recommendation: packet.recommendation,
          ...(packet.schemaVersion === 2
            ? { generationId: packet.generationId, generation: packet.generation }
            : {})
        }
      }
    );
    if (packet.schemaVersion === 2) {
      events.push({
        type: "MilestoneGenerationOutcomeReady",
        streamType: "milestone_generation",
        streamId: packet.generationId,
        data: {
          generationId: packet.generationId,
          programId: packet.programId,
          milestoneId: packet.milestoneId,
          generation: packet.generation,
          runId: packet.runId,
          outcomePacketId: packet.outcomePacketId,
          recommendation: packet.recommendation
        }
      });
      const admission = [...state.portfolioAdmissions.values()].find(
        (entry) => entry.status === "active" && entry.admission.generationId === packet.generationId
      );
      if (admission) {
        const leases = [...state.concurrencyLeases.values()].filter(
          (entry) =>
            entry.status === "active" && entry.lease.admissionId === admission.admission.admissionId
        );
        const fencingToken = leases[0]?.lease.fencingToken;
        const releasedAt = run.completedAt ?? run.cancelledAt ?? run.createdAt;
        if (fencingToken && leases.every((entry) => entry.lease.fencingToken === fencingToken)) {
          events.push({
            type: "PortfolioAdmissionReleased",
            streamType: "portfolio_admission",
            streamId: admission.admission.admissionId,
            data: {
              admissionId: admission.admission.admissionId,
              generationId: packet.generationId,
              fencingToken,
              reason: `terminal_run:${run.status}`,
              releasedAt,
              leaseIds: leases.map((entry) => entry.lease.leaseId)
            }
          });
        }
      }
    }
  }
  return events;
}

export interface OutcomePacketVerification {
  outcomePacketId: string;
  valid: boolean;
  packetDigest: string | null;
  computedDigest: string | null;
  failures: string[];
}

export function verifyOutcomePacketState(
  state: ProjectionState,
  stored: OutcomePacketState | undefined
): OutcomePacketVerification {
  if (!stored) {
    return {
      outcomePacketId: "missing",
      valid: false,
      packetDigest: null,
      computedDigest: null,
      failures: ["outcome packet missing"]
    };
  }
  const failures: string[] = [];
  const computedDigest = canonicalDigest(stored.packet);
  if (computedDigest !== stored.packetDigest) failures.push("outcome packet digest mismatch");
  if (stored.packet.schemaVersion === 2) {
    const graph = state.programGraphs.get(stored.packet.graphRevisionId);
    const context = state.contextPackets.get(stored.packet.contextPacketId);
    const generation = state.milestoneGenerations.get(stored.packet.generationId);
    if (graph?.graphDigest !== stored.packet.graphDigest) {
      failures.push("program graph digest mismatch");
    }
    if (context?.packetDigest !== stored.packet.contextPacketDigest) {
      failures.push("context packet digest mismatch");
    }
    if (
      generation?.runId !== stored.packet.runId ||
      generation.contextPacketId !== stored.packet.contextPacketId ||
      generation.generation !== stored.packet.generation
    ) {
      failures.push("milestone generation binding mismatch");
    }
    for (const reference of stored.packet.dependencyOutcomeRefs) {
      const dependency = state.outcomePackets.get(reference.id);
      if (dependency?.packetDigest !== reference.digest) {
        failures.push(`dependency outcome digest mismatch: ${reference.id}`);
      }
    }
    for (const reference of stored.packet.dependencyValidationRefs) {
      const validation = state.outcomeValidations.get(reference.id);
      if (validation?.validationDigest !== reference.digest) {
        failures.push(`dependency validation digest mismatch: ${reference.id}`);
      }
    }
  }
  const baseRevision = state.sourceRevisions.get(stored.packet.baseRevisionId);
  if (!baseRevision) {
    failures.push("base source revision missing");
  } else if (
    sourceRevisionDigest(sourceRevisionIdentity(baseRevision)) !== baseRevision.revisionDigest
  ) {
    failures.push("base source revision digest mismatch");
  }
  if (stored.packet.candidateRevisionId) {
    const candidate = state.sourceRevisions.get(stored.packet.candidateRevisionId);
    if (!candidate) {
      failures.push("candidate source revision missing");
    } else if (
      sourceRevisionDigest(sourceRevisionIdentity(candidate)) !== candidate.revisionDigest
    ) {
      failures.push("candidate source revision digest mismatch");
    }
  }
  for (const reference of stored.packet.driverReceipts) {
    const receipt = state.driverReceipts.get(reference.id);
    if (!receipt) {
      failures.push(`driver receipt missing: ${reference.id}`);
    } else if (
      receipt.receiptDigest !== reference.digest ||
      driverReceiptDigest(receipt.receipt) !== receipt.receiptDigest
    ) {
      failures.push(`driver receipt digest mismatch: ${reference.id}`);
    }
  }
  for (const reference of stored.packet.artifactManifests) {
    const manifest = state.artifactManifests.get(reference.id);
    if (!manifest) {
      failures.push(`artifact manifest missing: ${reference.id}`);
    } else if (
      manifest.manifestDigest !== reference.digest ||
      artifactManifestDigest(manifest.entries) !== manifest.manifestDigest
    ) {
      failures.push(`artifact manifest digest mismatch: ${reference.id}`);
    }
  }
  for (const reference of stored.packet.verificationReceipts) {
    const verification = state.verifications.get(reference.id);
    const manifest = verification?.artifactManifestId
      ? state.artifactManifests.get(verification.artifactManifestId)
      : undefined;
    if (
      !verification ||
      !manifest ||
      !verification.result ||
      !verification.resultDigest ||
      !verification.receiptDigest
    ) {
      failures.push(`verification receipt missing: ${reference.id}`);
    } else if (
      verification.receiptDigest !== reference.digest ||
      verificationResultDigest(verification.result) !== verification.resultDigest ||
      verificationReceiptDigest(
        receiptIdentity(
          verification,
          manifest.artifactManifestId,
          manifest.manifestDigest,
          verification.resultDigest
        )
      ) !== verification.receiptDigest
    ) {
      failures.push(`verification receipt digest mismatch: ${reference.id}`);
    }
  }
  try {
    const expected = buildOutcomePacket(state, stored.milestoneId, stored.runId);
    if (canonicalJson(expected) !== canonicalJson(stored.packet)) {
      failures.push("outcome packet does not match authoritative evidence");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "outcome packet could not be derived");
  }
  return {
    outcomePacketId: stored.outcomePacketId,
    valid: failures.length === 0,
    packetDigest: stored.packetDigest,
    computedDigest,
    failures
  };
}
