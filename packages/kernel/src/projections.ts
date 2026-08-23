import { z } from "zod";
import { canonicalDigest, canonicalJson } from "./canonical.js";
import type { SqliteDatabase } from "./database.js";
import { emptyProjectionState, serializeProjectionState, workflowKey } from "./model.js";
import type { ProjectionState, SerializedProjectionState, StateEntity } from "./model.js";
import {
  AttentionBudgetIncidentStateSchema,
  AttentionDeliveryStateSchema,
  AttentionDigestArtifactStateSchema,
  AttentionMeasurementReportStateSchema,
  AttentionPolicyStateSchema,
  AttentionSpanStateSchema,
  ArtifactManifestStateSchema,
  ApprovalRequestStateSchema,
  AttemptStateSchema,
  DecisionAcknowledgementStateSchema,
  DecisionActionResultStateSchema,
  DecisionEvidenceBundleStateSchema,
  DecisionPacketRevisionStateSchema,
  DecisionPacketStateSchema,
  DecisionPrecedentStateSchema,
  DecisionResolutionStateSchema,
  DriverReceiptStateSchema,
  EventMetadataSchema,
  EventPayloadSchemas,
  JobStateSchema,
  ContextPacketStateSchema,
  MeasurementReportStateSchema,
  MilestoneGenerationStateSchema,
  MilestoneStateSchema,
  OutcomePacketStateSchema,
  OutcomeDispositionStateSchema,
  OutcomeValidationStateSchema,
  OperatorDecisionRequestStateSchema,
  OutboxStateSchema,
  ProgramStateSchema,
  ProgramGraphStateSchema,
  ProgramInterviewStateSchema,
  RoutedIssueStateSchema,
  RunStateSchema,
  SourceRevisionStateSchema,
  VerificationStateSchema,
  WorkflowDefinitionSchema,
  WorkflowStateSchema,
  PortfolioPolicyStateSchema,
  IntegrationTargetStateSchema,
  PortfolioAdmissionStateSchema,
  ConcurrencyLeaseStateSchema,
  CandidateDiffManifestStateSchema,
  IntegrationCandidateStateSchema,
  IntegrationWorkStateSchema,
  IntegrationConflictStateSchema,
  IntegrationVerificationStateSchema,
  PromotionReceiptStateSchema,
  PortfolioSloIncidentStateSchema,
  PortfolioMeasurementReportStateSchema,
  parseEventPayload
} from "./schema.js";
import type { EventType, StoredEvent } from "./schema.js";
import {
  AdvisorAuditStateSchema,
  AdvisorCaseStateSchema,
  AdvisorContaminationStateSchema,
  AdvisorCorpusStateSchema,
  AdvisorEvaluationStateSchema,
  AdvisorIncidentStateSchema,
  AdvisorInvocationStateSchema,
  AdvisorRecommendationStateSchema,
  AdvisorResolutionStateSchema,
  AdvisorSubjectStateSchema,
  DecisionPolicyPromotionStateSchema,
  DecisionPolicyProposalStateSchema,
  DecisionPolicyStateSchema
} from "./advisor-schema.js";

const EventRowSchema = z.strictObject({
  globalPosition: z.number().int().positive(),
  eventId: z.uuid(),
  commandId: z.uuid(),
  streamType: z.enum([
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
  ]),
  streamId: z.string().min(1),
  streamVersion: z.number().int().positive(),
  eventType: z.string().min(1),
  eventSchemaVersion: z.number().int().positive(),
  dataJson: z.string(),
  metadataJson: z.string(),
  occurredAt: z.iso.datetime({ offset: true })
});

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseJsonColumn(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`${label} is not stored as text`);
  return parseJson(value, label);
}

function readJsonStates<T>(
  database: SqliteDatabase,
  table: string,
  schema: z.ZodType<T>,
  label: string
): T[] {
  const rows = database.prepare(`SELECT state_json AS stateJson FROM ${table}`).all() as {
    stateJson: string;
  }[];
  return rows.map((row) => schema.parse(parseJson(row.stateJson, label)));
}

export function loadEvents(
  database: SqliteDatabase,
  afterPosition = 0,
  limit?: number
): StoredEvent[] {
  const sql = `
    SELECT global_position AS globalPosition, event_id AS eventId, command_id AS commandId,
      stream_type AS streamType, stream_id AS streamId, stream_version AS streamVersion,
      event_type AS eventType, event_schema_version AS eventSchemaVersion,
      data_json AS dataJson, metadata_json AS metadataJson, occurred_at AS occurredAt
    FROM events WHERE global_position > ? ORDER BY global_position
    ${limit === undefined ? "" : "LIMIT ?"}
  `;
  const rows =
    limit === undefined
      ? database.prepare(sql).all(afterPosition)
      : database.prepare(sql).all(afterPosition, limit);
  return rows.map((raw) => {
    const row = EventRowSchema.parse(raw);
    if (row.eventSchemaVersion !== 1) {
      throw new Error(`Unsupported event schema version ${String(row.eventSchemaVersion)}`);
    }
    if (!Object.hasOwn(EventPayloadSchemas, row.eventType)) {
      throw new Error(`Unknown event type ${row.eventType}`);
    }
    const type = row.eventType as EventType;
    const data = parseEventPayload(type, parseJson(row.dataJson, "Event payload"));
    if (type === "WorkflowDefinitionRegistered") {
      const workflow = EventPayloadSchemas.WorkflowDefinitionRegistered.parse(data);
      if (canonicalDigest(workflow.definition) !== workflow.definitionDigest) {
        throw new Error("Workflow event definition digest does not match its content");
      }
    }
    if (type === "ProgramApproved") {
      const approval = EventPayloadSchemas.ProgramApproved.parse(data);
      if (canonicalDigest(approval.intent) !== approval.intentDigest) {
        throw new Error("Program intent event digest does not match its content");
      }
    }
    if (type === "MilestoneApproved") {
      const approval = EventPayloadSchemas.MilestoneApproved.parse(data);
      if (canonicalDigest(approval.contract) !== approval.contractDigest) {
        throw new Error("Milestone contract event digest does not match its content");
      }
    }
    if (type === "OutcomePacketRecorded") {
      const record = EventPayloadSchemas.OutcomePacketRecorded.parse(data);
      if (canonicalDigest(record.packet) !== record.packetDigest) {
        throw new Error("Outcome packet event digest does not match its content");
      }
    }
    return {
      type,
      streamType: row.streamType,
      streamId: row.streamId,
      data,
      eventId: row.eventId,
      commandId: row.commandId,
      globalPosition: row.globalPosition,
      streamVersion: row.streamVersion,
      schemaVersion: 1,
      occurredAt: row.occurredAt,
      metadata: EventMetadataSchema.parse(parseJson(row.metadataJson, "Event metadata"))
    } as StoredEvent;
  });
}

export function readProjectionState(database: SqliteDatabase): ProjectionState {
  const state = emptyProjectionState();
  for (const raw of database
    .prepare(
      `SELECT program_id AS programId, name, status, intent_json AS intentJson,
        intent_digest AS intentDigest, approved_by AS approvedBy, approved_at AS approvedAt,
        program_mode AS programMode, phase, initial_source_revision_id AS initialSourceRevisionId,
        initial_source_revision_digest AS initialSourceRevisionDigest,
        active_graph_revision_id AS activeGraphRevisionId,
        active_graph_digest AS activeGraphDigest, started_at AS startedAt,
        attention_phase AS attentionPhase, attention_priority AS attentionPriority,
        portfolio_mode AS portfolioMode, portfolio_phase AS portfolioPhase,
        portfolio_resume_phase AS portfolioResumePhase,
        execution_request_id AS executionRequestId,
        execution_requested_at AS executionRequestedAt,
        execution_policy_json AS executionPolicyJson,
        created_at AS createdAt, version FROM programs_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = ProgramStateSchema.parse({
      kind: "program",
      programId: raw["programId"],
      name: raw["name"],
      status: raw["status"],
      intent:
        raw["intentJson"] === null ? null : parseJsonColumn(raw["intentJson"], "Program intent"),
      intentDigest: raw["intentDigest"],
      approvedBy: raw["approvedBy"],
      approvedAt: raw["approvedAt"],
      programMode: raw["portfolioMode"] === "graph_v2" ? "graph_v2" : raw["programMode"],
      phase:
        raw["attentionPhase"] === "parked" ? "parked" : (raw["portfolioPhase"] ?? raw["phase"]),
      resumePhase: raw["portfolioResumePhase"],
      executionRequestId: raw["executionRequestId"],
      executionRequestedAt: raw["executionRequestedAt"],
      executionPolicy:
        raw["executionPolicyJson"] === null
          ? null
          : parseJsonColumn(raw["executionPolicyJson"], "Program execution policy"),
      attentionPriority: raw["attentionPriority"],
      initialSourceRevisionId: raw["initialSourceRevisionId"],
      initialSourceRevisionDigest: raw["initialSourceRevisionDigest"],
      activeGraphRevisionId: raw["activeGraphRevisionId"],
      activeGraphDigest: raw["activeGraphDigest"],
      startedAt: raw["startedAt"],
      createdAt: raw["createdAt"],
      version: raw["version"]
    });
    state.programs.set(value.programId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT milestone_id AS milestoneId, program_id AS programId,
        contract_json AS contractJson, contract_digest AS contractDigest,
        workflow_digest AS workflowDigest, graph_revision_id AS graphRevisionId,
        dependencies_json AS dependenciesJson,
        source_predecessor_milestone_id AS sourcePredecessorMilestoneId,
        allowed_work_surfaces_json AS allowedWorkSurfacesJson,
        structured_work_surfaces_json AS structuredWorkSurfacesJson,
        resource_claim_ids_json AS resourceClaimsJson,
        capability_claims_json AS capabilityClaimsJson,
        status, generation, active_generation_id AS activeGenerationId,
        run_id AS runId, job_id AS jobId,
        base_revision_id AS baseRevisionId, outcome_packet_id AS outcomePacketId,
        latest_validated_outcome_packet_id AS latestValidatedOutcomePacketId,
        recommendation, approved_by AS approvedBy, approved_at AS approvedAt,
        pause_reason AS pauseReason, started_at AS startedAt, completed_at AS completedAt, version
       FROM milestones_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = MilestoneStateSchema.parse({
      kind: "milestone",
      milestoneId: raw["milestoneId"],
      programId: raw["programId"],
      contract: parseJsonColumn(raw["contractJson"], "Milestone contract"),
      contractDigest: raw["contractDigest"],
      workflowDigest: raw["workflowDigest"],
      graphRevisionId: raw["graphRevisionId"],
      dependencies: parseJsonColumn(raw["dependenciesJson"], "Milestone dependencies"),
      sourcePredecessorMilestoneId: raw["sourcePredecessorMilestoneId"],
      allowedWorkSurfaces: parseJsonColumn(
        raw["allowedWorkSurfacesJson"],
        "Milestone allowed work surfaces"
      ),
      structuredWorkSurfaces:
        raw["structuredWorkSurfacesJson"] === null
          ? []
          : parseJsonColumn(raw["structuredWorkSurfacesJson"], "Structured work surfaces"),
      resourceClaims:
        raw["resourceClaimsJson"] === null
          ? []
          : parseJsonColumn(raw["resourceClaimsJson"], "Milestone resource claims"),
      capabilityClaims:
        raw["capabilityClaimsJson"] === null
          ? []
          : parseJsonColumn(raw["capabilityClaimsJson"], "Milestone capability claims"),
      status: raw["status"],
      generation: raw["generation"],
      activeGenerationId: raw["activeGenerationId"],
      runId: raw["runId"],
      jobId: raw["jobId"],
      baseRevisionId: raw["baseRevisionId"],
      outcomePacketId: raw["outcomePacketId"],
      latestValidatedOutcomePacketId: raw["latestValidatedOutcomePacketId"],
      recommendation: raw["recommendation"],
      pauseReason: raw["pauseReason"],
      approvedBy: raw["approvedBy"],
      approvedAt: raw["approvedAt"],
      startedAt: raw["startedAt"],
      completedAt: raw["completedAt"],
      version: raw["version"]
    });
    if (canonicalDigest(value.contract) !== value.contractDigest) {
      throw new Error("Milestone projection contract digest does not match its content");
    }
    state.milestones.set(value.milestoneId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT workflow_id AS workflowId, version, name, definition_json AS definitionJson,
        definition_digest AS definitionDigest, registered_at AS registeredAt,
        stream_version AS streamVersion FROM workflows_projection`
    )
    .all() as Record<string, unknown>[]) {
    const definition = WorkflowDefinitionSchema.parse(
      parseJson(String(raw["definitionJson"]), "Workflow definition")
    );
    const value = WorkflowStateSchema.parse({
      kind: "workflow",
      workflowId: raw["workflowId"],
      version: raw["version"],
      name: raw["name"],
      definition,
      definitionDigest: raw["definitionDigest"],
      registeredAt: raw["registeredAt"],
      streamVersion: raw["streamVersion"]
    });
    if (canonicalDigest(value.definition) !== value.definitionDigest) {
      throw new Error("Workflow projection definition digest does not match its content");
    }
    state.workflows.set(workflowKey(value.workflowId, value.version), value);
  }
  for (const raw of database
    .prepare(
      `SELECT revision_id AS revisionId, repository_id AS repositoryId,
        object_format AS objectFormat, commit_oid AS commitOid, tree_oid AS treeOid,
        storage_ref AS storageRef, revision_digest AS revisionDigest,
        captured_at AS capturedAt, version FROM source_revisions_projection`
    )
    .all()) {
    const value = SourceRevisionStateSchema.parse({ kind: "source_revision", ...(raw as object) });
    state.sourceRevisions.set(value.revisionId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT run_id AS runId, program_id AS programId, workflow_id AS workflowId,
        workflow_version AS workflowVersion, milestone_id AS milestoneId,
        generation_id AS generationId, generation, status,
        created_at AS createdAt,
        scheduled_at AS scheduledAt, started_at AS startedAt, completed_at AS completedAt,
        cancelled_at AS cancelledAt, cancellation_reason AS cancellationReason,
        failure_reason AS failureReason, version FROM runs_projection`
    )
    .all()) {
    const value = RunStateSchema.parse({ kind: "run", ...(raw as object) });
    state.runs.set(value.runId, value);
  }
  const dependencies = new Map<string, string[]>();
  for (const row of database
    .prepare(
      `SELECT job_id AS jobId, depends_on_job_id AS dependsOnJobId
       FROM job_dependencies_projection ORDER BY job_id, dependency_ordinal`
    )
    .all() as { jobId: string; dependsOnJobId: string }[]) {
    dependencies.set(row.jobId, [...(dependencies.get(row.jobId) ?? []), row.dependsOnJobId]);
  }
  for (const raw of database
    .prepare(
      `SELECT job_id AS jobId, run_id AS runId, step_id AS stepId, capability, status,
        max_attempts AS maxAttempts, attempt_timeout_ms AS attemptTimeoutMs,
        retry_delays_json AS retryDelaysJson, attempt_count AS attemptCount,
        active_attempt_id AS activeAttemptId, available_at AS availableAt,
        lease_owner_id AS leaseOwnerId, lease_fencing_token AS leaseFencingToken,
        lease_acquired_at AS leaseAcquiredAt, lease_expires_at AS leaseExpiresAt,
        source_revision_id AS sourceRevisionId,
        execution_contract_json AS executionContractJson,
        execution_contract_digest AS executionContractDigest,
        capability_manifest_json AS capabilityManifestJson,
        capability_manifest_digest AS capabilityManifestDigest,
        context_packet_id AS contextPacketId, context_packet_digest AS contextPacketDigest,
        verifier_contract_json AS verifierContractJson,
        verifier_contract_digest AS verifierContractDigest,
        candidate_revision_id AS candidateRevisionId,
        created_at AS createdAt, completed_at AS completedAt, failure_reason AS failureReason,
        version FROM jobs_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = JobStateSchema.parse({
      kind: "job",
      jobId: raw["jobId"],
      runId: raw["runId"],
      stepId: raw["stepId"],
      capability: raw["capability"],
      dependencyJobIds: dependencies.get(String(raw["jobId"])) ?? [],
      status: raw["status"],
      policy: {
        maxAttempts: raw["maxAttempts"],
        attemptTimeoutMs: raw["attemptTimeoutMs"],
        retryDelaysMs: parseJson(String(raw["retryDelaysJson"]), "Job retry delays")
      },
      sourceRevisionId: raw["sourceRevisionId"],
      executionContract:
        raw["executionContractJson"] === null
          ? null
          : parseJsonColumn(raw["executionContractJson"], "Execution contract"),
      executionContractDigest: raw["executionContractDigest"],
      capabilityManifest:
        raw["capabilityManifestJson"] === null
          ? null
          : parseJsonColumn(raw["capabilityManifestJson"], "Capability manifest"),
      capabilityManifestDigest: raw["capabilityManifestDigest"],
      contextPacketId: raw["contextPacketId"],
      contextPacketDigest: raw["contextPacketDigest"],
      verifierContract:
        raw["verifierContractJson"] === null
          ? null
          : parseJsonColumn(raw["verifierContractJson"], "Verifier contract"),
      verifierContractDigest: raw["verifierContractDigest"],
      candidateRevisionId: raw["candidateRevisionId"],
      attemptCount: raw["attemptCount"],
      activeAttemptId: raw["activeAttemptId"],
      availableAt: raw["availableAt"],
      leaseOwnerId: raw["leaseOwnerId"],
      leaseFencingToken: raw["leaseFencingToken"],
      leaseAcquiredAt: raw["leaseAcquiredAt"],
      leaseExpiresAt: raw["leaseExpiresAt"],
      createdAt: raw["createdAt"],
      completedAt: raw["completedAt"],
      failureReason: raw["failureReason"],
      version: raw["version"]
    });
    state.jobs.set(value.jobId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT attempt_id AS attemptId, run_id AS runId, job_id AS jobId, ordinal, status,
        allocated_at AS allocatedAt, started_at AS startedAt, deadline_at AS deadlineAt,
        external_run_id AS externalRunId, driver_cursor AS driverCursor,
        cumulative_usage_json AS cumulativeUsageJson,
        candidate_revision_id AS candidateRevisionId, driver_receipt_id AS driverReceiptId,
        finished_at AS finishedAt,
        cancelled_at AS cancelledAt, cancellation_reason AS cancellationReason,
        termination_reason AS terminationReason, version FROM attempts_projection`
    )
    .all()) {
    const row = raw as Record<string, unknown>;
    const attempt = { ...row };
    delete attempt["cumulativeUsageJson"];
    const value = AttemptStateSchema.parse({
      kind: "attempt",
      ...attempt,
      cumulativeUsage:
        row["cumulativeUsageJson"] === null
          ? null
          : parseJsonColumn(row["cumulativeUsageJson"], "Attempt cumulative usage")
    });
    state.attempts.set(value.attemptId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT outbox_id AS outboxId, run_id AS runId, job_id AS jobId,
        attempt_id AS attemptId, effect_type AS effectType, effect_key AS effectKey,
        payload_json AS payloadJson,
        status, delivery_attempts AS deliveryAttempts, retry_delays_json AS retryDelaysJson,
        available_at AS availableAt, lease_owner_id AS leaseOwnerId,
        lease_fencing_token AS leaseFencingToken, lease_acquired_at AS leaseAcquiredAt,
        lease_expires_at AS leaseExpiresAt, external_effect_id AS externalEffectId,
        created_at AS createdAt, delivered_at AS deliveredAt, last_error AS lastError,
        version FROM outbox_projection`
    )
    .all() as Record<string, unknown>[]) {
    const effect = parseJson(String(raw["payloadJson"]), "Outbox payload");
    const value = OutboxStateSchema.parse({
      kind: "outbox",
      outboxId: raw["outboxId"],
      runId: raw["runId"],
      jobId: raw["jobId"],
      attemptId: raw["attemptId"],
      effectKey: raw["effectKey"],
      effect,
      status: raw["status"],
      deliveryAttempts: raw["deliveryAttempts"],
      retryDelaysMs: parseJson(String(raw["retryDelaysJson"]), "Outbox retry delays"),
      availableAt: raw["availableAt"],
      leaseOwnerId: raw["leaseOwnerId"],
      leaseFencingToken: raw["leaseFencingToken"],
      leaseAcquiredAt: raw["leaseAcquiredAt"],
      leaseExpiresAt: raw["leaseExpiresAt"],
      externalEffectId: raw["externalEffectId"],
      createdAt: raw["createdAt"],
      deliveredAt: raw["deliveredAt"],
      lastError: raw["lastError"],
      version: raw["version"]
    });
    if (value.effect.effectType !== raw["effectType"]) {
      throw new Error("Outbox projection effect type does not match its payload");
    }
    state.outbox.set(value.outboxId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT artifact_manifest_id AS artifactManifestId, run_id AS runId, job_id AS jobId,
        attempt_id AS attemptId, source_revision_id AS sourceRevisionId,
        producer,
        entries_json AS entriesJson, manifest_digest AS manifestDigest,
        total_bytes AS totalBytes, created_at AS createdAt, version
       FROM artifact_manifests_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = ArtifactManifestStateSchema.parse({
      kind: "artifact_manifest",
      artifactManifestId: raw["artifactManifestId"],
      runId: raw["runId"],
      jobId: raw["jobId"],
      attemptId: raw["attemptId"],
      sourceRevisionId: raw["sourceRevisionId"],
      producer: raw["producer"],
      entries: parseJson(String(raw["entriesJson"]), "Artifact entries"),
      manifestDigest: raw["manifestDigest"],
      totalBytes: raw["totalBytes"],
      createdAt: raw["createdAt"],
      version: raw["version"]
    });
    state.artifactManifests.set(value.artifactManifestId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT verification_id AS verificationId, run_id AS runId, job_id AS jobId,
        attempt_id AS attemptId, workflow_id AS workflowId,
        workflow_version AS workflowVersion, workflow_digest AS workflowDigest,
        source_revision_id AS sourceRevisionId,
        verifier_contract_digest AS verifierContractDigest,
        artifact_manifest_id AS artifactManifestId, status, result_json AS resultJson,
        result_digest AS resultDigest, receipt_digest AS receiptDigest, exit_code AS exitCode,
        failure_reason AS failureReason, requested_at AS requestedAt,
        completed_at AS completedAt, version FROM verifications_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = VerificationStateSchema.parse({
      kind: "verification",
      verificationId: raw["verificationId"],
      runId: raw["runId"],
      jobId: raw["jobId"],
      attemptId: raw["attemptId"],
      workflowId: raw["workflowId"],
      workflowVersion: raw["workflowVersion"],
      workflowDigest: raw["workflowDigest"],
      sourceRevisionId: raw["sourceRevisionId"],
      verifierContractDigest: raw["verifierContractDigest"],
      artifactManifestId: raw["artifactManifestId"],
      status: raw["status"],
      result:
        raw["resultJson"] === null
          ? null
          : parseJsonColumn(raw["resultJson"], "Verification result"),
      resultDigest: raw["resultDigest"],
      receiptDigest: raw["receiptDigest"],
      exitCode: raw["exitCode"],
      failureReason: raw["failureReason"],
      requestedAt: raw["requestedAt"],
      completedAt: raw["completedAt"],
      version: raw["version"]
    });
    state.verifications.set(value.verificationId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT driver_receipt_id AS driverReceiptId, run_id AS runId, job_id AS jobId,
        attempt_id AS attemptId, base_revision_id AS baseRevisionId,
        candidate_revision_id AS candidateRevisionId, receipt_json AS receiptJson,
        receipt_digest AS receiptDigest, outcome, terminal_reason AS terminalReason,
        recorded_at AS recordedAt, version FROM driver_receipts_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = DriverReceiptStateSchema.parse({
      kind: "driver_receipt",
      driverReceiptId: raw["driverReceiptId"],
      runId: raw["runId"],
      jobId: raw["jobId"],
      attemptId: raw["attemptId"],
      baseRevisionId: raw["baseRevisionId"],
      candidateRevisionId: raw["candidateRevisionId"],
      receipt: parseJson(String(raw["receiptJson"]), "Driver receipt"),
      receiptDigest: raw["receiptDigest"],
      outcome: raw["outcome"],
      terminalReason: raw["terminalReason"],
      recordedAt: raw["recordedAt"],
      version: raw["version"]
    });
    state.driverReceipts.set(value.driverReceiptId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT approval_request_id AS approvalRequestId, run_id AS runId, job_id AS jobId,
        attempt_id AS attemptId, capability, reason, sequence,
        requested_at AS requestedAt, version FROM approval_requests_projection`
    )
    .all()) {
    const value = ApprovalRequestStateSchema.parse({
      kind: "approval_request",
      ...(raw as object)
    });
    state.approvalRequests.set(value.approvalRequestId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT outcome_packet_id AS outcomePacketId, program_id AS programId,
        milestone_id AS milestoneId, generation_id AS generationId, generation,
        run_id AS runId, packet_json AS packetJson,
        packet_digest AS packetDigest, recorded_at AS recordedAt, version
       FROM outcome_packets_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = OutcomePacketStateSchema.parse({
      kind: "outcome_packet",
      outcomePacketId: raw["outcomePacketId"],
      programId: raw["programId"],
      milestoneId: raw["milestoneId"],
      generationId: raw["generationId"],
      generation: raw["generation"],
      runId: raw["runId"],
      packet: parseJsonColumn(raw["packetJson"], "Outcome packet"),
      packetDigest: raw["packetDigest"],
      recordedAt: raw["recordedAt"],
      version: raw["version"]
    });
    if (canonicalDigest(value.packet) !== value.packetDigest) {
      throw new Error("Outcome packet projection digest does not match its content");
    }
    state.outcomePackets.set(value.outcomePacketId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT interview_id AS interviewId, program_id AS programId,
        transcript_json AS transcriptJson, transcript_digest AS transcriptDigest,
        playback_json AS playbackJson, playback_digest AS playbackDigest,
        captured_at AS capturedAt, version FROM program_interviews_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = ProgramInterviewStateSchema.parse({
      kind: "program_interview",
      interviewId: raw["interviewId"],
      programId: raw["programId"],
      transcript: parseJsonColumn(raw["transcriptJson"], "Interview transcript"),
      transcriptDigest: raw["transcriptDigest"],
      playback: parseJsonColumn(raw["playbackJson"], "Intent playback"),
      playbackDigest: raw["playbackDigest"],
      capturedAt: raw["capturedAt"],
      version: raw["version"]
    });
    if (
      canonicalDigest(value.transcript) !== value.transcriptDigest ||
      canonicalDigest(value.playback) !== value.playbackDigest
    ) {
      throw new Error("Interview projection digest does not match its content");
    }
    state.programInterviews.set(value.interviewId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT graph_revision_id AS graphRevisionId, program_id AS programId, revision,
        prior_graph_revision_id AS priorGraphRevisionId, graph_json AS graphJson,
        graph_digest AS graphDigest, approved_by AS approvedBy, approved_at AS approvedAt,
        superseded_at AS supersededAt, version FROM program_graphs_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = ProgramGraphStateSchema.parse({
      kind: "program_graph",
      graphRevisionId: raw["graphRevisionId"],
      programId: raw["programId"],
      revision: raw["revision"],
      priorGraphRevisionId: raw["priorGraphRevisionId"],
      graph: parseJsonColumn(raw["graphJson"], "Program graph"),
      graphDigest: raw["graphDigest"],
      approvedBy: raw["approvedBy"],
      approvedAt: raw["approvedAt"],
      supersededAt: raw["supersededAt"],
      version: raw["version"]
    });
    if (canonicalDigest(value.graph) !== value.graphDigest) {
      throw new Error("Program graph projection digest does not match its content");
    }
    state.programGraphs.set(value.graphRevisionId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT generation_id AS generationId, program_id AS programId,
        milestone_id AS milestoneId, graph_revision_id AS graphRevisionId, generation,
        run_id AS runId, job_id AS jobId, context_packet_id AS contextPacketId,
        base_revision_id AS baseRevisionId, status, outcome_packet_id AS outcomePacketId,
        recommendation, started_at AS startedAt, completed_at AS completedAt, version
       FROM milestone_generations_projection`
    )
    .all()) {
    const value = MilestoneGenerationStateSchema.parse({
      kind: "milestone_generation",
      ...(raw as object)
    });
    state.milestoneGenerations.set(value.generationId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT context_packet_id AS contextPacketId, program_id AS programId,
        milestone_id AS milestoneId, generation_id AS generationId, packet_json AS packetJson,
        packet_digest AS packetDigest, compiled_at AS compiledAt, version
       FROM context_packets_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = ContextPacketStateSchema.parse({
      kind: "context_packet",
      contextPacketId: raw["contextPacketId"],
      programId: raw["programId"],
      milestoneId: raw["milestoneId"],
      generationId: raw["generationId"],
      packet: parseJsonColumn(raw["packetJson"], "Context packet"),
      packetDigest: raw["packetDigest"],
      compiledAt: raw["compiledAt"],
      version: raw["version"]
    });
    if (canonicalDigest(value.packet) !== value.packetDigest) {
      throw new Error("Context packet projection digest does not match its content");
    }
    state.contextPackets.set(value.contextPacketId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT validation_id AS validationId, program_id AS programId,
        milestone_id AS milestoneId, outcome_packet_id AS outcomePacketId,
        packet_digest AS packetDigest, validation_json AS validationJson,
        validation_digest AS validationDigest, validated_at AS validatedAt, version
       FROM outcome_validations_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = OutcomeValidationStateSchema.parse({
      kind: "outcome_validation",
      validationId: raw["validationId"],
      programId: raw["programId"],
      milestoneId: raw["milestoneId"],
      outcomePacketId: raw["outcomePacketId"],
      packetDigest: raw["packetDigest"],
      validation: parseJsonColumn(raw["validationJson"], "Outcome validation"),
      validationDigest: raw["validationDigest"],
      validatedAt: raw["validatedAt"],
      version: raw["version"]
    });
    if (canonicalDigest(value.validation) !== value.validationDigest) {
      throw new Error("Outcome validation projection digest does not match its content");
    }
    state.outcomeValidations.set(value.validationId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT issue_json AS issueJson, issue_digest AS issueDigest, version FROM routed_issues_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = RoutedIssueStateSchema.parse({
      kind: "routed_issue",
      issue: parseJsonColumn(raw["issueJson"], "Routed issue"),
      issueDigest: raw["issueDigest"],
      version: raw["version"]
    });
    if (canonicalDigest(value.issue) !== value.issueDigest) {
      throw new Error("Routed issue projection digest does not match its content");
    }
    state.routedIssues.set(value.issue.issueId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT attention_span_id AS attentionSpanId, program_id AS programId,
        actor_id AS actorId, label, started_at AS startedAt, stopped_at AS stoppedAt, version
       FROM attention_spans_projection`
    )
    .all()) {
    const value = AttentionSpanStateSchema.parse({ kind: "attention_span", ...(raw as object) });
    state.attentionSpans.set(value.attentionSpanId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT outcome_packet_id AS outcomePacketId, program_id AS programId, disposition,
        reason, actor_id AS actorId, recorded_at AS recordedAt, version
       FROM outcome_dispositions_projection`
    )
    .all()) {
    const rawValue = raw as Record<string, unknown>;
    const value = OutcomeDispositionStateSchema.parse({
      kind: "outcome_disposition",
      disposition: {
        schemaVersion: 1,
        outcomePacketId: rawValue["outcomePacketId"],
        programId: rawValue["programId"],
        disposition: rawValue["disposition"],
        reason: rawValue["reason"],
        actorId: rawValue["actorId"],
        recordedAt: rawValue["recordedAt"]
      },
      version: rawValue["version"]
    });
    state.outcomeDispositions.set(value.disposition.outcomePacketId, value);
  }
  for (const raw of database
    .prepare(
      `SELECT report_json AS reportJson, report_digest AS reportDigest, version
       FROM measurement_reports_projection`
    )
    .all() as Record<string, unknown>[]) {
    const value = MeasurementReportStateSchema.parse({
      kind: "measurement_report",
      report: parseJsonColumn(raw["reportJson"], "Measurement report"),
      reportDigest: raw["reportDigest"],
      version: raw["version"]
    });
    if (canonicalDigest(value.report) !== value.reportDigest) {
      throw new Error("Measurement report projection digest does not match its content");
    }
    state.measurementReports.set(value.report.reportId, value);
  }
  for (const value of readJsonStates(
    database,
    "operator_decision_requests_projection",
    OperatorDecisionRequestStateSchema,
    "Operator decision request"
  )) {
    if (canonicalDigest(value.request) !== value.requestDigest) {
      throw new Error("Operator decision request projection digest does not match its content");
    }
    state.operatorDecisionRequests.set(value.request.requestId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_packets_projection",
    DecisionPacketStateSchema,
    "Decision packet"
  )) {
    state.decisionPackets.set(value.packetId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_packet_revisions_projection",
    DecisionPacketRevisionStateSchema,
    "Decision packet revision"
  )) {
    if (canonicalDigest(value.revision) !== value.revisionDigest) {
      throw new Error("Decision packet revision projection digest does not match its content");
    }
    state.decisionPacketRevisions.set(value.revision.packetRevisionId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_evidence_bundles_projection",
    DecisionEvidenceBundleStateSchema,
    "Decision evidence bundle"
  )) {
    if (canonicalDigest(value.bundle) !== value.bundleDigest) {
      throw new Error("Decision evidence bundle projection digest does not match its content");
    }
    state.decisionEvidenceBundles.set(value.bundle.evidenceBundleId, value);
  }
  for (const value of readJsonStates(
    database,
    "attention_policies_projection",
    AttentionPolicyStateSchema,
    "Attention policy"
  )) {
    if (canonicalDigest(value.policy) !== value.policyDigest) {
      throw new Error("Attention policy projection digest does not match its content");
    }
    state.attentionPolicies.set(value.policy.policyRevisionId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_acknowledgements_projection",
    DecisionAcknowledgementStateSchema,
    "Decision acknowledgement"
  )) {
    if (canonicalDigest(value.acknowledgement) !== value.acknowledgementDigest) {
      throw new Error("Decision acknowledgement projection digest does not match its content");
    }
    state.decisionAcknowledgements.set(value.acknowledgement.acknowledgementId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_resolutions_projection",
    DecisionResolutionStateSchema,
    "Decision resolution"
  )) {
    if (canonicalDigest(value.resolution) !== value.resolutionDigest) {
      throw new Error("Decision resolution projection digest does not match its content");
    }
    state.decisionResolutions.set(value.resolution.resolutionId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_action_results_projection",
    DecisionActionResultStateSchema,
    "Decision action result"
  )) {
    if (canonicalDigest(value.result) !== value.resultDigest) {
      throw new Error("Decision action result projection digest does not match its content");
    }
    state.decisionActionResults.set(value.result.actionResultId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_precedents_projection",
    DecisionPrecedentStateSchema,
    "Decision precedent"
  )) {
    if (canonicalDigest(value.precedent) !== value.precedentDigest) {
      throw new Error("Decision precedent projection digest does not match its content");
    }
    state.decisionPrecedents.set(value.precedent.precedentId, value);
  }
  for (const value of readJsonStates(
    database,
    "attention_deliveries_projection",
    AttentionDeliveryStateSchema,
    "Attention delivery"
  )) {
    state.attentionDeliveries.set(value.delivery.deliveryId, value);
  }
  for (const value of readJsonStates(
    database,
    "attention_budget_incidents_projection",
    AttentionBudgetIncidentStateSchema,
    "Attention budget incident"
  )) {
    if (canonicalDigest(value.incident) !== value.incidentDigest) {
      throw new Error("Attention budget incident projection digest does not match its content");
    }
    state.attentionBudgetIncidents.set(value.incident.incidentId, value);
  }
  for (const value of readJsonStates(
    database,
    "attention_measurement_reports_projection",
    AttentionMeasurementReportStateSchema,
    "Attention measurement report"
  )) {
    if (canonicalDigest(value.report) !== value.reportDigest) {
      throw new Error("Attention measurement report projection digest does not match its content");
    }
    state.attentionMeasurementReports.set(value.report.reportId, value);
  }
  for (const value of readJsonStates(
    database,
    "attention_digest_artifacts_projection",
    AttentionDigestArtifactStateSchema,
    "Attention digest artifact"
  )) {
    if (canonicalDigest(value.artifact) !== value.artifactDigest) {
      throw new Error("Attention digest artifact projection digest does not match its content");
    }
    state.attentionDigestArtifacts.set(value.artifact.artifactId, value);
  }
  for (const value of readJsonStates(
    database,
    "portfolio_policies_projection",
    PortfolioPolicyStateSchema,
    "Portfolio policy"
  )) {
    if (canonicalDigest(value.policy) !== value.policyDigest) {
      throw new Error("Portfolio policy projection digest does not match its content");
    }
    state.portfolioPolicies.set(value.policy.policyRevisionId, value);
  }
  for (const value of readJsonStates(
    database,
    "integration_targets_projection",
    IntegrationTargetStateSchema,
    "Integration target"
  )) {
    if (canonicalDigest(value.target) !== value.targetDigest) {
      throw new Error("Integration target projection digest does not match its content");
    }
    state.integrationTargets.set(value.target.targetRevisionId, value);
  }
  for (const value of readJsonStates(
    database,
    "portfolio_admissions_projection",
    PortfolioAdmissionStateSchema,
    "Portfolio admission"
  )) {
    if (canonicalDigest(value.admission) !== value.admissionDigest) {
      throw new Error("Portfolio admission projection digest does not match its content");
    }
    state.portfolioAdmissions.set(value.admission.admissionId, value);
  }
  for (const value of readJsonStates(
    database,
    "concurrency_leases_projection",
    ConcurrencyLeaseStateSchema,
    "Concurrency lease"
  )) {
    if (canonicalDigest(value.lease) !== value.leaseDigest) {
      throw new Error("Concurrency lease projection digest does not match its content");
    }
    state.concurrencyLeases.set(value.lease.leaseId, value);
  }
  for (const value of readJsonStates(
    database,
    "candidate_diff_manifests_projection",
    CandidateDiffManifestStateSchema,
    "Candidate diff manifest"
  )) {
    if (canonicalDigest(value.manifest) !== value.manifestDigest) {
      throw new Error("Candidate diff manifest projection digest does not match its content");
    }
    state.candidateDiffManifests.set(value.manifest.manifestId, value);
  }
  for (const value of readJsonStates(
    database,
    "integration_candidates_projection",
    IntegrationCandidateStateSchema,
    "Integration candidate"
  )) {
    if (canonicalDigest(value.candidate) !== value.candidateDigest) {
      throw new Error("Integration candidate projection digest does not match its content");
    }
    state.integrationCandidates.set(value.candidate.candidateId, value);
  }
  for (const value of readJsonStates(
    database,
    "integration_work_projection",
    IntegrationWorkStateSchema,
    "Integration work"
  )) {
    if (canonicalDigest(value.work) !== value.workDigest) {
      throw new Error("Integration work projection digest does not match its content");
    }
    state.integrationWork.set(value.work.workId, value);
  }
  for (const value of readJsonStates(
    database,
    "integration_conflicts_projection",
    IntegrationConflictStateSchema,
    "Integration conflict"
  )) {
    if (canonicalDigest(value.conflict) !== value.conflictDigest) {
      throw new Error("Integration conflict projection digest does not match its content");
    }
    state.integrationConflicts.set(value.conflict.conflictId, value);
  }
  for (const value of readJsonStates(
    database,
    "integration_verifications_projection",
    IntegrationVerificationStateSchema,
    "Integration verification"
  )) {
    if (canonicalDigest(value.verification) !== value.verificationDigest) {
      throw new Error("Integration verification projection digest does not match its content");
    }
    state.integrationVerifications.set(value.verification.integrationVerificationId, value);
  }
  for (const value of readJsonStates(
    database,
    "promotion_receipts_projection",
    PromotionReceiptStateSchema,
    "Promotion receipt"
  )) {
    if (canonicalDigest(value.receipt) !== value.receiptDigest) {
      throw new Error("Promotion receipt projection digest does not match its content");
    }
    state.promotionReceipts.set(value.receipt.receiptId, value);
  }
  for (const value of readJsonStates(
    database,
    "portfolio_slo_incidents_projection",
    PortfolioSloIncidentStateSchema,
    "Portfolio SLO incident"
  )) {
    if (canonicalDigest(value.incident) !== value.incidentDigest) {
      throw new Error("Portfolio SLO incident projection digest does not match its content");
    }
    state.portfolioSloIncidents.set(value.incident.incidentId, value);
  }
  for (const value of readJsonStates(
    database,
    "portfolio_measurement_reports_projection",
    PortfolioMeasurementReportStateSchema,
    "Portfolio measurement report"
  )) {
    if (canonicalDigest(value.report) !== value.reportDigest) {
      throw new Error("Portfolio measurement report projection digest does not match its content");
    }
    state.portfolioMeasurementReports.set(value.report.reportId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_subjects_projection",
    AdvisorSubjectStateSchema,
    "Advisor subject"
  )) {
    if (canonicalDigest(value.subject) !== value.subjectDigest) {
      throw new Error("Advisor subject projection digest does not match its content");
    }
    state.advisorSubjects.set(value.subject.subjectId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_cases_projection",
    AdvisorCaseStateSchema,
    "Advisor case"
  )) {
    if (
      canonicalDigest(value.case) !== value.caseDigest ||
      canonicalDigest(value.case.input) !== value.case.inputDigest
    ) {
      throw new Error("Advisor case projection digest does not match its content");
    }
    state.advisorCases.set(value.case.caseId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_corpora_projection",
    AdvisorCorpusStateSchema,
    "Advisor corpus"
  )) {
    if (canonicalDigest(value.corpus) !== value.corpusDigest) {
      throw new Error("Advisor corpus projection digest does not match its content");
    }
    state.advisorCorpora.set(value.corpus.corpusRevisionId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_contamination_projection",
    AdvisorContaminationStateSchema,
    "Advisor contamination"
  )) {
    if (canonicalDigest(value.contamination) !== value.contaminationDigest) {
      throw new Error("Advisor contamination projection digest does not match its content");
    }
    state.advisorContamination.set(value.contamination.contaminationId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_invocations_projection",
    AdvisorInvocationStateSchema,
    "Advisor invocation"
  )) {
    if (canonicalDigest(value.invocation) !== value.invocationDigest) {
      throw new Error("Advisor invocation projection digest does not match its content");
    }
    state.advisorInvocations.set(value.invocation.invocationId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_recommendations_projection",
    AdvisorRecommendationStateSchema,
    "Advisor recommendation"
  )) {
    if (canonicalDigest(value.recommendation) !== value.recommendationDigest) {
      throw new Error("Advisor recommendation projection digest does not match its content");
    }
    state.advisorRecommendations.set(value.recommendation.recommendationId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_evaluations_projection",
    AdvisorEvaluationStateSchema,
    "Advisor evaluation"
  )) {
    if (canonicalDigest(value.report) !== value.reportDigest) {
      throw new Error("Advisor evaluation projection digest does not match its content");
    }
    state.advisorEvaluations.set(value.report.reportId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_policy_proposals_projection",
    DecisionPolicyProposalStateSchema,
    "Decision policy proposal"
  )) {
    if (canonicalDigest(value.proposal) !== value.proposalDigest) {
      throw new Error("Decision policy proposal projection digest does not match its content");
    }
    state.decisionPolicyProposals.set(value.proposal.proposalId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_policies_projection",
    DecisionPolicyStateSchema,
    "Decision policy"
  )) {
    if (canonicalDigest(value.policy) !== value.policyDigest) {
      throw new Error("Decision policy projection digest does not match its content");
    }
    state.decisionPolicies.set(value.policy.policyRevisionId, value);
  }
  for (const value of readJsonStates(
    database,
    "decision_policy_promotions_projection",
    DecisionPolicyPromotionStateSchema,
    "Decision policy promotion"
  )) {
    if (canonicalDigest(value.promotion) !== value.promotionDigest) {
      throw new Error("Decision policy promotion projection digest does not match its content");
    }
    state.decisionPolicyPromotions.set(value.promotion.promotionId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_resolutions_projection",
    AdvisorResolutionStateSchema,
    "Advisor resolution"
  )) {
    if (canonicalDigest(value.resolution) !== value.resolutionDigest) {
      throw new Error("Advisor resolution projection digest does not match its content");
    }
    state.advisorResolutions.set(value.resolution.resolutionId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_audits_projection",
    AdvisorAuditStateSchema,
    "Advisor audit"
  )) {
    if (canonicalDigest(value.audit) !== value.auditDigest) {
      throw new Error("Advisor audit projection digest does not match its content");
    }
    state.advisorAudits.set(value.audit.auditId, value);
  }
  for (const value of readJsonStates(
    database,
    "advisor_incidents_projection",
    AdvisorIncidentStateSchema,
    "Advisor incident"
  )) {
    if (canonicalDigest(value.incident) !== value.incidentDigest) {
      throw new Error("Advisor incident projection digest does not match its content");
    }
    state.advisorIncidents.set(value.incident.incidentId, value);
  }
  const meta = database
    .prepare(
      "SELECT last_applied_position AS lastAppliedPosition FROM projection_meta WHERE singleton = 1"
    )
    .get() as { lastAppliedPosition: number } | undefined;
  if (!meta) throw new Error("Projection metadata is missing");
  state.lastAppliedPosition = meta.lastAppliedPosition;
  return state;
}

export function writeProjectionState(database: SqliteDatabase, state: ProjectionState): void {
  database.prepare("DELETE FROM advisor_incidents_projection").run();
  database.prepare("DELETE FROM advisor_audits_projection").run();
  database.prepare("DELETE FROM advisor_resolutions_projection").run();
  database.prepare("DELETE FROM decision_policy_promotions_projection").run();
  database.prepare("DELETE FROM decision_policies_projection").run();
  database.prepare("DELETE FROM decision_policy_proposals_projection").run();
  database.prepare("DELETE FROM advisor_evaluations_projection").run();
  database.prepare("DELETE FROM advisor_recommendations_projection").run();
  database.prepare("DELETE FROM advisor_invocations_projection").run();
  database.prepare("DELETE FROM advisor_contamination_projection").run();
  database.prepare("DELETE FROM advisor_corpora_projection").run();
  database.prepare("DELETE FROM advisor_cases_projection").run();
  database.prepare("DELETE FROM advisor_subjects_projection").run();
  database.prepare("DELETE FROM portfolio_measurement_reports_projection").run();
  database.prepare("DELETE FROM portfolio_slo_incidents_projection").run();
  database.prepare("DELETE FROM promotion_receipts_projection").run();
  database.prepare("DELETE FROM integration_verifications_projection").run();
  database.prepare("DELETE FROM integration_conflicts_projection").run();
  database.prepare("DELETE FROM integration_work_projection").run();
  database.prepare("DELETE FROM integration_candidates_projection").run();
  database.prepare("DELETE FROM candidate_diff_manifests_projection").run();
  database.prepare("DELETE FROM concurrency_leases_projection").run();
  database.prepare("DELETE FROM portfolio_admissions_projection").run();
  database.prepare("DELETE FROM integration_targets_projection").run();
  database.prepare("DELETE FROM portfolio_policies_projection").run();
  database.prepare("DELETE FROM attention_digest_artifacts_projection").run();
  database.prepare("DELETE FROM attention_measurement_reports_projection").run();
  database.prepare("DELETE FROM attention_budget_incidents_projection").run();
  database.prepare("DELETE FROM attention_deliveries_projection").run();
  database.prepare("DELETE FROM decision_precedents_projection").run();
  database.prepare("DELETE FROM decision_action_results_projection").run();
  database.prepare("DELETE FROM decision_resolutions_projection").run();
  database.prepare("DELETE FROM decision_acknowledgements_projection").run();
  database.prepare("DELETE FROM attention_policies_projection").run();
  database.prepare("DELETE FROM decision_evidence_bundles_projection").run();
  database.prepare("DELETE FROM decision_packet_revisions_projection").run();
  database.prepare("DELETE FROM decision_packets_projection").run();
  database.prepare("DELETE FROM operator_decision_requests_projection").run();
  database.prepare("DELETE FROM measurement_reports_projection").run();
  database.prepare("DELETE FROM attention_spans_projection").run();
  database.prepare("DELETE FROM outcome_dispositions_projection").run();
  database.prepare("DELETE FROM routed_issues_projection").run();
  database.prepare("DELETE FROM outcome_validations_projection").run();
  database.prepare("DELETE FROM context_packets_projection").run();
  database.prepare("DELETE FROM milestone_generations_projection").run();
  database.prepare("DELETE FROM program_graphs_projection").run();
  database.prepare("DELETE FROM program_interviews_projection").run();
  database.prepare("DELETE FROM outcome_packets_projection").run();
  database.prepare("DELETE FROM approval_requests_projection").run();
  database.prepare("DELETE FROM driver_receipts_projection").run();
  database.prepare("DELETE FROM verifications_projection").run();
  database.prepare("DELETE FROM artifact_manifests_projection").run();
  database.prepare("DELETE FROM outbox_projection").run();
  database.prepare("DELETE FROM attempts_projection").run();
  database.prepare("DELETE FROM job_dependencies_projection").run();
  database.prepare("DELETE FROM jobs_projection").run();
  database.prepare("DELETE FROM runs_projection").run();
  database.prepare("DELETE FROM milestones_projection").run();
  database.prepare("DELETE FROM workflows_projection").run();
  database.prepare("DELETE FROM programs_projection").run();
  database.prepare("DELETE FROM source_revisions_projection").run();

  const insertProgram = database.prepare(
    `INSERT INTO programs_projection
      (program_id, name, status, intent_json, intent_digest, approved_by, approved_at,
       program_mode, phase, initial_source_revision_id, initial_source_revision_digest,
       active_graph_revision_id, active_graph_digest, started_at, attention_phase,
       attention_priority, portfolio_mode, portfolio_phase, portfolio_resume_phase,
       execution_request_id, execution_requested_at, execution_policy_json, created_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.programs.values()) {
    const baseProgramMode =
      value.programMode === "graph_v2" ? "graph_v1" : (value.programMode ?? "legacy_v1");
    const basePhase =
      value.programMode === "graph_v2"
        ? value.phase === "completed"
          ? "completed"
          : value.phase === "running"
            ? "running"
            : "approved"
        : value.phase === "parked"
          ? "running"
          : (value.phase ?? "legacy_active");
    insertProgram.run(
      value.programId,
      value.name,
      value.status,
      value.intent === null ? null : canonicalJson(value.intent),
      value.intentDigest,
      value.approvedBy,
      value.approvedAt,
      baseProgramMode,
      basePhase,
      value.initialSourceRevisionId ?? null,
      value.initialSourceRevisionDigest ?? null,
      value.activeGraphRevisionId ?? null,
      value.activeGraphDigest ?? null,
      value.startedAt ?? null,
      value.phase === "parked" ? "parked" : null,
      value.attentionPriority ?? "p2",
      value.programMode === "graph_v2" ? "graph_v2" : null,
      value.programMode === "graph_v2" && value.phase !== "parked" ? value.phase : null,
      value.resumePhase ?? null,
      value.executionRequestId ?? null,
      value.executionRequestedAt ?? null,
      value.executionPolicy === null || value.executionPolicy === undefined
        ? null
        : canonicalJson(value.executionPolicy),
      value.createdAt,
      value.version
    );
  }
  const insertMilestone = database.prepare(
    `INSERT INTO milestones_projection
      (milestone_id, program_id, contract_json, contract_digest, workflow_digest, status,
       graph_revision_id, dependencies_json, source_predecessor_milestone_id,
       allowed_work_surfaces_json, structured_work_surfaces_json, resource_claim_ids_json,
       capability_claims_json, generation, active_generation_id,
       run_id, job_id, base_revision_id, outcome_packet_id,
       latest_validated_outcome_packet_id, recommendation, pause_reason, approved_by,
       approved_at, started_at, completed_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.milestones.values()) {
    insertMilestone.run(
      value.milestoneId,
      value.programId,
      canonicalJson(value.contract),
      value.contractDigest,
      value.workflowDigest,
      value.status,
      value.graphRevisionId ?? null,
      canonicalJson(value.dependencies ?? []),
      value.sourcePredecessorMilestoneId ?? null,
      canonicalJson(value.allowedWorkSurfaces ?? []),
      canonicalJson(value.structuredWorkSurfaces ?? []),
      canonicalJson(value.resourceClaims ?? []),
      canonicalJson(value.capabilityClaims ?? []),
      value.generation ?? 0,
      value.activeGenerationId ?? null,
      value.runId,
      value.jobId,
      value.baseRevisionId,
      value.outcomePacketId,
      value.latestValidatedOutcomePacketId ?? null,
      value.recommendation,
      value.pauseReason ?? null,
      value.approvedBy,
      value.approvedAt,
      value.startedAt,
      value.completedAt,
      value.version
    );
  }
  const insertWorkflow = database.prepare(
    `INSERT INTO workflows_projection
      (workflow_id, version, name, definition_json, definition_digest, registered_at, stream_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.workflows.values()) {
    insertWorkflow.run(
      value.workflowId,
      value.version,
      value.name,
      canonicalJson(value.definition),
      value.definitionDigest,
      value.registeredAt,
      value.streamVersion
    );
  }
  const insertRevision = database.prepare(
    `INSERT INTO source_revisions_projection
      (revision_id, repository_id, object_format, commit_oid, tree_oid, storage_ref,
       revision_digest, captured_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.sourceRevisions.values()) {
    insertRevision.run(
      value.revisionId,
      value.repositoryId,
      value.objectFormat,
      value.commitOid,
      value.treeOid,
      value.storageRef,
      value.revisionDigest,
      value.capturedAt,
      value.version
    );
  }
  const insertRun = database.prepare(
    `INSERT INTO runs_projection
      (run_id, program_id, workflow_id, workflow_version, milestone_id, status,
       generation_id, generation, created_at, scheduled_at,
       started_at, completed_at, cancelled_at, cancellation_reason, failure_reason, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.runs.values()) {
    insertRun.run(
      value.runId,
      value.programId,
      value.workflowId,
      value.workflowVersion,
      value.milestoneId,
      value.status,
      value.generationId ?? null,
      value.generation ?? null,
      value.createdAt,
      value.scheduledAt,
      value.startedAt,
      value.completedAt,
      value.cancelledAt,
      value.cancellationReason,
      value.failureReason,
      value.version
    );
  }
  const insertJob = database.prepare(
    `INSERT INTO jobs_projection
      (job_id, run_id, step_id, capability, status, max_attempts, attempt_timeout_ms,
       retry_delays_json, attempt_count, active_attempt_id, available_at, lease_owner_id,
       lease_fencing_token, lease_acquired_at, lease_expires_at, created_at, completed_at,
       failure_reason, source_revision_id, execution_contract_json, execution_contract_digest,
       capability_manifest_json, capability_manifest_digest, verifier_contract_json,
       verifier_contract_digest, context_packet_id, context_packet_digest,
       candidate_revision_id, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.jobs.values()) {
    insertJob.run(
      value.jobId,
      value.runId,
      value.stepId,
      value.capability,
      value.status,
      value.policy.maxAttempts,
      value.policy.attemptTimeoutMs,
      canonicalJson(value.policy.retryDelaysMs),
      value.attemptCount,
      value.activeAttemptId,
      value.availableAt,
      value.leaseOwnerId,
      value.leaseFencingToken,
      value.leaseAcquiredAt,
      value.leaseExpiresAt,
      value.createdAt,
      value.completedAt,
      value.failureReason,
      value.sourceRevisionId,
      value.executionContract === null ? null : canonicalJson(value.executionContract),
      value.executionContractDigest,
      value.capabilityManifest === null ? null : canonicalJson(value.capabilityManifest),
      value.capabilityManifestDigest,
      value.verifierContract === null ? null : canonicalJson(value.verifierContract),
      value.verifierContractDigest,
      value.contextPacketId ?? null,
      value.contextPacketDigest ?? null,
      value.candidateRevisionId,
      value.version
    );
  }
  const insertDependency = database.prepare(
    `INSERT INTO job_dependencies_projection
      (job_id, depends_on_job_id, dependency_ordinal) VALUES (?, ?, ?)`
  );
  for (const value of state.jobs.values()) {
    for (const [index, dependencyId] of value.dependencyJobIds.entries()) {
      insertDependency.run(value.jobId, dependencyId, index);
    }
  }
  const insertAttempt = database.prepare(
    `INSERT INTO attempts_projection
      (attempt_id, run_id, job_id, ordinal, status, allocated_at, started_at, deadline_at,
       external_run_id, driver_cursor, cumulative_usage_json, candidate_revision_id,
       driver_receipt_id, finished_at, cancelled_at, cancellation_reason, termination_reason, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.attempts.values()) {
    insertAttempt.run(
      value.attemptId,
      value.runId,
      value.jobId,
      value.ordinal,
      value.status,
      value.allocatedAt,
      value.startedAt,
      value.deadlineAt,
      value.externalRunId,
      value.driverCursor,
      value.cumulativeUsage === null ? null : canonicalJson(value.cumulativeUsage),
      value.candidateRevisionId,
      value.driverReceiptId,
      value.finishedAt,
      value.cancelledAt,
      value.cancellationReason,
      value.terminationReason,
      value.version
    );
  }
  const insertOutbox = database.prepare(
    `INSERT INTO outbox_projection
      (outbox_id, run_id, job_id, attempt_id, effect_type, effect_key, payload_json, status,
       delivery_attempts, retry_delays_json, available_at, lease_owner_id, lease_fencing_token,
       lease_acquired_at, lease_expires_at, external_effect_id, created_at, delivered_at,
       last_error, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.outbox.values()) {
    insertOutbox.run(
      value.outboxId,
      value.runId,
      value.jobId,
      value.attemptId,
      value.effect.effectType,
      value.effectKey,
      canonicalJson(value.effect),
      value.status,
      value.deliveryAttempts,
      canonicalJson(value.retryDelaysMs),
      value.availableAt,
      value.leaseOwnerId,
      value.leaseFencingToken,
      value.leaseAcquiredAt,
      value.leaseExpiresAt,
      value.externalEffectId,
      value.createdAt,
      value.deliveredAt,
      value.lastError,
      value.version
    );
  }
  const insertManifest = database.prepare(
    `INSERT INTO artifact_manifests_projection
      (artifact_manifest_id, run_id, job_id, attempt_id, source_revision_id,
       producer, entries_json, manifest_digest, total_bytes, created_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.artifactManifests.values()) {
    insertManifest.run(
      value.artifactManifestId,
      value.runId,
      value.jobId,
      value.attemptId,
      value.sourceRevisionId,
      value.producer,
      canonicalJson(value.entries),
      value.manifestDigest,
      value.totalBytes,
      value.createdAt,
      value.version
    );
  }
  const insertVerification = database.prepare(
    `INSERT INTO verifications_projection
      (verification_id, run_id, job_id, attempt_id, workflow_id, workflow_version,
       workflow_digest, source_revision_id, verifier_contract_digest, artifact_manifest_id,
       status, result_json, result_digest, receipt_digest, exit_code, failure_reason,
       requested_at, completed_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.verifications.values()) {
    insertVerification.run(
      value.verificationId,
      value.runId,
      value.jobId,
      value.attemptId,
      value.workflowId,
      value.workflowVersion,
      value.workflowDigest,
      value.sourceRevisionId,
      value.verifierContractDigest,
      value.artifactManifestId,
      value.status,
      value.result === null ? null : canonicalJson(value.result),
      value.resultDigest,
      value.receiptDigest,
      value.exitCode,
      value.failureReason,
      value.requestedAt,
      value.completedAt,
      value.version
    );
  }
  const insertDriverReceipt = database.prepare(
    `INSERT INTO driver_receipts_projection
      (driver_receipt_id, run_id, job_id, attempt_id, external_run_id, base_revision_id,
       candidate_revision_id, outcome, terminal_reason, receipt_json, receipt_digest,
       recorded_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.driverReceipts.values()) {
    insertDriverReceipt.run(
      value.driverReceiptId,
      value.runId,
      value.jobId,
      value.attemptId,
      value.receipt.externalRunId,
      value.baseRevisionId,
      value.candidateRevisionId,
      value.outcome,
      value.terminalReason,
      canonicalJson(value.receipt),
      value.receiptDigest,
      value.recordedAt,
      value.version
    );
  }
  const insertApprovalRequest = database.prepare(
    `INSERT INTO approval_requests_projection
      (approval_request_id, run_id, job_id, attempt_id, capability, reason, sequence,
       requested_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.approvalRequests.values()) {
    insertApprovalRequest.run(
      value.approvalRequestId,
      value.runId,
      value.jobId,
      value.attemptId,
      value.capability,
      value.reason,
      value.sequence,
      value.requestedAt,
      value.version
    );
  }
  const insertOutcomePacket = database.prepare(
    `INSERT INTO outcome_packets_projection
      (outcome_packet_id, program_id, milestone_id, run_id, packet_json, packet_digest,
       generation_id, generation, recorded_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.outcomePackets.values()) {
    insertOutcomePacket.run(
      value.outcomePacketId,
      value.programId,
      value.milestoneId,
      value.runId,
      canonicalJson(value.packet),
      value.packetDigest,
      value.generationId ?? null,
      value.generation ?? null,
      value.recordedAt,
      value.version
    );
  }
  const insertInterview = database.prepare(
    `INSERT INTO program_interviews_projection
      (interview_id, program_id, transcript_json, transcript_digest, playback_id,
       playback_json, playback_digest, captured_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.programInterviews.values()) {
    insertInterview.run(
      value.interviewId,
      value.programId,
      canonicalJson(value.transcript),
      value.transcriptDigest,
      value.playback.playbackId,
      canonicalJson(value.playback),
      value.playbackDigest,
      value.capturedAt,
      value.version
    );
  }
  const insertGraph = database.prepare(
    `INSERT INTO program_graphs_projection
      (graph_revision_id, program_id, revision, prior_graph_revision_id, graph_json,
       graph_digest, approved_by, approved_at, superseded_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.programGraphs.values()) {
    insertGraph.run(
      value.graphRevisionId,
      value.programId,
      value.revision,
      value.priorGraphRevisionId,
      canonicalJson(value.graph),
      value.graphDigest,
      value.approvedBy,
      value.approvedAt,
      value.supersededAt,
      value.version
    );
  }
  const insertContext = database.prepare(
    `INSERT INTO context_packets_projection
      (context_packet_id, program_id, milestone_id, generation_id, packet_json,
       packet_digest, compiled_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.contextPackets.values()) {
    insertContext.run(
      value.contextPacketId,
      value.programId,
      value.milestoneId,
      value.generationId,
      canonicalJson(value.packet),
      value.packetDigest,
      value.compiledAt,
      value.version
    );
  }
  const insertGeneration = database.prepare(
    `INSERT INTO milestone_generations_projection
      (generation_id, program_id, milestone_id, graph_revision_id, generation, run_id,
       job_id, context_packet_id, base_revision_id, status, outcome_packet_id,
       recommendation, started_at, completed_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.milestoneGenerations.values()) {
    insertGeneration.run(
      value.generationId,
      value.programId,
      value.milestoneId,
      value.graphRevisionId,
      value.generation,
      value.runId,
      value.jobId,
      value.contextPacketId,
      value.baseRevisionId,
      value.status,
      value.outcomePacketId,
      value.recommendation,
      value.startedAt,
      value.completedAt,
      value.version
    );
  }
  const insertValidation = database.prepare(
    `INSERT INTO outcome_validations_projection
      (validation_id, program_id, milestone_id, outcome_packet_id, packet_digest,
       validation_json, validation_digest, validated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.outcomeValidations.values()) {
    insertValidation.run(
      value.validationId,
      value.programId,
      value.milestoneId,
      value.outcomePacketId,
      value.packetDigest,
      canonicalJson(value.validation),
      value.validationDigest,
      value.validatedAt,
      value.version
    );
  }
  const insertIssue = database.prepare(
    `INSERT INTO routed_issues_projection
      (issue_id, program_id, issue_json, issue_digest, status, resolution_json,
       raised_at, resolved_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.routedIssues.values()) {
    insertIssue.run(
      value.issue.issueId,
      value.issue.programId,
      canonicalJson(value.issue),
      value.issueDigest,
      value.issue.status,
      value.issue.resolution === null ? null : canonicalJson(value.issue.resolution),
      value.issue.raisedAt,
      value.issue.resolution?.resolvedAt ?? null,
      value.version
    );
  }
  const insertAttention = database.prepare(
    `INSERT INTO attention_spans_projection
      (attention_span_id, program_id, actor_id, label, started_at, stopped_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.attentionSpans.values()) {
    insertAttention.run(
      value.attentionSpanId,
      value.programId,
      value.actorId,
      value.label,
      value.startedAt,
      value.stoppedAt,
      value.version
    );
  }
  const insertDisposition = database.prepare(
    `INSERT INTO outcome_dispositions_projection
      (outcome_packet_id, program_id, disposition, reason, actor_id, recorded_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.outcomeDispositions.values()) {
    insertDisposition.run(
      value.disposition.outcomePacketId,
      value.disposition.programId,
      value.disposition.disposition,
      value.disposition.reason,
      value.disposition.actorId,
      value.disposition.recordedAt,
      value.version
    );
  }
  const insertReport = database.prepare(
    `INSERT INTO measurement_reports_projection
      (report_id, program_id, report_json, report_digest, compiled_at, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.measurementReports.values()) {
    insertReport.run(
      value.report.reportId,
      value.report.programId,
      canonicalJson(value.report),
      value.reportDigest,
      value.report.compiledAt,
      value.version
    );
  }
  const insertOperatorRequest = database.prepare(
    `INSERT INTO operator_decision_requests_projection
      (request_id, program_id, state_json, digest, version) VALUES (?, ?, ?, ?, ?)`
  );
  for (const value of state.operatorDecisionRequests.values()) {
    insertOperatorRequest.run(
      value.request.requestId,
      value.request.programId,
      canonicalJson(value),
      value.requestDigest,
      value.version
    );
  }
  const insertDecisionPacket = database.prepare(
    `INSERT INTO decision_packets_projection
      (packet_id, program_id, current_revision_id, current_revision_digest, status,
       state_json, version) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionPackets.values()) {
    insertDecisionPacket.run(
      value.packetId,
      value.programId,
      value.currentRevisionId,
      value.currentRevisionDigest,
      value.status,
      canonicalJson(value),
      value.version
    );
  }
  const insertDecisionRevision = database.prepare(
    `INSERT INTO decision_packet_revisions_projection
      (packet_revision_id, packet_id, program_id, revision, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionPacketRevisions.values()) {
    insertDecisionRevision.run(
      value.revision.packetRevisionId,
      value.revision.packetId,
      value.revision.programId,
      value.revision.revision,
      canonicalJson(value),
      value.revisionDigest,
      value.version
    );
  }
  const insertEvidenceBundle = database.prepare(
    `INSERT INTO decision_evidence_bundles_projection
      (evidence_bundle_id, packet_id, program_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionEvidenceBundles.values()) {
    insertEvidenceBundle.run(
      value.bundle.evidenceBundleId,
      value.bundle.packetId,
      value.bundle.programId,
      canonicalJson(value),
      value.bundleDigest,
      value.version
    );
  }
  const insertAttentionPolicy = database.prepare(
    `INSERT INTO attention_policies_projection
      (policy_revision_id, policy_id, revision, state_json, digest, superseded_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.attentionPolicies.values()) {
    insertAttentionPolicy.run(
      value.policy.policyRevisionId,
      value.policy.policyId,
      value.policy.revision,
      canonicalJson(value),
      value.policyDigest,
      value.supersededAt,
      value.version
    );
  }
  const insertAcknowledgement = database.prepare(
    `INSERT INTO decision_acknowledgements_projection
      (acknowledgement_id, packet_id, program_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionAcknowledgements.values()) {
    const packet = state.decisionPackets.get(value.acknowledgement.packetId);
    if (!packet) throw new Error("Acknowledgement packet projection is missing");
    insertAcknowledgement.run(
      value.acknowledgement.acknowledgementId,
      packet.packetId,
      packet.programId,
      canonicalJson(value),
      value.acknowledgementDigest,
      value.version
    );
  }
  const insertResolution = database.prepare(
    `INSERT INTO decision_resolutions_projection
      (resolution_id, packet_id, program_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionResolutions.values()) {
    const packet = state.decisionPackets.get(value.resolution.packetId);
    if (!packet) throw new Error("Resolution packet projection is missing");
    insertResolution.run(
      value.resolution.resolutionId,
      packet.packetId,
      packet.programId,
      canonicalJson(value),
      value.resolutionDigest,
      value.version
    );
  }
  const insertActionResult = database.prepare(
    `INSERT INTO decision_action_results_projection
      (action_result_id, packet_id, program_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionActionResults.values()) {
    const packet = state.decisionPackets.get(value.result.packetId);
    if (!packet) throw new Error("Action-result packet projection is missing");
    insertActionResult.run(
      value.result.actionResultId,
      packet.packetId,
      packet.programId,
      canonicalJson(value),
      value.resultDigest,
      value.version
    );
  }
  const insertPrecedent = database.prepare(
    `INSERT INTO decision_precedents_projection
      (precedent_id, packet_id, program_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionPrecedents.values()) {
    const packetId = value.precedent.packetRevisionRef.id;
    const revision = state.decisionPacketRevisions.get(packetId);
    const packet = revision ? state.decisionPackets.get(revision.revision.packetId) : undefined;
    if (!packet) throw new Error("Precedent packet projection is missing");
    insertPrecedent.run(
      value.precedent.precedentId,
      packet.packetId,
      value.precedent.programId,
      canonicalJson(value),
      value.precedentDigest,
      value.version
    );
  }
  const insertAttentionDelivery = database.prepare(
    `INSERT INTO attention_deliveries_projection
      (delivery_id, packet_id, program_id, status, available_at, state_json, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.attentionDeliveries.values()) {
    insertAttentionDelivery.run(
      value.delivery.deliveryId,
      value.delivery.packetId,
      value.delivery.programId,
      value.delivery.status,
      value.delivery.availableAt,
      canonicalJson(value),
      value.version
    );
  }
  const insertBudgetIncident = database.prepare(
    `INSERT INTO attention_budget_incidents_projection
      (incident_id, packet_id, program_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.attentionBudgetIncidents.values()) {
    insertBudgetIncident.run(
      value.incident.incidentId,
      value.incident.packetId,
      value.incident.programId,
      canonicalJson(value),
      value.incidentDigest,
      value.version
    );
  }
  const insertAttentionMeasurement = database.prepare(
    `INSERT INTO attention_measurement_reports_projection
      (report_id, program_id, state_json, digest, version) VALUES (?, ?, ?, ?, ?)`
  );
  for (const value of state.attentionMeasurementReports.values()) {
    insertAttentionMeasurement.run(
      value.report.reportId,
      value.report.programId,
      canonicalJson(value),
      value.reportDigest,
      value.version
    );
  }
  const insertAttentionDigest = database.prepare(
    `INSERT INTO attention_digest_artifacts_projection
      (artifact_id, program_id, state_json, digest, version) VALUES (?, ?, ?, ?, ?)`
  );
  for (const value of state.attentionDigestArtifacts.values()) {
    insertAttentionDigest.run(
      value.artifact.artifactId,
      value.artifact.programId,
      canonicalJson(value),
      value.artifactDigest,
      value.version
    );
  }
  const insertPortfolioPolicy = database.prepare(
    `INSERT INTO portfolio_policies_projection
      (policy_revision_id, policy_id, revision, state_json, digest, superseded_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.portfolioPolicies.values()) {
    insertPortfolioPolicy.run(
      value.policy.policyRevisionId,
      value.policy.policyId,
      value.policy.revision,
      canonicalJson(value),
      value.policyDigest,
      value.supersededAt,
      value.version
    );
  }
  const insertIntegrationTarget = database.prepare(
    `INSERT INTO integration_targets_projection
      (target_revision_id, target_id, revision, repository_id, state_json, digest,
       superseded_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.integrationTargets.values()) {
    insertIntegrationTarget.run(
      value.target.targetRevisionId,
      value.target.targetId,
      value.target.revision,
      value.target.repositoryId,
      canonicalJson(value),
      value.targetDigest,
      value.supersededAt,
      value.version
    );
  }
  const insertAdmission = database.prepare(
    `INSERT INTO portfolio_admissions_projection
      (admission_id, program_id, generation_id, status, admission_sequence, state_json,
       digest, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.portfolioAdmissions.values()) {
    insertAdmission.run(
      value.admission.admissionId,
      value.admission.programId,
      value.admission.generationId,
      value.status,
      value.admission.admissionSequence,
      canonicalJson(value),
      value.admissionDigest,
      value.version
    );
  }
  const insertLease = database.prepare(
    `INSERT INTO concurrency_leases_projection
      (lease_id, admission_id, program_id, claim_key, status, expires_at, fencing_token,
       state_json, digest, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.concurrencyLeases.values()) {
    insertLease.run(
      value.lease.leaseId,
      value.lease.admissionId,
      value.lease.programId,
      value.lease.claimKey,
      value.status,
      value.lease.expiresAt,
      value.lease.fencingToken,
      canonicalJson(value),
      value.leaseDigest,
      value.version
    );
  }
  const insertDiff = database.prepare(
    `INSERT INTO candidate_diff_manifests_projection
      (manifest_id, program_id, candidate_revision_id, eligible, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.candidateDiffManifests.values()) {
    insertDiff.run(
      value.manifest.manifestId,
      value.manifest.programId,
      value.manifest.candidateRevisionRef.id,
      value.manifest.eligible ? 1 : 0,
      canonicalJson(value),
      value.manifestDigest,
      value.version
    );
  }
  const insertCandidate = database.prepare(
    `INSERT INTO integration_candidates_projection
      (candidate_id, program_id, target_id, status, admission_sequence, state_json,
       digest, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.integrationCandidates.values()) {
    insertCandidate.run(
      value.candidate.candidateId,
      value.candidate.programId,
      value.candidate.targetRef.id,
      value.status,
      value.candidate.finalAdmissionSequence,
      canonicalJson(value),
      value.candidateDigest,
      value.version
    );
  }
  const insertIntegrationWork = database.prepare(
    `INSERT INTO integration_work_projection
      (work_id, candidate_id, status, available_at, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.integrationWork.values()) {
    insertIntegrationWork.run(
      value.work.workId,
      value.work.candidateId,
      value.work.status,
      value.work.availableAt,
      canonicalJson(value),
      value.workDigest,
      value.version
    );
  }
  const insertConflict = database.prepare(
    `INSERT INTO integration_conflicts_projection
      (conflict_id, candidate_id, state_json, digest, version) VALUES (?, ?, ?, ?, ?)`
  );
  for (const value of state.integrationConflicts.values()) {
    insertConflict.run(
      value.conflict.conflictId,
      value.conflict.candidateId,
      canonicalJson(value),
      value.conflictDigest,
      value.version
    );
  }
  const insertIntegrationVerification = database.prepare(
    `INSERT INTO integration_verifications_projection
      (integration_verification_id, candidate_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const value of state.integrationVerifications.values()) {
    insertIntegrationVerification.run(
      value.verification.integrationVerificationId,
      value.verification.candidateId,
      canonicalJson(value),
      value.verificationDigest,
      value.version
    );
  }
  const insertPromotion = database.prepare(
    `INSERT INTO promotion_receipts_projection
      (receipt_id, candidate_id, program_id, target_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.promotionReceipts.values()) {
    insertPromotion.run(
      value.receipt.receiptId,
      value.receipt.candidateId,
      value.receipt.programId,
      value.receipt.targetRef.id,
      canonicalJson(value),
      value.receiptDigest,
      value.version
    );
  }
  const insertSloIncident = database.prepare(
    `INSERT INTO portfolio_slo_incidents_projection
      (incident_id, policy_revision_id, incident_kind, status, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.portfolioSloIncidents.values()) {
    insertSloIncident.run(
      value.incident.incidentId,
      value.incident.policyRef.id,
      value.incident.kind,
      value.incident.status,
      canonicalJson(value),
      value.incidentDigest,
      value.version
    );
  }
  const insertPortfolioMeasurement = database.prepare(
    `INSERT INTO portfolio_measurement_reports_projection
      (report_id, policy_revision_id, state_json, digest, version) VALUES (?, ?, ?, ?, ?)`
  );
  for (const value of state.portfolioMeasurementReports.values()) {
    insertPortfolioMeasurement.run(
      value.report.reportId,
      value.report.policyRef.id,
      canonicalJson(value),
      value.reportDigest,
      value.version
    );
  }
  const insertAdvisorSubject = database.prepare(
    `INSERT INTO advisor_subjects_projection
      (subject_id, state_json, digest, version) VALUES (?, ?, ?, ?)`
  );
  for (const value of state.advisorSubjects.values()) {
    insertAdvisorSubject.run(
      value.subject.subjectId,
      canonicalJson(value),
      value.subjectDigest,
      value.version
    );
  }
  const insertAdvisorCase = database.prepare(
    `INSERT INTO advisor_cases_projection
      (case_id, program_id, source_family, provenance, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorCases.values()) {
    insertAdvisorCase.run(
      value.case.caseId,
      value.case.input.programId,
      value.case.sourceFamily,
      value.case.provenance,
      canonicalJson(value),
      value.caseDigest,
      value.version
    );
  }
  const insertAdvisorCorpus = database.prepare(
    `INSERT INTO advisor_corpora_projection
      (corpus_revision_id, corpus_id, revision, state_json, digest, superseded_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorCorpora.values()) {
    insertAdvisorCorpus.run(
      value.corpus.corpusRevisionId,
      value.corpus.corpusId,
      value.corpus.revision,
      canonicalJson(value),
      value.corpusDigest,
      value.supersededAt,
      value.version
    );
  }
  const insertAdvisorContamination = database.prepare(
    `INSERT INTO advisor_contamination_projection
      (contamination_id, corpus_revision_id, case_id, partition_name, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorContamination.values()) {
    insertAdvisorContamination.run(
      value.contamination.contaminationId,
      value.contamination.corpusRevisionRef.id,
      value.contamination.caseRef.id,
      value.contamination.partition,
      canonicalJson(value),
      value.contaminationDigest,
      value.version
    );
  }
  const insertAdvisorInvocation = database.prepare(
    `INSERT INTO advisor_invocations_projection
      (invocation_id, status, available_at, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorInvocations.values()) {
    insertAdvisorInvocation.run(
      value.invocation.invocationId,
      value.invocation.status,
      value.invocation.availableAt,
      canonicalJson(value),
      value.invocationDigest,
      value.version
    );
  }
  const insertAdvisorRecommendation = database.prepare(
    `INSERT INTO advisor_recommendations_projection
      (recommendation_id, invocation_id, subject_id, program_id, purpose, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorRecommendations.values()) {
    insertAdvisorRecommendation.run(
      value.recommendation.recommendationId,
      value.recommendation.invocationId,
      value.recommendation.subjectRef.id,
      value.recommendation.programId,
      value.recommendation.purpose,
      canonicalJson(value),
      value.recommendationDigest,
      value.version
    );
  }
  const insertAdvisorEvaluation = database.prepare(
    `INSERT INTO advisor_evaluations_projection
      (report_id, policy_revision_id, promotion_eligible, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorEvaluations.values()) {
    insertAdvisorEvaluation.run(
      value.report.reportId,
      value.report.policyRevisionRef.id,
      value.report.promotionEligible ? 1 : 0,
      canonicalJson(value),
      value.reportDigest,
      value.version
    );
  }
  const insertDecisionPolicyProposal = database.prepare(
    `INSERT INTO decision_policy_proposals_projection
      (proposal_id, status, state_json, digest, version) VALUES (?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionPolicyProposals.values()) {
    insertDecisionPolicyProposal.run(
      value.proposal.proposalId,
      value.status,
      canonicalJson(value),
      value.proposalDigest,
      value.version
    );
  }
  const insertDecisionPolicy = database.prepare(
    `INSERT INTO decision_policies_projection
      (policy_revision_id, policy_id, revision, status, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionPolicies.values()) {
    insertDecisionPolicy.run(
      value.policy.policyRevisionId,
      value.policy.policyId,
      value.policy.revision,
      value.status,
      canonicalJson(value),
      value.policyDigest,
      value.version
    );
  }
  const insertDecisionPolicyPromotion = database.prepare(
    `INSERT INTO decision_policy_promotions_projection
      (promotion_id, policy_revision_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const value of state.decisionPolicyPromotions.values()) {
    insertDecisionPolicyPromotion.run(
      value.promotion.promotionId,
      value.promotion.policyRevisionRef.id,
      canonicalJson(value),
      value.promotionDigest,
      value.version
    );
  }
  const insertAdvisorResolution = database.prepare(
    `INSERT INTO advisor_resolutions_projection
      (resolution_id, policy_revision_id, program_id, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorResolutions.values()) {
    insertAdvisorResolution.run(
      value.resolution.resolutionId,
      value.resolution.policyRevisionRef.id,
      value.resolution.programId,
      canonicalJson(value),
      value.resolutionDigest,
      value.version
    );
  }
  const insertAdvisorAudit = database.prepare(
    `INSERT INTO advisor_audits_projection
      (audit_id, resolution_id, policy_revision_id, status, due_at, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorAudits.values()) {
    insertAdvisorAudit.run(
      value.audit.auditId,
      value.audit.resolutionRef.id,
      value.audit.policyRevisionRef.id,
      value.audit.status,
      value.audit.dueAt,
      canonicalJson(value),
      value.auditDigest,
      value.version
    );
  }
  const insertAdvisorIncident = database.prepare(
    `INSERT INTO advisor_incidents_projection
      (incident_id, policy_revision_id, status, state_json, digest, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const value of state.advisorIncidents.values()) {
    insertAdvisorIncident.run(
      value.incident.incidentId,
      value.incident.policyRevisionRef.id,
      value.incident.status,
      canonicalJson(value),
      value.incidentDigest,
      value.version
    );
  }
  database
    .prepare("UPDATE projection_meta SET last_applied_position = ? WHERE singleton = 1")
    .run(state.lastAppliedPosition);
}

export function projectionDigest(state: ProjectionState): string {
  return canonicalDigest(serializeProjectionState(state));
}

function firstDifferenceValue(left: unknown, right: unknown, path: string): string | null {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right) return path;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return path;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path;
    if (left.length !== right.length) return `${path}.length`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifferenceValue(
        left[index],
        right[index],
        `${path}[${String(index)}]`
      );
      if (difference) return difference;
    }
    return null;
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
  for (const key of keys) {
    if (!(key in leftObject) || !(key in rightObject)) return `${path}.${key}`;
    const difference = firstDifferenceValue(leftObject[key], rightObject[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

export function firstProjectionDifference(
  current: SerializedProjectionState,
  replayed: SerializedProjectionState
): string | null {
  return firstDifferenceValue(current, replayed, "$projection");
}

export function getStateEntity(
  state: ProjectionState,
  kind: StateEntity["kind"],
  id: string
): StateEntity | null {
  switch (kind) {
    case "program":
      return state.programs.get(id) ?? null;
    case "milestone":
      return state.milestones.get(id) ?? null;
    case "outcome_packet":
      return state.outcomePackets.get(id) ?? null;
    case "workflow":
      return state.workflows.get(id) ?? null;
    case "run":
      return state.runs.get(id) ?? null;
    case "attempt":
      return state.attempts.get(id) ?? null;
    case "job":
      return state.jobs.get(id) ?? null;
    case "outbox":
      return state.outbox.get(id) ?? null;
    case "source_revision":
      return state.sourceRevisions.get(id) ?? null;
    case "artifact_manifest":
      return state.artifactManifests.get(id) ?? null;
    case "verification":
      return state.verifications.get(id) ?? null;
    case "driver_receipt":
      return state.driverReceipts.get(id) ?? null;
    case "approval_request":
      return state.approvalRequests.get(id) ?? null;
    case "program_interview":
      return state.programInterviews.get(id) ?? null;
    case "program_graph":
      return state.programGraphs.get(id) ?? null;
    case "milestone_generation":
      return state.milestoneGenerations.get(id) ?? null;
    case "context_packet":
      return state.contextPackets.get(id) ?? null;
    case "outcome_validation":
      return state.outcomeValidations.get(id) ?? null;
    case "routed_issue":
      return state.routedIssues.get(id) ?? null;
    case "attention_span":
      return state.attentionSpans.get(id) ?? null;
    case "outcome_disposition":
      return state.outcomeDispositions.get(id) ?? null;
    case "measurement_report":
      return state.measurementReports.get(id) ?? null;
    case "operator_decision_request":
      return state.operatorDecisionRequests.get(id) ?? null;
    case "decision_packet":
      return state.decisionPackets.get(id) ?? null;
    case "decision_packet_revision":
      return state.decisionPacketRevisions.get(id) ?? null;
    case "decision_evidence_bundle":
      return state.decisionEvidenceBundles.get(id) ?? null;
    case "attention_policy":
      return state.attentionPolicies.get(id) ?? null;
    case "decision_acknowledgement":
      return state.decisionAcknowledgements.get(id) ?? null;
    case "decision_resolution":
      return state.decisionResolutions.get(id) ?? null;
    case "decision_action_result":
      return state.decisionActionResults.get(id) ?? null;
    case "decision_precedent":
      return state.decisionPrecedents.get(id) ?? null;
    case "attention_delivery":
      return state.attentionDeliveries.get(id) ?? null;
    case "attention_budget_incident":
      return state.attentionBudgetIncidents.get(id) ?? null;
    case "attention_measurement_report":
      return state.attentionMeasurementReports.get(id) ?? null;
    case "attention_digest_artifact":
      return state.attentionDigestArtifacts.get(id) ?? null;
    case "portfolio_policy":
      return state.portfolioPolicies.get(id) ?? null;
    case "integration_target":
      return state.integrationTargets.get(id) ?? null;
    case "portfolio_admission":
      return state.portfolioAdmissions.get(id) ?? null;
    case "concurrency_lease":
      return state.concurrencyLeases.get(id) ?? null;
    case "candidate_diff_manifest":
      return state.candidateDiffManifests.get(id) ?? null;
    case "integration_candidate":
      return state.integrationCandidates.get(id) ?? null;
    case "integration_work":
      return state.integrationWork.get(id) ?? null;
    case "integration_conflict":
      return state.integrationConflicts.get(id) ?? null;
    case "integration_verification":
      return state.integrationVerifications.get(id) ?? null;
    case "promotion_receipt":
      return state.promotionReceipts.get(id) ?? null;
    case "portfolio_slo_incident":
      return state.portfolioSloIncidents.get(id) ?? null;
    case "portfolio_measurement_report":
      return state.portfolioMeasurementReports.get(id) ?? null;
    case "advisor_subject":
      return state.advisorSubjects.get(id) ?? null;
    case "advisor_case":
      return state.advisorCases.get(id) ?? null;
    case "advisor_corpus":
      return state.advisorCorpora.get(id) ?? null;
    case "advisor_contamination":
      return state.advisorContamination.get(id) ?? null;
    case "advisor_invocation":
      return state.advisorInvocations.get(id) ?? null;
    case "advisor_recommendation":
      return state.advisorRecommendations.get(id) ?? null;
    case "advisor_evaluation":
      return state.advisorEvaluations.get(id) ?? null;
    case "decision_policy_proposal":
      return state.decisionPolicyProposals.get(id) ?? null;
    case "decision_policy":
      return state.decisionPolicies.get(id) ?? null;
    case "decision_policy_promotion":
      return state.decisionPolicyPromotions.get(id) ?? null;
    case "advisor_resolution":
      return state.advisorResolutions.get(id) ?? null;
    case "advisor_audit":
      return state.advisorAudits.get(id) ?? null;
    case "advisor_incident":
      return state.advisorIncidents.get(id) ?? null;
  }
}
