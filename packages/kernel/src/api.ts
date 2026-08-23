import { z } from "zod";
import { StateEntitySchema } from "./schema.js";
import type { JobState, OutboxState, StoredEvent } from "./schema.js";
import type {
  AttentionBudgetIncidentState,
  AttentionDeliveryState,
  ApprovalRequestState,
  ArtifactManifestState,
  AttemptState,
  DecisionAcknowledgementState,
  DecisionActionResultState,
  DecisionEvidenceBundleState,
  DecisionPacketRevisionState,
  DecisionPacketState,
  DecisionPrecedentState,
  DecisionResolutionState,
  DriverReceiptState,
  MilestoneState,
  OutcomePacketState,
  ProgramState,
  RunState,
  SourceRevisionState,
  VerificationState,
  WorkflowState
} from "./schema.js";

export const ErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "IDEMPOTENCY_CONFLICT",
  "PROGRAM_NOT_FOUND",
  "PROGRAM_ALREADY_EXISTS",
  "PROGRAM_NOT_STARTABLE",
  "PROGRAM_NOT_ADVANCEABLE",
  "INTERVIEW_NOT_FOUND",
  "GRAPH_NOT_FOUND",
  "GRAPH_INVALID",
  "ISSUE_NOT_FOUND",
  "ATTENTION_SPAN_NOT_FOUND",
  "OUTCOME_PACKET_NOT_FOUND",
  "MEASUREMENT_NOT_READY",
  "ATTENTION_SOURCE_NOT_FOUND",
  "ATTENTION_POLICY_CONFLICT",
  "ADVISOR_SUBJECT_CONFLICT",
  "ADVISOR_CASE_INVALID",
  "ADVISOR_CORPUS_INVALID",
  "ADVISOR_INVOCATION_NOT_CLAIMABLE",
  "ADVISOR_INVOCATION_LEASE_CONFLICT",
  "ADVISOR_OUTPUT_INVALID",
  "ADVISOR_EVALUATION_BLOCKED",
  "DECISION_POLICY_CONFLICT",
  "DECISION_POLICY_NOT_PROMOTABLE",
  "DECISION_POLICY_INACTIVE",
  "ADVISOR_AUDIT_NOT_FOUND",
  "DECISION_PACKET_NOT_FOUND",
  "DECISION_PACKET_STALE",
  "DECISION_ACTION_MISMATCH",
  "DECISION_ALREADY_RESOLVED",
  "ATTENTION_DELIVERY_NOT_CLAIMABLE",
  "ATTENTION_DELIVERY_LEASE_CONFLICT",
  "APPROVAL_REQUIRES_OPERATOR",
  "MILESTONE_NOT_FOUND",
  "MILESTONE_ALREADY_EXISTS",
  "MILESTONE_NOT_STARTABLE",
  "WORKFLOW_NOT_FOUND",
  "WORKFLOW_VERSION_CONFLICT",
  "RUN_NOT_FOUND",
  "RUN_ALREADY_EXISTS",
  "RUN_TERMINAL",
  "RUN_NOT_SCHEDULABLE",
  "RUN_ALREADY_SCHEDULED",
  "SCHEDULE_MISMATCH",
  "LEGACY_ACTIVE_ATTEMPT",
  "ATTEMPT_NOT_FOUND",
  "ATTEMPT_ALREADY_EXISTS",
  "ATTEMPT_TERMINAL",
  "ATTEMPT_NOT_ACTIVE",
  "ACTIVE_ATTEMPT_EXISTS",
  "COMMAND_RETIRED",
  "JOB_NOT_FOUND",
  "JOB_NOT_CLAIMABLE",
  "JOB_LEASE_CONFLICT",
  "JOB_LEASE_EXPIRED",
  "OUTBOX_NOT_FOUND",
  "OUTBOX_NOT_CLAIMABLE",
  "OUTBOX_LEASE_CONFLICT",
  "OUTBOX_LEASE_EXPIRED",
  "VERIFICATION_REQUIRED",
  "SOURCE_REVISION_NOT_FOUND",
  "SOURCE_REVISION_ALREADY_EXISTS",
  "SOURCE_REVISION_CONFLICT",
  "VERIFICATION_NOT_FOUND",
  "VERIFICATION_NOT_ACTIVE",
  "EVIDENCE_DIGEST_MISMATCH",
  "ARTIFACT_MANIFEST_CONFLICT"
]);

export const EventSummarySchema = z.strictObject({
  eventId: z.uuid(),
  globalPosition: z.number().int().positive(),
  streamType: z
    .enum([
      "program",
      "milestone",
      "milestone_generation",
      "program_interview",
      "program_graph",
      "context_packet",
      "outcome_validation",
      "routed_issue",
      "attention_span",
      "outcome_disposition",
      "measurement_report",
      "outcome_packet",
      "workflow",
      "run",
      "attempt",
      "job",
      "outbox",
      "source_revision",
      "artifact_manifest",
      "verification",
      "driver_receipt",
      "approval_request",
      "operator_decision_request",
      "decision_packet",
      "decision_packet_revision",
      "decision_evidence_bundle",
      "attention_policy",
      "decision_acknowledgement",
      "decision_resolution",
      "decision_action_result",
      "decision_precedent",
      "attention_delivery",
      "attention_budget_incident",
      "attention_measurement_report",
      "attention_digest_artifact",
      "portfolio_policy",
      "integration_target",
      "portfolio_admission",
      "concurrency_lease",
      "candidate_diff_manifest",
      "integration_candidate",
      "integration_work",
      "integration_conflict",
      "promotion_receipt",
      "portfolio_slo_incident",
      "portfolio_measurement_report",
      "advisor_subject",
      "advisor_case",
      "advisor_corpus",
      "advisor_contamination",
      "advisor_invocation",
      "advisor_recommendation",
      "advisor_evaluation",
      "decision_policy_proposal",
      "decision_policy",
      "decision_policy_promotion",
      "advisor_resolution",
      "advisor_audit",
      "advisor_incident"
    ])
    .optional(),
  streamId: z.string().min(1),
  streamVersion: z.number().int().positive(),
  type: z.string().min(1)
});

const ErrorDetailsSchema = z.record(z.string(), z.union([z.string(), z.number()]));

const LegacyAttemptReceiptStateSchema = z.strictObject({
  kind: z.literal("attempt"),
  attemptId: z.uuid(),
  runId: z.uuid(),
  ordinal: z.number().int().positive(),
  status: z.enum(["allocated", "cancelled"]),
  allocatedAt: z.iso.datetime({ offset: true }),
  cancelledAt: z.iso.datetime({ offset: true }).nullable(),
  cancellationReason: z.string().nullable(),
  version: z.number().int().positive()
});

const LegacyRunReceiptStateSchema = z.strictObject({
  kind: z.literal("run"),
  runId: z.uuid(),
  programId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersion: z.number().int().positive(),
  status: z.enum(["created", "cancelled"]),
  createdAt: z.iso.datetime({ offset: true }),
  cancelledAt: z.iso.datetime({ offset: true }).nullable(),
  cancellationReason: z.string().nullable(),
  version: z.number().int().positive()
});

const ReceiptStateEntitySchema = z.union([
  StateEntitySchema,
  LegacyAttemptReceiptStateSchema,
  LegacyRunReceiptStateSchema
]);

export const CommandResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    commandId: z.uuid(),
    idempotencyKey: z.string().min(1),
    replayed: z.boolean(),
    events: z.array(EventSummarySchema),
    data: ReceiptStateEntitySchema
  }),
  z.strictObject({
    ok: z.literal(false),
    commandId: z.uuid().nullable(),
    idempotencyKey: z.string().nullable(),
    replayed: z.boolean(),
    error: z.strictObject({
      code: ErrorCodeSchema,
      message: z.string().min(1),
      details: ErrorDetailsSchema.optional()
    })
  })
]);

export type CommandResult = z.infer<typeof CommandResultSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export type StateReference =
  | { kind: "program"; id: string }
  | { kind: "milestone"; id: string }
  | { kind: "outcome_packet"; id: string }
  | { kind: "workflow"; id: string; version: number }
  | { kind: "run"; id: string }
  | { kind: "attempt"; id: string }
  | { kind: "job"; id: string }
  | { kind: "outbox"; id: string }
  | { kind: "source_revision"; id: string }
  | { kind: "artifact_manifest"; id: string }
  | { kind: "verification"; id: string }
  | { kind: "driver_receipt"; id: string }
  | { kind: "approval_request"; id: string }
  | { kind: "program_interview"; id: string }
  | { kind: "program_graph"; id: string }
  | { kind: "milestone_generation"; id: string }
  | { kind: "context_packet"; id: string }
  | { kind: "outcome_validation"; id: string }
  | { kind: "routed_issue"; id: string }
  | { kind: "attention_span"; id: string }
  | { kind: "outcome_disposition"; id: string }
  | { kind: "measurement_report"; id: string }
  | { kind: "operator_decision_request"; id: string }
  | { kind: "decision_packet"; id: string }
  | { kind: "decision_packet_revision"; id: string }
  | { kind: "decision_evidence_bundle"; id: string }
  | { kind: "attention_policy"; id: string }
  | { kind: "decision_acknowledgement"; id: string }
  | { kind: "decision_resolution"; id: string }
  | { kind: "decision_action_result"; id: string }
  | { kind: "decision_precedent"; id: string }
  | { kind: "attention_delivery"; id: string }
  | { kind: "attention_budget_incident"; id: string }
  | { kind: "attention_measurement_report"; id: string }
  | { kind: "attention_digest_artifact"; id: string }
  | { kind: "portfolio_policy"; id: string }
  | { kind: "integration_target"; id: string }
  | { kind: "portfolio_admission"; id: string }
  | { kind: "concurrency_lease"; id: string }
  | { kind: "candidate_diff_manifest"; id: string }
  | { kind: "integration_candidate"; id: string }
  | { kind: "integration_work"; id: string }
  | { kind: "integration_conflict"; id: string }
  | { kind: "integration_verification"; id: string }
  | { kind: "promotion_receipt"; id: string }
  | { kind: "portfolio_slo_incident"; id: string }
  | { kind: "portfolio_measurement_report"; id: string }
  | { kind: "advisor_subject"; id: string }
  | { kind: "advisor_case"; id: string }
  | { kind: "advisor_corpus"; id: string }
  | { kind: "advisor_contamination"; id: string }
  | { kind: "advisor_invocation"; id: string }
  | { kind: "advisor_recommendation"; id: string }
  | { kind: "advisor_evaluation"; id: string }
  | { kind: "decision_policy_proposal"; id: string }
  | { kind: "decision_policy"; id: string }
  | { kind: "decision_policy_promotion"; id: string }
  | { kind: "advisor_resolution"; id: string }
  | { kind: "advisor_audit"; id: string }
  | { kind: "advisor_incident"; id: string };

export type StateResult = z.infer<typeof StateEntitySchema> | null;

export interface EventPage {
  events: StoredEvent[];
  nextPosition: number | null;
}

export interface AttentionQueueItem {
  packet: DecisionPacketState;
  revision: DecisionPacketRevisionState;
  acknowledgement: DecisionAcknowledgementState | null;
}

export interface DecisionAudit {
  packet: DecisionPacketState;
  revisions: DecisionPacketRevisionState[];
  evidenceBundles: DecisionEvidenceBundleState[];
  acknowledgements: DecisionAcknowledgementState[];
  resolution: DecisionResolutionState | null;
  actionResult: DecisionActionResultState | null;
  precedent: DecisionPrecedentState | null;
  deliveries: AttentionDeliveryState[];
  budgetIncidents: AttentionBudgetIncidentState[];
}

export interface ProjectionVerification {
  projectionSchemaVersion: 1;
  valid: boolean;
  currentDigest: string | null;
  replayedDigest: string;
  eventCount: number;
  firstDivergence: string | null;
}

export interface ProjectionRebuildResult {
  projectionSchemaVersion: 1;
  previousDigest: string | null;
  rebuiltDigest: string;
  eventCount: number;
  firstDivergence: string | null;
}

export interface JobQuery {
  runId?: string;
  statuses?: JobState["status"][];
  ownerId?: string;
}

export interface OutboxQuery {
  runId?: string;
  statuses?: OutboxState["status"][];
  ownerId?: string;
}

export interface EvidenceQuery {
  runId?: string;
  attemptId?: string;
}

export interface ExecutionTraceRecord {
  globalPosition: number;
  occurredAt: string;
  commandId: string;
  eventId: string;
  type: string;
  streamType: StoredEvent["streamType"];
  entityId: string;
  runId: string;
  milestoneId: string | null;
  outcomePacketId: string | null;
  jobId: string | null;
  attemptId: string | null;
  outboxId: string | null;
  sourceRevisionId: string | null;
  artifactManifestId: string | null;
  verificationId: string | null;
  driverReceiptId: string | null;
  approvalRequestId: string | null;
  baseRevisionId: string | null;
  candidateRevisionId: string | null;
  workflowDigest: string | null;
  executionContractDigest: string | null;
  capabilityManifestDigest: string | null;
  verifierContractDigest: string | null;
  revisionDigest: string | null;
  manifestDigest: string | null;
  resultDigest: string | null;
  receiptDigest: string | null;
  outcomePacketDigest: string | null;
  driverCursor: number | null;
  cumulativeUsage: { cpuMillis: number; memoryPeakBytes: number } | null;
  driverEvents: unknown[] | null;
  status: string | null;
  terminationReason: string | null;
}

export type EvidenceState = SourceRevisionState | ArtifactManifestState | VerificationState;

export interface ExecutionTrace {
  traceId: string;
  runId: string;
  programId: string;
  workflowId: string;
  workflowVersion: number;
  records: ExecutionTraceRecord[];
}

export interface MilestoneSnapshot {
  snapshotVersion: 1;
  program: ProgramState;
  milestone: MilestoneState;
  workflow: WorkflowState;
  run: RunState | null;
  job: JobState | null;
  attempts: AttemptState[];
  driverReceipts: DriverReceiptState[];
  verifications: VerificationState[];
  artifactManifests: ArtifactManifestState[];
  approvalRequests: ApprovalRequestState[];
  outcomePacket: OutcomePacketState | null;
  trace: ExecutionTrace | null;
}
