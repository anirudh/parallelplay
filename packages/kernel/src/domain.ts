import { createHash } from "node:crypto";
import { canonicalDigest } from "./canonical.js";
import { decideAdvisor } from "./advisor.js";
import {
  artifactManifestDigest,
  canonicalArtifactEntries,
  driverReceiptDigest,
  receiptIdentity,
  sourceRevisionDigest,
  verificationReceiptDigest,
  verificationResultDigest
} from "./evidence.js";
import type { AttemptState, JobState, OutboxState, ProjectionState, StateEntity } from "./model.js";
import { workflowKey } from "./model.js";
import type {
  AttentionPolicyBindingV1,
  AttentionReferenceV1,
  AttentionSourceReferenceV1,
  DecisionOptionV1,
  DecisionPacketRevisionV1,
  DecisionTypedActionV1,
  Command,
  ContextPacketV1,
  DomainEventInput,
  JobPolicy,
  OutcomeValidationV1,
  ProgramGraphState
} from "./schema.js";

export type DomainErrorCode =
  | "PROGRAM_NOT_FOUND"
  | "PROGRAM_ALREADY_EXISTS"
  | "PROGRAM_NOT_STARTABLE"
  | "PROGRAM_NOT_ADVANCEABLE"
  | "INTERVIEW_NOT_FOUND"
  | "GRAPH_NOT_FOUND"
  | "GRAPH_INVALID"
  | "ISSUE_NOT_FOUND"
  | "ATTENTION_SPAN_NOT_FOUND"
  | "OUTCOME_PACKET_NOT_FOUND"
  | "MEASUREMENT_NOT_READY"
  | "ATTENTION_SOURCE_NOT_FOUND"
  | "ATTENTION_POLICY_CONFLICT"
  | "ADVISOR_SUBJECT_CONFLICT"
  | "ADVISOR_CASE_INVALID"
  | "ADVISOR_CORPUS_INVALID"
  | "ADVISOR_INVOCATION_NOT_CLAIMABLE"
  | "ADVISOR_INVOCATION_LEASE_CONFLICT"
  | "ADVISOR_OUTPUT_INVALID"
  | "ADVISOR_EVALUATION_BLOCKED"
  | "DECISION_POLICY_CONFLICT"
  | "DECISION_POLICY_NOT_PROMOTABLE"
  | "DECISION_POLICY_INACTIVE"
  | "ADVISOR_AUDIT_NOT_FOUND"
  | "DECISION_PACKET_NOT_FOUND"
  | "DECISION_PACKET_STALE"
  | "DECISION_ACTION_MISMATCH"
  | "DECISION_ALREADY_RESOLVED"
  | "ATTENTION_DELIVERY_NOT_CLAIMABLE"
  | "ATTENTION_DELIVERY_LEASE_CONFLICT"
  | "APPROVAL_REQUIRES_OPERATOR"
  | "MILESTONE_NOT_FOUND"
  | "MILESTONE_ALREADY_EXISTS"
  | "MILESTONE_NOT_STARTABLE"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_VERSION_CONFLICT"
  | "RUN_NOT_FOUND"
  | "RUN_ALREADY_EXISTS"
  | "RUN_TERMINAL"
  | "RUN_NOT_SCHEDULABLE"
  | "RUN_ALREADY_SCHEDULED"
  | "SCHEDULE_MISMATCH"
  | "LEGACY_ACTIVE_ATTEMPT"
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_TERMINAL"
  | "ATTEMPT_NOT_ACTIVE"
  | "COMMAND_RETIRED"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_CLAIMABLE"
  | "JOB_LEASE_CONFLICT"
  | "JOB_LEASE_EXPIRED"
  | "OUTBOX_NOT_FOUND"
  | "OUTBOX_NOT_CLAIMABLE"
  | "OUTBOX_LEASE_CONFLICT"
  | "OUTBOX_LEASE_EXPIRED"
  | "VERIFICATION_REQUIRED"
  | "SOURCE_REVISION_NOT_FOUND"
  | "SOURCE_REVISION_ALREADY_EXISTS"
  | "SOURCE_REVISION_CONFLICT"
  | "VERIFICATION_NOT_FOUND"
  | "VERIFICATION_NOT_ACTIVE"
  | "EVIDENCE_DIGEST_MISMATCH"
  | "ARTIFACT_MANIFEST_CONFLICT";

export interface DomainError {
  code: DomainErrorCode;
  message: string;
  details?: Record<string, string | number>;
}

export type Decision =
  | { ok: true; events: DomainEventInput[]; resultKind: StateEntity["kind"]; resultId: string }
  | { ok: false; error: DomainError };

export interface DecisionContext {
  now: string;
  staleActionConflictCount?: number;
}

const OUTBOX_RETRY_DELAYS = [250, 1_000, 5_000, 10_000, 30_000, 30_000, 30_000];
const TERMINAL_RUNS = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_JOBS = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_ATTEMPTS = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

function failure(
  code: DomainErrorCode,
  message: string,
  details?: DomainError["details"]
): Decision {
  return details
    ? { ok: false, error: { code, message, details } }
    : { ok: false, error: { code, message } };
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function atOrBefore(timestamp: string, now: string): boolean {
  return timestamp <= now;
}

function deterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hash[12] = "5";
  hash[16] = "8";
  const value = hash.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function outboxEnqueued(
  outboxId: string,
  job: JobState,
  attempt: AttemptState,
  effect:
    | {
        effectType: "agent.start";
        driver: "fake" | "generic-command";
        capability: string;
        attemptId: string;
        attemptStartedAt?: string;
        jobId: string;
        runId: string;
        baseRevisionId?: string;
        executionContract?: NonNullable<JobState["executionContract"]>;
        executionContractDigest?: string;
        capabilityManifest?: NonNullable<JobState["capabilityManifest"]>;
        capabilityManifestDigest?: string;
        contextPacket?: ContextPacketV1;
        contextPacketDigest?: string;
      }
    | {
        effectType: "agent.cancel";
        externalRunId: string;
        reason: "operator_cancelled" | "timed_out" | "approval_required";
        attemptId: string;
        jobId: string;
        runId: string;
      }
    | {
        effectType: "verification.run";
        verificationId: string;
        sourceRevisionId: string;
        workflowId: string;
        workflowVersion: number;
        workflowDigest: string;
        verifierContract: NonNullable<JobState["verifierContract"]>;
        verifierContractDigest: string;
        attemptId: string;
        jobId: string;
        runId: string;
      }
): DomainEventInput {
  return {
    type: "OutboxEnqueued",
    streamType: "outbox",
    streamId: outboxId,
    data: {
      outboxId,
      runId: job.runId,
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      effectKey: outboxId,
      effect,
      retryDelaysMs: OUTBOX_RETRY_DELAYS
    }
  };
}

function cancellationEvents(
  state: ProjectionState,
  job: JobState,
  reason: "operator_cancelled" | "run_failed",
  generatedOutboxIds: Set<string>
): DomainEventInput[] {
  const events: DomainEventInput[] = [];
  const attempt = job.activeAttemptId ? state.attempts.get(job.activeAttemptId) : undefined;
  if (attempt && !TERMINAL_ATTEMPTS.has(attempt.status)) {
    events.push({
      type: "AttemptFinished",
      streamType: "attempt",
      streamId: attempt.attemptId,
      data: {
        attemptId: attempt.attemptId,
        jobId: job.jobId,
        runId: job.runId,
        status: "cancelled",
        terminationReason: reason === "operator_cancelled" ? "operator_cancelled" : "run_failed",
        detail: reason
      }
    });
    for (const outbox of state.outbox.values()) {
      if (
        outbox.attemptId === attempt.attemptId &&
        outbox.effect.effectType !== "agent.cancel" &&
        (outbox.status === "pending" || outbox.status === "leased")
      ) {
        events.push({
          type: "OutboxObsoleted",
          streamType: "outbox",
          streamId: outbox.outboxId,
          data: { outboxId: outbox.outboxId, runId: outbox.runId, reason }
        });
      }
    }
    const verification = [...state.verifications.values()].find(
      (candidate) => candidate.attemptId === attempt.attemptId && candidate.status === "requested"
    );
    if (verification) {
      events.push({
        type: "VerificationCancelled",
        streamType: "verification",
        streamId: verification.verificationId,
        data: { verificationId: verification.verificationId, runId: job.runId, reason }
      });
    }
    if (attempt.externalRunId) {
      const outboxId = deterministicUuid(`${attempt.attemptId}:agent.cancel`);
      if (!state.outbox.has(outboxId) && !generatedOutboxIds.has(outboxId)) {
        generatedOutboxIds.add(outboxId);
        events.push(
          outboxEnqueued(outboxId, job, attempt, {
            effectType: "agent.cancel",
            externalRunId: attempt.externalRunId,
            reason: reason === "operator_cancelled" ? "operator_cancelled" : "operator_cancelled",
            attemptId: attempt.attemptId,
            jobId: job.jobId,
            runId: job.runId
          })
        );
      }
    }
  }
  events.push({
    type: "JobCancelled",
    streamType: "job",
    streamId: job.jobId,
    data: { jobId: job.jobId, runId: job.runId, reason }
  });
  return events;
}

function validateJobLease(
  job: JobState,
  ownerId: string,
  fencingToken: number,
  now: string
): Decision | null {
  if (job.leaseOwnerId !== ownerId || job.leaseFencingToken !== fencingToken) {
    return failure("JOB_LEASE_CONFLICT", "Job lease owner or fencing token does not match", {
      jobId: job.jobId,
      fencingToken
    });
  }
  if (!job.leaseExpiresAt || atOrBefore(job.leaseExpiresAt, now)) {
    return failure("JOB_LEASE_EXPIRED", "Job lease has expired", { jobId: job.jobId });
  }
  return null;
}

function validateOutboxLease(
  outbox: OutboxState,
  ownerId: string,
  fencingToken: number,
  now: string
): Decision | null {
  if (outbox.leaseOwnerId !== ownerId || outbox.leaseFencingToken !== fencingToken) {
    return failure("OUTBOX_LEASE_CONFLICT", "Outbox lease owner or fencing token does not match", {
      outboxId: outbox.outboxId,
      fencingToken
    });
  }
  if (!outbox.leaseExpiresAt || atOrBefore(outbox.leaseExpiresAt, now)) {
    return failure("OUTBOX_LEASE_EXPIRED", "Outbox lease has expired", {
      outboxId: outbox.outboxId
    });
  }
  return null;
}

function failureTransitionEvents(
  state: ProjectionState,
  job: JobState,
  attempt: AttemptState,
  reason: "driver_error" | "timed_out",
  now: string,
  detail?: string,
  excludedOutboxId?: string
): DomainEventInput[] {
  const events: DomainEventInput[] = [
    {
      type: "AttemptFinished",
      streamType: "attempt",
      streamId: attempt.attemptId,
      data: {
        attemptId: attempt.attemptId,
        jobId: job.jobId,
        runId: job.runId,
        status: reason === "timed_out" ? "timed_out" : "failed",
        terminationReason: reason,
        ...(detail ? { detail } : {})
      }
    }
  ];

  for (const outbox of state.outbox.values()) {
    if (
      outbox.attemptId === attempt.attemptId &&
      outbox.outboxId !== excludedOutboxId &&
      outbox.effect.effectType !== "agent.cancel" &&
      (outbox.status === "pending" || outbox.status === "leased")
    ) {
      events.push({
        type: "OutboxObsoleted",
        streamType: "outbox",
        streamId: outbox.outboxId,
        data: { outboxId: outbox.outboxId, runId: outbox.runId, reason }
      });
    }
  }
  const verification = [...state.verifications.values()].find(
    (candidate) => candidate.attemptId === attempt.attemptId && candidate.status === "requested"
  );
  if (verification) {
    events.push({
      type: "VerificationCancelled",
      streamType: "verification",
      streamId: verification.verificationId,
      data: { verificationId: verification.verificationId, runId: job.runId, reason }
    });
  }

  if (reason === "timed_out" && attempt.externalRunId) {
    const outboxId = deterministicUuid(`${attempt.attemptId}:agent.cancel`);
    if (!state.outbox.has(outboxId)) {
      events.push(
        outboxEnqueued(outboxId, job, attempt, {
          effectType: "agent.cancel",
          externalRunId: attempt.externalRunId,
          reason: "timed_out",
          attemptId: attempt.attemptId,
          jobId: job.jobId,
          runId: job.runId
        })
      );
    }
  }

  if (job.attemptCount < job.policy.maxAttempts) {
    const delay = job.policy.retryDelaysMs[job.attemptCount - 1] ?? 0;
    events.push({
      type: "JobRetryScheduled",
      streamType: "job",
      streamId: job.jobId,
      data: {
        jobId: job.jobId,
        runId: job.runId,
        availableAt: addMilliseconds(now, delay),
        reason
      }
    });
    return events;
  }

  const failureReason = detail ?? reason;
  events.push({
    type: "JobFailed",
    streamType: "job",
    streamId: job.jobId,
    data: { jobId: job.jobId, runId: job.runId, reason: failureReason }
  });
  const generatedOutboxIds = new Set<string>();
  for (const other of state.jobs.values()) {
    if (
      other.runId === job.runId &&
      other.jobId !== job.jobId &&
      !TERMINAL_JOBS.has(other.status)
    ) {
      events.push(...cancellationEvents(state, other, "run_failed", generatedOutboxIds));
    }
  }
  events.push({
    type: "RunFailed",
    streamType: "run",
    streamId: job.runId,
    data: { runId: job.runId, reason: failureReason }
  });
  return events;
}

function activeGenerationForProgram(state: ProjectionState, programId: string) {
  return [...state.milestoneGenerations.values()].find(
    (generation) => generation.programId === programId && generation.status === "running"
  );
}

function graphMilestone(
  graph: ProgramGraphState,
  milestoneId: string
): ProgramGraphState["graph"]["milestones"][number] | undefined {
  return graph.graph.milestones.find((entry) => entry.contract.milestoneId === milestoneId);
}

function graphNodeAllowedPaths(node: ProgramGraphState["graph"]["milestones"][number]): string[] {
  return "workSurfaces" in node
    ? node.workSurfaces.map((surface) => surface.path)
    : node.allowedWorkSurfaces;
}

function graphNodeStructuredSurfaces(node: ProgramGraphState["graph"]["milestones"][number]) {
  return "workSurfaces" in node ? node.workSurfaces : [];
}

function workSurfacesOverlap(
  left: { kind: "file" | "subtree"; path: string },
  right: { kind: "file" | "subtree"; path: string }
): boolean {
  if (left.path === right.path) return true;
  if (left.kind === "subtree" && right.path.startsWith(`${left.path}/`)) return true;
  return right.kind === "subtree" && left.path.startsWith(`${right.path}/`);
}

function surfaceClaimKey(
  targetRevisionId: string,
  surface: { kind: "file" | "subtree"; path: string }
): string {
  return `surface:${targetRevisionId}:${surface.kind}:${surface.path}`;
}

function parseSurfaceClaimKey(
  claimKey: string
): { targetRevisionId: string; kind: "file" | "subtree"; path: string } | null {
  const match = /^surface:([^:]+):(file|subtree):(.+)$/.exec(claimKey);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    targetRevisionId: match[1],
    kind: match[2] as "file" | "subtree",
    path: match[3]
  };
}

function recordsForMilestone<T extends { scope: { kind: string; milestoneIds?: string[] } }>(
  records: T[],
  milestoneId: string
): T[] {
  return records.filter(
    (record) =>
      record.scope.kind === "program" || record.scope.milestoneIds?.includes(milestoneId) === true
  );
}

function generationSeed(
  graphDigest: string,
  milestoneId: string,
  generation: number,
  validations: OutcomeValidationV1[]
): string {
  return [
    "parallelplay:program:generation:v1",
    graphDigest,
    milestoneId,
    String(generation),
    ...validations.map((validation) => validation.packetDigest).sort()
  ].join(":");
}

function buildContextPacket(
  state: ProjectionState,
  graph: ProgramGraphState,
  milestoneId: string,
  generationId: string,
  generation: number,
  baseRevisionId: string,
  validations: OutcomeValidationV1[],
  now: string
): ContextPacketV1 {
  const node = graphMilestone(graph, milestoneId);
  if (!node) throw new Error("Graph milestone is missing");
  const source = state.sourceRevisions.get(baseRevisionId);
  if (!source) throw new Error("Context source revision is missing");
  const interview = [...state.programInterviews.values()].find(
    (candidate) => candidate.playback.playbackId === graph.graph.intentPlaybackRef.id
  );
  if (!interview) throw new Error("Context intent playback is missing");
  const seed = generationSeed(graph.graphDigest, milestoneId, generation, validations);
  const dependencyPackets = validations.map((validation) => {
    const packet = state.outcomePackets.get(validation.outcomePacketId);
    if (!packet) throw new Error("Context dependency outcome is missing");
    return packet;
  });
  return {
    schemaVersion: 1,
    contextPacketId: deterministicUuid(`${seed}:context`),
    programId: graph.programId,
    milestoneId,
    generationId,
    generation,
    intentPlaybackRef: graph.graph.intentPlaybackRef,
    graphRevisionRef: {
      kind: "program_graph",
      id: graph.graphRevisionId,
      digest: graph.graphDigest
    },
    milestoneContractRef: {
      kind: "milestone_contract",
      id: milestoneId,
      digest: canonicalDigest(node.contract)
    },
    sourceRevisionRef: {
      kind: "source_revision",
      id: source.revisionId,
      digest: source.revisionDigest
    },
    dependencyOutcomeRefs: dependencyPackets.map((packet) => ({
      kind: "outcome_packet",
      id: packet.outcomePacketId,
      digest: packet.packetDigest
    })),
    dependencyVerificationRefs: dependencyPackets.flatMap((packet) => [
      ...packet.packet.driverReceipts,
      ...packet.packet.verificationReceipts,
      ...packet.packet.artifactManifests
    ]),
    decisions: recordsForMilestone(graph.graph.initialContext.decisions, milestoneId),
    assumptions: recordsForMilestone(graph.graph.initialContext.assumptions, milestoneId),
    risks: recordsForMilestone(graph.graph.initialContext.risks, milestoneId),
    unresolvedQuestions: recordsForMilestone(
      graph.graph.initialContext.unresolvedQuestions,
      milestoneId
    ),
    refs: [...graph.graph.initialContext.refs, ...node.refs],
    allowedWorkSurfaces: graphNodeAllowedPaths(node),
    compiledAt: now
  };
}

function startGraphMilestoneEvents(
  state: ProjectionState,
  graph: ProgramGraphState,
  milestoneId: string,
  generation: number,
  baseRevisionId: string,
  validations: OutcomeValidationV1[],
  policy: JobPolicy,
  now: string
): { events: DomainEventInput[]; runId: string; generationId: string } | Decision {
  const node = graphMilestone(graph, milestoneId);
  if (!node)
    return failure("MILESTONE_NOT_FOUND", "Graph milestone does not exist", { milestoneId });
  const workflow = state.workflows.get(
    workflowKey(node.contract.workflowId, node.contract.workflowVersion)
  );
  if (
    !workflow ||
    !("schemaVersion" in workflow.definition) ||
    workflow.definition.schemaVersion !== 3 ||
    workflow.definition.steps.length !== 1 ||
    workflow.definition.steps[0]?.dependsOn.length !== 0
  ) {
    return failure("WORKFLOW_NOT_FOUND", "program milestones require one-step Workflow V3", {
      milestoneId
    });
  }
  const step = workflow.definition.steps[0];
  if (step.verification.timeoutMs > policy.attemptTimeoutMs) {
    return failure("VERIFICATION_REQUIRED", "Verifier timeout must fit within attempt timeout", {
      milestoneId
    });
  }
  const seed = generationSeed(graph.graphDigest, milestoneId, generation, validations);
  const generationId = deterministicUuid(`${seed}:generation`);
  const runId = deterministicUuid(`${seed}:run`);
  const jobId = deterministicUuid(`${seed}:job`);
  if (
    state.milestoneGenerations.has(generationId) ||
    state.runs.has(runId) ||
    state.jobs.has(jobId)
  ) {
    return failure("PROGRAM_NOT_ADVANCEABLE", "Deterministic generation already exists", {
      milestoneId,
      generation
    });
  }
  const packet = buildContextPacket(
    state,
    graph,
    milestoneId,
    generationId,
    generation,
    baseRevisionId,
    validations,
    now
  );
  const packetDigest = canonicalDigest(packet);
  const executionContract = {
    ...step.execution,
    context: {
      ...step.execution.context,
      contextPacketId: packet.contextPacketId,
      contextPacketDigest: packetDigest
    }
  };
  const capabilityManifest = {
    ...step.capabilities,
    context: {
      ...step.capabilities.context,
      contextPacketId: packet.contextPacketId,
      contextPacketDigest: packetDigest
    }
  };
  const generationState = {
    schemaVersion: 1 as const,
    generationId,
    programId: graph.programId,
    milestoneId,
    graphRevisionId: graph.graphRevisionId,
    generation,
    runId,
    jobId,
    contextPacketId: packet.contextPacketId,
    baseRevisionId,
    status: "running" as const,
    outcomePacketId: null,
    recommendation: null,
    startedAt: now,
    completedAt: null
  };
  return {
    runId,
    generationId,
    events: [
      {
        type: "ContextPacketCompiled",
        streamType: "context_packet",
        streamId: packet.contextPacketId,
        data: { packet, packetDigest }
      },
      {
        type: "MilestoneGenerationStarted",
        streamType: "milestone_generation",
        streamId: generationId,
        data: { generation: generationState }
      },
      {
        type: "MilestoneRunCreated",
        streamType: "run",
        streamId: runId,
        data: {
          runId,
          milestoneId,
          programId: graph.programId,
          workflowId: workflow.workflowId,
          workflowVersion: workflow.version,
          generationId,
          generation
        }
      },
      {
        type: "JobScheduled",
        streamType: "job",
        streamId: jobId,
        data: {
          jobId,
          runId,
          stepId: step.id,
          capability: step.capability,
          dependencyJobIds: [],
          initialStatus: "ready",
          policy,
          sourceRevisionId: baseRevisionId,
          executionContract,
          executionContractDigest: canonicalDigest(executionContract),
          capabilityManifest,
          capabilityManifestDigest: canonicalDigest(capabilityManifest),
          contextPacketId: packet.contextPacketId,
          contextPacketDigest: packetDigest,
          verifierContract: step.verification,
          verifierContractDigest: canonicalDigest(step.verification)
        }
      },
      {
        type: "RunScheduled",
        streamType: "run",
        streamId: runId,
        data: { runId }
      }
    ]
  };
}

function sumDecimalStrings(values: string[]): string {
  const scale = Math.max(...values.map((value) => value.split(".")[1]?.length ?? 0));
  const total = values.reduce((sum, value) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return sum + BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  }, 0n);
  if (scale === 0) return total.toString();
  const padded = total.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function nonretryableDriverFailureEvents(
  state: ProjectionState,
  job: JobState,
  attempt: AttemptState,
  reason: "approval_required" | "protocol_invalid" | "capability_violation" | "operator_cancelled",
  detail: string
): DomainEventInput[] {
  const events: DomainEventInput[] = [
    {
      type: "AttemptFinished",
      streamType: "attempt",
      streamId: attempt.attemptId,
      data: {
        attemptId: attempt.attemptId,
        jobId: job.jobId,
        runId: job.runId,
        status:
          reason === "approval_required"
            ? "approval_required"
            : reason === "operator_cancelled"
              ? "cancelled"
              : "failed",
        terminationReason: reason,
        detail
      }
    }
  ];
  for (const outbox of state.outbox.values()) {
    if (
      outbox.attemptId === attempt.attemptId &&
      outbox.effect.effectType !== "agent.cancel" &&
      (outbox.status === "pending" || outbox.status === "leased")
    ) {
      events.push({
        type: "OutboxObsoleted",
        streamType: "outbox",
        streamId: outbox.outboxId,
        data: { outboxId: outbox.outboxId, runId: job.runId, reason }
      });
    }
  }
  events.push({
    type: "JobFailed",
    streamType: "job",
    streamId: job.jobId,
    data: { jobId: job.jobId, runId: job.runId, reason: detail }
  });
  const generatedOutboxIds = new Set<string>();
  for (const other of state.jobs.values()) {
    if (
      other.runId === job.runId &&
      other.jobId !== job.jobId &&
      !TERMINAL_JOBS.has(other.status)
    ) {
      events.push(...cancellationEvents(state, other, "run_failed", generatedOutboxIds));
    }
  }
  events.push({
    type: "RunFailed",
    streamType: "run",
    streamId: job.runId,
    data: { runId: job.runId, reason: detail }
  });
  return events;
}

const KERNEL_DEFAULT_ATTENTION_POLICY = {
  version: "kernel-default-v1" as const,
  description: "Page safety or authority boundaries; queue all routine decisions",
  defaultOnTimeout: null,
  routinePageBudget: { maxPages: 0, windowMs: 86_400_000 }
};

interface AttentionSourceMaterial {
  programId: string;
  milestoneId: string | null;
  source: AttentionSourceReferenceV1;
  originalQuestion: string;
  prompt: string;
  context: string;
  riskClass: "low" | "normal" | "high" | "reserved";
  safetyClass: "routine" | "safety_critical";
  reversibility: "reversible" | "costly" | "one_way";
  options: DecisionOptionV1[];
  refs: AttentionReferenceV1[];
  deadlineAt: string | null;
}

function optionId(source: AttentionSourceReferenceV1, label: string): string {
  return deterministicUuid(`parallelplay:attention-option:v1:${source.kind}:${source.id}:${label}`);
}

function attentionRef(
  kind: AttentionReferenceV1["kind"],
  id: string,
  digest: string
): AttentionReferenceV1 {
  return { kind, id, digest };
}

function attentionReferenceAuthority(
  state: ProjectionState,
  reference: AttentionReferenceV1
): { digest: string; programId: string | null } | null {
  const runProgram = (runId: string): string | null => state.runs.get(runId)?.programId ?? null;
  switch (reference.kind) {
    case "intent_playback": {
      const interview = [...state.programInterviews.values()].find(
        (entry) => entry.playback.playbackId === reference.id
      );
      return interview
        ? { digest: interview.playbackDigest, programId: interview.programId }
        : null;
    }
    case "program_graph": {
      const value = state.programGraphs.get(reference.id);
      return value ? { digest: value.graphDigest, programId: value.programId } : null;
    }
    case "milestone_contract": {
      const value = state.milestones.get(reference.id);
      return value ? { digest: value.contractDigest, programId: value.programId } : null;
    }
    case "context_packet": {
      const value = state.contextPackets.get(reference.id);
      return value ? { digest: value.packetDigest, programId: value.programId } : null;
    }
    case "source_revision": {
      const value = state.sourceRevisions.get(reference.id);
      return value ? { digest: value.revisionDigest, programId: null } : null;
    }
    case "outcome_packet": {
      const value = state.outcomePackets.get(reference.id);
      return value ? { digest: value.packetDigest, programId: value.programId } : null;
    }
    case "outcome_validation": {
      const value = state.outcomeValidations.get(reference.id);
      return value ? { digest: value.validationDigest, programId: value.programId } : null;
    }
    case "artifact_manifest": {
      const value = state.artifactManifests.get(reference.id);
      return value ? { digest: value.manifestDigest, programId: runProgram(value.runId) } : null;
    }
    case "driver_receipt": {
      const value = state.driverReceipts.get(reference.id);
      return value ? { digest: value.receiptDigest, programId: runProgram(value.runId) } : null;
    }
    case "verification": {
      const value = state.verifications.get(reference.id);
      const digest = value?.receiptDigest ?? value?.resultDigest;
      return value && digest ? { digest, programId: runProgram(value.runId) } : null;
    }
    case "routed_issue": {
      const value = state.routedIssues.get(reference.id);
      return value ? { digest: value.issueDigest, programId: value.issue.programId } : null;
    }
    case "approval_request": {
      const value = state.approvalRequests.get(reference.id);
      return value ? { digest: canonicalDigest(value), programId: runProgram(value.runId) } : null;
    }
    case "outcome_disposition": {
      const value = state.outcomeDispositions.get(reference.id);
      return value
        ? { digest: canonicalDigest(value.disposition), programId: value.disposition.programId }
        : null;
    }
    case "operator_decision_request": {
      const value = state.operatorDecisionRequests.get(reference.id);
      return value ? { digest: value.requestDigest, programId: value.request.programId } : null;
    }
    case "decision_packet_revision": {
      const value = state.decisionPacketRevisions.get(reference.id);
      return value ? { digest: value.revisionDigest, programId: value.revision.programId } : null;
    }
    case "decision_evidence_bundle": {
      const value = state.decisionEvidenceBundles.get(reference.id);
      return value ? { digest: value.bundleDigest, programId: value.bundle.programId } : null;
    }
    case "attention_policy": {
      const value = state.attentionPolicies.get(reference.id);
      return value ? { digest: value.policyDigest, programId: null } : null;
    }
    case "decision_acknowledgement": {
      const value = state.decisionAcknowledgements.get(reference.id);
      const packet = value ? state.decisionPackets.get(value.acknowledgement.packetId) : undefined;
      return value && packet
        ? { digest: value.acknowledgementDigest, programId: packet.programId }
        : null;
    }
    case "decision_resolution": {
      const value = state.decisionResolutions.get(reference.id);
      const packet = value ? state.decisionPackets.get(value.resolution.packetId) : undefined;
      return value && packet
        ? { digest: value.resolutionDigest, programId: packet.programId }
        : null;
    }
    case "decision_action_result": {
      const value = state.decisionActionResults.get(reference.id);
      const packet = value ? state.decisionPackets.get(value.result.packetId) : undefined;
      return value && packet ? { digest: value.resultDigest, programId: packet.programId } : null;
    }
    case "decision_precedent": {
      const value = state.decisionPrecedents.get(reference.id);
      return value ? { digest: value.precedentDigest, programId: value.precedent.programId } : null;
    }
    case "attention_delivery": {
      const value = state.attentionDeliveries.get(reference.id);
      return value
        ? { digest: canonicalDigest(value.delivery), programId: value.delivery.programId }
        : null;
    }
    case "attention_budget_incident": {
      const value = state.attentionBudgetIncidents.get(reference.id);
      return value ? { digest: value.incidentDigest, programId: value.incident.programId } : null;
    }
    case "attention_measurement_report": {
      const value = state.attentionMeasurementReports.get(reference.id);
      return value ? { digest: value.reportDigest, programId: value.report.programId } : null;
    }
    case "attention_digest_artifact": {
      const value = state.attentionDigestArtifacts.get(reference.id);
      return value ? { digest: value.artifactDigest, programId: value.artifact.programId } : null;
    }
  }
}

function attentionOptionInScope(
  state: ProjectionState,
  programId: string,
  option: DecisionOptionV1
): boolean {
  const target = option.action.target;
  if (target.kind === "record_only") {
    const authority = attentionReferenceAuthority(state, target.targetRef);
    return (
      authority?.digest === target.targetRef.digest &&
      (authority.programId === null || authority.programId === programId)
    );
  }
  if (target.kind === "issue_resolution") {
    const issue = state.routedIssues.get(target.issueId);
    return (
      issue?.issue.programId === programId &&
      issue.issue.status === "open" &&
      issue.issueDigest === target.issueDigest
    );
  }
  if (target.kind === "outcome_disposition") {
    const packet = state.outcomePackets.get(target.outcomePacketId);
    return (
      packet?.programId === programId &&
      packet.packetDigest === target.outcomePacketDigest &&
      !state.outcomeDispositions.has(packet.outcomePacketId)
    );
  }
  if (target.kind === "program_resume") {
    const program = state.programs.get(target.programId);
    return (
      target.programId === programId &&
      program?.phase === "parked" &&
      program.version === target.expectedProgramVersion &&
      program.activeGraphDigest === target.expectedGraphDigest
    );
  }
  if (target.kind === "milestone_retry") {
    const program = state.programs.get(target.programId);
    const milestone = state.milestones.get(target.milestoneId);
    const graph = state.programGraphs.get(target.graphRevisionId);
    return (
      target.programId === programId &&
      program?.phase === "running" &&
      program.activeGraphRevisionId === target.graphRevisionId &&
      program.activeGraphDigest === target.graphDigest &&
      graph?.graphDigest === target.graphDigest &&
      milestone?.programId === programId &&
      milestone.version === target.expectedMilestoneVersion &&
      (milestone.generation ?? 0) === target.expectedGeneration &&
      milestone.contractDigest === target.contractDigest
    );
  }
  if (target.kind === "run_cancel") {
    const run = state.runs.get(target.runId);
    return (
      run?.programId === programId &&
      run.version === target.expectedRunVersion &&
      !TERMINAL_RUNS.has(run.status)
    );
  }
  if (target.kind === "program_park") {
    const program = state.programs.get(target.programId);
    return (
      target.programId === programId &&
      program !== undefined &&
      (program.phase === "running" ||
        (program.programMode === "graph_v2" &&
          (program.phase === "eligible" || program.phase === "integration_pending"))) &&
      program.version === target.expectedProgramVersion &&
      program.activeGraphDigest === target.expectedGraphDigest
    );
  }
  const program = state.programs.get(target.programId);
  return target.programId === programId && program?.version === target.expectedProgramVersion;
}

function validateAttentionMaterial(
  state: ProjectionState,
  material: AttentionSourceMaterial
): Decision | null {
  for (const reference of material.refs) {
    if (
      reference.kind === material.source.kind &&
      reference.id === material.source.id &&
      reference.digest === material.source.digest
    ) {
      continue;
    }
    const authority = attentionReferenceAuthority(state, reference);
    if (
      authority?.digest !== reference.digest ||
      (authority.programId !== null && authority.programId !== material.programId)
    ) {
      return failure(
        "ATTENTION_SOURCE_NOT_FOUND",
        "Attention evidence reference is missing, stale, or outside the program"
      );
    }
  }
  if (
    !material.options.every((option) => attentionOptionInScope(state, material.programId, option))
  ) {
    return failure(
      "ATTENTION_SOURCE_NOT_FOUND",
      "Attention action target is missing, stale, or outside the program"
    );
  }
  return null;
}

function sourceMaterial(
  state: ProjectionState,
  source: AttentionSourceReferenceV1
): AttentionSourceMaterial | Decision {
  if (source.kind === "routed_issue") {
    const stored = state.routedIssues.get(source.id);
    if (
      stored?.issueDigest !== source.digest ||
      canonicalDigest(stored.issue) !== source.digest ||
      stored.issue.status !== "open" ||
      stored.issue.route === "record_only"
    ) {
      return failure("ATTENTION_SOURCE_NOT_FOUND", "Eligible routed issue does not exist");
    }
    const options: DecisionOptionV1[] = [];
    const resolutionActions =
      stored.issue.route === "operator_required"
        ? (["requires_graph_revision"] as const)
        : (["resume_unchanged_contract", "requires_graph_revision"] as const);
    for (const action of resolutionActions) {
      const label =
        action === "resume_unchanged_contract"
          ? "Resume with the unchanged contract"
          : "Require an approved graph revision";
      options.push({
        optionId: optionId(source, action),
        label,
        consequences: [
          action === "resume_unchanged_contract"
            ? "Only the already-approved milestone contract may resume"
            : "Execution remains blocked until program-graph.approve supplies new authority"
        ],
        reversalCost:
          action === "resume_unchanged_contract"
            ? "A later issue can pause the scope"
            : "Requires another operator decision",
        action: {
          kind: "approve",
          target: {
            kind: "issue_resolution",
            issueId: stored.issue.issueId,
            issueDigest: stored.issueDigest,
            action,
            text: label
          }
        }
      });
    }
    for (const milestoneId of stored.issue.affectedMilestoneIds) {
      const milestone = state.milestones.get(milestoneId);
      const run = milestone?.runId ? state.runs.get(milestone.runId) : undefined;
      if (run && !TERMINAL_RUNS.has(run.status)) {
        options.push({
          optionId: optionId(source, `cancel:${run.runId}`),
          label: "Cancel the affected run",
          consequences: ["Only the exact affected run is cancelled through the fenced path"],
          reversalCost: "A fresh generation requires a separate retry decision",
          action: {
            kind: "cancel",
            target: {
              kind: "run_cancel",
              runId: run.runId,
              expectedRunVersion: run.version,
              reason: `decision_packet:${source.id}`
            }
          }
        });
      }
    }
    const riskClass =
      stored.issue.proposedClass === "authority_boundary"
        ? ("reserved" as const)
        : stored.issue.proposedClass === "contradiction"
          ? ("high" as const)
          : ("normal" as const);
    return {
      programId: stored.issue.programId,
      milestoneId:
        stored.issue.affectedMilestoneIds.length === 1
          ? (stored.issue.affectedMilestoneIds[0] ?? null)
          : null,
      source,
      originalQuestion: stored.issue.originalText,
      prompt: `Resolve ${stored.issue.proposedClass.replace("_", " ")} for the affected scope`,
      context: `Route: ${stored.issue.route}. Affected milestones: ${stored.issue.affectedMilestoneIds.join(", ")}.`,
      riskClass,
      safetyClass:
        stored.issue.proposedClass === "authority_boundary" ? "safety_critical" : "routine",
      reversibility: stored.issue.proposedClass === "authority_boundary" ? "one_way" : "costly",
      options,
      refs: [
        attentionRef("routed_issue", stored.issue.issueId, stored.issueDigest),
        ...stored.issue.refs
      ],
      deadlineAt: null
    };
  }
  if (source.kind === "approval_request") {
    const stored = state.approvalRequests.get(source.id);
    if (!stored || canonicalDigest(stored) !== source.digest) {
      return failure("ATTENTION_SOURCE_NOT_FOUND", "Approval request does not exist");
    }
    const run = state.runs.get(stored.runId);
    if (!run) return failure("ATTENTION_SOURCE_NOT_FOUND", "Approval request run is missing");
    const options: DecisionOptionV1[] = [
      {
        optionId: optionId(source, "record-for-graph-revision"),
        label: "Record for an explicit graph revision",
        consequences: ["No capability is granted and the failed run remains terminal"],
        reversalCost: "A later graph revision and retry remain explicit operator actions",
        action: {
          kind: "approve",
          target: {
            kind: "record_only",
            targetRef: attentionRef("approval_request", stored.approvalRequestId, source.digest),
            text: "Capability request recorded without granting authority"
          }
        }
      }
    ];
    if (!TERMINAL_RUNS.has(run.status)) {
      options.push({
        optionId: optionId(source, "cancel-run"),
        label: "Cancel the requesting run",
        consequences: ["Only the exact requesting run is cancelled"],
        reversalCost: "A new generation requires a separate retry decision",
        action: {
          kind: "cancel",
          target: {
            kind: "run_cancel",
            runId: run.runId,
            expectedRunVersion: run.version,
            reason: `approval_request:${stored.approvalRequestId}`
          }
        }
      });
    }
    return {
      programId: run.programId,
      milestoneId: run.milestoneId,
      source,
      originalQuestion: stored.reason,
      prompt: `Review denied capability request ${stored.capability}`,
      context:
        "attention cannot grant worker capabilities; authority changes require an approved graph revision.",
      riskClass: "reserved",
      safetyClass: "safety_critical",
      reversibility: "one_way",
      options,
      refs: [attentionRef("approval_request", stored.approvalRequestId, source.digest)],
      deadlineAt: null
    };
  }
  if (source.kind === "outcome_packet") {
    const stored = state.outcomePackets.get(source.id);
    if (
      stored?.packetDigest !== source.digest ||
      canonicalDigest(stored.packet) !== source.digest ||
      state.outcomeDispositions.has(stored.outcomePacketId)
    ) {
      return failure("ATTENTION_SOURCE_NOT_FOUND", "Undisposed outcome packet does not exist");
    }
    const option = (disposition: "accepted" | "rejected"): DecisionOptionV1 => ({
      optionId: optionId(source, disposition),
      label: disposition === "accepted" ? "Accept the validated outcome" : "Reject the outcome",
      consequences: [
        disposition === "accepted"
          ? "Records operator acceptance without merging or expanding scope"
          : "Records rejection without mutating the candidate revision"
      ],
      reversalCost: "The immutable disposition remains historical evidence",
      action: {
        kind: "approve",
        target: {
          kind: "outcome_disposition",
          outcomePacketId: stored.outcomePacketId,
          outcomePacketDigest: stored.packetDigest,
          disposition,
          reason: null
        }
      }
    });
    const refs: AttentionReferenceV1[] = [
      attentionRef("outcome_packet", stored.outcomePacketId, stored.packetDigest),
      ...stored.packet.driverReceipts,
      ...stored.packet.verificationReceipts,
      ...stored.packet.artifactManifests
    ];
    return {
      programId: stored.programId,
      milestoneId: stored.milestoneId,
      source,
      originalQuestion: `Should outcome ${stored.outcomePacketId} be accepted?`,
      prompt: `Review ${stored.packet.recommendation} recommendation for milestone ${stored.milestoneId}`,
      context: `${String(stored.packet.criteriaResults.filter((item) => item.result === "pass").length)} of ${String(stored.packet.criteriaResults.length)} criteria passed.`,
      riskClass: stored.packet.recommendation === "merge" ? "normal" : "high",
      safetyClass: "routine",
      reversibility: "costly",
      options: [option("accepted"), option("rejected")],
      refs,
      deadlineAt: null
    };
  }
  const stored = state.operatorDecisionRequests.get(source.id);
  if (
    stored?.requestDigest !== source.digest ||
    canonicalDigest(stored.request) !== source.digest ||
    stored.request.schemaVersion !== 1
  ) {
    return failure("ATTENTION_SOURCE_NOT_FOUND", "Operator decision request does not exist");
  }
  return {
    programId: stored.request.programId,
    milestoneId: stored.request.milestoneId,
    source,
    originalQuestion: stored.request.originalQuestion,
    prompt: stored.request.prompt,
    context: stored.request.context,
    riskClass: stored.request.riskClass,
    safetyClass: stored.request.safetyClass,
    reversibility: stored.request.reversibility,
    options: stored.request.options,
    refs: [
      attentionRef("operator_decision_request", stored.request.requestId, stored.requestDigest),
      ...stored.request.refs
    ],
    deadlineAt: stored.request.deadlineAt
  };
}

function activeAttentionPolicy(state: ProjectionState) {
  return [...state.attentionPolicies.values()]
    .filter((entry) => entry.supersededAt === null)
    .sort((left, right) => right.policy.revision - left.policy.revision)[0];
}

function ruleMatches(
  material: AttentionSourceMaterial,
  rule: NonNullable<ReturnType<typeof activeAttentionPolicy>>["policy"]["rules"][number],
  now: string
): boolean {
  const actionKinds = [...new Set(material.options.map((option) => option.action.kind))];
  const matches = <T>(allowed: T[], value: T): boolean =>
    allowed.length === 0 || allowed.includes(value);
  if (
    !matches(rule.when.sourceKinds, material.source.kind) ||
    !matches(rule.when.riskClasses, material.riskClass) ||
    !matches(rule.when.safetyClasses, material.safetyClass) ||
    !matches(rule.when.reversibilities, material.reversibility) ||
    (rule.when.actionKinds.length > 0 &&
      !actionKinds.some((kind) => rule.when.actionKinds.includes(kind)))
  ) {
    return false;
  }
  if (rule.when.deadlineWithinMs === null) return true;
  if (material.deadlineAt === null) return false;
  const remaining = new Date(material.deadlineAt).getTime() - new Date(now).getTime();
  return remaining >= 0 && remaining <= rule.when.deadlineWithinMs;
}

function compileAttentionEvents(
  state: ProjectionState,
  material: AttentionSourceMaterial,
  now: string
): { events: DomainEventInput[]; packetId: string } | Decision {
  const validation = validateAttentionMaterial(state, material);
  if (validation) return validation;
  const policy = activeAttentionPolicy(state);
  const policyBinding: AttentionPolicyBindingV1 = policy
    ? { kind: "attention_policy", id: policy.policy.policyRevisionId, digest: policy.policyDigest }
    : {
        kind: "kernel_default",
        version: "kernel-default-v1",
        digest: canonicalDigest(KERNEL_DEFAULT_ATTENTION_POLICY)
      };
  const actionKinds = [...new Set(material.options.map((option) => option.action.kind))].sort();
  const deduplicationKey = canonicalDigest({
    programId: material.programId,
    sourceKind: material.source.kind,
    sourceId: material.source.id,
    requiredAuthority: "operator",
    milestoneId: material.milestoneId,
    actionKinds
  });
  const existing = [...state.decisionPackets.values()].find((packet) => {
    if (packet.status !== "open") return false;
    const revision = state.decisionPacketRevisions.get(packet.currentRevisionId);
    return revision?.revision.deduplicationKey === deduplicationKey;
  });
  const packetId =
    existing?.packetId ?? deterministicUuid(`parallelplay:decision-packet:v1:${deduplicationKey}`);
  const revisionNumber = existing
    ? (state.decisionPacketRevisions.get(existing.currentRevisionId)?.revision.revision ?? 0) + 1
    : 1;
  const packetRevisionId = deterministicUuid(
    `parallelplay:decision-revision:v1:${packetId}:${String(revisionNumber)}:${material.source.digest}:${String(state.lastAppliedPosition)}`
  );
  const evidenceBundleId = deterministicUuid(
    `parallelplay:decision-evidence:v1:${packetRevisionId}`
  );
  const bundle = {
    schemaVersion: 1 as const,
    evidenceBundleId,
    packetId,
    packetRevisionId,
    programId: material.programId,
    sourceRef: material.source,
    refs: [
      ...new Map(material.refs.map((ref) => [`${ref.kind}:${ref.id}:${ref.digest}`, ref])).values()
    ],
    orientation: material.context,
    compiledAt: now
  };
  const bundleDigest = canonicalDigest(bundle);
  const current = existing
    ? state.decisionPacketRevisions.get(existing.currentRevisionId)
    : undefined;
  const currentBundle = current
    ? state.decisionEvidenceBundles.get(current.revision.evidenceBundleRef.id)
    : undefined;
  if (
    current &&
    currentBundle &&
    current.revision.source.digest === material.source.digest &&
    canonicalDigest(currentBundle.bundle.sourceRef) === canonicalDigest(bundle.sourceRef) &&
    canonicalDigest(currentBundle.bundle.refs) === canonicalDigest(bundle.refs) &&
    currentBundle.bundle.orientation === bundle.orientation &&
    current.revision.originalQuestion === material.originalQuestion &&
    current.revision.prompt === material.prompt &&
    current.revision.context === material.context &&
    current.revision.riskClass === material.riskClass &&
    current.revision.safetyClass === material.safetyClass &&
    current.revision.reversibility === material.reversibility &&
    current.revision.deadlineAt === material.deadlineAt &&
    canonicalDigest(current.revision.options) === canonicalDigest(material.options) &&
    canonicalDigest(current.revision.policyBinding) === canonicalDigest(policyBinding)
  ) {
    return { events: [], packetId };
  }
  const matchedRule = policy?.policy.rules.find((rule) => ruleMatches(material, rule, now));
  let route: "queue" | "page" = policy
    ? (matchedRule?.route ?? policy.policy.defaultRoute)
    : material.safetyClass === "safety_critical" || material.riskClass === "reserved"
      ? "page"
      : "queue";
  let urgency: "p0" | "p1" | "p2" | "p3" = policy
    ? (matchedRule?.urgency ?? policy.policy.defaultUrgency)
    : route === "page"
      ? "p0"
      : "p2";
  let reason = policy
    ? matchedRule
      ? `policy_rule:${matchedRule.ruleId}`
      : "policy_default"
    : "kernel_default";
  const configuredOneWay =
    material.reversibility === "one_way" ||
    Boolean(policy?.policy.oneWayDoorActionKinds.some((kind) => actionKinds.includes(kind)));
  if (
    material.safetyClass === "safety_critical" ||
    material.riskClass === "reserved" ||
    configuredOneWay
  ) {
    route = "page";
    urgency = "p0";
    reason =
      material.safetyClass === "safety_critical" ? "safety_critical" : "authority_or_one_way_door";
  }
  const budget =
    policy?.policy.routinePageBudget ?? KERNEL_DEFAULT_ATTENTION_POLICY.routinePageBudget;
  const windowStart = new Date(new Date(now).getTime() - budget.windowMs).toISOString();
  const used = [...state.attentionDeliveries.values()].filter(
    (entry) => entry.delivery.createdAt >= windowStart && entry.delivery.status !== "obsolete"
  ).length;
  const safetyBypass =
    material.safetyClass === "safety_critical" || material.riskClass === "reserved";
  const routineBudgetApplied = route === "page" && !safetyBypass;
  const allowed = !routineBudgetApplied || used < budget.maxPages;
  const events: DomainEventInput[] = [];
  let incidentId: string | null = null;
  if (!allowed) {
    route = "queue";
    reason = "routine_page_budget_exhausted";
    incidentId = deterministicUuid(`parallelplay:attention-budget-incident:v1:${packetRevisionId}`);
  }
  const routing = {
    route,
    urgency,
    matchedRuleId: matchedRule?.ruleId ?? null,
    requireAcknowledgement: matchedRule?.requireAcknowledgement ?? route === "page",
    reason,
    routineBudget: {
      applied: routineBudgetApplied,
      allowed,
      used,
      limit: budget.maxPages,
      windowMs: budget.windowMs
    }
  };
  const revision: DecisionPacketRevisionV1 = {
    schemaVersion: 1,
    packetRevisionId,
    packetId,
    programId: material.programId,
    milestoneId: material.milestoneId,
    revision: revisionNumber,
    priorRevisionRef: existing
      ? attentionRef(
          "decision_packet_revision",
          existing.currentRevisionId,
          existing.currentRevisionDigest
        )
      : null,
    source: material.source,
    originalQuestion: material.originalQuestion,
    prompt: material.prompt,
    context: material.context,
    requiredAuthority: "operator",
    riskClass: material.riskClass,
    safetyClass: material.safetyClass,
    reversibility: material.reversibility,
    options: material.options,
    evidenceBundleRef: attentionRef("decision_evidence_bundle", evidenceBundleId, bundleDigest),
    policyBinding,
    precedentRefs: [],
    deadlineAt: material.deadlineAt,
    defaultOnTimeout: null,
    deduplicationKey,
    routing,
    createdAt: now
  };
  const revisionDigest = canonicalDigest(revision);
  events.push(
    {
      type: "DecisionEvidenceBundleRecorded",
      streamType: "decision_evidence_bundle",
      streamId: evidenceBundleId,
      data: { bundle, bundleDigest }
    },
    {
      type: "DecisionPacketRevisionRecorded",
      streamType: "decision_packet_revision",
      streamId: packetRevisionId,
      data: {
        revision,
        revisionDigest,
        supersededRevisionId: existing?.currentRevisionId ?? null
      }
    },
    existing
      ? {
          type: "DecisionPacketCurrentRevisionChanged",
          streamType: "decision_packet" as const,
          streamId: packetId,
          data: {
            packetId,
            priorPacketRevisionId: existing.currentRevisionId,
            packetRevisionId,
            packetRevisionDigest: revisionDigest
          }
        }
      : {
          type: "DecisionPacketOpened",
          streamType: "decision_packet" as const,
          streamId: packetId,
          data: {
            packetId,
            programId: material.programId,
            milestoneId: material.milestoneId,
            packetRevisionId,
            packetRevisionDigest: revisionDigest
          }
        }
  );
  if (existing) {
    for (const delivery of state.attentionDeliveries.values()) {
      if (
        delivery.delivery.packetRevisionId === existing.currentRevisionId &&
        (delivery.delivery.status === "pending" || delivery.delivery.status === "leased")
      ) {
        events.push({
          type: "AttentionDeliveryObsoleted",
          streamType: "attention_delivery",
          streamId: delivery.delivery.deliveryId,
          data: { deliveryId: delivery.delivery.deliveryId, reason: "decision_revision_superseded" }
        });
      }
    }
  }
  if (incidentId) {
    const incident = {
      schemaVersion: 1 as const,
      incidentId,
      programId: material.programId,
      packetId,
      packetRevisionId,
      policyBinding,
      used,
      limit: budget.maxPages,
      windowMs: budget.windowMs,
      occurredAt: now
    };
    events.push({
      type: "AttentionBudgetIncidentRecorded",
      streamType: "attention_budget_incident",
      streamId: incidentId,
      data: { incident, incidentDigest: canonicalDigest(incident) }
    });
  }
  if (route === "page") {
    const deliveryId = deterministicUuid(`parallelplay:attention-delivery:v1:${packetRevisionId}`);
    events.push({
      type: "AttentionDeliveryQueued",
      streamType: "attention_delivery",
      streamId: deliveryId,
      data: {
        delivery: {
          schemaVersion: 1,
          deliveryId,
          programId: material.programId,
          packetId,
          packetRevisionId,
          packetRevisionDigest: revisionDigest,
          policyBinding,
          matchedRuleId: matchedRule?.ruleId ?? null,
          channel: "page",
          deepLink: `/decisions/${packetId}?revision=${packetRevisionId}`,
          idempotencyKey: `attention-page:${packetRevisionId}:${revisionDigest}`,
          status: "pending",
          deliveryAttempts: 0,
          retryDelaysMs: [1_000, 5_000, 30_000],
          availableAt: now,
          leaseOwnerId: null,
          leaseFencingToken: 0,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          receipt: null,
          createdAt: now,
          deliveredAt: null,
          lastError: null
        }
      }
    });
  }
  return { events, packetId };
}

function decisionOption(
  state: ProjectionState,
  command: Extract<
    Command,
    {
      type:
        | "decision.approve"
        | "decision.retry"
        | "decision.cancel"
        | "decision.park"
        | "decision.reprioritize";
    }
  >,
  expectedKind: DecisionTypedActionV1["kind"],
  now: string
):
  | {
      packet: ProjectionState["decisionPackets"] extends Map<string, infer T> ? T : never;
      revision: DecisionPacketRevisionV1;
      option: DecisionOptionV1;
    }
  | Decision {
  if (command.actor.kind !== "operator") {
    return failure("APPROVAL_REQUIRES_OPERATOR", "Decision resolution requires an operator actor");
  }
  const packet = state.decisionPackets.get(command.payload.packetId);
  if (!packet) return failure("DECISION_PACKET_NOT_FOUND", "Decision packet does not exist");
  if (packet.status !== "open") {
    return failure("DECISION_ALREADY_RESOLVED", "Decision packet is not open");
  }
  const stored = state.decisionPacketRevisions.get(command.payload.packetRevisionId);
  if (
    stored?.revision.packetRevisionId !== packet.currentRevisionId ||
    stored.revision.schemaVersion !== 1 ||
    packet.currentRevisionDigest !== stored.revisionDigest ||
    command.payload.packetRevisionDigest !== stored.revisionDigest ||
    canonicalDigest(stored.revision) !== stored.revisionDigest
  ) {
    return failure("DECISION_PACKET_STALE", "Decision packet revision is stale");
  }
  if (stored.revision.deadlineAt !== null && stored.revision.deadlineAt <= now) {
    return failure("DECISION_PACKET_STALE", "Decision packet has expired and requires refresh");
  }
  const option = stored.revision.options.find(
    (candidate) => candidate.optionId === command.payload.optionId
  );
  if (
    option?.action.kind !== expectedKind ||
    canonicalDigest(option.action.target) !== command.payload.targetPreconditionDigest
  ) {
    return failure("DECISION_ACTION_MISMATCH", "Decision option and action do not match");
  }
  return { packet, revision: stored.revision, option };
}

function finalizedDecisionEvents(
  revision: DecisionPacketRevisionV1,
  option: DecisionOptionV1,
  actorId: string,
  targetPreconditionDigest: string,
  domainEvents: DomainEventInput[],
  now: string
): { events: DomainEventInput[]; actionResultId: string } {
  const actionResultId = deterministicUuid(
    `parallelplay:decision-action-result:v1:${revision.packetRevisionId}:${option.optionId}`
  );
  const resolutionId = deterministicUuid(
    `parallelplay:decision-resolution:v1:${revision.packetRevisionId}:${option.optionId}`
  );
  const precedentId = deterministicUuid(
    `parallelplay:decision-precedent:v1:${revision.packetRevisionId}:${option.optionId}`
  );
  const result = {
    schemaVersion: 1 as const,
    actionResultId,
    packetId: revision.packetId,
    packetRevisionId: revision.packetRevisionId,
    optionId: option.optionId,
    actionKind: option.action.kind,
    targetPreconditionDigest,
    appliedEventTypes: domainEvents.map((event) => event.type),
    actorId,
    appliedAt: now
  };
  const resultDigest = canonicalDigest(result);
  const resolution = {
    schemaVersion: 1 as const,
    resolutionId,
    packetId: revision.packetId,
    packetRevisionId: revision.packetRevisionId,
    packetRevisionDigest: canonicalDigest(revision),
    optionId: option.optionId,
    actionKind: option.action.kind,
    actorId,
    resolvedAt: now
  };
  const precedent = {
    schemaVersion: 1 as const,
    precedentId,
    programId: revision.programId,
    packetRevisionRef: attentionRef(
      "decision_packet_revision",
      revision.packetRevisionId,
      canonicalDigest(revision)
    ),
    selectedOptionId: option.optionId,
    actionResultRef: attentionRef("decision_action_result", actionResultId, resultDigest),
    evidenceBundleRef: revision.evidenceBundleRef,
    policyBinding: revision.policyBinding,
    authority: "operator" as const,
    actorId,
    recordedAt: now
  };
  return {
    actionResultId,
    events: [
      ...domainEvents,
      {
        type: "DecisionActionApplied",
        streamType: "decision_action_result",
        streamId: actionResultId,
        data: { result, resultDigest }
      },
      {
        type: "DecisionResolved",
        streamType: "decision_resolution",
        streamId: resolutionId,
        data: { resolution, resolutionDigest: canonicalDigest(resolution) }
      },
      {
        type: "DecisionPrecedentRecorded",
        streamType: "decision_precedent",
        streamId: precedentId,
        data: { precedent, precedentDigest: canonicalDigest(precedent) }
      }
    ]
  };
}

function cancellationForRun(
  state: ProjectionState,
  runId: string,
  reason: string
): DomainEventInput[] | Decision {
  const run = state.runs.get(runId);
  if (!run) return failure("RUN_NOT_FOUND", "Run does not exist", { runId });
  if (TERMINAL_RUNS.has(run.status)) {
    return failure("RUN_TERMINAL", "Run is already terminal", { runId });
  }
  const events: DomainEventInput[] = [];
  const generatedOutboxIds = new Set<string>();
  for (const attempt of state.attempts.values()) {
    if (attempt.runId === run.runId && attempt.jobId === null && attempt.status === "allocated") {
      events.push({
        type: "AttemptCancelled",
        streamType: "attempt",
        streamId: attempt.attemptId,
        data: { attemptId: attempt.attemptId, runId: run.runId, reason }
      });
    }
  }
  for (const job of state.jobs.values()) {
    if (job.runId === run.runId && !TERMINAL_JOBS.has(job.status)) {
      events.push(...cancellationEvents(state, job, "operator_cancelled", generatedOutboxIds));
    }
  }
  events.push({
    type: "RunCancelled",
    streamType: "run",
    streamId: run.runId,
    data: { runId: run.runId, reason }
  });
  return events;
}

function issueResolutionEvent(
  state: ProjectionState,
  issueId: string,
  expectedDigest: string | null,
  action: "record_only" | "resume_unchanged_contract" | "requires_graph_revision",
  text: string,
  actorId: string
): DomainEventInput | Decision {
  const stored = state.routedIssues.get(issueId);
  if (
    stored?.issue.status !== "open" ||
    (expectedDigest !== null &&
      (stored.issueDigest !== expectedDigest || canonicalDigest(stored.issue) !== expectedDigest))
  ) {
    return failure(
      expectedDigest === null ? "ISSUE_NOT_FOUND" : "DECISION_PACKET_STALE",
      expectedDigest === null
        ? "Open routed issue does not exist"
        : "Routed issue precondition changed"
    );
  }
  const resumedMilestoneIds =
    action === "resume_unchanged_contract"
      ? stored.issue.affectedMilestoneIds.filter(
          (milestoneId) => state.milestones.get(milestoneId)?.pauseReason === stored.issue.issueId
        )
      : [];
  return {
    type: "RoutedIssueResolved",
    streamType: "routed_issue",
    streamId: stored.issue.issueId,
    data: {
      issueId: stored.issue.issueId,
      programId: stored.issue.programId,
      action,
      text,
      resolvedBy: actorId,
      resumedMilestoneIds
    }
  };
}

function outcomeDispositionEvent(
  state: ProjectionState,
  outcomePacketId: string,
  expectedDigest: string | null,
  disposition: "accepted" | "rejected",
  reason: string | null,
  actorId: string,
  now: string
): DomainEventInput | Decision {
  const packet = state.outcomePackets.get(outcomePacketId);
  if (
    !packet ||
    state.outcomeDispositions.has(outcomePacketId) ||
    (expectedDigest !== null &&
      (packet.packetDigest !== expectedDigest || canonicalDigest(packet.packet) !== expectedDigest))
  ) {
    return failure(
      expectedDigest === null ? "OUTCOME_PACKET_NOT_FOUND" : "DECISION_PACKET_STALE",
      expectedDigest === null
        ? "Undisposed outcome packet does not exist"
        : "Outcome packet precondition changed"
    );
  }
  return {
    type: "OutcomeDispositionRecorded",
    streamType: "outcome_disposition",
    streamId: packet.outcomePacketId,
    data: {
      disposition: {
        schemaVersion: 1,
        outcomePacketId: packet.outcomePacketId,
        programId: packet.programId,
        disposition,
        reason,
        actorId,
        recordedAt: now
      }
    }
  };
}

export function decide(
  state: ProjectionState,
  command: Command,
  context: DecisionContext
): Decision {
  const now = context.now;
  const advisorDecision = decideAdvisor(state, command, now);
  if (advisorDecision) return advisorDecision;
  switch (command.type) {
    case "source-revision.register": {
      const value = command.payload;
      const existing = state.sourceRevisions.get(value.revisionId);
      if (existing) {
        return failure(
          existing.revisionDigest === value.revisionDigest
            ? "SOURCE_REVISION_ALREADY_EXISTS"
            : "SOURCE_REVISION_CONFLICT",
          "Source revision identifier already exists",
          { revisionId: value.revisionId }
        );
      }
      if (
        value.revisionDigest !==
        sourceRevisionDigest({
          repositoryId: value.repositoryId,
          objectFormat: value.objectFormat,
          commitOid: value.commitOid,
          treeOid: value.treeOid
        })
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Source revision digest is invalid", {
          revisionId: value.revisionId
        });
      }
      if (
        (value.objectFormat === "sha1" &&
          (value.commitOid.length !== 40 || value.treeOid.length !== 40)) ||
        (value.objectFormat === "sha256" &&
          (value.commitOid.length !== 64 || value.treeOid.length !== 64))
      ) {
        return failure("SOURCE_REVISION_CONFLICT", "Git object IDs do not match object format", {
          revisionId: value.revisionId
        });
      }
      return {
        ok: true,
        events: [
          {
            type: "SourceRevisionRegistered",
            streamType: "source_revision",
            streamId: value.revisionId,
            data: value
          }
        ],
        resultKind: "source_revision",
        resultId: value.revisionId
      };
    }
    case "program.create": {
      const { programId, name } = command.payload;
      if (state.programs.has(programId)) {
        return failure("PROGRAM_ALREADY_EXISTS", "Program already exists", { programId });
      }
      return {
        ok: true,
        events: [
          {
            type: "ProgramCreated",
            streamType: "program",
            streamId: programId,
            data: { programId, name }
          }
        ],
        resultKind: "program",
        resultId: programId
      };
    }
    case "program.kickoff": {
      const value = command.payload;
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Program kickoff requires an operator actor");
      }
      if (state.programs.has(value.programId)) {
        return failure("PROGRAM_ALREADY_EXISTS", "Program already exists", {
          programId: value.programId
        });
      }
      const source = state.sourceRevisions.get(value.initialSourceRevisionId);
      if (!source) {
        return failure("SOURCE_REVISION_NOT_FOUND", "Initial source revision does not exist", {
          revisionId: value.initialSourceRevisionId
        });
      }
      if (source.revisionDigest !== value.initialSourceRevisionDigest) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Initial source revision digest does not match");
      }
      return {
        ok: true,
        events: [
          {
            type: "ProgramKickedOff",
            streamType: "program",
            streamId: value.programId,
            data: {
              programId: value.programId,
              name: value.name,
              initialSourceRevisionId: value.initialSourceRevisionId,
              initialSourceRevisionDigest: value.initialSourceRevisionDigest
            }
          }
        ],
        resultKind: "program",
        resultId: value.programId
      };
    }
    case "interview.capture": {
      const value = command.payload;
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Interview capture requires an operator actor"
        );
      }
      const program = state.programs.get(value.programId);
      if (!program || (program.programMode !== "graph_v1" && program.programMode !== "graph_v2")) {
        return failure("PROGRAM_NOT_FOUND", "Draft graph program does not exist", {
          programId: value.programId
        });
      }
      if (program.phase !== "draft") {
        return failure("PROGRAM_NOT_STARTABLE", "Interview capture is closed after graph approval");
      }
      if (state.programInterviews.has(value.interviewId)) {
        return failure("PROGRAM_NOT_STARTABLE", "Interview identifier already exists");
      }
      if (
        [...state.programInterviews.values()].some(
          (candidate) => candidate.playback.playbackId === value.playbackId
        )
      ) {
        return failure("PROGRAM_NOT_STARTABLE", "Playback identifier already exists");
      }
      const transcriptDigest = canonicalDigest(value.transcript);
      const playback = {
        schemaVersion: 1 as const,
        playbackId: value.playbackId,
        interviewId: value.interviewId,
        programId: value.programId,
        transcriptDigest,
        ...value.answers
      };
      return {
        ok: true,
        events: [
          {
            type: "ProgramInterviewCaptured",
            streamType: "program_interview",
            streamId: value.interviewId,
            data: {
              interviewId: value.interviewId,
              programId: value.programId,
              transcript: value.transcript,
              transcriptDigest,
              playback,
              playbackDigest: canonicalDigest(playback)
            }
          }
        ],
        resultKind: "program_interview",
        resultId: value.interviewId
      };
    }
    case "program-graph.approve": {
      const graph = command.payload;
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Program graph approval requires an operator actor"
        );
      }
      const program = state.programs.get(graph.programId);
      if (
        !program ||
        (program.programMode !== "graph_v1" && program.programMode !== "graph_v2") ||
        (graph.schemaVersion === 1 && program.programMode !== "graph_v1")
      ) {
        return failure("PROGRAM_NOT_FOUND", "Graph program does not exist", {
          programId: graph.programId
        });
      }
      if (activeGenerationForProgram(state, graph.programId)) {
        return failure("PROGRAM_NOT_STARTABLE", "Cannot replace a graph during active execution");
      }
      const source = state.sourceRevisions.get(graph.initialSourceRef.id);
      if (
        graph.initialSourceRef.kind !== "source_revision" ||
        source?.revisionDigest !== graph.initialSourceRef.digest ||
        source.revisionId !== program.initialSourceRevisionId ||
        source.revisionDigest !== program.initialSourceRevisionDigest
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Graph initial source does not match kickoff");
      }
      const interview = [...state.programInterviews.values()].find(
        (candidate) => candidate.playback.playbackId === graph.intentPlaybackRef.id
      );
      if (
        graph.intentPlaybackRef.kind !== "intent_playback" ||
        interview?.programId !== graph.programId ||
        interview.playbackDigest !== graph.intentPlaybackRef.digest
      ) {
        return failure("INTERVIEW_NOT_FOUND", "Approved intent playback is unavailable");
      }
      const activeGraph = program.activeGraphRevisionId
        ? state.programGraphs.get(program.activeGraphRevisionId)
        : undefined;
      if (
        (!activeGraph && (graph.revision !== 1 || graph.priorGraphRef !== null)) ||
        (activeGraph &&
          (graph.revision !== activeGraph.revision + 1 ||
            graph.priorGraphRef?.id !== activeGraph.graphRevisionId ||
            graph.priorGraphRef.digest !== activeGraph.graphDigest))
      ) {
        return failure("GRAPH_INVALID", "Graph revision does not extend the active graph");
      }
      if (state.programGraphs.has(graph.graphRevisionId)) {
        return failure("GRAPH_INVALID", "Graph revision identifier already exists");
      }
      if (graph.schemaVersion === 2) {
        const policy = state.portfolioPolicies.get(graph.portfolioPolicyRef.id);
        const target = state.integrationTargets.get(graph.integrationTargetRef.id);
        if (
          graph.portfolioPolicyRef.kind !== "portfolio_policy" ||
          policy?.policyDigest !== graph.portfolioPolicyRef.digest ||
          policy.supersededAt !== null
        ) {
          return failure("GRAPH_INVALID", "Graph V2 portfolio policy reference is unavailable");
        }
        if (
          graph.integrationTargetRef.kind !== "integration_target" ||
          target?.targetDigest !== graph.integrationTargetRef.digest ||
          target.supersededAt !== null ||
          target.target.repositoryId !== source.repositoryId
        ) {
          return failure("GRAPH_INVALID", "Graph V2 integration target reference is unavailable");
        }
        const mergeLane = policy.policy.resources.find(
          (resource) => resource.resourceId === target.target.mergeLaneResourceId
        );
        if (mergeLane?.kind !== "merge_lane") {
          return failure("GRAPH_INVALID", "Integration target merge lane is not in the policy");
        }
        for (const dependency of graph.crossProgramDependencies) {
          const dependencyGraph = state.programGraphs.get(dependency.graphRevisionId);
          if (
            dependency.programId === graph.programId ||
            dependencyGraph?.programId !== dependency.programId ||
            dependencyGraph.graphDigest !== dependency.graphDigest ||
            dependencyGraph.graph.schemaVersion !== 2 ||
            dependencyGraph.graph.integrationTargetRef.id !== graph.integrationTargetRef.id
          ) {
            return failure("GRAPH_INVALID", "Cross-program dependency is stale or incompatible");
          }
          const reachesProgram = (
            candidate: ProgramGraphState,
            seen = new Set<string>()
          ): boolean => {
            if (candidate.programId === graph.programId) return true;
            if (seen.has(candidate.graphRevisionId) || candidate.graph.schemaVersion !== 2) {
              return false;
            }
            seen.add(candidate.graphRevisionId);
            return candidate.graph.crossProgramDependencies.some((entry) => {
              const next = state.programGraphs.get(entry.graphRevisionId);
              return next ? reachesProgram(next, seen) : false;
            });
          };
          if (reachesProgram(dependencyGraph)) {
            return failure("GRAPH_INVALID", "Cross-program dependencies must be acyclic");
          }
        }
      }
      for (const node of graph.milestones) {
        const existing = state.milestones.get(node.contract.milestoneId);
        if (existing && existing.programId !== graph.programId) {
          return failure("MILESTONE_ALREADY_EXISTS", "Milestone belongs to another program", {
            milestoneId: node.contract.milestoneId
          });
        }
        if (
          existing &&
          (existing.contractDigest !== canonicalDigest(node.contract) ||
            canonicalDigest(existing.dependencies) !== canonicalDigest(node.dependencies) ||
            existing.sourcePredecessorMilestoneId !== node.sourcePredecessorMilestoneId ||
            canonicalDigest(existing.allowedWorkSurfaces) !==
              canonicalDigest(graphNodeAllowedPaths(node)) ||
            canonicalDigest(existing.structuredWorkSurfaces) !==
              canonicalDigest(graphNodeStructuredSurfaces(node)) ||
            canonicalDigest(existing.resourceClaims) !==
              canonicalDigest("resourceClaims" in node ? node.resourceClaims : []) ||
            canonicalDigest(existing.capabilityClaims) !==
              canonicalDigest("capabilityClaims" in node ? node.capabilityClaims : []))
        ) {
          return failure(
            "MILESTONE_ALREADY_EXISTS",
            "Replacement graphs cannot rewrite a historical milestone contract",
            { milestoneId: node.contract.milestoneId }
          );
        }
        const workflow = state.workflows.get(
          workflowKey(node.contract.workflowId, node.contract.workflowVersion)
        );
        const step =
          workflow &&
          "schemaVersion" in workflow.definition &&
          workflow.definition.schemaVersion === 3 &&
          workflow.definition.steps.length === 1
            ? workflow.definition.steps[0]
            : undefined;
        if (step?.dependsOn.length !== 0) {
          return failure("WORKFLOW_NOT_FOUND", "Every program milestone requires Workflow V3", {
            milestoneId: node.contract.milestoneId
          });
        }
        if (graph.schemaVersion === 2) {
          const policy = state.portfolioPolicies.get(graph.portfolioPolicyRef.id);
          if (!policy) {
            return failure("WORKFLOW_NOT_FOUND", "Graph V2 requires a one-step Workflow V3");
          }
          if (
            !("capabilityClaims" in node) ||
            node.capabilityClaims.length !== 1 ||
            node.capabilityClaims[0] !== step.capability ||
            !policy.policy.capabilityCapacities.some(
              (capacity) => capacity.capability === step.capability
            )
          ) {
            return failure(
              "GRAPH_INVALID",
              "Graph V2 capability claims must exactly match the workflow"
            );
          }
          if (!("resourceClaims" in node)) {
            return failure("GRAPH_INVALID", "Graph V2 resource claims are missing");
          }
          for (const resourceId of node.resourceClaims) {
            const resource = policy.policy.resources.find(
              (candidate) => candidate.resourceId === resourceId
            );
            if (!resource || resource.kind === "merge_lane") {
              return failure("GRAPH_INVALID", "Graph V2 contains an unknown resource claim");
            }
          }
        }
        if (node.contract.criteria.some((criterion) => criterion.verificationStepId !== step.id)) {
          return failure(
            "SCHEDULE_MISMATCH",
            "Milestone criteria must bind to the Workflow V3 step",
            {
              milestoneId: node.contract.milestoneId
            }
          );
        }
      }
      const graphDigest = canonicalDigest(graph);
      const events: DomainEventInput[] = [];
      if (activeGraph) {
        events.push({
          type: "ProgramGraphSuperseded",
          streamType: "program_graph",
          streamId: activeGraph.graphRevisionId,
          data: {
            graphRevisionId: activeGraph.graphRevisionId,
            programId: graph.programId,
            supersededByGraphRevisionId: graph.graphRevisionId
          }
        });
      }
      events.push({
        type: "ProgramGraphApproved",
        streamType: "program_graph",
        streamId: graph.graphRevisionId,
        data: { graph, graphDigest, approvedBy: command.actor.id }
      });
      if (activeGraph) {
        for (const issue of state.routedIssues.values()) {
          if (
            issue.issue.programId === graph.programId &&
            issue.issue.status === "requires_graph_revision"
          ) {
            events.push({
              type: "RoutedIssueGraphRevisionSatisfied",
              streamType: "routed_issue",
              streamId: issue.issue.issueId,
              data: {
                issueId: issue.issue.issueId,
                programId: graph.programId,
                graphRevisionId: graph.graphRevisionId,
                resolvedBy: command.actor.id
              }
            });
          }
        }
      }
      for (const node of graph.milestones) {
        if (state.milestones.has(node.contract.milestoneId)) continue;
        const workflow = state.workflows.get(
          workflowKey(node.contract.workflowId, node.contract.workflowVersion)
        );
        if (!workflow) throw new Error("Validated graph workflow is missing");
        events.push({
          type: "MilestoneApproved",
          streamType: "milestone",
          streamId: node.contract.milestoneId,
          data: {
            milestoneId: node.contract.milestoneId,
            programId: graph.programId,
            contract: node.contract,
            contractDigest: canonicalDigest(node.contract),
            workflowDigest: workflow.definitionDigest,
            approvedBy: command.actor.id,
            graphRevisionId: graph.graphRevisionId,
            dependencies: node.dependencies,
            sourcePredecessorMilestoneId: node.sourcePredecessorMilestoneId,
            allowedWorkSurfaces: graphNodeAllowedPaths(node),
            structuredWorkSurfaces: graphNodeStructuredSurfaces(node),
            ...("resourceClaims" in node ? { resourceClaims: node.resourceClaims } : {}),
            ...("capabilityClaims" in node ? { capabilityClaims: node.capabilityClaims } : {})
          }
        });
      }
      return {
        ok: true,
        events,
        resultKind: "program_graph",
        resultId: graph.graphRevisionId
      };
    }
    case "program.start": {
      const value = command.payload;
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Program start requires an operator actor");
      }
      const program = state.programs.get(value.programId);
      const graph = state.programGraphs.get(value.graphRevisionId);
      if (value.schemaVersion === 2) {
        const pipelineWip = [...state.programs.values()].filter(
          (entry) =>
            entry.programMode === "graph_v2" &&
            ["eligible", "running", "integration_pending"].includes(entry.phase ?? "")
        ).length;
        const graphPolicy =
          graph?.graph.schemaVersion === 2
            ? state.portfolioPolicies.get(graph.graph.portfolioPolicyRef.id)
            : undefined;
        if (
          program?.programMode !== "graph_v2" ||
          program.phase !== "approved" ||
          program.activeGraphRevisionId !== value.graphRevisionId ||
          program.activeGraphDigest !== value.graphDigest ||
          graph?.graphDigest !== value.graphDigest ||
          graph.graph.schemaVersion !== 2 ||
          !graphPolicy ||
          pipelineWip >= graphPolicy.policy.limits.maxPipelineWip ||
          value.policy.attemptTimeoutMs >
            (state.portfolioPolicies.get(graph.graph.portfolioPolicyRef.id)?.policy.limits
              .maxAttemptMs ?? 0)
        ) {
          return failure("PROGRAM_NOT_STARTABLE", "Graph V2 program is not eligible to queue");
        }
        return {
          ok: true,
          events: [
            {
              type: "ProgramExecutionRequested",
              streamType: "program",
              streamId: program.programId,
              data: {
                requestId: value.requestId,
                programId: program.programId,
                graphRevisionId: graph.graphRevisionId,
                graphDigest: graph.graphDigest,
                policy: value.policy,
                requestedBy: command.actor.id
              }
            }
          ],
          resultKind: "program",
          resultId: program.programId
        };
      }
      if (
        program?.programMode !== "graph_v1" ||
        program.phase !== "approved" ||
        program.activeGraphRevisionId !== value.graphRevisionId ||
        program.activeGraphDigest !== value.graphDigest ||
        graph?.graphDigest !== value.graphDigest
      ) {
        return failure("PROGRAM_NOT_STARTABLE", "Program and active graph are not startable");
      }
      if (
        [...state.milestoneGenerations.values()].some(
          (generation) => generation.status === "running"
        )
      ) {
        return failure("PROGRAM_NOT_STARTABLE", "Graph V1 uses the global legacy-serial lane");
      }
      const root = graph.graph.milestones.find(
        (node) => node.sourcePredecessorMilestoneId === null
      );
      if (!root || !program.initialSourceRevisionId) {
        return failure("GRAPH_INVALID", "Active graph root or pinned source is missing");
      }
      const scheduled = startGraphMilestoneEvents(
        state,
        graph,
        root.contract.milestoneId,
        1,
        program.initialSourceRevisionId,
        [],
        value.policy,
        now
      );
      if ("ok" in scheduled) return scheduled;
      return {
        ok: true,
        events: [
          {
            type: "ProgramStarted",
            streamType: "program",
            streamId: program.programId,
            data: {
              programId: program.programId,
              graphRevisionId: graph.graphRevisionId,
              graphDigest: graph.graphDigest,
              startedBy: command.actor.id
            }
          },
          ...scheduled.events
        ],
        resultKind: "run",
        resultId: scheduled.runId
      };
    }
    case "program.advance": {
      const value = command.payload;
      if (command.actor.kind !== "system") {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Program advance requires a system actor");
      }
      const program = state.programs.get(value.programId);
      const graph = state.programGraphs.get(value.graphRevisionId);
      if (
        !program ||
        (program.phase !== "running" &&
          !(program.programMode === "graph_v2" && program.phase === "eligible")) ||
        program.activeGraphRevisionId !== value.graphRevisionId ||
        program.activeGraphDigest !== value.graphDigest ||
        graph?.graphDigest !== value.graphDigest
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Active program graph does not match");
      }
      if (activeGenerationForProgram(state, value.programId)) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Program already has an active generation");
      }
      if (
        [...state.routedIssues.values()].some(
          (issue) =>
            issue.issue.programId === value.programId &&
            issue.issue.status !== "resolved" &&
            issue.issue.route !== "record_only"
        )
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Program has an unresolved blocking issue");
      }
      const validateInput = (validation: OutcomeValidationV1): Decision | null => {
        const packet = state.outcomePackets.get(validation.outcomePacketId);
        if (
          packet?.programId !== value.programId ||
          packet.milestoneId !== validation.milestoneId ||
          packet.packetDigest !== validation.packetDigest ||
          canonicalDigest(packet.packet) !== validation.computedDigest ||
          validation.packetDigest !== validation.computedDigest ||
          !packet.packet.criteriaResults.every((criterion) => criterion.result === "pass") ||
          packet.packet.recommendation !== "merge" ||
          packet.packet.candidateRevisionId === null ||
          validation.recommendation !== "merge" ||
          validation.candidateRevisionId !== packet.packet.candidateRevisionId ||
          !validation.criteriaPassed
        ) {
          return failure("EVIDENCE_DIGEST_MISMATCH", "Dependency outcome validation is invalid", {
            outcomePacketId: validation.outcomePacketId
          });
        }
        const primary = [
          ...packet.packet.driverReceipts.map((reference) => reference.digest),
          ...packet.packet.verificationReceipts.map((reference) => reference.digest),
          ...packet.packet.artifactManifests.map((reference) => reference.digest)
        ].sort();
        if (
          canonicalDigest(primary) !==
          canonicalDigest([...validation.primaryEvidenceDigests].sort())
        ) {
          return failure("EVIDENCE_DIGEST_MISMATCH", "Primary evidence digest set does not match");
        }
        return null;
      };
      for (const validation of value.dependencyValidations) {
        const invalid = validateInput(validation);
        if (invalid) return invalid;
      }
      const validationEvents: DomainEventInput[] = value.dependencyValidations.map(
        (validation) => ({
          type: "OutcomeValidationRecorded",
          streamType: "outcome_validation",
          streamId: validation.validationId,
          data: { validation, validationDigest: canonicalDigest(validation) }
        })
      );
      const nextNode = graph.graph.milestones.find((node) => {
        const milestone = state.milestones.get(node.contract.milestoneId);
        return (
          milestone?.status === "approved" &&
          node.dependencies.every(
            (dependency) => state.milestones.get(dependency)?.status === "outcome_ready"
          )
        );
      });
      if (!nextNode) {
        if (value.expectedMilestoneId !== null || value.expectedGeneration !== null) {
          return failure(
            "PROGRAM_NOT_ADVANCEABLE",
            "No milestone is eligible for the expected advance"
          );
        }
        const prospectiveValidated = new Set(
          [...state.milestones.values()].flatMap((milestone) =>
            milestone.latestValidatedOutcomePacketId ? [milestone.milestoneId] : []
          )
        );
        for (const validation of value.dependencyValidations) {
          prospectiveValidated.add(validation.milestoneId);
        }
        if (
          graph.graph.milestones.some(
            (node) => !prospectiveValidated.has(node.contract.milestoneId)
          )
        ) {
          return failure("PROGRAM_NOT_ADVANCEABLE", "Final milestone outcome is not validated");
        }
        if (graph.graph.schemaVersion === 2) {
          const finalValidation = value.dependencyValidations.at(-1);
          const finalPacket = finalValidation
            ? state.outcomePackets.get(finalValidation.outcomePacketId)
            : [...state.outcomePackets.values()]
                .filter((packet) => packet.programId === program.programId)
                .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
          if (!finalPacket?.packet.candidateRevisionId) {
            return failure("PROGRAM_NOT_ADVANCEABLE", "Final candidate revision is missing");
          }
          const candidateId = deterministicUuid(
            `parallelplay:integration:integration-candidate:${program.programId}:${graph.graphRevisionId}:${finalPacket.packet.candidateRevisionId}`
          );
          return {
            ok: true,
            events: [
              ...validationEvents,
              {
                type: "ProgramIntegrationPending",
                streamType: "program",
                streamId: program.programId,
                data: {
                  programId: program.programId,
                  graphRevisionId: graph.graphRevisionId,
                  graphDigest: graph.graphDigest,
                  candidateId
                }
              }
            ],
            resultKind: "program",
            resultId: program.programId
          };
        }
        return {
          ok: true,
          events: [
            ...validationEvents,
            {
              type: "ProgramCompleted",
              streamType: "program",
              streamId: program.programId,
              data: {
                programId: program.programId,
                graphRevisionId: graph.graphRevisionId,
                graphDigest: graph.graphDigest
              }
            }
          ],
          resultKind: "program",
          resultId: program.programId
        };
      }
      const milestone = state.milestones.get(nextNode.contract.milestoneId);
      if (!milestone) throw new Error("Approved graph milestone projection is missing");
      const expectedGeneration = (milestone.generation ?? 0) + 1;
      if (
        value.expectedMilestoneId !== nextNode.contract.milestoneId ||
        value.expectedGeneration !== expectedGeneration
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Expected milestone generation does not match");
      }
      const validationByMilestone = new Map(
        value.dependencyValidations.map((validation) => [validation.milestoneId, validation])
      );
      if (
        nextNode.dependencies.length !== validationByMilestone.size ||
        nextNode.dependencies.some((dependency) => !validationByMilestone.has(dependency))
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Every dependency requires a live validation");
      }
      let baseRevisionId = program.initialSourceRevisionId;
      if (nextNode.sourcePredecessorMilestoneId) {
        const predecessorValidation = validationByMilestone.get(
          nextNode.sourcePredecessorMilestoneId
        );
        baseRevisionId = predecessorValidation?.candidateRevisionId ?? null;
      }
      if (!baseRevisionId || !state.sourceRevisions.has(baseRevisionId)) {
        return failure(
          "SOURCE_REVISION_NOT_FOUND",
          "Eligible candidate source revision is missing"
        );
      }
      if (graph.graph.schemaVersion === 2) {
        const recorded = validationEvents[0];
        if (recorded?.type !== "OutcomeValidationRecorded") {
          return failure(
            "PROGRAM_NOT_ADVANCEABLE",
            "Graph V2 advance requires validation evidence"
          );
        }
        return {
          ok: true,
          events: validationEvents,
          resultKind: "outcome_validation",
          resultId: recorded.data.validation.validationId
        };
      }
      const scheduled = startGraphMilestoneEvents(
        state,
        graph,
        nextNode.contract.milestoneId,
        expectedGeneration,
        baseRevisionId,
        value.dependencyValidations,
        value.policy,
        now
      );
      if ("ok" in scheduled) return scheduled;
      return {
        ok: true,
        events: [...validationEvents, ...scheduled.events],
        resultKind: "run",
        resultId: scheduled.runId
      };
    }
    case "portfolio.coordinate": {
      if (command.actor.kind !== "system") {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Portfolio coordination requires a system actor");
      }
      if (command.payload.expectedThroughPosition !== state.lastAppliedPosition) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Portfolio coordination snapshot is stale");
      }
      if (
        [...state.portfolioSloIncidents.values()].some((entry) => entry.incident.status === "open")
      ) {
        return failure(
          "PROGRAM_NOT_ADVANCEABLE",
          "Portfolio admission is frozen by an SLO incident"
        );
      }
      const eligiblePrograms = [...state.programs.values()]
        .filter(
          (program) =>
            program.programMode === "graph_v2" &&
            program.phase === "eligible" &&
            program.executionRequestId &&
            program.executionRequestedAt &&
            program.executionPolicy
        )
        .sort(
          (left, right) =>
            (left.executionRequestedAt ?? "").localeCompare(right.executionRequestedAt ?? "") ||
            left.programId.localeCompare(right.programId)
        );
      const activeAdmissions = [...state.portfolioAdmissions.values()].filter(
        (entry) => entry.status === "active"
      );
      if (
        [...state.programs.values()].some(
          (entry) => entry.programMode === "graph_v1" && entry.phase === "running"
        )
      ) {
        return failure(
          "PROGRAM_NOT_ADVANCEABLE",
          "Legacy serial execution owns the portfolio lane"
        );
      }
      const activeLeases = [...state.concurrencyLeases.values()].filter(
        (entry) => entry.status === "active"
      );
      for (const program of eligiblePrograms) {
        const graph = program.activeGraphRevisionId
          ? state.programGraphs.get(program.activeGraphRevisionId)
          : undefined;
        if (graph?.graph.schemaVersion !== 2 || !program.executionPolicy) continue;
        const policy = state.portfolioPolicies.get(graph.graph.portfolioPolicyRef.id);
        const target = state.integrationTargets.get(graph.graph.integrationTargetRef.id);
        if (
          policy?.policyDigest !== graph.graph.portfolioPolicyRef.digest ||
          policy.supersededAt !== null ||
          target?.targetDigest !== graph.graph.integrationTargetRef.digest ||
          target.supersededAt !== null
        ) {
          continue;
        }
        if (activeAdmissions.length >= policy.policy.limits.maxExecutingPrograms) continue;
        const dependenciesReady = graph.graph.crossProgramDependencies.every((dependency) =>
          [...state.promotionReceipts.values()].some((receipt) => {
            const candidate = state.integrationCandidates.get(receipt.receipt.candidateId);
            return (
              receipt.receipt.programId === dependency.programId &&
              candidate?.candidate.graphRevisionRef.id === dependency.graphRevisionId &&
              candidate.candidate.graphRevisionRef.digest === dependency.graphDigest
            );
          })
        );
        if (!dependenciesReady) continue;
        const node = graph.graph.milestones.find((candidate) => {
          const milestone = state.milestones.get(candidate.contract.milestoneId);
          return (
            milestone?.status === "approved" &&
            candidate.dependencies.every(
              (dependency) => state.milestones.get(dependency)?.status === "outcome_ready"
            )
          );
        });
        if (!node) continue;
        const validations = node.dependencies.flatMap((dependency) => {
          const milestone = state.milestones.get(dependency);
          if (!milestone?.latestValidatedOutcomePacketId) return [];
          const found = [...state.outcomeValidations.values()].find(
            (validation) =>
              validation.milestoneId === dependency &&
              validation.outcomePacketId === milestone.latestValidatedOutcomePacketId
          );
          return found ? [found.validation] : [];
        });
        if (validations.length !== node.dependencies.length) continue;
        let baseRevisionId = program.initialSourceRevisionId;
        if (node.sourcePredecessorMilestoneId) {
          baseRevisionId =
            validations.find(
              (validation) => validation.milestoneId === node.sourcePredecessorMilestoneId
            )?.candidateRevisionId ?? null;
        }
        if (!baseRevisionId || !state.sourceRevisions.has(baseRevisionId)) continue;
        const executionSlot = [1, 2].find(
          (slot) =>
            !activeLeases.some((lease) => lease.lease.claimKey === `execution-slot:${String(slot)}`)
        );
        if (!executionSlot) continue;
        const capabilitySlots: string[] = [];
        let capabilitiesAvailable = true;
        for (const capability of node.capabilityClaims) {
          const capacity = policy.policy.capabilityCapacities.find(
            (entry) => entry.capability === capability
          )?.capacity;
          const slot = capacity
            ? Array.from({ length: capacity }, (_, index) => index + 1).find(
                (candidate) =>
                  !activeLeases.some(
                    (lease) =>
                      lease.lease.claimKey === `capability:${capability}:${String(candidate)}`
                  )
              )
            : undefined;
          if (!slot) {
            capabilitiesAvailable = false;
            break;
          }
          capabilitySlots.push(`capability:${capability}:${String(slot)}`);
        }
        if (!capabilitiesAvailable) continue;
        if (
          node.resourceClaims.some((resourceId) =>
            activeLeases.some((lease) => lease.lease.claimKey === `resource:${resourceId}`)
          )
        ) {
          continue;
        }
        const surfaceConflict = node.workSurfaces.some((surface) =>
          activeLeases.some((lease) => {
            const claimed = parseSurfaceClaimKey(lease.lease.claimKey);
            return (
              claimed?.targetRevisionId === target.target.targetRevisionId &&
              workSurfacesOverlap(surface, claimed)
            );
          })
        );
        if (surfaceConflict) continue;
        const milestone = state.milestones.get(node.contract.milestoneId);
        if (!milestone) continue;
        const generation = (milestone.generation ?? 0) + 1;
        const scheduled = startGraphMilestoneEvents(
          state,
          graph,
          node.contract.milestoneId,
          generation,
          baseRevisionId,
          validations,
          program.executionPolicy,
          now
        );
        if ("ok" in scheduled) return scheduled;
        const sequence =
          Math.max(
            0,
            ...[...state.portfolioAdmissions.values()].map(
              (entry) => entry.admission.admissionSequence
            )
          ) + 1;
        const requestId = program.executionRequestId;
        if (!requestId) continue;
        const admissionId = deterministicUuid(
          `parallelplay:integration:admission:${requestId}:${scheduled.generationId}`
        );
        const admission = {
          schemaVersion: 1 as const,
          admissionId,
          admissionSequence: sequence,
          requestId,
          programId: program.programId,
          graphRevisionRef: {
            kind: "program_graph" as const,
            id: graph.graphRevisionId,
            digest: graph.graphDigest
          },
          policyRef: graph.graph.portfolioPolicyRef,
          targetRef: graph.graph.integrationTargetRef,
          milestoneId: node.contract.milestoneId,
          generationId: scheduled.generationId,
          runId: scheduled.runId,
          executionSlot,
          capabilityClaims: [...node.capabilityClaims],
          resourceClaims: [...node.resourceClaims],
          surfaceClaims: [...node.workSurfaces],
          admittedAt: now,
          releasedAt: null,
          fencedAt: null
        };
        const claimKeys = [
          `execution-slot:${String(executionSlot)}`,
          ...capabilitySlots,
          ...node.resourceClaims.map((resourceId) => `resource:${resourceId}`),
          ...node.workSurfaces.map((surface) =>
            surfaceClaimKey(target.target.targetRevisionId, surface)
          )
        ];
        const expiresAt = addMilliseconds(now, command.payload.leaseDurationMs);
        const leases = claimKeys.map((claimKey) => {
          const claimKind = claimKey.startsWith("execution-slot:")
            ? ("execution_slot" as const)
            : claimKey.startsWith("capability:")
              ? ("capability" as const)
              : claimKey.startsWith("resource:")
                ? ("resource" as const)
                : ("surface" as const);
          const lease = {
            schemaVersion: 1 as const,
            leaseId: deterministicUuid(`parallelplay:integration:lease:${admissionId}:${claimKey}`),
            admissionId,
            programId: program.programId,
            generationId: scheduled.generationId,
            claimKind,
            claimKey,
            fencingToken: sequence,
            acquiredAt: now,
            expiresAt,
            renewedAt: null,
            releasedAt: null,
            fencedAt: null
          };
          return { lease, leaseDigest: canonicalDigest(lease) };
        });
        return {
          ok: true,
          events: [
            {
              type: "PortfolioAdmissionGranted",
              streamType: "portfolio_admission",
              streamId: admissionId,
              data: { admission, admissionDigest: canonicalDigest(admission), leases }
            },
            ...(program.startedAt
              ? []
              : [
                  {
                    type: "ProgramStarted" as const,
                    streamType: "program" as const,
                    streamId: program.programId,
                    data: {
                      programId: program.programId,
                      graphRevisionId: graph.graphRevisionId,
                      graphDigest: graph.graphDigest,
                      startedBy: command.actor.id
                    }
                  }
                ]),
            ...scheduled.events
          ],
          resultKind: "portfolio_admission",
          resultId: admissionId
        };
      }
      return failure("PROGRAM_NOT_ADVANCEABLE", "No eligible program fits portfolio capacity");
    }
    case "portfolio-lease.renew": {
      if (command.actor.kind !== "system") {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Lease renewal requires a system actor");
      }
      const stored = state.concurrencyLeases.get(command.payload.leaseId);
      if (
        stored?.status !== "active" ||
        stored.lease.admissionId !== command.payload.ownerAdmissionId ||
        stored.lease.fencingToken !== command.payload.fencingToken ||
        stored.lease.expiresAt <= now
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Concurrency lease owner or fence is stale");
      }
      const lease = {
        ...stored.lease,
        renewedAt: now,
        expiresAt: addMilliseconds(now, command.payload.leaseDurationMs)
      };
      return {
        ok: true,
        events: [
          {
            type: "PortfolioLeaseRenewed",
            streamType: "concurrency_lease",
            streamId: lease.leaseId,
            data: { lease, leaseDigest: canonicalDigest(lease) }
          }
        ],
        resultKind: "concurrency_lease",
        resultId: lease.leaseId
      };
    }
    case "portfolio-admission.release":
    case "portfolio-admission.fence": {
      if (command.actor.kind !== "system") {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Admission transition requires a system actor");
      }
      const stored = state.portfolioAdmissions.get(command.payload.admissionId);
      if (
        stored?.status !== "active" ||
        stored.admission.generationId !== command.payload.generationId
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Portfolio admission is stale");
      }
      const leases = [...state.concurrencyLeases.values()].filter(
        (entry) => entry.lease.admissionId === stored.admission.admissionId
      );
      if (
        leases.length === 0 ||
        leases.some(
          (entry) =>
            entry.status !== "active" || entry.lease.fencingToken !== command.payload.fencingToken
        )
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Admission lease fence is stale");
      }
      const isRelease = command.type === "portfolio-admission.release";
      return {
        ok: true,
        events: [
          isRelease
            ? {
                type: "PortfolioAdmissionReleased",
                streamType: "portfolio_admission",
                streamId: stored.admission.admissionId,
                data: {
                  admissionId: command.payload.admissionId,
                  generationId: command.payload.generationId,
                  fencingToken: command.payload.fencingToken,
                  reason: command.payload.reason,
                  releasedAt: now,
                  leaseIds: leases.map((entry) => entry.lease.leaseId)
                }
              }
            : {
                type: "PortfolioAdmissionFenced",
                streamType: "portfolio_admission",
                streamId: stored.admission.admissionId,
                data: {
                  admissionId: command.payload.admissionId,
                  generationId: command.payload.generationId,
                  fencingToken: command.payload.fencingToken,
                  reason: command.payload.reason,
                  fencedAt: now,
                  leaseIds: leases.map((entry) => entry.lease.leaseId)
                }
              }
        ],
        resultKind: "portfolio_admission",
        resultId: stored.admission.admissionId
      };
    }
    case "portfolio-policy.approve": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Portfolio policy approval requires an operator actor"
        );
      }
      const input = command.payload.policy;
      if (
        new Set(input.resources.map((entry) => entry.resourceId)).size !== input.resources.length ||
        new Set(input.capabilityCapacities.map((entry) => entry.capability)).size !==
          input.capabilityCapacities.length ||
        (input.priorPolicyRef !== null && input.priorPolicyRef.kind !== "portfolio_policy")
      ) {
        return failure("ATTENTION_POLICY_CONFLICT", "Portfolio policy registry is invalid");
      }
      const active = [...state.portfolioPolicies.values()].find(
        (entry) => entry.policy.policyId === input.policyId && entry.supersededAt === null
      );
      if (
        state.portfolioPolicies.has(input.policyRevisionId) ||
        (active
          ? input.revision !== active.policy.revision + 1 ||
            input.priorPolicyRef?.kind !== "portfolio_policy" ||
            input.priorPolicyRef.id !== active.policy.policyRevisionId ||
            input.priorPolicyRef.digest !== active.policyDigest
          : input.revision !== 1 || input.priorPolicyRef !== null)
      ) {
        return failure("ATTENTION_POLICY_CONFLICT", "Portfolio policy revision chain conflicts");
      }
      const attentionPolicy = state.attentionPolicies.get(input.attention.policyRef.id);
      if (
        attentionPolicy?.supersededAt !== null ||
        attentionPolicy.policyDigest !== input.attention.policyRef.digest ||
        attentionPolicy.policy.routinePageBudget.maxPages !== 0
      ) {
        return failure(
          "ATTENTION_POLICY_CONFLICT",
          "Portfolio policy must pin the active zero-routine-page attention policy"
        );
      }
      const policy = { ...input, approvedBy: command.actor.id, approvedAt: now };
      return {
        ok: true,
        events: [
          {
            type: "PortfolioPolicyApproved",
            streamType: "portfolio_policy",
            streamId: policy.policyRevisionId,
            data: {
              policy,
              policyDigest: canonicalDigest(policy),
              supersededPolicyRevisionId: active?.policy.policyRevisionId ?? null
            }
          }
        ],
        resultKind: "portfolio_policy",
        resultId: policy.policyRevisionId
      };
    }
    case "integration-target.approve": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Integration target approval requires an operator actor"
        );
      }
      const input = command.payload.target;
      if (
        input.managedRef !== `refs/parallelplay/integration/${input.targetId}` ||
        input.initialHeadRef.kind !== "source_revision" ||
        (input.priorTargetRef !== null && input.priorTargetRef.kind !== "integration_target")
      ) {
        return failure("GRAPH_INVALID", "Integration target identity is invalid");
      }
      const active = [...state.integrationTargets.values()].find(
        (entry) => entry.target.targetId === input.targetId && entry.supersededAt === null
      );
      if (
        state.integrationTargets.has(input.targetRevisionId) ||
        (active
          ? input.revision !== active.target.revision + 1 ||
            input.priorTargetRef?.kind !== "integration_target" ||
            input.priorTargetRef.id !== active.target.targetRevisionId ||
            input.priorTargetRef.digest !== active.targetDigest
          : input.revision !== 1 || input.priorTargetRef !== null)
      ) {
        return failure("GRAPH_INVALID", "Integration target revision chain conflicts");
      }
      const source = state.sourceRevisions.get(input.initialHeadRef.id);
      if (
        source?.revisionDigest !== input.initialHeadRef.digest ||
        source.repositoryId !== input.repositoryId ||
        canonicalDigest(input.verifierContract) !== input.verifierContractDigest ||
        input.verifierContract.timeoutMs > 300_000 ||
        (active !== undefined &&
          canonicalDigest(input.initialHeadRef) !== canonicalDigest(active.currentHeadRef))
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Integration target evidence is invalid");
      }
      const policy = [...state.portfolioPolicies.values()].find(
        (entry) => entry.supersededAt === null
      );
      if (
        !policy?.policy.resources.some(
          (resource) =>
            resource.resourceId === input.mergeLaneResourceId && resource.kind === "merge_lane"
        )
      ) {
        return failure("GRAPH_INVALID", "Integration target merge lane is not registered");
      }
      const target = { ...input, approvedBy: command.actor.id, approvedAt: now };
      return {
        ok: true,
        events: [
          {
            type: "IntegrationTargetApproved",
            streamType: "integration_target",
            streamId: target.targetRevisionId,
            data: {
              target,
              targetDigest: canonicalDigest(target),
              supersededTargetRevisionId: active?.target.targetRevisionId ?? null
            }
          }
        ],
        resultKind: "integration_target",
        resultId: target.targetRevisionId
      };
    }
    case "candidate-diff.record": {
      if (command.actor.kind !== "system") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Candidate diff evidence requires the host");
      }
      const { manifest, manifestDigest } = command.payload;
      if (
        canonicalDigest(manifest) !== manifestDigest ||
        state.candidateDiffManifests.has(manifest.manifestId)
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Candidate diff manifest is invalid");
      }
      const graph = state.programGraphs.get(manifest.graphRevisionId);
      const base = state.sourceRevisions.get(manifest.baseRevisionRef.id);
      const candidate = state.sourceRevisions.get(manifest.candidateRevisionRef.id);
      if (
        graph?.programId !== manifest.programId ||
        graph.graph.schemaVersion !== 2 ||
        manifest.baseRevisionRef.kind !== "source_revision" ||
        manifest.candidateRevisionRef.kind !== "source_revision" ||
        base?.revisionDigest !== manifest.baseRevisionRef.digest ||
        candidate?.revisionDigest !== manifest.candidateRevisionRef.digest ||
        base.repositoryId !== candidate.repositoryId
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Candidate diff references are invalid");
      }
      const expectedSurfaces = [
        ...new Map(
          graph.graph.milestones
            .flatMap((milestone) => milestone.workSurfaces)
            .map((surface) => [`${surface.kind}:${surface.path}`, surface])
        ).values()
      ].sort(
        (left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)
      );
      const sorted = [...manifest.entries].sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.change.localeCompare(right.change)
      );
      if (
        canonicalDigest(sorted) !== canonicalDigest(manifest.entries) ||
        new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length ||
        canonicalDigest(manifest.allowedSurfaces) !== canonicalDigest(expectedSurfaces)
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Candidate diff entries are not canonical");
      }
      const computedViolations = manifest.entries
        .filter(
          (entry) =>
            !manifest.allowedSurfaces.some((surface) =>
              surface.kind === "file"
                ? entry.path === surface.path
                : entry.path === surface.path || entry.path.startsWith(`${surface.path}/`)
            )
        )
        .map((entry) => entry.path)
        .sort();
      if (
        canonicalDigest(computedViolations) !== canonicalDigest([...manifest.violations].sort()) ||
        manifest.eligible !== (computedViolations.length === 0)
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Candidate surface verdict is inconsistent");
      }
      return {
        ok: true,
        events: [
          {
            type: "CandidateDiffManifestRecorded",
            streamType: "candidate_diff_manifest",
            streamId: manifest.manifestId,
            data: { manifest, manifestDigest }
          }
        ],
        resultKind: "candidate_diff_manifest",
        resultId: manifest.manifestId
      };
    }
    case "integration-candidate.queue": {
      if (command.actor.kind !== "system") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Integration candidate queueing requires the host"
        );
      }
      const { candidate, candidateDigest, workId } = command.payload;
      const manifest = state.candidateDiffManifests.get(candidate.diffManifestRef.id);
      const graph = state.programGraphs.get(candidate.graphRevisionRef.id);
      const policy = state.portfolioPolicies.get(candidate.policyRef.id);
      const target = state.integrationTargets.get(candidate.targetRef.id);
      const expectedDependencyCandidateIds =
        graph?.graph.schemaVersion === 2
          ? graph.graph.crossProgramDependencies
              .map((dependency) =>
                [...state.integrationCandidates.values()].find(
                  (entry) =>
                    entry.candidate.programId === dependency.programId &&
                    entry.candidate.graphRevisionRef.id === dependency.graphRevisionId &&
                    entry.candidate.graphRevisionRef.digest === dependency.graphDigest
                )
              )
              .map((entry) => entry?.candidate.candidateId ?? "missing")
              .sort()
          : [];
      const currentPaths = new Set(manifest?.manifest.entries.map((entry) => entry.path) ?? []);
      const expectedOverlapPredecessors = [...state.integrationCandidates.values()]
        .filter(
          (entry) =>
            entry.candidate.targetRef.id === candidate.targetRef.id &&
            (entry.candidate.finalAdmissionSequence < candidate.finalAdmissionSequence ||
              (entry.candidate.finalAdmissionSequence === candidate.finalAdmissionSequence &&
                entry.candidate.candidateId.localeCompare(candidate.candidateId) < 0))
        )
        .filter((entry) => {
          const prior = state.candidateDiffManifests.get(entry.candidate.diffManifestRef.id);
          return prior?.manifest.entries.some((path) => currentPaths.has(path.path)) ?? false;
        })
        .map((entry) => entry.candidate.candidateId)
        .sort();
      if (
        canonicalDigest(candidate) !== candidateDigest ||
        state.integrationCandidates.has(candidate.candidateId) ||
        !manifest?.manifest.eligible ||
        manifest.manifestDigest !== candidate.diffManifestRef.digest ||
        graph?.graphDigest !== candidate.graphRevisionRef.digest ||
        graph.graph.schemaVersion !== 2 ||
        graph.programId !== candidate.programId ||
        policy?.policyDigest !== candidate.policyRef.digest ||
        target?.targetDigest !== candidate.targetRef.digest ||
        candidate.originalCandidateRef.kind !== "source_revision" ||
        manifest.manifest.candidateRevisionRef.id !== candidate.originalCandidateRef.id ||
        manifest.manifest.candidateRevisionRef.digest !== candidate.originalCandidateRef.digest ||
        canonicalDigest([...candidate.dependencyCandidateIds].sort()) !==
          canonicalDigest(expectedDependencyCandidateIds) ||
        canonicalDigest([...candidate.actualOverlapPredecessorIds].sort()) !==
          canonicalDigest(expectedOverlapPredecessors) ||
        new Set(candidate.dependencyCandidateIds).size !==
          candidate.dependencyCandidateIds.length ||
        new Set(candidate.actualOverlapPredecessorIds).size !==
          candidate.actualOverlapPredecessorIds.length
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Integration candidate evidence is invalid");
      }
      const readyCount = [...state.integrationCandidates.values()].filter((entry) =>
        [
          "pending",
          "blocked",
          "preparing",
          "verifying",
          "awaiting_authorization",
          "authorized",
          "promoting"
        ].includes(entry.status)
      ).length;
      if (readyCount >= policy.policy.limits.maxIntegrationReadyCandidates) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Integration-ready capacity is full");
      }
      const work = {
        schemaVersion: 1 as const,
        workId,
        candidateId: candidate.candidateId,
        status: "pending" as const,
        availableAt: now,
        leaseOwnerId: null,
        leaseFencingToken: 0,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        expectedHeadRef: null,
        rebasedCandidateRef: null,
        verification: null,
        authorizationRef: null,
        createdAt: now,
        completedAt: null,
        lastError: null
      };
      return {
        ok: true,
        events: [
          {
            type: "IntegrationCandidateQueued",
            streamType: "integration_candidate",
            streamId: candidate.candidateId,
            data: {
              candidate,
              candidateDigest,
              work,
              workDigest: canonicalDigest(work)
            }
          },
          {
            type: "ProgramIntegrationPending",
            streamType: "program",
            streamId: candidate.programId,
            data: {
              programId: candidate.programId,
              graphRevisionId: graph.graphRevisionId,
              graphDigest: graph.graphDigest,
              candidateId: candidate.candidateId
            }
          }
        ],
        resultKind: "integration_candidate",
        resultId: candidate.candidateId
      };
    }
    case "integration-work.lease.acquire": {
      if (command.actor.kind !== "system") {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Integration leasing requires a system actor");
      }
      const stored = state.integrationWork.get(command.payload.workId);
      const candidate = stored
        ? state.integrationCandidates.get(stored.work.candidateId)
        : undefined;
      const reclaimable =
        stored?.work.status === "leased" &&
        (stored.work.leaseExpiresAt === null || stored.work.leaseExpiresAt <= now);
      if (!stored || (stored.work.status !== "pending" && !reclaimable) || !candidate) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Integration work is not claimable");
      }
      const predecessors = [
        ...candidate.candidate.dependencyCandidateIds,
        ...candidate.candidate.actualOverlapPredecessorIds
      ];
      if (predecessors.some((id) => state.integrationCandidates.get(id)?.status !== "promoted")) {
        return failure(
          "PROGRAM_NOT_ADVANCEABLE",
          "Integration candidate predecessors are incomplete"
        );
      }
      const targetId = candidate.candidate.targetRef.id;
      const earlier = [...state.integrationCandidates.values()]
        .filter(
          (entry) =>
            entry.candidate.targetRef.id === targetId &&
            entry.status !== "promoted" &&
            entry.status !== "ineligible" &&
            entry.status !== "conflicted" &&
            entry.candidate.candidateId !== candidate.candidate.candidateId
        )
        .sort(
          (left, right) =>
            left.candidate.finalAdmissionSequence - right.candidate.finalAdmissionSequence ||
            left.candidate.candidateId.localeCompare(right.candidate.candidateId)
        )[0];
      if (
        earlier &&
        (earlier.candidate.finalAdmissionSequence < candidate.candidate.finalAdmissionSequence ||
          (earlier.candidate.finalAdmissionSequence ===
            candidate.candidate.finalAdmissionSequence &&
            earlier.candidate.candidateId.localeCompare(candidate.candidate.candidateId) < 0))
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "An earlier integration candidate owns ordering");
      }
      const targetBusy = [...state.integrationWork.values()].some((entry) => {
        if (
          entry.work.workId === stored.work.workId ||
          entry.work.status !== "leased" ||
          entry.work.leaseExpiresAt === null ||
          entry.work.leaseExpiresAt <= now
        ) {
          return false;
        }
        const other = state.integrationCandidates.get(entry.work.candidateId);
        return other?.candidate.targetRef.id === targetId;
      });
      if (targetBusy) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "The target merge lane is leased");
      }
      return {
        ok: true,
        events: [
          {
            type: "IntegrationWorkLeaseAcquired",
            streamType: "integration_work",
            streamId: stored.work.workId,
            data: {
              workId: stored.work.workId,
              ownerId: command.payload.ownerId,
              fencingToken: stored.work.leaseFencingToken + 1,
              leaseExpiresAt: addMilliseconds(now, command.payload.leaseDurationMs)
            }
          }
        ],
        resultKind: "integration_work",
        resultId: stored.work.workId
      };
    }
    case "integration-work.prepare": {
      if (command.actor.kind !== "system") {
        return failure(
          "PROGRAM_NOT_ADVANCEABLE",
          "Integration preparation requires a system actor"
        );
      }
      const stored = state.integrationWork.get(command.payload.workId);
      const candidate = stored
        ? state.integrationCandidates.get(stored.work.candidateId)
        : undefined;
      const target = candidate
        ? state.integrationTargets.get(candidate.candidate.targetRef.id)
        : undefined;
      if (
        stored?.work.status !== "leased" ||
        stored.work.leaseOwnerId !== command.payload.ownerId ||
        stored.work.leaseFencingToken !== command.payload.fencingToken ||
        !stored.work.leaseExpiresAt ||
        stored.work.leaseExpiresAt < now ||
        candidate?.candidate.candidateId !== stored.work.candidateId ||
        canonicalDigest(target?.currentHeadRef ?? null) !==
          canonicalDigest(command.payload.expectedHeadRef) ||
        command.payload.rebasedCandidateRef.kind !== "source_revision" ||
        !state.sourceRevisions.has(command.payload.rebasedCandidateRef.id)
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Integration preparation fence is stale");
      }
      return {
        ok: true,
        events: [
          {
            type: "IntegrationCandidatePrepared",
            streamType: "integration_work",
            streamId: stored.work.workId,
            data: {
              workId: command.payload.workId,
              candidateId: candidate.candidate.candidateId,
              ownerId: command.payload.ownerId,
              fencingToken: command.payload.fencingToken,
              expectedHeadRef: command.payload.expectedHeadRef,
              rebasedCandidateRef: command.payload.rebasedCandidateRef
            }
          }
        ],
        resultKind: "integration_work",
        resultId: stored.work.workId
      };
    }
    case "integration-work.conflict": {
      if (command.actor.kind !== "system") {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Conflict evidence requires a system actor");
      }
      const stored = state.integrationWork.get(command.payload.workId);
      if (
        stored?.work.status !== "leased" ||
        stored.work.leaseOwnerId !== command.payload.ownerId ||
        stored.work.leaseFencingToken !== command.payload.fencingToken ||
        !stored.work.leaseExpiresAt ||
        stored.work.leaseExpiresAt <= now ||
        canonicalDigest(command.payload.conflict) !== command.payload.conflictDigest ||
        command.payload.conflict.candidateId !== stored.work.candidateId
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Integration conflict evidence is stale");
      }
      return {
        ok: true,
        events: [
          {
            type: "IntegrationConflictRecorded",
            streamType: "integration_conflict",
            streamId: command.payload.conflict.conflictId,
            data: {
              workId: command.payload.workId,
              ownerId: command.payload.ownerId,
              fencingToken: command.payload.fencingToken,
              conflict: command.payload.conflict,
              conflictDigest: command.payload.conflictDigest
            }
          }
        ],
        resultKind: "integration_conflict",
        resultId: command.payload.conflict.conflictId
      };
    }
    case "integration-work.verify": {
      if (command.actor.kind !== "system") {
        return failure(
          "PROGRAM_NOT_ADVANCEABLE",
          "Integration verification requires a system actor"
        );
      }
      const stored = state.integrationWork.get(command.payload.workId);
      const candidate = stored
        ? state.integrationCandidates.get(stored.work.candidateId)
        : undefined;
      const target = candidate
        ? state.integrationTargets.get(candidate.candidate.targetRef.id)
        : undefined;
      if (
        stored?.work.status !== "prepared" ||
        stored.work.leaseOwnerId !== command.payload.ownerId ||
        stored.work.leaseFencingToken !== command.payload.fencingToken ||
        !stored.work.leaseExpiresAt ||
        stored.work.leaseExpiresAt <= now ||
        !stored.work.expectedHeadRef ||
        !stored.work.rebasedCandidateRef ||
        candidate?.candidate.candidateId !== stored.work.candidateId ||
        canonicalDigest(command.payload.verification) !== command.payload.verificationDigest ||
        command.payload.verification.candidateId !== stored.work.candidateId ||
        canonicalDigest(command.payload.verification.expectedHeadRef) !==
          canonicalDigest(stored.work.expectedHeadRef) ||
        canonicalDigest(command.payload.verification.rebasedCandidateRef) !==
          canonicalDigest(stored.work.rebasedCandidateRef) ||
        canonicalDigest(target?.currentHeadRef ?? null) !==
          canonicalDigest(stored.work.expectedHeadRef) ||
        command.payload.verification.verifierContractDigest !==
          target?.target.verifierContractDigest
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Integration verification is stale or invalid");
      }
      return {
        ok: true,
        events: [
          {
            type: "IntegrationVerificationRecorded",
            streamType: "integration_work",
            streamId: stored.work.workId,
            data: {
              workId: command.payload.workId,
              ownerId: command.payload.ownerId,
              fencingToken: command.payload.fencingToken,
              verification: command.payload.verification,
              verificationDigest: command.payload.verificationDigest
            }
          }
        ],
        resultKind: "integration_verification",
        resultId: command.payload.verification.integrationVerificationId
      };
    }
    case "integration.promote.record": {
      if (command.actor.kind !== "system") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Promotion receipts require the host");
      }
      const { receipt, receiptDigest } = command.payload;
      const candidate = state.integrationCandidates.get(receipt.candidateId);
      const work = [...state.integrationWork.values()].find(
        (entry) => entry.work.candidateId === receipt.candidateId
      );
      const target = state.integrationTargets.get(receipt.targetRef.id);
      if (
        canonicalDigest(receipt) !== receiptDigest ||
        candidate?.status !== "authorized" ||
        work?.work.status !== "authorized" ||
        work.work.authorizationRef?.id !== receipt.authorizationRef.id ||
        canonicalDigest(target?.currentHeadRef ?? null) !==
          canonicalDigest(receipt.expectedOldHeadRef) ||
        canonicalDigest(work.work.rebasedCandidateRef) !== canonicalDigest(receipt.newHeadRef)
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Promotion receipt is stale or unauthorized");
      }
      return {
        ok: true,
        events: [
          {
            type: "IntegrationPromotionRecorded",
            streamType: "promotion_receipt",
            streamId: receipt.receiptId,
            data: { receipt, receiptDigest }
          }
        ],
        resultKind: "promotion_receipt",
        resultId: receipt.receiptId
      };
    }
    case "portfolio-slo.record": {
      if (command.actor.kind !== "system") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Portfolio SLO evidence requires the host");
      }
      if (
        canonicalDigest(command.payload.incident) !== command.payload.incidentDigest ||
        !state.portfolioPolicies.has(command.payload.incident.policyRef.id)
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Portfolio SLO incident is invalid");
      }
      return {
        ok: true,
        events: [
          {
            type: "PortfolioSloIncidentRecorded",
            streamType: "portfolio_slo_incident",
            streamId: command.payload.incident.incidentId,
            data: command.payload
          }
        ],
        resultKind: "portfolio_slo_incident",
        resultId: command.payload.incident.incidentId
      };
    }
    case "portfolio-measurement-report.compile": {
      if (command.actor.kind !== "system") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Portfolio measurement requires the host");
      }
      if (
        canonicalDigest(command.payload.report) !== command.payload.reportDigest ||
        command.payload.report.throughPosition !== state.lastAppliedPosition
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Portfolio measurement report is stale");
      }
      return {
        ok: true,
        events: [
          {
            type: "PortfolioMeasurementReportCompiled",
            streamType: "portfolio_measurement_report",
            streamId: command.payload.report.reportId,
            data: command.payload
          }
        ],
        resultKind: "portfolio_measurement_report",
        resultId: command.payload.report.reportId
      };
    }
    case "attention-policy.approve": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Attention policy approval requires an operator actor"
        );
      }
      const input = command.payload.policy;
      const active = activeAttentionPolicy(state);
      if (state.attentionPolicies.has(input.policyRevisionId)) {
        return failure(
          "ATTENTION_POLICY_CONFLICT",
          "Attention policy revision identifier already exists"
        );
      }
      if (
        active
          ? input.policyId !== active.policy.policyId ||
            input.revision !== active.policy.revision + 1 ||
            input.priorPolicyRef?.kind !== "attention_policy" ||
            input.priorPolicyRef.id !== active.policy.policyRevisionId ||
            input.priorPolicyRef.digest !== active.policyDigest
          : input.revision !== 1 || input.priorPolicyRef !== null
      ) {
        return failure(
          "ATTENTION_POLICY_CONFLICT",
          "Attention policy revision chain does not match"
        );
      }
      if (
        new Set(input.rules.map((rule) => rule.ruleId)).size !== input.rules.length ||
        new Set(input.oneWayDoorActionKinds).size !== input.oneWayDoorActionKinds.length
      ) {
        return failure("ATTENTION_POLICY_CONFLICT", "Attention policy identifiers must be unique");
      }
      const policy = { ...input, approvedBy: command.actor.id, approvedAt: now };
      return {
        ok: true,
        events: [
          {
            type: "AttentionPolicyApproved",
            streamType: "attention_policy",
            streamId: policy.policyId,
            data: {
              policy,
              policyDigest: canonicalDigest(policy),
              supersededPolicyRevisionId: active?.policy.policyRevisionId ?? null
            }
          }
        ],
        resultKind: "attention_policy",
        resultId: policy.policyRevisionId
      };
    }
    case "integration-decision.compile": {
      if (command.actor.kind !== "system") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Integration packet compilation requires the host"
        );
      }
      if (command.payload.expectedThroughPosition !== state.lastAppliedPosition) {
        return failure("DECISION_PACKET_STALE", "Integration packet compilation snapshot is stale");
      }
      const candidate = state.integrationCandidates.get(command.payload.candidateId);
      const work = [...state.integrationWork.values()].find(
        (entry) => entry.work.candidateId === command.payload.candidateId
      );
      const verification = work?.work.verification
        ? state.integrationVerifications.get(work.work.verification.integrationVerificationId)
        : undefined;
      const target = candidate
        ? state.integrationTargets.get(candidate.candidate.targetRef.id)
        : undefined;
      const policy = candidate
        ? state.portfolioPolicies.get(candidate.candidate.policyRef.id)
        : undefined;
      const graph = candidate
        ? state.programGraphs.get(candidate.candidate.graphRevisionRef.id)
        : undefined;
      const manifest = candidate
        ? state.candidateDiffManifests.get(candidate.candidate.diffManifestRef.id)
        : undefined;
      const finalOutcome = candidate
        ? [...state.outcomePackets.values()]
            .filter(
              (packet) =>
                packet.programId === candidate.candidate.programId &&
                packet.packet.candidateRevisionId === candidate.candidate.originalCandidateRef.id
            )
            .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]
        : undefined;
      const attentionPolicy = policy
        ? state.attentionPolicies.get(policy.policy.attention.policyRef.id)
        : undefined;
      if (
        candidate?.status !== "awaiting_authorization" ||
        work?.work.status !== "verified" ||
        !work.work.expectedHeadRef ||
        !work.work.rebasedCandidateRef ||
        verification?.verification.result !== "passed" ||
        canonicalDigest(target?.currentHeadRef ?? null) !==
          canonicalDigest(work.work.expectedHeadRef) ||
        target?.target.managedRef === undefined ||
        policy?.policyDigest !== candidate.candidate.policyRef.digest ||
        graph?.graphRevisionId !== candidate.candidate.graphRevisionRef.id ||
        !manifest?.manifest.eligible ||
        finalOutcome?.packet.recommendation !== "merge" ||
        attentionPolicy?.policyDigest !== policy.policy.attention.policyRef.digest
      ) {
        return failure("DECISION_PACKET_STALE", "Integration candidate is not ready for authority");
      }
      const targetPreconditionDigest = canonicalDigest({
        graph: candidate.candidate.graphRevisionRef,
        policy: candidate.candidate.policyRef,
        target: candidate.candidate.targetRef,
        expectedHead: work.work.expectedHeadRef,
        originalCandidate: candidate.candidate.originalCandidateRef,
        rebasedCandidate: work.work.rebasedCandidateRef,
        finalOutcome: {
          kind: "outcome_packet",
          id: finalOutcome.outcomePacketId,
          digest: finalOutcome.packetDigest
        },
        diffManifest: candidate.candidate.diffManifestRef,
        integrationVerification: {
          kind: "integration_verification",
          id: verification.verification.integrationVerificationId,
          digest: verification.verificationDigest
        }
      });
      const packetId = deterministicUuid(
        `parallelplay:integration:integration-packet:${candidate.candidate.candidateId}:${targetPreconditionDigest}`
      );
      if (state.decisionPackets.has(packetId)) {
        return {
          ok: true,
          events: [],
          resultKind: "decision_packet",
          resultId: packetId
        };
      }
      const packetRevisionId = deterministicUuid(`${packetId}:revision:1`);
      const evidenceBundleId = deterministicUuid(`${packetId}:evidence:1`);
      const requestId = deterministicUuid(`${packetId}:request`);
      const optionId = deterministicUuid(`${packetId}:integrate`);
      const source = {
        kind: "integration_candidate" as const,
        id: candidate.candidate.candidateId,
        digest: candidate.candidateDigest
      };
      const refs = [
        candidate.candidate.graphRevisionRef,
        candidate.candidate.policyRef,
        candidate.candidate.targetRef,
        candidate.candidate.diffManifestRef,
        {
          kind: "integration_verification" as const,
          id: verification.verification.integrationVerificationId,
          digest: verification.verificationDigest
        },
        {
          kind: "integration_candidate" as const,
          id: candidate.candidate.candidateId,
          digest: candidate.candidateDigest
        },
        {
          kind: "outcome_packet" as const,
          id: finalOutcome.outcomePacketId,
          digest: finalOutcome.packetDigest
        }
      ];
      const action = {
        kind: "integrate" as const,
        target: {
          kind: "managed_integration_promotion" as const,
          workId: work.work.workId,
          candidateId: candidate.candidate.candidateId,
          programId: candidate.candidate.programId,
          graphRef: candidate.candidate.graphRevisionRef,
          policyRef: candidate.candidate.policyRef,
          targetRef: candidate.candidate.targetRef,
          expectedHeadRef: work.work.expectedHeadRef,
          originalCandidateRef: candidate.candidate.originalCandidateRef,
          rebasedCandidateRef: work.work.rebasedCandidateRef,
          finalOutcomeRef: {
            kind: "outcome_packet" as const,
            id: finalOutcome.outcomePacketId,
            digest: finalOutcome.packetDigest
          },
          diffManifestRef: candidate.candidate.diffManifestRef,
          integrationVerificationRef: {
            kind: "integration_verification" as const,
            id: verification.verification.integrationVerificationId,
            digest: verification.verificationDigest
          },
          targetPreconditionDigest
        }
      };
      const option = {
        schemaVersion: 2 as const,
        optionId,
        label: "Integrate the verified candidate",
        consequences: [
          `Authorizes one compare-and-swap update of ${target.target.managedRef}`,
          "Accepts the final outcome and records permanent operator precedent"
        ],
        reversalCost: "A later managed promotion is required to reverse this integration",
        action
      };
      const policyBinding = {
        kind: "attention_policy" as const,
        id: attentionPolicy.policy.policyRevisionId,
        digest: attentionPolicy.policyDigest
      };
      const bundle = {
        schemaVersion: 2 as const,
        evidenceBundleId,
        packetId,
        packetRevisionId,
        programId: candidate.candidate.programId,
        sourceRef: source,
        refs,
        orientation: `Promote ${work.work.rebasedCandidateRef.id} only if managed head ${work.work.expectedHeadRef.id} is unchanged.`,
        compiledAt: now
      };
      const revision = {
        schemaVersion: 2 as const,
        packetRevisionId,
        packetId,
        programId: candidate.candidate.programId,
        milestoneId: null,
        revision: 1 as const,
        priorRevisionRef: null,
        source,
        originalQuestion: `Integrate candidate ${candidate.candidate.candidateId}?`,
        prompt: "Authorize the exact verified managed-ref promotion",
        context: bundle.orientation,
        requiredAuthority: "operator" as const,
        riskClass: "reserved" as const,
        safetyClass: "safety_critical" as const,
        reversibility: "one_way" as const,
        options: [option],
        evidenceBundleRef: {
          kind: "decision_evidence_bundle" as const,
          id: evidenceBundleId,
          digest: canonicalDigest(bundle)
        },
        policyBinding,
        precedentRefs: [],
        deadlineAt: null,
        defaultOnTimeout: null,
        deduplicationKey: canonicalDigest(source),
        routing: {
          route: "page" as const,
          urgency: "p0" as const,
          matchedRuleId: null,
          requireAcknowledgement: true,
          reason: "human_integration_authority",
          routineBudget: {
            applied: false,
            allowed: true,
            used: 0,
            limit: 0,
            windowMs: 86_400_000
          }
        },
        createdAt: now
      };
      const revisionDigest = canonicalDigest(revision);
      const request = {
        schemaVersion: 2 as const,
        requestId,
        programId: candidate.candidate.programId,
        milestoneId: null,
        originalQuestion: revision.originalQuestion,
        prompt: revision.prompt,
        context: revision.context,
        requiredAuthority: "operator" as const,
        riskClass: "reserved" as const,
        safetyClass: "safety_critical" as const,
        reversibility: "one_way" as const,
        options: [option],
        refs,
        deadlineAt: null,
        requestedBy: command.actor.id,
        requestedAt: now
      };
      const deliveryId = deterministicUuid(`${packetRevisionId}:page`);
      return {
        ok: true,
        events: [
          {
            type: "OperatorDecisionRequestRecorded",
            streamType: "operator_decision_request",
            streamId: requestId,
            data: { request, requestDigest: canonicalDigest(request) }
          },
          {
            type: "DecisionEvidenceBundleRecorded",
            streamType: "decision_evidence_bundle",
            streamId: evidenceBundleId,
            data: { bundle, bundleDigest: canonicalDigest(bundle) }
          },
          {
            type: "DecisionPacketOpened",
            streamType: "decision_packet",
            streamId: packetId,
            data: {
              packetId,
              programId: candidate.candidate.programId,
              milestoneId: null,
              packetRevisionId,
              packetRevisionDigest: revisionDigest
            }
          },
          {
            type: "DecisionPacketRevisionRecorded",
            streamType: "decision_packet_revision",
            streamId: packetRevisionId,
            data: { revision, revisionDigest, supersededRevisionId: null }
          },
          {
            type: "AttentionDeliveryQueued",
            streamType: "attention_delivery",
            streamId: deliveryId,
            data: {
              delivery: {
                schemaVersion: 1,
                deliveryId,
                programId: candidate.candidate.programId,
                packetId,
                packetRevisionId,
                packetRevisionDigest: revisionDigest,
                policyBinding,
                matchedRuleId: null,
                channel: "page",
                deepLink: `/packets/${packetId}`,
                idempotencyKey: `attention:${packetRevisionId}:page`,
                status: "pending",
                availableAt: now,
                deliveryAttempts: 0,
                retryDelaysMs: [250, 1_000, 5_000, 10_000, 30_000, 30_000, 30_000],
                leaseOwnerId: null,
                leaseFencingToken: 0,
                leaseAcquiredAt: null,
                leaseExpiresAt: null,
                receipt: null,
                createdAt: now,
                deliveredAt: null,
                lastError: null
              }
            }
          }
        ],
        resultKind: "decision_packet",
        resultId: packetId
      };
    }
    case "decision.request": {
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Decision requests require an operator actor");
      }
      const input = command.payload.request;
      const program = state.programs.get(input.programId);
      if (!program) return failure("PROGRAM_NOT_FOUND", "Decision request program does not exist");
      if (
        input.milestoneId &&
        state.milestones.get(input.milestoneId)?.programId !== input.programId
      ) {
        return failure("MILESTONE_NOT_FOUND", "Decision request milestone is outside the program");
      }
      if (state.operatorDecisionRequests.has(input.requestId)) {
        return failure(
          "ATTENTION_POLICY_CONFLICT",
          "Operator decision request identifier already exists"
        );
      }
      if (new Set(input.options.map((option) => option.optionId)).size !== input.options.length) {
        return failure("DECISION_ACTION_MISMATCH", "Decision option identifiers must be unique");
      }
      const request = {
        ...input,
        requiredAuthority: "operator" as const,
        requestedBy: command.actor.id,
        requestedAt: now
      };
      const requestDigest = canonicalDigest(request);
      const source = {
        kind: "operator_decision_request" as const,
        id: request.requestId,
        digest: requestDigest
      };
      const compiled = compileAttentionEvents(
        state,
        {
          programId: request.programId,
          milestoneId: request.milestoneId,
          source,
          originalQuestion: request.originalQuestion,
          prompt: request.prompt,
          context: request.context,
          riskClass: request.riskClass,
          safetyClass: request.safetyClass,
          reversibility: request.reversibility,
          options: request.options,
          refs: [
            attentionRef("operator_decision_request", request.requestId, requestDigest),
            ...request.refs
          ],
          deadlineAt: request.deadlineAt
        },
        now
      );
      if ("ok" in compiled) return compiled;
      return {
        ok: true,
        events: [
          {
            type: "OperatorDecisionRequestRecorded",
            streamType: "operator_decision_request",
            streamId: request.requestId,
            data: { request, requestDigest }
          },
          ...compiled.events
        ],
        resultKind: "decision_packet",
        resultId: compiled.packetId
      };
    }
    case "attention.compile": {
      if (command.actor.kind !== "system") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Attention compilation requires a system actor"
        );
      }
      if (command.payload.expectedThroughPosition !== state.lastAppliedPosition) {
        return failure("DECISION_PACKET_STALE", "Attention compilation cutoff is stale", {
          expectedThroughPosition: state.lastAppliedPosition
        });
      }
      const material = sourceMaterial(state, command.payload.source);
      if ("ok" in material) return material;
      const compiled = compileAttentionEvents(state, material, now);
      if ("ok" in compiled) return compiled;
      return {
        ok: true,
        events: compiled.events,
        resultKind: "decision_packet",
        resultId: compiled.packetId
      };
    }
    case "decision.acknowledge": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Decision acknowledgement requires an operator actor"
        );
      }
      const packet = state.decisionPackets.get(command.payload.packetId);
      const revision = state.decisionPacketRevisions.get(command.payload.packetRevisionId);
      if (!packet || !revision)
        return failure("DECISION_PACKET_NOT_FOUND", "Decision packet does not exist");
      if (
        packet.status !== "open" ||
        packet.currentRevisionId !== revision.revision.packetRevisionId ||
        packet.currentRevisionDigest !== revision.revisionDigest ||
        command.payload.packetRevisionDigest !== revision.revisionDigest
      ) {
        return failure("DECISION_PACKET_STALE", "Decision acknowledgement revision is stale");
      }
      if (packet.acknowledgementId !== null) {
        return failure("DECISION_PACKET_STALE", "Decision revision is already acknowledged");
      }
      const acknowledgement = {
        schemaVersion: 1 as const,
        acknowledgementId: command.payload.acknowledgementId,
        packetId: packet.packetId,
        packetRevisionId: revision.revision.packetRevisionId,
        packetRevisionDigest: revision.revisionDigest,
        actorId: command.actor.id,
        acknowledgedAt: now
      };
      const events: DomainEventInput[] = [
        {
          type: "DecisionAcknowledged",
          streamType: "decision_acknowledgement",
          streamId: acknowledgement.acknowledgementId,
          data: { acknowledgement, acknowledgementDigest: canonicalDigest(acknowledgement) }
        }
      ];
      for (const delivery of state.attentionDeliveries.values()) {
        if (
          delivery.delivery.packetRevisionId === revision.revision.packetRevisionId &&
          (delivery.delivery.status === "pending" || delivery.delivery.status === "leased")
        ) {
          events.push({
            type: "AttentionDeliveryObsoleted",
            streamType: "attention_delivery",
            streamId: delivery.delivery.deliveryId,
            data: { deliveryId: delivery.delivery.deliveryId, reason: "decision_acknowledged" }
          });
        }
      }
      return {
        ok: true,
        events,
        resultKind: "decision_acknowledgement",
        resultId: acknowledgement.acknowledgementId
      };
    }
    case "decision.approve": {
      const binding = decisionOption(state, command, "approve", now);
      if ("ok" in binding) return binding;
      if (binding.option.action.kind !== "approve") {
        return failure("DECISION_ACTION_MISMATCH", "Decision option is not an approve action");
      }
      const target = binding.option.action.target;
      const domainEvents: DomainEventInput[] = [];
      if (target.kind === "issue_resolution") {
        const event = issueResolutionEvent(
          state,
          target.issueId,
          target.issueDigest,
          target.action,
          target.text,
          command.actor.id
        );
        if ("ok" in event) return event;
        domainEvents.push(event);
      } else if (target.kind === "outcome_disposition") {
        const event = outcomeDispositionEvent(
          state,
          target.outcomePacketId,
          target.outcomePacketDigest,
          target.disposition,
          target.reason,
          command.actor.id,
          now
        );
        if ("ok" in event) return event;
        domainEvents.push(event);
      } else if (target.kind === "program_resume") {
        const program = state.programs.get(target.programId);
        if (
          program?.phase !== "parked" ||
          program.version !== target.expectedProgramVersion ||
          program.activeGraphDigest !== target.expectedGraphDigest
        ) {
          return failure("DECISION_PACKET_STALE", "Parked program precondition changed");
        }
        domainEvents.push({
          type: "ProgramResumed",
          streamType: "program",
          streamId: program.programId,
          data: { programId: program.programId, resumedBy: command.actor.id }
        });
      } else {
        const source = sourceMaterial(state, binding.revision.source);
        if ("ok" in source) return failure("DECISION_PACKET_STALE", "Record-only source changed");
      }
      const finalized = finalizedDecisionEvents(
        binding.revision,
        binding.option,
        command.actor.id,
        command.payload.targetPreconditionDigest,
        domainEvents,
        now
      );
      return {
        ok: true,
        events: finalized.events,
        resultKind: "decision_action_result",
        resultId: finalized.actionResultId
      };
    }
    case "decision.retry": {
      const binding = decisionOption(state, command, "retry", now);
      if ("ok" in binding) return binding;
      if (binding.option.action.kind !== "retry") {
        return failure("DECISION_ACTION_MISMATCH", "Decision option is not a retry action");
      }
      const target = binding.option.action.target;
      const program = state.programs.get(target.programId);
      const milestone = state.milestones.get(target.milestoneId);
      const graph = state.programGraphs.get(target.graphRevisionId);
      const priorGeneration = milestone?.activeGenerationId
        ? state.milestoneGenerations.get(milestone.activeGenerationId)
        : [...state.milestoneGenerations.values()]
            .filter((candidate) => candidate.milestoneId === target.milestoneId)
            .sort((left, right) => right.generation - left.generation)[0];
      if (
        program?.phase !== "running" ||
        program.activeGraphRevisionId !== target.graphRevisionId ||
        program.activeGraphDigest !== target.graphDigest ||
        graph?.graphDigest !== target.graphDigest ||
        milestone?.version !== target.expectedMilestoneVersion ||
        (milestone.generation ?? 0) !== target.expectedGeneration ||
        milestone.contractDigest !== target.contractDigest ||
        priorGeneration?.baseRevisionId !== target.baseRevisionId ||
        activeGenerationForProgram(state, target.programId)
      ) {
        return failure("DECISION_PACKET_STALE", "Milestone retry precondition changed");
      }
      if (
        [...state.routedIssues.values()].some(
          (issue) =>
            issue.issue.programId === target.programId &&
            issue.issue.status !== "resolved" &&
            issue.issue.route !== "record_only"
        )
      ) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Program has an unresolved blocking issue");
      }
      const node = graphMilestone(graph, target.milestoneId);
      if (
        node?.dependencies.length !== target.dependencyValidations.length ||
        node.dependencies.some(
          (dependency) =>
            !target.dependencyValidations.some(
              (validation) => validation.milestoneId === dependency
            )
        )
      ) {
        return failure("DECISION_PACKET_STALE", "Retry dependency set changed");
      }
      for (const validation of target.dependencyValidations) {
        const packet = state.outcomePackets.get(validation.outcomePacketId);
        if (
          packet?.programId !== target.programId ||
          packet.milestoneId !== validation.milestoneId ||
          packet.packetDigest !== validation.packetDigest ||
          canonicalDigest(packet.packet) !== validation.computedDigest ||
          validation.packetDigest !== validation.computedDigest ||
          packet.packet.recommendation !== "merge" ||
          !packet.packet.criteriaResults.every((criterion) => criterion.result === "pass")
        ) {
          return failure("EVIDENCE_DIGEST_MISMATCH", "Retry dependency evidence changed");
        }
      }
      const scheduled = startGraphMilestoneEvents(
        state,
        graph,
        target.milestoneId,
        target.expectedGeneration + 1,
        target.baseRevisionId,
        target.dependencyValidations,
        target.policy,
        now
      );
      if ("ok" in scheduled) return scheduled;
      const finalized = finalizedDecisionEvents(
        binding.revision,
        binding.option,
        command.actor.id,
        command.payload.targetPreconditionDigest,
        scheduled.events,
        now
      );
      return {
        ok: true,
        events: finalized.events,
        resultKind: "decision_action_result",
        resultId: finalized.actionResultId
      };
    }
    case "decision.cancel": {
      const binding = decisionOption(state, command, "cancel", now);
      if ("ok" in binding) return binding;
      if (binding.option.action.kind !== "cancel") {
        return failure("DECISION_ACTION_MISMATCH", "Decision option is not a cancel action");
      }
      const target = binding.option.action.target;
      const run = state.runs.get(target.runId);
      if (run?.version !== target.expectedRunVersion) {
        return failure("DECISION_PACKET_STALE", "Run cancellation precondition changed");
      }
      const cancellation = cancellationForRun(state, target.runId, target.reason);
      if ("ok" in cancellation) return cancellation;
      const finalized = finalizedDecisionEvents(
        binding.revision,
        binding.option,
        command.actor.id,
        command.payload.targetPreconditionDigest,
        cancellation,
        now
      );
      return {
        ok: true,
        events: finalized.events,
        resultKind: "decision_action_result",
        resultId: finalized.actionResultId
      };
    }
    case "decision.park": {
      const binding = decisionOption(state, command, "park", now);
      if ("ok" in binding) return binding;
      if (binding.option.action.kind !== "park") {
        return failure("DECISION_ACTION_MISMATCH", "Decision option is not a park action");
      }
      const target = binding.option.action.target;
      const program = state.programs.get(target.programId);
      if (
        !program ||
        (program.phase !== "running" &&
          !(
            program.programMode === "graph_v2" &&
            (program.phase === "eligible" || program.phase === "integration_pending")
          )) ||
        program.version !== target.expectedProgramVersion ||
        program.activeGraphDigest !== target.expectedGraphDigest
      ) {
        return failure("DECISION_PACKET_STALE", "Program park precondition changed");
      }
      const domainEvents: DomainEventInput[] = [];
      const active = activeGenerationForProgram(state, program.programId);
      if (active) {
        const cancellation = cancellationForRun(
          state,
          active.runId,
          `program_parked:${target.reason}`
        );
        if ("ok" in cancellation) return cancellation;
        domainEvents.push(...cancellation);
        if (program.programMode === "graph_v2") {
          const admission = [...state.portfolioAdmissions.values()].find(
            (entry) =>
              entry.status === "active" && entry.admission.generationId === active.generationId
          );
          const leases = admission
            ? [...state.concurrencyLeases.values()].filter(
                (entry) => entry.lease.admissionId === admission.admission.admissionId
              )
            : [];
          const firstLease = leases[0];
          if (admission && firstLease) {
            domainEvents.push({
              type: "PortfolioAdmissionFenced",
              streamType: "portfolio_admission",
              streamId: admission.admission.admissionId,
              data: {
                admissionId: admission.admission.admissionId,
                generationId: admission.admission.generationId,
                fencingToken: firstLease.lease.fencingToken,
                reason: `program_parked:${target.reason}`,
                fencedAt: now,
                leaseIds: leases.map((entry) => entry.lease.leaseId)
              }
            });
          }
        }
      }
      domainEvents.push({
        type: "ProgramParked",
        streamType: "program",
        streamId: program.programId,
        data: { programId: program.programId, reason: target.reason, parkedBy: command.actor.id }
      });
      const finalized = finalizedDecisionEvents(
        binding.revision,
        binding.option,
        command.actor.id,
        command.payload.targetPreconditionDigest,
        domainEvents,
        now
      );
      return {
        ok: true,
        events: finalized.events,
        resultKind: "decision_action_result",
        resultId: finalized.actionResultId
      };
    }
    case "decision.reprioritize": {
      const binding = decisionOption(state, command, "reprioritize", now);
      if ("ok" in binding) return binding;
      if (binding.option.action.kind !== "reprioritize") {
        return failure("DECISION_ACTION_MISMATCH", "Decision option is not a reprioritize action");
      }
      const target = binding.option.action.target;
      const program = state.programs.get(target.programId);
      if (program?.version !== target.expectedProgramVersion) {
        return failure("DECISION_PACKET_STALE", "Program priority precondition changed");
      }
      const domainEvents: DomainEventInput[] = [
        {
          type: "ProgramAttentionPriorityChanged",
          streamType: "program",
          streamId: program.programId,
          data: {
            programId: program.programId,
            priority: target.priority,
            changedBy: command.actor.id
          }
        }
      ];
      const finalized = finalizedDecisionEvents(
        binding.revision,
        binding.option,
        command.actor.id,
        command.payload.targetPreconditionDigest,
        domainEvents,
        now
      );
      return {
        ok: true,
        events: finalized.events,
        resultKind: "decision_action_result",
        resultId: finalized.actionResultId
      };
    }
    case "decision.integrate": {
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Integration requires an operator actor");
      }
      const packet = state.decisionPackets.get(command.payload.packetId);
      const stored = state.decisionPacketRevisions.get(command.payload.packetRevisionId);
      if (
        packet?.status !== "open" ||
        packet.currentRevisionId !== command.payload.packetRevisionId ||
        packet.currentRevisionDigest !== command.payload.packetRevisionDigest ||
        stored?.revision.schemaVersion !== 2 ||
        stored.revisionDigest !== command.payload.packetRevisionDigest ||
        canonicalDigest(stored.revision) !== stored.revisionDigest
      ) {
        return failure("DECISION_PACKET_STALE", "Integration decision packet is stale");
      }
      const option = stored.revision.options.find(
        (entry) => entry.optionId === command.payload.optionId
      );
      if (!option) {
        return failure("DECISION_ACTION_MISMATCH", "Integration option does not match");
      }
      const target = option.action.target;
      const candidate = state.integrationCandidates.get(target.candidateId);
      const work = state.integrationWork.get(target.workId);
      const integrationTarget = state.integrationTargets.get(target.targetRef.id);
      const verification = state.integrationVerifications.get(target.integrationVerificationRef.id);
      const manifest = state.candidateDiffManifests.get(target.diffManifestRef.id);
      const finalOutcome = state.outcomePackets.get(target.finalOutcomeRef.id);
      const livePreconditionDigest = canonicalDigest({
        graph: target.graphRef,
        policy: target.policyRef,
        target: target.targetRef,
        expectedHead: target.expectedHeadRef,
        originalCandidate: target.originalCandidateRef,
        rebasedCandidate: target.rebasedCandidateRef,
        finalOutcome: target.finalOutcomeRef,
        diffManifest: target.diffManifestRef,
        integrationVerification: target.integrationVerificationRef
      });
      if (
        target.targetPreconditionDigest !== command.payload.targetPreconditionDigest ||
        livePreconditionDigest !== target.targetPreconditionDigest ||
        target.candidateId !== command.payload.candidateId ||
        canonicalDigest(target.expectedHeadRef) !==
          canonicalDigest(command.payload.expectedHeadRef) ||
        canonicalDigest(target.rebasedCandidateRef) !==
          canonicalDigest(command.payload.rebasedCandidateRef) ||
        canonicalDigest(target.finalOutcomeRef) !==
          canonicalDigest(command.payload.finalOutcomeRef) ||
        canonicalDigest(target.diffManifestRef) !==
          canonicalDigest(command.payload.diffManifestRef) ||
        canonicalDigest(target.integrationVerificationRef) !==
          canonicalDigest(command.payload.integrationVerificationRef) ||
        candidate?.status !== "awaiting_authorization" ||
        candidate.candidateDigest !== stored.revision.source.digest ||
        work?.work.status !== "verified" ||
        canonicalDigest(work.work.expectedHeadRef) !== canonicalDigest(target.expectedHeadRef) ||
        canonicalDigest(work.work.rebasedCandidateRef) !==
          canonicalDigest(target.rebasedCandidateRef) ||
        integrationTarget?.targetDigest !== target.targetRef.digest ||
        canonicalDigest(integrationTarget.currentHeadRef) !==
          canonicalDigest(target.expectedHeadRef) ||
        verification?.verificationDigest !== target.integrationVerificationRef.digest ||
        verification.verification.result !== "passed" ||
        manifest?.manifestDigest !== target.diffManifestRef.digest ||
        !manifest.manifest.eligible ||
        finalOutcome?.packetDigest !== target.finalOutcomeRef.digest ||
        finalOutcome.packet.recommendation !== "merge" ||
        state.outcomeDispositions.has(finalOutcome.outcomePacketId)
      ) {
        return failure("DECISION_PACKET_STALE", "Integration evidence or target head changed");
      }
      const dispositionEvent = outcomeDispositionEvent(
        state,
        finalOutcome.outcomePacketId,
        finalOutcome.packetDigest,
        "accepted",
        "Accepted with exact managed integration authorization",
        command.actor.id,
        now
      );
      if ("ok" in dispositionEvent) return dispositionEvent;
      const actionResultId = deterministicUuid(
        `parallelplay:decision-action-result:v2:${stored.revision.packetRevisionId}:${option.optionId}`
      );
      const resolutionId = deterministicUuid(
        `parallelplay:decision-resolution:v2:${stored.revision.packetRevisionId}:${option.optionId}`
      );
      const precedentId = deterministicUuid(
        `parallelplay:decision-precedent:v2:${stored.revision.packetRevisionId}:${option.optionId}`
      );
      const appliedEventTypes: ["OutcomeDispositionRecorded", "IntegrationPromotionAuthorized"] = [
        "OutcomeDispositionRecorded",
        "IntegrationPromotionAuthorized"
      ];
      const result = {
        schemaVersion: 2 as const,
        actionResultId,
        packetId: packet.packetId,
        packetRevisionId: stored.revision.packetRevisionId,
        optionId: option.optionId,
        actionKind: "integrate" as const,
        targetPreconditionDigest: target.targetPreconditionDigest,
        appliedEventTypes,
        actorId: command.actor.id,
        appliedAt: now
      };
      const resultDigest = canonicalDigest(result);
      const actionResultRef = {
        kind: "decision_action_result" as const,
        id: actionResultId,
        digest: resultDigest
      };
      const resolution = {
        schemaVersion: 2 as const,
        resolutionId,
        packetId: packet.packetId,
        packetRevisionId: stored.revision.packetRevisionId,
        packetRevisionDigest: stored.revisionDigest,
        optionId: option.optionId,
        actionKind: "integrate" as const,
        actorId: command.actor.id,
        resolvedAt: now
      };
      const precedent = {
        schemaVersion: 2 as const,
        precedentId,
        programId: candidate.candidate.programId,
        packetRevisionRef: {
          kind: "decision_packet_revision" as const,
          id: stored.revision.packetRevisionId,
          digest: stored.revisionDigest
        },
        selectedOptionId: option.optionId,
        actionResultRef,
        evidenceBundleRef: stored.revision.evidenceBundleRef,
        policyBinding: stored.revision.policyBinding,
        authority: "operator" as const,
        actorId: command.actor.id,
        recordedAt: now
      };
      return {
        ok: true,
        events: [
          dispositionEvent,
          {
            type: "IntegrationPromotionAuthorized",
            streamType: "integration_work",
            streamId: work.work.workId,
            data: {
              workId: work.work.workId,
              candidateId: candidate.candidate.candidateId,
              actionResultRef,
              expectedHeadRef: target.expectedHeadRef,
              rebasedCandidateRef: target.rebasedCandidateRef
            }
          },
          {
            type: "DecisionActionApplied",
            streamType: "decision_action_result",
            streamId: actionResultId,
            data: { result, resultDigest }
          },
          {
            type: "DecisionResolved",
            streamType: "decision_resolution",
            streamId: resolutionId,
            data: { resolution, resolutionDigest: canonicalDigest(resolution) }
          },
          {
            type: "DecisionPrecedentRecorded",
            streamType: "decision_precedent",
            streamId: precedentId,
            data: { precedent, precedentDigest: canonicalDigest(precedent) }
          }
        ],
        resultKind: "decision_action_result",
        resultId: actionResultId
      };
    }
    case "decision.expire": {
      if (command.actor.kind !== "system") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Decision expiry requires a system actor");
      }
      const packet = state.decisionPackets.get(command.payload.packetId);
      const revision = state.decisionPacketRevisions.get(command.payload.packetRevisionId);
      if (
        packet?.status !== "open" ||
        revision?.revision.packetRevisionId !== packet.currentRevisionId ||
        packet.currentRevisionDigest !== command.payload.packetRevisionDigest ||
        revision.revision.deadlineAt === null ||
        revision.revision.deadlineAt > now
      ) {
        return failure("DECISION_PACKET_STALE", "Decision packet is not expirable");
      }
      return {
        ok: true,
        events: [
          {
            type: "DecisionExpired",
            streamType: "decision_packet",
            streamId: packet.packetId,
            data: {
              packetId: packet.packetId,
              packetRevisionId: revision.revision.packetRevisionId,
              packetRevisionDigest: revision.revisionDigest
            }
          }
        ],
        resultKind: "decision_packet",
        resultId: packet.packetId
      };
    }
    case "attention-measurement-report.compile": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Attention measurement requires an operator actor"
        );
      }
      if (command.payload.expectedThroughPosition !== state.lastAppliedPosition) {
        return failure("MEASUREMENT_NOT_READY", "Attention measurement cutoff is stale");
      }
      const program = state.programs.get(command.payload.programId);
      if (!program) return failure("PROGRAM_NOT_FOUND", "Program does not exist");
      if (state.attentionMeasurementReports.has(command.payload.reportId)) {
        return failure("MEASUREMENT_NOT_READY", "Attention measurement report identifier exists");
      }
      const packets = [...state.decisionPackets.values()].filter(
        (packet) => packet.programId === program.programId
      );
      const metric = (start: string, end: string | null, open: boolean) =>
        end
          ? {
              status: "available" as const,
              milliseconds: Math.max(0, new Date(end).getTime() - new Date(start).getTime())
            }
          : open
            ? { status: "open" as const }
            : { status: "unavailable" as const, reason: "No matching authoritative event" };
      const report = {
        schemaVersion: 1 as const,
        reportId: command.payload.reportId,
        programId: program.programId,
        observationWindow: {
          status: program.phase === "completed" ? ("complete" as const) : ("open" as const),
          startedAt: program.createdAt,
          throughAt: now,
          throughPosition: state.lastAppliedPosition
        },
        packets: packets.map((packet) => {
          const acknowledgement = packet.acknowledgementId
            ? state.decisionAcknowledgements.get(packet.acknowledgementId)
            : undefined;
          const resolution = packet.resolutionId
            ? state.decisionResolutions.get(packet.resolutionId)
            : undefined;
          return {
            packetId: packet.packetId,
            queueWait: metric(
              packet.createdAt,
              acknowledgement?.acknowledgement.acknowledgedAt ?? null,
              packet.status === "open"
            ),
            acknowledgementLatency: metric(
              packet.createdAt,
              acknowledgement?.acknowledgement.acknowledgedAt ?? null,
              packet.status === "open"
            ),
            resolutionLatency: metric(
              packet.createdAt,
              resolution?.resolution.resolvedAt ?? null,
              packet.status === "open"
            )
          };
        }),
        pageCount: [...state.attentionDeliveries.values()].filter(
          (entry) => entry.delivery.programId === program.programId
        ).length,
        routineBudgetIncidentCount: [...state.attentionBudgetIncidents.values()].filter(
          (entry) => entry.incident.programId === program.programId
        ).length,
        staleActionConflictCount: context.staleActionConflictCount ?? 0,
        completeness: {
          acknowledgements: packets.every(
            (packet) => packet.acknowledgementId !== null || packet.status !== "open"
          ),
          resolutions: packets.every((packet) => packet.status !== "open"),
          window: program.phase === "completed"
        },
        compiledAt: now
      };
      return {
        ok: true,
        events: [
          {
            type: "AttentionMeasurementReportCompiled",
            streamType: "attention_measurement_report",
            streamId: report.reportId,
            data: { report, reportDigest: canonicalDigest(report) }
          }
        ],
        resultKind: "attention_measurement_report",
        resultId: report.reportId
      };
    }
    case "attention-digest.compile": {
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Attention digest requires an operator actor");
      }
      if (command.payload.expectedThroughPosition !== state.lastAppliedPosition) {
        return failure("MEASUREMENT_NOT_READY", "Attention digest cutoff is stale");
      }
      const program = state.programs.get(command.payload.programId);
      if (!program) return failure("PROGRAM_NOT_FOUND", "Program does not exist");
      const items = [...state.decisionPackets.values()]
        .filter((packet) => packet.programId === program.programId && packet.status === "open")
        .map((packet) => {
          const revision = state.decisionPacketRevisions.get(packet.currentRevisionId);
          if (!revision) throw new Error("Decision packet revision projection is missing");
          return {
            packetId: packet.packetId,
            packetRevisionId: revision.revision.packetRevisionId,
            packetRevisionDigest: revision.revisionDigest,
            route: revision.revision.routing.route,
            urgency: revision.revision.routing.urgency,
            prompt: revision.revision.prompt,
            deepLink: `/decisions/${packet.packetId}?revision=${revision.revision.packetRevisionId}`
          };
        })
        .sort((left, right) => left.packetId.localeCompare(right.packetId));
      const artifact = {
        schemaVersion: 1 as const,
        artifactId: command.payload.artifactId,
        programId: program.programId,
        throughPosition: state.lastAppliedPosition,
        items,
        compiledAt: now
      };
      return {
        ok: true,
        events: [
          {
            type: "AttentionDigestArtifactCompiled",
            streamType: "attention_digest_artifact",
            streamId: artifact.artifactId,
            data: { artifact, artifactDigest: canonicalDigest(artifact) }
          }
        ],
        resultKind: "attention_digest_artifact",
        resultId: artifact.artifactId
      };
    }
    case "attention-delivery.lease.acquire": {
      if (command.actor.kind !== "system") {
        return failure(
          "ATTENTION_DELIVERY_NOT_CLAIMABLE",
          "Attention delivery leasing requires a system actor"
        );
      }
      const stored = state.attentionDeliveries.get(command.payload.deliveryId);
      if (!stored)
        return failure("ATTENTION_DELIVERY_NOT_CLAIMABLE", "Attention delivery does not exist");
      const delivery = stored.delivery;
      const reclaiming =
        delivery.status === "leased" &&
        delivery.leaseExpiresAt !== null &&
        delivery.leaseExpiresAt <= now;
      if (
        !((delivery.status === "pending" && delivery.availableAt <= now) || reclaiming) ||
        state.decisionPackets.get(delivery.packetId)?.acknowledgementId !== null
      ) {
        return failure("ATTENTION_DELIVERY_NOT_CLAIMABLE", "Attention delivery is not claimable");
      }
      const fencingToken = delivery.leaseFencingToken + 1;
      return {
        ok: true,
        events: [
          {
            type: "AttentionDeliveryLeaseAcquired",
            streamType: "attention_delivery",
            streamId: delivery.deliveryId,
            data: {
              deliveryId: delivery.deliveryId,
              ownerId: command.payload.ownerId,
              fencingToken,
              leaseExpiresAt: addMilliseconds(now, command.payload.leaseDurationMs),
              deliveryAttempt: delivery.deliveryAttempts + 1
            }
          }
        ],
        resultKind: "attention_delivery",
        resultId: delivery.deliveryId
      };
    }
    case "attention-delivery.succeed": {
      const stored = state.attentionDeliveries.get(command.payload.deliveryId);
      const delivery = stored?.delivery;
      if (
        delivery?.status !== "leased" ||
        delivery.leaseOwnerId !== command.payload.ownerId ||
        delivery.leaseFencingToken !== command.payload.fencingToken ||
        delivery.leaseExpiresAt === null ||
        delivery.leaseExpiresAt <= now
      ) {
        return failure("ATTENTION_DELIVERY_LEASE_CONFLICT", "Attention delivery lease is stale");
      }
      return {
        ok: true,
        events: [
          {
            type: "AttentionDeliverySucceeded",
            streamType: "attention_delivery",
            streamId: delivery.deliveryId,
            data: { deliveryId: delivery.deliveryId, receipt: command.payload.receipt }
          }
        ],
        resultKind: "attention_delivery",
        resultId: delivery.deliveryId
      };
    }
    case "attention-delivery.fail": {
      const stored = state.attentionDeliveries.get(command.payload.deliveryId);
      const delivery = stored?.delivery;
      if (
        delivery?.status !== "leased" ||
        delivery.leaseOwnerId !== command.payload.ownerId ||
        delivery.leaseFencingToken !== command.payload.fencingToken
      ) {
        return failure("ATTENTION_DELIVERY_LEASE_CONFLICT", "Attention delivery lease is stale");
      }
      const delay = delivery.retryDelaysMs[delivery.deliveryAttempts - 1];
      const permanent = command.payload.permanent || delay === undefined;
      return {
        ok: true,
        events: [
          {
            type: "AttentionDeliveryFailed",
            streamType: "attention_delivery",
            streamId: delivery.deliveryId,
            data: {
              deliveryId: delivery.deliveryId,
              availableAt: permanent ? now : addMilliseconds(now, delay),
              permanent,
              error: command.payload.error
            }
          }
        ],
        resultKind: "attention_delivery",
        resultId: delivery.deliveryId
      };
    }
    case "issue.raise": {
      const value = command.payload;
      const program = state.programs.get(value.programId);
      if (
        !program ||
        (program.programMode !== "graph_v1" && program.programMode !== "graph_v2") ||
        !program.activeGraphRevisionId
      ) {
        return failure("PROGRAM_NOT_FOUND", "Active graph program does not exist");
      }
      if (state.routedIssues.has(value.issueId)) {
        return failure("ISSUE_NOT_FOUND", "Routed issue identifier already exists");
      }
      const graph = state.programGraphs.get(program.activeGraphRevisionId);
      if (
        !graph ||
        value.affectedMilestoneIds.some((milestoneId) => !graphMilestone(graph, milestoneId))
      ) {
        return failure("GRAPH_INVALID", "Issue scope must reference the active graph");
      }
      if (value.proposedClass === "blocker") {
        const retryAvailable = value.affectedMilestoneIds.some((milestoneId) => {
          const milestone = state.milestones.get(milestoneId);
          const job = milestone?.jobId ? state.jobs.get(milestone.jobId) : undefined;
          return job !== undefined && job.attemptCount < job.policy.maxAttempts;
        });
        if (retryAvailable) {
          return failure(
            "PROGRAM_NOT_ADVANCEABLE",
            "Blockers route only after retries are exhausted"
          );
        }
      }
      const route =
        value.proposedClass === "new_idea" ||
        (value.proposedClass === "clarification" && value.resultImpact === "none")
          ? ("record_only" as const)
          : value.proposedClass === "blocker"
            ? ("retry_exhausted" as const)
            : value.proposedClass === "authority_boundary"
              ? ("operator_required" as const)
              : ("pause_affected" as const);
      const paused = new Set<string>();
      if (route !== "record_only") {
        value.affectedMilestoneIds.forEach((milestoneId) => paused.add(milestoneId));
        if (value.proposedClass === "contradiction") {
          let changed = true;
          while (changed) {
            changed = false;
            for (const node of graph.graph.milestones) {
              if (
                node.dependencies.some((dependency) => paused.has(dependency)) &&
                !paused.has(node.contract.milestoneId)
              ) {
                paused.add(node.contract.milestoneId);
                changed = true;
              }
            }
          }
        }
      }
      const events: DomainEventInput[] = [];
      const cancelledRuns = new Set<string>();
      for (const milestoneId of paused) {
        const milestone = state.milestones.get(milestoneId);
        const run = milestone?.runId ? state.runs.get(milestone.runId) : undefined;
        const job = milestone?.jobId ? state.jobs.get(milestone.jobId) : undefined;
        if (run?.status === "running" || run?.status === "scheduled") {
          if (job && !TERMINAL_JOBS.has(job.status)) {
            events.push(...cancellationEvents(state, job, "operator_cancelled", new Set()));
          }
          if (!cancelledRuns.has(run.runId)) {
            cancelledRuns.add(run.runId);
            events.push({
              type: "RunCancelled",
              streamType: "run",
              streamId: run.runId,
              data: { runId: run.runId, reason: `routed_issue:${value.issueId}` }
            });
          }
        }
      }
      const issue = {
        schemaVersion: 1 as const,
        issueId: value.issueId,
        programId: value.programId,
        originalText: value.originalText,
        proposedClass: value.proposedClass,
        resultImpact: value.resultImpact,
        affectedMilestoneIds: value.affectedMilestoneIds,
        refs: value.refs,
        requiredAuthority: "operator" as const,
        route,
        source: value.source ?? ({ kind: "command" } as const),
        status: "open" as const,
        resolution: null,
        raisedAt: now
      };
      events.push({
        type: "RoutedIssueRaised",
        streamType: "routed_issue",
        streamId: value.issueId,
        data: { issue, issueDigest: canonicalDigest(issue), pausedMilestoneIds: [...paused].sort() }
      });
      return {
        ok: true,
        events,
        resultKind: "routed_issue",
        resultId: value.issueId
      };
    }
    case "issue.resolve": {
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Issue resolution requires an operator actor");
      }
      const event = issueResolutionEvent(
        state,
        command.payload.issueId,
        null,
        command.payload.action,
        command.payload.text,
        command.actor.id
      );
      if ("ok" in event) return event;
      return {
        ok: true,
        events: [event],
        resultKind: "routed_issue",
        resultId: command.payload.issueId
      };
    }
    case "attention.start": {
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Attention spans require an operator actor");
      }
      const program = state.programs.get(command.payload.programId);
      if (!program) return failure("PROGRAM_NOT_FOUND", "Program does not exist");
      if (state.attentionSpans.has(command.payload.attentionSpanId)) {
        return failure("ATTENTION_SPAN_NOT_FOUND", "Attention span identifier already exists");
      }
      if (
        [...state.attentionSpans.values()].some(
          (span) =>
            span.programId === command.payload.programId &&
            span.actorId === command.actor.id &&
            span.stoppedAt === null
        )
      ) {
        return failure("MEASUREMENT_NOT_READY", "Actor already has an open attention span");
      }
      const span = {
        schemaVersion: 1 as const,
        attentionSpanId: command.payload.attentionSpanId,
        programId: command.payload.programId,
        actorId: command.actor.id,
        label: command.payload.label,
        startedAt: now,
        stoppedAt: null
      };
      return {
        ok: true,
        events: [
          {
            type: "AttentionSpanStarted",
            streamType: "attention_span",
            streamId: span.attentionSpanId,
            data: { span }
          }
        ],
        resultKind: "attention_span",
        resultId: span.attentionSpanId
      };
    }
    case "attention.stop": {
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Attention spans require an operator actor");
      }
      const span = state.attentionSpans.get(command.payload.attentionSpanId);
      if (span?.stoppedAt !== null || span.actorId !== command.actor.id) {
        return failure("ATTENTION_SPAN_NOT_FOUND", "Open attention span does not exist");
      }
      return {
        ok: true,
        events: [
          {
            type: "AttentionSpanStopped",
            streamType: "attention_span",
            streamId: span.attentionSpanId,
            data: {
              attentionSpanId: span.attentionSpanId,
              programId: span.programId,
              stoppedAt: now
            }
          }
        ],
        resultKind: "attention_span",
        resultId: span.attentionSpanId
      };
    }
    case "outcome-packet.disposition": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Outcome disposition requires an operator actor"
        );
      }
      if (state.outcomeDispositions.has(command.payload.outcomePacketId)) {
        return failure("PROGRAM_NOT_ADVANCEABLE", "Outcome packet already has a disposition");
      }
      const event = outcomeDispositionEvent(
        state,
        command.payload.outcomePacketId,
        null,
        command.payload.disposition,
        command.payload.reason,
        command.actor.id,
        now
      );
      if ("ok" in event) return event;
      return {
        ok: true,
        events: [event],
        resultKind: "outcome_disposition",
        resultId: command.payload.outcomePacketId
      };
    }
    case "measurement-report.compile": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Measurement report requires an operator actor"
        );
      }
      const value = command.payload;
      const program = state.programs.get(value.programId);
      if (program?.programMode !== "graph_v1") {
        return failure("PROGRAM_NOT_FOUND", "Graph program does not exist");
      }
      if (value.expectedThroughPosition !== state.lastAppliedPosition) {
        return failure("MEASUREMENT_NOT_READY", "Measurement cutoff is stale", {
          expectedThroughPosition: state.lastAppliedPosition
        });
      }
      if (state.measurementReports.has(value.reportId)) {
        return failure("MEASUREMENT_NOT_READY", "Measurement report identifier already exists");
      }
      const graph = program.activeGraphRevisionId
        ? state.programGraphs.get(program.activeGraphRevisionId)
        : undefined;
      if (!graph) return failure("GRAPH_NOT_FOUND", "Active graph is missing");
      const spans = [...state.attentionSpans.values()].filter(
        (span) => span.programId === value.programId
      );
      const closedSpans = spans.filter((span) => span.stoppedAt !== null);
      const attentionComplete = spans.length > 0 && closedSpans.length === spans.length;
      const attentionMilliseconds = closedSpans.reduce(
        (total, span) =>
          total +
          new Date(span.stoppedAt ?? span.startedAt).getTime() -
          new Date(span.startedAt).getTime(),
        0
      );
      const generations = [...state.milestoneGenerations.values()].filter(
        (generation) => generation.programId === value.programId
      );
      const generationLatency = generations.map((generation) => ({
        generationId: generation.generationId,
        milliseconds:
          new Date(generation.completedAt ?? now).getTime() -
          new Date(generation.startedAt).getTime()
      }));
      const programRunIds = new Set(generations.map((generation) => generation.runId));
      const receipts = [...state.driverReceipts.values()].filter((receipt) =>
        programRunIds.has(receipt.runId)
      );
      const resourcesComplete = receipts.length > 0;
      const knownCosts = receipts.flatMap((receipt) =>
        receipt.receipt.schemaVersion === 2 && receipt.receipt.usage.monetaryCost.status === "known"
          ? [{ driverReceiptId: receipt.driverReceiptId, ...receipt.receipt.usage.monetaryCost }]
          : []
      );
      const costCurrencies = new Set(knownCosts.map((cost) => cost.currency));
      const costSources = new Set(knownCosts.map((cost) => cost.pricingSource));
      const costVersions = new Set(knownCosts.map((cost) => cost.pricingVersion));
      const costComplete =
        receipts.length > 0 &&
        knownCosts.length === receipts.length &&
        costCurrencies.size === 1 &&
        costSources.size === 1 &&
        costVersions.size === 1;
      const costUnavailableReasons = receipts.flatMap((receipt) => {
        if (receipt.receipt.schemaVersion === 1) return ["driver_protocol_v1_has_no_cost"];
        const cost = receipt.receipt.usage.monetaryCost;
        return cost.status === "unavailable" ? [cost.reason] : [];
      });
      if (knownCosts.length > 0 && costCurrencies.size > 1) {
        costUnavailableReasons.push("mixed_currency");
      }
      if (knownCosts.length > 0 && (costSources.size > 1 || costVersions.size > 1)) {
        costUnavailableReasons.push("incompatible_pricing_basis");
      }
      const selectedPackets = graph.graph.milestones.flatMap((node) => {
        const packetId = state.milestones.get(
          node.contract.milestoneId
        )?.latestValidatedOutcomePacketId;
        const packet = packetId ? state.outcomePackets.get(packetId) : undefined;
        return packet ? [packet] : [];
      });
      const dispositions = selectedPackets.flatMap((packet) => {
        const disposition = state.outcomeDispositions.get(packet.outcomePacketId);
        return disposition ? [disposition] : [];
      });
      const blockingIssueOpen = [...state.routedIssues.values()].some(
        (issue) =>
          issue.issue.programId === value.programId &&
          issue.issue.status !== "resolved" &&
          issue.issue.route !== "record_only"
      );
      const windowComplete =
        program.phase === "completed" &&
        !blockingIssueOpen &&
        !activeGenerationForProgram(state, value.programId) &&
        selectedPackets.length === graph.graph.milestones.length &&
        dispositions.length === selectedPackets.length;
      const passedCriteria = selectedPackets.reduce(
        (count, packet) =>
          count +
          packet.packet.criteriaResults.filter((criterion) => criterion.result === "pass").length,
        0
      );
      const totalCriteria = selectedPackets.reduce(
        (count, packet) => count + packet.packet.criteriaResults.length,
        0
      );
      const report = {
        schemaVersion: 1 as const,
        reportId: value.reportId,
        programId: value.programId,
        observationWindow: {
          status: windowComplete ? ("complete" as const) : ("open" as const),
          startedAt: program.startedAt ?? program.createdAt,
          throughAt: now,
          throughPosition: state.lastAppliedPosition
        },
        activeHumanTime: attentionComplete
          ? {
              status: "available" as const,
              milliseconds: attentionMilliseconds,
              closedSpanCount: closedSpans.length
            }
          : {
              status: "unavailable" as const,
              reason: spans.length === 0 ? "no_attention_spans" : "attention_span_open"
            },
        latency: {
          status: windowComplete ? ("complete" as const) : ("partial" as const),
          programMilliseconds:
            new Date(now).getTime() - new Date(program.startedAt ?? program.createdAt).getTime(),
          generationMilliseconds: generationLatency
        },
        resources: resourcesComplete
          ? {
              status: "available" as const,
              cpuMillis: receipts.reduce(
                (sum, receipt) => sum + receipt.receipt.usage.cpuMillis,
                0
              ),
              memoryPeakBytes: Math.max(
                ...receipts.map((receipt) => receipt.receipt.usage.memoryPeakBytes)
              ),
              receiptCount: receipts.length
            }
          : { status: "unavailable" as const, reason: "no_driver_receipts" },
        monetaryCost: costComplete
          ? {
              status: "available" as const,
              amount: sumDecimalStrings(knownCosts.map((cost) => cost.amount)),
              currency: knownCosts[0]?.currency ?? "USD",
              pricingSources: [...costSources].sort(),
              pricingVersions: [...costVersions].sort()
            }
          : {
              status: "unavailable" as const,
              reason: "cost_incomplete_or_mixed_currency",
              knownLineItems: knownCosts.map((cost) => ({
                driverReceiptId: cost.driverReceiptId,
                amount: cost.amount,
                currency: cost.currency,
                pricingSource: cost.pricingSource,
                pricingVersion: cost.pricingVersion
              })),
              reasons: [
                ...new Set(
                  costUnavailableReasons.length > 0 ? costUnavailableReasons : ["no_cost_receipts"]
                )
              ].sort()
            },
        clarificationCount: [...state.routedIssues.values()].filter(
          (issue) =>
            issue.issue.programId === value.programId &&
            issue.issue.proposedClass === "clarification"
        ).length,
        reworkCount:
          generations.reduce((sum, generation) => sum + (generation.generation > 1 ? 1 : 0), 0) +
          [...state.programGraphs.values()].filter(
            (candidate) =>
              candidate.programId === value.programId && candidate.supersededAt !== null
          ).length,
        quality: {
          passedCriteria,
          totalCriteria,
          acceptedOutcomes: dispositions.filter(
            (disposition) => disposition.disposition.disposition === "accepted"
          ).length,
          rejectedOutcomes: dispositions.filter(
            (disposition) => disposition.disposition.disposition === "rejected"
          ).length,
          undisposedOutcomes: selectedPackets.length - dispositions.length
        },
        completeness: {
          attention: attentionComplete,
          resources: resourcesComplete,
          cost: costComplete,
          quality:
            selectedPackets.length === graph.graph.milestones.length &&
            dispositions.length === selectedPackets.length,
          window: windowComplete
        },
        compiledAt: now
      };
      return {
        ok: true,
        events: [
          {
            type: "MeasurementReportCompiled",
            streamType: "measurement_report",
            streamId: value.reportId,
            data: { report, reportDigest: canonicalDigest(report) }
          }
        ],
        resultKind: "measurement_report",
        resultId: value.reportId
      };
    }
    case "program.approve": {
      const { program, milestone } = command.payload;
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Program approval requires an operator actor");
      }
      if (state.programs.has(program.programId)) {
        return failure("PROGRAM_ALREADY_EXISTS", "Program already exists", {
          programId: program.programId
        });
      }
      if (state.milestones.has(milestone.milestoneId)) {
        return failure("MILESTONE_ALREADY_EXISTS", "Milestone already exists", {
          milestoneId: milestone.milestoneId
        });
      }
      const workflow = state.workflows.get(
        workflowKey(milestone.workflowId, milestone.workflowVersion)
      );
      if (!workflow) {
        return failure("WORKFLOW_NOT_FOUND", "Workflow version does not exist", {
          workflowId: milestone.workflowId,
          workflowVersion: milestone.workflowVersion
        });
      }
      if (!("schemaVersion" in workflow.definition)) {
        return failure(
          "WORKFLOW_NOT_FOUND",
          "Approved milestones require a Workflow V2 definition",
          {
            workflowId: milestone.workflowId,
            workflowVersion: milestone.workflowVersion
          }
        );
      }
      const [step] = workflow.definition.steps;
      if (!step || workflow.definition.steps.length !== 1 || step.dependsOn.length !== 0) {
        return failure(
          "SCHEDULE_MISMATCH",
          "Approved milestones require exactly one independent workflow step",
          { workflowId: workflow.workflowId, workflowVersion: workflow.version }
        );
      }
      if (milestone.criteria.some((criterion) => criterion.verificationStepId !== step.id)) {
        return failure(
          "SCHEDULE_MISMATCH",
          "Every milestone criterion must bind to the workflow verification step",
          { milestoneId: milestone.milestoneId }
        );
      }
      const intentDigest = canonicalDigest(program.intent);
      const contractDigest = canonicalDigest(milestone);
      return {
        ok: true,
        events: [
          {
            type: "ProgramCreated",
            streamType: "program",
            streamId: program.programId,
            data: { programId: program.programId, name: program.name }
          },
          {
            type: "ProgramApproved",
            streamType: "program",
            streamId: program.programId,
            data: {
              programId: program.programId,
              intent: program.intent,
              intentDigest,
              approvedBy: command.actor.id
            }
          },
          {
            type: "MilestoneApproved",
            streamType: "milestone",
            streamId: milestone.milestoneId,
            data: {
              milestoneId: milestone.milestoneId,
              programId: program.programId,
              contract: milestone,
              contractDigest,
              workflowDigest: workflow.definitionDigest,
              approvedBy: command.actor.id
            }
          }
        ],
        resultKind: "milestone",
        resultId: milestone.milestoneId
      };
    }
    case "workflow.register": {
      const definition = command.payload;
      const existingVersions = [...state.workflows.values()]
        .filter((workflow) => workflow.workflowId === definition.workflowId)
        .map((workflow) => workflow.version);
      const expectedVersion = existingVersions.length === 0 ? 1 : Math.max(...existingVersions) + 1;
      if (definition.version !== expectedVersion) {
        return failure(
          "WORKFLOW_VERSION_CONFLICT",
          "Workflow versions must be registered sequentially",
          {
            workflowId: definition.workflowId,
            expectedVersion,
            receivedVersion: definition.version
          }
        );
      }
      return {
        ok: true,
        events: [
          {
            type: "WorkflowDefinitionRegistered",
            streamType: "workflow",
            streamId: definition.workflowId,
            data: { definition, definitionDigest: canonicalDigest(definition) }
          }
        ],
        resultKind: "workflow",
        resultId: workflowKey(definition.workflowId, definition.version)
      };
    }
    case "run.create": {
      const { runId, programId, workflowId, workflowVersion } = command.payload;
      if (state.runs.has(runId))
        return failure("RUN_ALREADY_EXISTS", "Run already exists", { runId });
      if (!state.programs.has(programId)) {
        return failure("PROGRAM_NOT_FOUND", "Program does not exist", { programId });
      }
      if (!state.workflows.has(workflowKey(workflowId, workflowVersion))) {
        return failure("WORKFLOW_NOT_FOUND", "Workflow version does not exist", {
          workflowId,
          workflowVersion
        });
      }
      return {
        ok: true,
        events: [
          {
            type: "RunCreated",
            streamType: "run",
            streamId: runId,
            data: { runId, programId, workflowId, workflowVersion }
          }
        ],
        resultKind: "run",
        resultId: runId
      };
    }
    case "milestone.start": {
      const value = command.payload;
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Milestone start requires an operator actor");
      }
      const milestone = state.milestones.get(value.milestoneId);
      if (!milestone) {
        return failure("MILESTONE_NOT_FOUND", "Milestone does not exist", {
          milestoneId: value.milestoneId
        });
      }
      if (milestone.graphRevisionId !== null) {
        return failure(
          "MILESTONE_NOT_STARTABLE",
          "program graph milestones start only through the program coordinator",
          { milestoneId: milestone.milestoneId }
        );
      }
      if (milestone.status !== "approved" || milestone.runId !== null) {
        return failure("MILESTONE_NOT_STARTABLE", "Milestone has already started", {
          milestoneId: milestone.milestoneId
        });
      }
      if (state.runs.has(value.runId)) {
        return failure("RUN_ALREADY_EXISTS", "Run already exists", { runId: value.runId });
      }
      if (state.jobs.has(value.jobId)) {
        return failure("SCHEDULE_MISMATCH", "Job already exists", { jobId: value.jobId });
      }
      if (!state.sourceRevisions.has(value.sourceRevisionId)) {
        return failure("SOURCE_REVISION_NOT_FOUND", "Source revision does not exist", {
          revisionId: value.sourceRevisionId
        });
      }
      const workflow = state.workflows.get(
        workflowKey(milestone.contract.workflowId, milestone.contract.workflowVersion)
      );
      if (
        workflow?.definitionDigest !== milestone.workflowDigest ||
        !("schemaVersion" in workflow.definition) ||
        workflow.definition.steps.length !== 1
      ) {
        return failure("WORKFLOW_NOT_FOUND", "Approved workflow contract is unavailable", {
          milestoneId: milestone.milestoneId
        });
      }
      const step = workflow.definition.steps[0];
      if (!step) throw new Error("Validated one-step workflow is empty");
      if (step.verification.timeoutMs > value.policy.attemptTimeoutMs) {
        return failure(
          "VERIFICATION_REQUIRED",
          "Verifier timeout must fit within the attempt timeout",
          { jobId: value.jobId }
        );
      }
      return {
        ok: true,
        events: [
          {
            type: "MilestoneStarted",
            streamType: "milestone",
            streamId: milestone.milestoneId,
            data: {
              milestoneId: milestone.milestoneId,
              runId: value.runId,
              jobId: value.jobId,
              baseRevisionId: value.sourceRevisionId
            }
          },
          {
            type: "MilestoneRunCreated",
            streamType: "run",
            streamId: value.runId,
            data: {
              runId: value.runId,
              milestoneId: milestone.milestoneId,
              programId: milestone.programId,
              workflowId: workflow.workflowId,
              workflowVersion: workflow.version
            }
          },
          {
            type: "JobScheduled",
            streamType: "job",
            streamId: value.jobId,
            data: {
              jobId: value.jobId,
              runId: value.runId,
              stepId: step.id,
              capability: step.capability,
              dependencyJobIds: [],
              initialStatus: "ready",
              policy: value.policy,
              sourceRevisionId: value.sourceRevisionId,
              executionContract: step.execution,
              executionContractDigest: canonicalDigest(step.execution),
              capabilityManifest: step.capabilities,
              capabilityManifestDigest: canonicalDigest(step.capabilities),
              verifierContract: step.verification,
              verifierContractDigest: canonicalDigest(step.verification)
            }
          },
          {
            type: "RunScheduled",
            streamType: "run",
            streamId: value.runId,
            data: { runId: value.runId }
          }
        ],
        resultKind: "run",
        resultId: value.runId
      };
    }
    case "run.schedule": {
      const run = state.runs.get(command.payload.runId);
      if (!run)
        return failure("RUN_NOT_FOUND", "Run does not exist", { runId: command.payload.runId });
      if (run.status !== "created") {
        return failure(
          run.status === "scheduled" || run.status === "running"
            ? "RUN_ALREADY_SCHEDULED"
            : "RUN_NOT_SCHEDULABLE",
          "Run cannot be scheduled from its current state",
          { runId: run.runId }
        );
      }
      if (
        [...state.attempts.values()].some(
          (attempt) =>
            attempt.runId === run.runId && attempt.jobId === null && attempt.status === "allocated"
        )
      ) {
        return failure("LEGACY_ACTIVE_ATTEMPT", "Run has an active legacy attempt", {
          runId: run.runId
        });
      }
      const workflow = state.workflows.get(workflowKey(run.workflowId, run.workflowVersion));
      if (!workflow) return failure("WORKFLOW_NOT_FOUND", "Workflow version does not exist");
      if (workflow.definition.steps.some((step) => step.verification === undefined)) {
        return failure(
          "VERIFICATION_REQUIRED",
          "Fresh schedules require verification-enabled workflow steps",
          { runId: run.runId }
        );
      }
      const jobIds = new Set(command.payload.jobs.map((job) => job.jobId));
      const stepIds = new Set(command.payload.jobs.map((job) => job.stepId));
      const expectedSteps = new Set(workflow.definition.steps.map((step) => step.id));
      if (
        jobIds.size !== command.payload.jobs.length ||
        stepIds.size !== command.payload.jobs.length ||
        stepIds.size !== expectedSteps.size ||
        [...expectedSteps].some((stepId) => !stepIds.has(stepId)) ||
        [...jobIds].some((jobId) => state.jobs.has(jobId))
      ) {
        return failure(
          "SCHEDULE_MISMATCH",
          "Schedule must contain one unique job for every workflow step",
          {
            runId: run.runId
          }
        );
      }
      const byStep = new Map(command.payload.jobs.map((job) => [job.stepId, job]));
      for (const step of workflow.definition.steps) {
        const job = byStep.get(step.id);
        if (!job?.sourceRevisionId) {
          return failure(
            "VERIFICATION_REQUIRED",
            "Every scheduled job requires a source revision",
            {
              runId: run.runId
            }
          );
        }
        if (!state.sourceRevisions.has(job.sourceRevisionId)) {
          return failure("SOURCE_REVISION_NOT_FOUND", "Scheduled source revision does not exist", {
            revisionId: job.sourceRevisionId
          });
        }
        if (!step.verification || step.verification.timeoutMs > job.policy.attemptTimeoutMs) {
          return failure(
            "VERIFICATION_REQUIRED",
            "Verifier timeout must fit within the attempt timeout",
            { jobId: job.jobId }
          );
        }
      }
      const events: DomainEventInput[] = workflow.definition.steps.map((step) => {
        const job = byStep.get(step.id);
        if (!job) throw new Error(`Missing validated job for ${step.id}`);
        const execution = "execution" in step ? step.execution : undefined;
        const capabilities = "capabilities" in step ? step.capabilities : undefined;
        return {
          type: "JobScheduled",
          streamType: "job",
          streamId: job.jobId,
          data: {
            jobId: job.jobId,
            runId: run.runId,
            stepId: step.id,
            capability: step.capability,
            dependencyJobIds: step.dependsOn.map((dependency) => {
              const dependencyJob = byStep.get(dependency);
              if (!dependencyJob) throw new Error(`Missing dependency job for ${dependency}`);
              return dependencyJob.jobId;
            }),
            initialStatus: step.dependsOn.length === 0 ? "ready" : "blocked",
            policy: job.policy,
            sourceRevisionId: job.sourceRevisionId,
            ...(execution
              ? {
                  executionContract: execution,
                  executionContractDigest: canonicalDigest(execution)
                }
              : {}),
            ...(capabilities
              ? {
                  capabilityManifest: capabilities,
                  capabilityManifestDigest: canonicalDigest(capabilities)
                }
              : {}),
            verifierContract: step.verification,
            verifierContractDigest: canonicalDigest(step.verification)
          }
        };
      });
      events.push({
        type: "RunScheduled",
        streamType: "run",
        streamId: run.runId,
        data: { runId: run.runId }
      });
      return { ok: true, events, resultKind: "run", resultId: run.runId };
    }
    case "attempt.allocate":
    case "attempt.cancel":
      return failure("COMMAND_RETIRED", "Manual attempt commands were retired in legacy");
    case "run.cancel": {
      const events = cancellationForRun(state, command.payload.runId, command.payload.reason);
      if (!Array.isArray(events)) return events;
      return { ok: true, events, resultKind: "run", resultId: command.payload.runId };
    }
    case "job.lease.acquire": {
      const job = state.jobs.get(command.payload.jobId);
      if (!job)
        return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: command.payload.jobId });
      const run = state.runs.get(job.runId);
      if (!run || TERMINAL_RUNS.has(run.status)) {
        return failure("JOB_NOT_CLAIMABLE", "Job belongs to a terminal or missing run", {
          jobId: job.jobId
        });
      }
      const resuming = job.status === "active" && Boolean(job.activeAttemptId);
      if (resuming) {
        if (job.leaseExpiresAt && !atOrBefore(job.leaseExpiresAt, now)) {
          return failure("JOB_LEASE_CONFLICT", "Job already has an active lease", {
            jobId: job.jobId
          });
        }
      } else if (!(
        (job.status === "ready" || job.status === "retry_wait") &&
        atOrBefore(job.availableAt, now) &&
        job.activeAttemptId === null
      )) {
        return failure("JOB_NOT_CLAIMABLE", "Job is not ready to be claimed", { jobId: job.jobId });
      }
      if (
        !resuming &&
        (state.attempts.has(command.payload.attemptId) ||
          state.outbox.has(command.payload.startOutboxId))
      ) {
        return failure("JOB_NOT_CLAIMABLE", "Attempt or outbox identifier already exists", {
          jobId: job.jobId
        });
      }
      const contextPacket = job.contextPacketId
        ? state.contextPackets.get(job.contextPacketId)
        : undefined;
      if (
        job.executionContract?.protocolVersion === 2 &&
        (!contextPacket ||
          contextPacket.packetDigest !== job.contextPacketDigest ||
          canonicalDigest(contextPacket.packet) !== contextPacket.packetDigest)
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Job context packet is missing or invalid", {
          jobId: job.jobId
        });
      }
      const fencingToken = job.leaseFencingToken + 1;
      const events: DomainEventInput[] = [];
      if (run.status === "scheduled") {
        events.push({
          type: "RunStarted",
          streamType: "run",
          streamId: run.runId,
          data: { runId: run.runId }
        });
      }
      events.push({
        type: "JobLeaseAcquired",
        streamType: "job",
        streamId: job.jobId,
        data: {
          jobId: job.jobId,
          runId: job.runId,
          ownerId: command.payload.ownerId,
          fencingToken,
          leaseExpiresAt: addMilliseconds(now, command.payload.leaseDurationMs),
          resumed: resuming
        }
      });
      if (!resuming) {
        const ordinal = job.attemptCount + 1;
        events.push({
          type: "AttemptStarted",
          streamType: "attempt",
          streamId: command.payload.attemptId,
          data: {
            attemptId: command.payload.attemptId,
            jobId: job.jobId,
            runId: job.runId,
            ordinal,
            deadlineAt: addMilliseconds(now, job.policy.attemptTimeoutMs)
          }
        });
        const attempt: AttemptState = {
          kind: "attempt",
          attemptId: command.payload.attemptId,
          jobId: job.jobId,
          runId: job.runId,
          ordinal,
          status: "starting",
          allocatedAt: now,
          startedAt: now,
          deadlineAt: addMilliseconds(now, job.policy.attemptTimeoutMs),
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
        };
        events.push(
          outboxEnqueued(command.payload.startOutboxId, job, attempt, {
            effectType: "agent.start",
            driver: job.executionContract ? "generic-command" : "fake",
            capability: job.capability,
            attemptId: attempt.attemptId,
            attemptStartedAt: attempt.startedAt ?? now,
            jobId: job.jobId,
            runId: job.runId,
            ...(job.sourceRevisionId ? { baseRevisionId: job.sourceRevisionId } : {}),
            ...(job.executionContract ? { executionContract: job.executionContract } : {}),
            ...(job.executionContractDigest
              ? { executionContractDigest: job.executionContractDigest }
              : {}),
            ...(job.capabilityManifest ? { capabilityManifest: job.capabilityManifest } : {}),
            ...(job.capabilityManifestDigest
              ? { capabilityManifestDigest: job.capabilityManifestDigest }
              : {}),
            ...(contextPacket ? { contextPacket: contextPacket.packet } : {}),
            ...(contextPacket ? { contextPacketDigest: contextPacket.packetDigest } : {})
          })
        );
      }
      return { ok: true, events, resultKind: "job", resultId: job.jobId };
    }
    case "job.lease.renew": {
      const job = state.jobs.get(command.payload.jobId);
      if (!job)
        return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: command.payload.jobId });
      const invalid = validateJobLease(
        job,
        command.payload.ownerId,
        command.payload.fencingToken,
        now
      );
      if (invalid) return invalid;
      return {
        ok: true,
        events: [
          {
            type: "JobLeaseRenewed",
            streamType: "job",
            streamId: job.jobId,
            data: {
              jobId: job.jobId,
              runId: job.runId,
              ownerId: command.payload.ownerId,
              fencingToken: command.payload.fencingToken,
              leaseExpiresAt: addMilliseconds(now, command.payload.leaseDurationMs)
            }
          }
        ],
        resultKind: "job",
        resultId: job.jobId
      };
    }
    case "job.lease.release": {
      const job = state.jobs.get(command.payload.jobId);
      if (!job)
        return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: command.payload.jobId });
      const invalid = validateJobLease(
        job,
        command.payload.ownerId,
        command.payload.fencingToken,
        now
      );
      if (invalid) return invalid;
      return {
        ok: true,
        events: [
          {
            type: "JobLeaseReleased",
            streamType: "job",
            streamId: job.jobId,
            data: {
              jobId: job.jobId,
              runId: job.runId,
              ownerId: command.payload.ownerId,
              fencingToken: command.payload.fencingToken
            }
          }
        ],
        resultKind: "job",
        resultId: job.jobId
      };
    }
    case "attempt.driver-events.observe": {
      const job = state.jobs.get(command.payload.jobId);
      if (!job)
        return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: command.payload.jobId });
      const invalid = validateJobLease(
        job,
        command.payload.ownerId,
        command.payload.fencingToken,
        now
      );
      if (invalid) return invalid;
      const attempt = state.attempts.get(command.payload.attemptId);
      if (!attempt) {
        return failure("ATTEMPT_NOT_FOUND", "Attempt does not exist", {
          attemptId: command.payload.attemptId
        });
      }
      if (job.activeAttemptId !== attempt.attemptId || attempt.status !== "running") {
        return failure("ATTEMPT_NOT_ACTIVE", "Attempt is not active in the driver", {
          attemptId: attempt.attemptId
        });
      }
      if (command.payload.afterSequence !== attempt.driverCursor) {
        return failure("ATTEMPT_NOT_ACTIVE", "Driver event cursor does not match", {
          attemptId: attempt.attemptId,
          expectedCursor: attempt.driverCursor
        });
      }
      let expected = attempt.driverCursor + 1;
      let terminalCount = 0;
      let cpuMillis = attempt.cumulativeUsage?.cpuMillis ?? 0;
      let memoryPeakBytes = attempt.cumulativeUsage?.memoryPeakBytes ?? 0;
      const events: DomainEventInput[] = [];
      const routedEventKeys = new Set<string>();
      for (const observed of command.payload.events) {
        if (observed.sequence !== expected) {
          return failure("EVIDENCE_DIGEST_MISMATCH", "Driver event sequence is not contiguous", {
            attemptId: attempt.attemptId,
            expectedSequence: expected
          });
        }
        expected += 1;
        if (observed.type === "terminal") terminalCount += 1;
        if (observed.type === "usage") {
          cpuMillis = Math.max(cpuMillis, observed.cpuMillis);
          memoryPeakBytes = Math.max(memoryPeakBytes, observed.memoryPeakBytes);
        }
        if (observed.type === "approval.requested") {
          events.push({
            type: "ApprovalRequestRecorded",
            streamType: "approval_request",
            streamId: observed.requestId,
            data: {
              approvalRequestId: observed.requestId,
              runId: job.runId,
              jobId: job.jobId,
              attemptId: attempt.attemptId,
              capability: observed.capability,
              reason: observed.reason,
              sequence: observed.sequence
            }
          });
        }
        if (observed.type === "issue.raised") {
          if (observed.proposedClass === "blocker" && job.attemptCount < job.policy.maxAttempts) {
            continue;
          }
          const run = state.runs.get(job.runId);
          if (!run) {
            return failure("RUN_NOT_FOUND", "Run does not exist", { runId: job.runId });
          }
          if (!run.milestoneId) {
            return failure("MILESTONE_NOT_FOUND", "Graph run is missing its milestone binding", {
              runId: run.runId
            });
          }
          const milestone = state.milestones.get(run.milestoneId);
          const contextPacket = job.contextPacketId
            ? state.contextPackets.get(job.contextPacketId)
            : undefined;
          const refs = [
            ...(contextPacket
              ? [
                  {
                    kind: "context_packet" as const,
                    id: contextPacket.contextPacketId,
                    digest: contextPacket.packetDigest
                  }
                ]
              : []),
            ...(milestone?.contractDigest
              ? [
                  {
                    kind: "milestone_contract" as const,
                    id: milestone.milestoneId,
                    digest: milestone.contractDigest
                  }
                ]
              : [])
          ];
          const issueId = deterministicUuid(
            `driver-issue:${attempt.attemptId}:${String(observed.sequence)}`
          );
          const routed = decide(
            state,
            {
              idempotencyKey: `driver-issue:${issueId}`,
              type: "issue.raise",
              actor: { kind: "system", id: "driver-protocol" },
              payload: {
                schemaVersion: 1,
                issueId,
                programId: run.programId,
                originalText: observed.originalText,
                proposedClass: observed.proposedClass,
                resultImpact: observed.resultImpact,
                affectedMilestoneIds: observed.affectedMilestoneIds,
                refs,
                source: {
                  kind: "driver_event",
                  attemptId: attempt.attemptId,
                  sequence: observed.sequence
                }
              }
            },
            context
          );
          if (!routed.ok) return routed;
          for (const event of routed.events) {
            const key = `${event.type}:${event.streamType}:${event.streamId}:${canonicalDigest(event.data)}`;
            if (!routedEventKeys.has(key)) {
              routedEventKeys.add(key);
              events.push(event);
            }
          }
        }
      }
      if (terminalCount > 1) {
        return failure(
          "EVIDENCE_DIGEST_MISMATCH",
          "Driver batch contains multiple terminal events",
          {
            attemptId: attempt.attemptId
          }
        );
      }
      const terminalIndex = command.payload.events.findIndex((event) => event.type === "terminal");
      if (terminalIndex >= 0 && terminalIndex !== command.payload.events.length - 1) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Driver terminal event must be final", {
          attemptId: attempt.attemptId
        });
      }
      events.unshift({
        type: "DriverEventsObserved",
        streamType: "attempt",
        streamId: attempt.attemptId,
        data: {
          attemptId: attempt.attemptId,
          jobId: job.jobId,
          runId: job.runId,
          afterSequence: command.payload.afterSequence,
          cursor: expected - 1,
          events: command.payload.events,
          cumulativeUsage: { cpuMillis, memoryPeakBytes }
        }
      });
      return {
        ok: true,
        events,
        resultKind: "attempt",
        resultId: attempt.attemptId
      };
    }
    case "driver.receipt.record": {
      const payload = command.payload;
      const job = state.jobs.get(payload.jobId);
      if (!job) return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: payload.jobId });
      const invalid = validateJobLease(job, payload.ownerId, payload.fencingToken, now);
      if (invalid) return invalid;
      const attempt = state.attempts.get(payload.attemptId);
      if (!attempt) {
        return failure("ATTEMPT_NOT_FOUND", "Attempt does not exist", {
          attemptId: payload.attemptId
        });
      }
      if (
        job.activeAttemptId !== attempt.attemptId ||
        attempt.status !== "running" ||
        !attempt.externalRunId
      ) {
        return failure("ATTEMPT_NOT_ACTIVE", "Attempt is not active in the driver", {
          attemptId: attempt.attemptId
        });
      }
      const receipt = payload.receipt;
      if (
        receipt.receiptDigest !== driverReceiptDigest(receipt) ||
        (receipt.schemaVersion === 1
          ? receipt.driver !== "generic-command"
          : (receipt.driver !== "generic-command" &&
              receipt.driver !== "trusted-cost-adapter-v1") ||
            (receipt.driver === "generic-command" &&
              receipt.usage.monetaryCost.status !== "unavailable")) ||
        receipt.runId !== job.runId ||
        receipt.jobId !== job.jobId ||
        receipt.attemptId !== attempt.attemptId ||
        receipt.externalRunId !== attempt.externalRunId ||
        receipt.baseRevisionId !== job.sourceRevisionId ||
        receipt.baseRevisionDigest !==
          state.sourceRevisions.get(receipt.baseRevisionId)?.revisionDigest ||
        receipt.executionContractDigest !== job.executionContractDigest ||
        receipt.capabilityManifestDigest !== job.capabilityManifestDigest ||
        (receipt.schemaVersion === 2
          ? receipt.contextPacketId !== job.contextPacketId ||
            receipt.contextPacketDigest !== job.contextPacketDigest ||
            job.executionContract?.protocolVersion !== 2 ||
            job.capabilityManifest?.schemaVersion !== 2
          : job.contextPacketId != null ||
            job.contextPacketDigest != null ||
            job.executionContract?.protocolVersion === 2 ||
            job.capabilityManifest?.schemaVersion === 2) ||
        receipt.image !== job.executionContract?.image ||
        receipt.eventCount !== attempt.driverCursor
      ) {
        return failure(
          "EVIDENCE_DIGEST_MISMATCH",
          "Driver receipt identity does not match the attempt",
          {
            attemptId: attempt.attemptId
          }
        );
      }
      if (state.driverReceipts.has(payload.driverReceiptId)) {
        return failure("ARTIFACT_MANIFEST_CONFLICT", "Driver receipt already exists", {
          driverReceiptId: payload.driverReceiptId
        });
      }
      const entries = canonicalArtifactEntries(payload.entries);
      if (
        canonicalDigest(entries) !== canonicalDigest(canonicalArtifactEntries(receipt.artifacts))
      ) {
        return failure(
          "EVIDENCE_DIGEST_MISMATCH",
          "Driver artifact receipt does not match entries",
          {
            attemptId: attempt.attemptId
          }
        );
      }
      const sourceRevisionId = receipt.candidateRevisionId ?? receipt.baseRevisionId;
      const events: DomainEventInput[] = [];
      if (payload.candidateRevision) {
        if (
          payload.candidateRevision.revisionId !== receipt.candidateRevisionId ||
          payload.candidateRevision.revisionDigest !== receipt.candidateRevisionDigest ||
          payload.candidateRevision.revisionDigest !==
            sourceRevisionDigest({
              repositoryId: payload.candidateRevision.repositoryId,
              objectFormat: payload.candidateRevision.objectFormat,
              commitOid: payload.candidateRevision.commitOid,
              treeOid: payload.candidateRevision.treeOid
            })
        ) {
          return failure(
            "EVIDENCE_DIGEST_MISMATCH",
            "Candidate revision does not match its receipt",
            {
              attemptId: attempt.attemptId
            }
          );
        }
        const existing = state.sourceRevisions.get(payload.candidateRevision.revisionId);
        if (existing && existing.revisionDigest !== payload.candidateRevision.revisionDigest) {
          return failure("SOURCE_REVISION_CONFLICT", "Candidate revision identifier conflicts", {
            revisionId: payload.candidateRevision.revisionId
          });
        }
        if (!existing) {
          events.push({
            type: "SourceRevisionRegistered",
            streamType: "source_revision",
            streamId: payload.candidateRevision.revisionId,
            data: payload.candidateRevision
          });
        }
      }
      if (
        receipt.outcome === "succeeded" &&
        (!payload.candidateRevision || receipt.approvals.length > 0)
      ) {
        return failure(
          "EVIDENCE_DIGEST_MISMATCH",
          "Successful receipt requires a candidate and no approvals",
          {
            attemptId: attempt.attemptId
          }
        );
      }
      if (!payload.candidateRevision && receipt.candidateRevisionDigest !== null) {
        return failure(
          "EVIDENCE_DIGEST_MISMATCH",
          "Receipt has a candidate digest without a candidate",
          {
            attemptId: attempt.attemptId
          }
        );
      }
      events.push({
        type: "ArtifactManifestRecorded",
        streamType: "artifact_manifest",
        streamId: payload.artifactManifestId,
        data: {
          artifactManifestId: payload.artifactManifestId,
          runId: job.runId,
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          sourceRevisionId,
          producer: "agent",
          entries,
          manifestDigest: artifactManifestDigest(entries),
          totalBytes: entries.reduce((total, entry) => total + entry.size, 0)
        }
      });
      events.push({
        type: "DriverReceiptRecorded",
        streamType: "driver_receipt",
        streamId: payload.driverReceiptId,
        data: {
          driverReceiptId: payload.driverReceiptId,
          runId: job.runId,
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          baseRevisionId: receipt.baseRevisionId,
          candidateRevisionId: receipt.candidateRevisionId,
          receipt,
          receiptDigest: receipt.receiptDigest,
          outcome: receipt.outcome,
          terminalReason: receipt.terminalReason
        }
      });
      for (const approval of receipt.approvals) {
        if (!state.approvalRequests.has(approval.requestId)) {
          events.push({
            type: "ApprovalRequestRecorded",
            streamType: "approval_request",
            streamId: approval.requestId,
            data: {
              approvalRequestId: approval.requestId,
              runId: job.runId,
              jobId: job.jobId,
              attemptId: attempt.attemptId,
              capability: approval.capability,
              reason: approval.reason,
              sequence: approval.sequence
            }
          });
        }
      }
      if (receipt.outcome === "succeeded") {
        const { verificationId, verificationOutboxId } = payload;
        if (
          !verificationId ||
          !verificationOutboxId ||
          !job.verifierContract ||
          !job.verifierContractDigest
        ) {
          return failure(
            "VERIFICATION_REQUIRED",
            "Successful receipt requires verification identifiers",
            {
              attemptId: attempt.attemptId
            }
          );
        }
        const run = state.runs.get(job.runId);
        if (!run) return failure("RUN_NOT_FOUND", "Run does not exist", { runId: job.runId });
        const workflow = state.workflows.get(workflowKey(run.workflowId, run.workflowVersion));
        if (!workflow) return failure("WORKFLOW_NOT_FOUND", "Workflow version does not exist");
        events.push(
          {
            type: "AttemptVerificationRequested",
            streamType: "attempt",
            streamId: attempt.attemptId,
            data: {
              attemptId: attempt.attemptId,
              jobId: job.jobId,
              runId: job.runId,
              verificationId
            }
          },
          {
            type: "VerificationRequested",
            streamType: "verification",
            streamId: verificationId,
            data: {
              verificationId,
              runId: job.runId,
              jobId: job.jobId,
              attemptId: attempt.attemptId,
              workflowId: run.workflowId,
              workflowVersion: run.workflowVersion,
              workflowDigest: workflow.definitionDigest,
              sourceRevisionId,
              verifierContractDigest: job.verifierContractDigest
            }
          },
          outboxEnqueued(verificationOutboxId, job, attempt, {
            effectType: "verification.run",
            verificationId,
            sourceRevisionId,
            workflowId: run.workflowId,
            workflowVersion: run.workflowVersion,
            workflowDigest: workflow.definitionDigest,
            verifierContract: job.verifierContract,
            verifierContractDigest: job.verifierContractDigest,
            attemptId: attempt.attemptId,
            jobId: job.jobId,
            runId: job.runId
          })
        );
      } else if (receipt.outcome === "failed" || receipt.outcome === "timed_out") {
        events.push(
          ...failureTransitionEvents(
            state,
            job,
            attempt,
            receipt.outcome === "timed_out" ? "timed_out" : "driver_error",
            now,
            receipt.terminalReason
          )
        );
      } else {
        events.push(
          ...nonretryableDriverFailureEvents(
            state,
            job,
            attempt,
            receipt.outcome,
            receipt.terminalReason
          )
        );
      }
      return { ok: true, events, resultKind: "driver_receipt", resultId: payload.driverReceiptId };
    }
    case "driver.terminal-receipt.record": {
      const payload = command.payload;
      const outbox = state.outbox.get(payload.outboxId);
      if (!outbox) return failure("OUTBOX_NOT_FOUND", "Outbox message does not exist");
      const outboxInvalid = validateOutboxLease(
        outbox,
        payload.ownerId,
        payload.outboxFencingToken,
        now
      );
      if (outboxInvalid) return outboxInvalid;
      const job = state.jobs.get(payload.jobId);
      if (!job) return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: payload.jobId });
      const attempt = state.attempts.get(payload.attemptId);
      if (!attempt) {
        return failure("ATTEMPT_NOT_FOUND", "Attempt does not exist", {
          attemptId: payload.attemptId
        });
      }
      const receipt = payload.receipt;
      const expectedOutcome =
        outbox.effect.effectType === "agent.cancel" ? outbox.effect.reason : null;
      if (
        outbox.jobId !== job.jobId ||
        outbox.attemptId !== attempt.attemptId ||
        outbox.effect.effectType !== "agent.cancel" ||
        !TERMINAL_ATTEMPTS.has(attempt.status) ||
        (expectedOutcome !== "operator_cancelled" && expectedOutcome !== "timed_out") ||
        receipt.outcome !== expectedOutcome ||
        receipt.receiptDigest !== driverReceiptDigest(receipt) ||
        (receipt.schemaVersion === 1
          ? receipt.driver !== "generic-command"
          : (receipt.driver !== "generic-command" &&
              receipt.driver !== "trusted-cost-adapter-v1") ||
            (receipt.driver === "generic-command" &&
              receipt.usage.monetaryCost.status !== "unavailable")) ||
        receipt.runId !== job.runId ||
        receipt.jobId !== job.jobId ||
        receipt.attemptId !== attempt.attemptId ||
        receipt.externalRunId !== outbox.effect.externalRunId ||
        receipt.baseRevisionId !== job.sourceRevisionId ||
        receipt.baseRevisionDigest !==
          state.sourceRevisions.get(receipt.baseRevisionId)?.revisionDigest ||
        receipt.candidateRevisionId !== null ||
        receipt.candidateRevisionDigest !== null ||
        receipt.executionContractDigest !== job.executionContractDigest ||
        receipt.capabilityManifestDigest !== job.capabilityManifestDigest ||
        (receipt.schemaVersion === 2
          ? receipt.contextPacketId !== job.contextPacketId ||
            receipt.contextPacketDigest !== job.contextPacketDigest ||
            job.executionContract?.protocolVersion !== 2 ||
            job.capabilityManifest?.schemaVersion !== 2
          : job.contextPacketId != null ||
            job.contextPacketDigest != null ||
            job.executionContract?.protocolVersion === 2 ||
            job.capabilityManifest?.schemaVersion === 2) ||
        receipt.image !== job.executionContract?.image ||
        payload.afterSequence !== attempt.driverCursor ||
        receipt.eventCount !== payload.afterSequence + payload.events.length
      ) {
        return failure(
          "EVIDENCE_DIGEST_MISMATCH",
          "Terminal driver receipt does not match its cancellation",
          {
            attemptId: attempt.attemptId
          }
        );
      }
      if (state.driverReceipts.has(payload.driverReceiptId)) {
        return failure("ARTIFACT_MANIFEST_CONFLICT", "Driver receipt already exists", {
          driverReceiptId: payload.driverReceiptId
        });
      }
      let expectedSequence = payload.afterSequence + 1;
      let cpuMillis = attempt.cumulativeUsage?.cpuMillis ?? 0;
      let memoryPeakBytes = attempt.cumulativeUsage?.memoryPeakBytes ?? 0;
      for (const observed of payload.events) {
        if (observed.sequence !== expectedSequence) {
          return failure("EVIDENCE_DIGEST_MISMATCH", "Terminal driver events are not contiguous", {
            attemptId: attempt.attemptId,
            expectedSequence
          });
        }
        expectedSequence += 1;
        if (observed.type === "usage") {
          cpuMillis = Math.max(cpuMillis, observed.cpuMillis);
          memoryPeakBytes = Math.max(memoryPeakBytes, observed.memoryPeakBytes);
        }
      }
      const entries = canonicalArtifactEntries(payload.entries);
      if (
        canonicalDigest(entries) !== canonicalDigest(canonicalArtifactEntries(receipt.artifacts))
      ) {
        return failure(
          "EVIDENCE_DIGEST_MISMATCH",
          "Terminal driver artifacts do not match the receipt",
          {
            attemptId: attempt.attemptId
          }
        );
      }
      const events: DomainEventInput[] = [];
      if (payload.events.length > 0) {
        events.push({
          type: "DriverEventsObserved",
          streamType: "attempt",
          streamId: attempt.attemptId,
          data: {
            attemptId: attempt.attemptId,
            jobId: job.jobId,
            runId: job.runId,
            afterSequence: payload.afterSequence,
            cursor: receipt.eventCount,
            events: payload.events,
            cumulativeUsage: { cpuMillis, memoryPeakBytes }
          }
        });
      }
      events.push(
        {
          type: "ArtifactManifestRecorded",
          streamType: "artifact_manifest",
          streamId: payload.artifactManifestId,
          data: {
            artifactManifestId: payload.artifactManifestId,
            runId: job.runId,
            jobId: job.jobId,
            attemptId: attempt.attemptId,
            sourceRevisionId: receipt.baseRevisionId,
            producer: "agent",
            entries,
            manifestDigest: artifactManifestDigest(entries),
            totalBytes: entries.reduce((total, entry) => total + entry.size, 0)
          }
        },
        {
          type: "DriverReceiptRecorded",
          streamType: "driver_receipt",
          streamId: payload.driverReceiptId,
          data: {
            driverReceiptId: payload.driverReceiptId,
            runId: job.runId,
            jobId: job.jobId,
            attemptId: attempt.attemptId,
            baseRevisionId: receipt.baseRevisionId,
            candidateRevisionId: null,
            receipt,
            receiptDigest: receipt.receiptDigest,
            outcome: receipt.outcome,
            terminalReason: receipt.terminalReason
          }
        }
      );
      return { ok: true, events, resultKind: "driver_receipt", resultId: payload.driverReceiptId };
    }
    case "attempt.observe":
    case "attempt.timeout": {
      const job = state.jobs.get(command.payload.jobId);
      if (!job)
        return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: command.payload.jobId });
      const invalid = validateJobLease(
        job,
        command.payload.ownerId,
        command.payload.fencingToken,
        now
      );
      if (invalid) return invalid;
      const attempt = state.attempts.get(command.payload.attemptId);
      if (!attempt) {
        return failure("ATTEMPT_NOT_FOUND", "Attempt does not exist", {
          attemptId: command.payload.attemptId
        });
      }
      if (TERMINAL_ATTEMPTS.has(attempt.status)) {
        return failure("ATTEMPT_TERMINAL", "Attempt is already terminal", {
          attemptId: attempt.attemptId
        });
      }
      if (job.activeAttemptId !== attempt.attemptId || attempt.jobId !== job.jobId) {
        return failure("ATTEMPT_NOT_ACTIVE", "Attempt is not active for this job", {
          attemptId: attempt.attemptId
        });
      }
      if (command.type === "attempt.timeout") {
        if (!attempt.deadlineAt || !atOrBefore(attempt.deadlineAt, now)) {
          return failure("ATTEMPT_NOT_ACTIVE", "Attempt deadline has not elapsed", {
            attemptId: attempt.attemptId
          });
        }
        return {
          ok: true,
          events: failureTransitionEvents(state, job, attempt, "timed_out", now),
          resultKind: "job",
          resultId: job.jobId
        };
      }
      if (attempt.deadlineAt && atOrBefore(attempt.deadlineAt, now)) {
        return failure("ATTEMPT_NOT_ACTIVE", "Attempt deadline has elapsed", {
          attemptId: attempt.attemptId
        });
      }
      if (attempt.status !== "running") {
        return failure("ATTEMPT_NOT_ACTIVE", "Attempt has not started in the driver", {
          attemptId: attempt.attemptId
        });
      }
      if (command.payload.outcome === "failed") {
        return {
          ok: true,
          events: failureTransitionEvents(
            state,
            job,
            attempt,
            "driver_error",
            now,
            command.payload.detail
          ),
          resultKind: "job",
          resultId: job.jobId
        };
      }
      if (job.sourceRevisionId && job.verifierContract && job.verifierContractDigest) {
        const { verificationId, verificationOutboxId } = command.payload;
        if (!verificationId || !verificationOutboxId) {
          return failure(
            "VERIFICATION_REQUIRED",
            "Successful execution requires verification identifiers",
            { attemptId: attempt.attemptId }
          );
        }
        if (state.verifications.has(verificationId) || state.outbox.has(verificationOutboxId)) {
          return failure("VERIFICATION_NOT_ACTIVE", "Verification identifier already exists", {
            verificationId
          });
        }
        const run = state.runs.get(job.runId);
        if (!run) return failure("RUN_NOT_FOUND", "Run does not exist", { runId: job.runId });
        const workflow = state.workflows.get(workflowKey(run.workflowId, run.workflowVersion));
        if (!workflow) return failure("WORKFLOW_NOT_FOUND", "Workflow version does not exist");
        const events: DomainEventInput[] = [
          {
            type: "AttemptVerificationRequested",
            streamType: "attempt",
            streamId: attempt.attemptId,
            data: {
              attemptId: attempt.attemptId,
              jobId: job.jobId,
              runId: job.runId,
              verificationId
            }
          },
          {
            type: "VerificationRequested",
            streamType: "verification",
            streamId: verificationId,
            data: {
              verificationId,
              runId: job.runId,
              jobId: job.jobId,
              attemptId: attempt.attemptId,
              workflowId: run.workflowId,
              workflowVersion: run.workflowVersion,
              workflowDigest: workflow.definitionDigest,
              sourceRevisionId: job.sourceRevisionId,
              verifierContractDigest: job.verifierContractDigest
            }
          },
          outboxEnqueued(verificationOutboxId, job, attempt, {
            effectType: "verification.run",
            verificationId,
            sourceRevisionId: job.sourceRevisionId,
            workflowId: run.workflowId,
            workflowVersion: run.workflowVersion,
            workflowDigest: workflow.definitionDigest,
            verifierContract: job.verifierContract,
            verifierContractDigest: job.verifierContractDigest,
            attemptId: attempt.attemptId,
            jobId: job.jobId,
            runId: job.runId
          })
        ];
        return { ok: true, events, resultKind: "job", resultId: job.jobId };
      }
      const events: DomainEventInput[] = [
        {
          type: "AttemptFinished",
          streamType: "attempt",
          streamId: attempt.attemptId,
          data: {
            attemptId: attempt.attemptId,
            jobId: job.jobId,
            runId: job.runId,
            status: "succeeded",
            terminationReason: "completed",
            ...(command.payload.detail ? { detail: command.payload.detail } : {})
          }
        },
        {
          type: "JobSucceeded",
          streamType: "job",
          streamId: job.jobId,
          data: { jobId: job.jobId, runId: job.runId }
        }
      ];
      for (const candidate of state.jobs.values()) {
        if (
          candidate.runId === job.runId &&
          candidate.status === "blocked" &&
          candidate.dependencyJobIds.every((dependencyId) => {
            if (dependencyId === job.jobId) return true;
            return state.jobs.get(dependencyId)?.status === "succeeded";
          })
        ) {
          events.push({
            type: "JobUnblocked",
            streamType: "job",
            streamId: candidate.jobId,
            data: { jobId: candidate.jobId, runId: candidate.runId }
          });
        }
      }
      const runJobs = [...state.jobs.values()].filter((candidate) => candidate.runId === job.runId);
      if (
        runJobs.every(
          (candidate) => candidate.jobId === job.jobId || candidate.status === "succeeded"
        )
      ) {
        events.push({
          type: "RunSucceeded",
          streamType: "run",
          streamId: job.runId,
          data: { runId: job.runId }
        });
      }
      return { ok: true, events, resultKind: "job", resultId: job.jobId };
    }
    case "verification.complete": {
      const payload = command.payload;
      const verification = state.verifications.get(payload.verificationId);
      if (!verification) {
        return failure("VERIFICATION_NOT_FOUND", "Verification does not exist", {
          verificationId: payload.verificationId
        });
      }
      if (verification.status !== "requested") {
        return failure("VERIFICATION_NOT_ACTIVE", "Verification is already terminal", {
          verificationId: verification.verificationId
        });
      }
      const job = state.jobs.get(payload.jobId);
      if (!job) return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: payload.jobId });
      const jobLeaseError = validateJobLease(job, payload.ownerId, payload.jobFencingToken, now);
      if (jobLeaseError) return jobLeaseError;
      const outbox = state.outbox.get(payload.outboxId);
      if (!outbox) {
        return failure("OUTBOX_NOT_FOUND", "Verification outbox message does not exist", {
          outboxId: payload.outboxId
        });
      }
      const outboxLeaseError = validateOutboxLease(
        outbox,
        payload.ownerId,
        payload.outboxFencingToken,
        now
      );
      if (outboxLeaseError) return outboxLeaseError;
      const attempt = state.attempts.get(payload.attemptId);
      if (
        attempt?.status !== "verifying" ||
        !attempt.deadlineAt ||
        atOrBefore(attempt.deadlineAt, now) ||
        job.activeAttemptId !== attempt.attemptId ||
        verification.attemptId !== attempt.attemptId ||
        verification.jobId !== job.jobId ||
        outbox.attemptId !== attempt.attemptId ||
        outbox.effect.effectType !== "verification.run" ||
        outbox.effect.verificationId !== verification.verificationId
      ) {
        return failure("VERIFICATION_NOT_ACTIVE", "Verification is not active for this attempt", {
          verificationId: verification.verificationId
        });
      }
      if (
        state.artifactManifests.has(payload.artifactManifestId) ||
        payload.entries.length > 256 ||
        payload.entries.reduce((total, entry) => total + entry.size, 0) > 268_435_456 ||
        new Set(payload.entries.map((entry) => entry.path)).size !== payload.entries.length
      ) {
        return failure("ARTIFACT_MANIFEST_CONFLICT", "Artifact manifest is invalid or reused", {
          artifactManifestId: payload.artifactManifestId
        });
      }
      const manifestDigest = artifactManifestDigest(payload.entries);
      const resultDigest = verificationResultDigest(payload.result);
      const expectedReceiptDigest = verificationReceiptDigest(
        receiptIdentity(verification, payload.artifactManifestId, manifestDigest, resultDigest)
      );
      if (
        payload.result.artifactManifestDigest !== manifestDigest ||
        payload.resultDigest !== resultDigest ||
        payload.receiptDigest !== expectedReceiptDigest
      ) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Verification evidence digest is invalid", {
          verificationId: verification.verificationId
        });
      }
      const mutated =
        payload.result.sourceStatusBeforeDigest !== payload.result.sourceStatusAfterDigest ||
        payload.result.contractDigestBefore !== payload.result.contractDigestAfter;
      const cleanSourceStatusDigest = createHash("sha256").update("").digest("hex");
      if (
        payload.result.environmentDigest !== payload.result.contractDigestBefore ||
        payload.result.sourceStatusBeforeDigest !== cleanSourceStatusDigest ||
        (payload.result.outcome !== "invalid" && mutated) ||
        (payload.result.outcome === "passed" &&
          (payload.result.exitCode !== 0 || payload.result.failureReason !== null)) ||
        (payload.result.outcome === "failed" &&
          (payload.result.exitCode === null || payload.result.exitCode === 0)) ||
        (payload.result.outcome !== "passed" && payload.result.failureReason === null)
      ) {
        return failure(
          "EVIDENCE_DIGEST_MISMATCH",
          "Verification outcome contradicts its evidence",
          { verificationId: verification.verificationId }
        );
      }
      const totalBytes = payload.entries.reduce((total, entry) => total + entry.size, 0);
      const events: DomainEventInput[] = [
        {
          type: "ArtifactManifestRecorded",
          streamType: "artifact_manifest",
          streamId: payload.artifactManifestId,
          data: {
            artifactManifestId: payload.artifactManifestId,
            runId: job.runId,
            jobId: job.jobId,
            attemptId: attempt.attemptId,
            sourceRevisionId: verification.sourceRevisionId,
            producer: "verifier",
            entries: canonicalArtifactEntries(payload.entries),
            manifestDigest,
            totalBytes
          }
        },
        {
          type: "VerificationReceiptRecorded",
          streamType: "verification",
          streamId: verification.verificationId,
          data: {
            verificationId: verification.verificationId,
            runId: job.runId,
            jobId: job.jobId,
            attemptId: attempt.attemptId,
            artifactManifestId: payload.artifactManifestId,
            status: payload.result.outcome,
            result: payload.result,
            resultDigest,
            receiptDigest: expectedReceiptDigest,
            exitCode: payload.result.exitCode,
            failureReason: payload.result.failureReason
          }
        },
        {
          type: "OutboxDelivered",
          streamType: "outbox",
          streamId: outbox.outboxId,
          data: {
            outboxId: outbox.outboxId,
            runId: outbox.runId,
            externalEffectId: expectedReceiptDigest
          }
        },
        {
          type: "AttemptFinished",
          streamType: "attempt",
          streamId: attempt.attemptId,
          data: {
            attemptId: attempt.attemptId,
            jobId: job.jobId,
            runId: job.runId,
            status: payload.result.outcome === "passed" ? "succeeded" : "failed",
            terminationReason:
              payload.result.outcome === "passed"
                ? "completed"
                : payload.result.outcome === "failed"
                  ? "verification_failed"
                  : "verification_invalid",
            ...(payload.result.failureReason ? { detail: payload.result.failureReason } : {})
          }
        }
      ];
      if (payload.result.outcome === "passed") {
        events.push({
          type: "JobSucceeded",
          streamType: "job",
          streamId: job.jobId,
          data: { jobId: job.jobId, runId: job.runId }
        });
        for (const candidate of state.jobs.values()) {
          if (
            candidate.runId === job.runId &&
            candidate.status === "blocked" &&
            candidate.dependencyJobIds.every((dependencyId) =>
              dependencyId === job.jobId
                ? true
                : state.jobs.get(dependencyId)?.status === "succeeded"
            )
          ) {
            events.push({
              type: "JobUnblocked",
              streamType: "job",
              streamId: candidate.jobId,
              data: { jobId: candidate.jobId, runId: candidate.runId }
            });
          }
        }
        const runJobs = [...state.jobs.values()].filter(
          (candidate) => candidate.runId === job.runId
        );
        if (
          runJobs.every(
            (candidate) => candidate.jobId === job.jobId || candidate.status === "succeeded"
          )
        ) {
          events.push({
            type: "RunSucceeded",
            streamType: "run",
            streamId: job.runId,
            data: { runId: job.runId }
          });
        }
      } else {
        const reason = payload.result.failureReason ?? payload.result.outcome;
        events.push({
          type: "JobFailed",
          streamType: "job",
          streamId: job.jobId,
          data: { jobId: job.jobId, runId: job.runId, reason }
        });
        const generatedOutboxIds = new Set<string>();
        for (const other of state.jobs.values()) {
          if (
            other.runId === job.runId &&
            other.jobId !== job.jobId &&
            !TERMINAL_JOBS.has(other.status)
          ) {
            events.push(...cancellationEvents(state, other, "run_failed", generatedOutboxIds));
          }
        }
        events.push({
          type: "RunFailed",
          streamType: "run",
          streamId: job.runId,
          data: { runId: job.runId, reason }
        });
      }
      return {
        ok: true,
        events,
        resultKind: "verification",
        resultId: verification.verificationId
      };
    }
    case "verification.execution.fail": {
      const payload = command.payload;
      const verification = state.verifications.get(payload.verificationId);
      if (!verification) {
        return failure("VERIFICATION_NOT_FOUND", "Verification does not exist", {
          verificationId: payload.verificationId
        });
      }
      if (verification.status !== "requested") {
        return failure("VERIFICATION_NOT_ACTIVE", "Verification is already terminal", {
          verificationId: verification.verificationId
        });
      }
      const job = state.jobs.get(payload.jobId);
      if (!job) return failure("JOB_NOT_FOUND", "Job does not exist", { jobId: payload.jobId });
      const jobLeaseError = validateJobLease(job, payload.ownerId, payload.jobFencingToken, now);
      if (jobLeaseError) return jobLeaseError;
      const outbox = state.outbox.get(payload.outboxId);
      if (!outbox) {
        return failure("OUTBOX_NOT_FOUND", "Verification outbox message does not exist", {
          outboxId: payload.outboxId
        });
      }
      const outboxLeaseError = validateOutboxLease(
        outbox,
        payload.ownerId,
        payload.outboxFencingToken,
        now
      );
      if (outboxLeaseError) return outboxLeaseError;
      const attempt = state.attempts.get(payload.attemptId);
      if (
        attempt?.status !== "verifying" ||
        job.activeAttemptId !== attempt.attemptId ||
        verification.attemptId !== attempt.attemptId ||
        verification.jobId !== job.jobId ||
        outbox.attemptId !== attempt.attemptId ||
        outbox.effect.effectType !== "verification.run" ||
        outbox.effect.verificationId !== verification.verificationId
      ) {
        return failure("VERIFICATION_NOT_ACTIVE", "Verification is not active for this attempt", {
          verificationId: verification.verificationId
        });
      }
      const events: DomainEventInput[] = [
        {
          type: "OutboxObsoleted",
          streamType: "outbox",
          streamId: outbox.outboxId,
          data: {
            outboxId: outbox.outboxId,
            runId: outbox.runId,
            reason: payload.reason
          }
        },
        ...failureTransitionEvents(
          state,
          job,
          attempt,
          payload.reason,
          now,
          payload.detail,
          outbox.outboxId
        )
      ];
      return { ok: true, events, resultKind: "job", resultId: job.jobId };
    }
    case "outbox.lease.acquire": {
      const outbox = state.outbox.get(command.payload.outboxId);
      if (!outbox) {
        return failure("OUTBOX_NOT_FOUND", "Outbox message does not exist", {
          outboxId: command.payload.outboxId
        });
      }
      const reclaiming =
        outbox.status === "leased" &&
        Boolean(outbox.leaseExpiresAt) &&
        atOrBefore(outbox.leaseExpiresAt ?? now, now);
      const pending = outbox.status === "pending" && atOrBefore(outbox.availableAt, now);
      if (!reclaiming && !pending) {
        return failure("OUTBOX_NOT_CLAIMABLE", "Outbox message is not available", {
          outboxId: outbox.outboxId
        });
      }
      if (outbox.effect.effectType !== "agent.cancel") {
        const attempt = state.attempts.get(outbox.attemptId);
        if (!attempt || TERMINAL_ATTEMPTS.has(attempt.status)) {
          return {
            ok: true,
            events: [
              {
                type: "OutboxObsoleted",
                streamType: "outbox",
                streamId: outbox.outboxId,
                data: {
                  outboxId: outbox.outboxId,
                  runId: outbox.runId,
                  reason: "Attempt is terminal"
                }
              }
            ],
            resultKind: "outbox",
            resultId: outbox.outboxId
          };
        }
      }
      const fencingToken = outbox.leaseFencingToken + 1;
      return {
        ok: true,
        events: [
          {
            type: "OutboxLeaseAcquired",
            streamType: "outbox",
            streamId: outbox.outboxId,
            data: {
              outboxId: outbox.outboxId,
              runId: outbox.runId,
              ownerId: command.payload.ownerId,
              fencingToken,
              leaseExpiresAt: addMilliseconds(now, command.payload.leaseDurationMs),
              deliveryAttempt: outbox.deliveryAttempts + 1
            }
          }
        ],
        resultKind: "outbox",
        resultId: outbox.outboxId
      };
    }
    case "outbox.delivery.succeed": {
      const outbox = state.outbox.get(command.payload.outboxId);
      if (!outbox) return failure("OUTBOX_NOT_FOUND", "Outbox message does not exist");
      const invalid = validateOutboxLease(
        outbox,
        command.payload.ownerId,
        command.payload.fencingToken,
        now
      );
      if (invalid) return invalid;
      const events: DomainEventInput[] = [
        {
          type: "OutboxDelivered",
          streamType: "outbox",
          streamId: outbox.outboxId,
          data: {
            outboxId: outbox.outboxId,
            runId: outbox.runId,
            externalEffectId: command.payload.externalEffectId
          }
        }
      ];
      if (outbox.effect.effectType === "agent.start") {
        const attempt = state.attempts.get(outbox.attemptId);
        const job = state.jobs.get(outbox.jobId);
        if (attempt && job && !TERMINAL_ATTEMPTS.has(attempt.status)) {
          events.push({
            type: "AttemptRunning",
            streamType: "attempt",
            streamId: attempt.attemptId,
            data: {
              attemptId: attempt.attemptId,
              jobId: job.jobId,
              runId: job.runId,
              externalRunId: command.payload.externalEffectId
            }
          });
        } else if (attempt && job) {
          const cancelOutboxId = deterministicUuid(`${attempt.attemptId}:agent.cancel`);
          if (!state.outbox.has(cancelOutboxId)) {
            events.push(
              outboxEnqueued(cancelOutboxId, job, attempt, {
                effectType: "agent.cancel",
                externalRunId: command.payload.externalEffectId,
                reason:
                  attempt.terminationReason === "timed_out" ? "timed_out" : "operator_cancelled",
                attemptId: attempt.attemptId,
                jobId: job.jobId,
                runId: job.runId
              })
            );
          }
        }
      }
      return { ok: true, events, resultKind: "outbox", resultId: outbox.outboxId };
    }
    case "outbox.delivery.fail": {
      const outbox = state.outbox.get(command.payload.outboxId);
      if (!outbox) return failure("OUTBOX_NOT_FOUND", "Outbox message does not exist");
      const invalid = validateOutboxLease(
        outbox,
        command.payload.ownerId,
        command.payload.fencingToken,
        now
      );
      if (invalid) return invalid;
      const deadLetter = outbox.deliveryAttempts >= outbox.retryDelaysMs.length + 1;
      const delay = outbox.retryDelaysMs[outbox.deliveryAttempts - 1] ?? 0;
      const events: DomainEventInput[] = [
        {
          type: "OutboxDeliveryFailed",
          streamType: "outbox",
          streamId: outbox.outboxId,
          data: {
            outboxId: outbox.outboxId,
            runId: outbox.runId,
            availableAt: deadLetter ? null : addMilliseconds(now, delay),
            deadLetter,
            error: command.payload.error
          }
        }
      ];
      if (deadLetter && outbox.effect.effectType !== "agent.cancel") {
        const attempt = state.attempts.get(outbox.attemptId);
        const job = state.jobs.get(outbox.jobId);
        if (attempt && job && !TERMINAL_ATTEMPTS.has(attempt.status)) {
          events.push(
            ...failureTransitionEvents(
              state,
              job,
              attempt,
              "driver_error",
              now,
              command.payload.error,
              outbox.outboxId
            )
          );
        }
      }
      return { ok: true, events, resultKind: "outbox", resultId: outbox.outboxId };
    }
    default:
      return failure("COMMAND_RETIRED", "Command is not implemented by this ParallelPlay build");
  }
}
