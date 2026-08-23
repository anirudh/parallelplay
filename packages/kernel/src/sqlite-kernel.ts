import { createHash, randomUUID } from "node:crypto";
import { canonicalDigest, canonicalJson } from "./canonical.js";
import { CommandResultSchema } from "./api.js";
import type {
  AttentionQueueItem,
  CommandResult,
  DecisionAudit,
  ExecutionTrace,
  EvidenceQuery,
  EventPage,
  JobQuery,
  MilestoneSnapshot,
  OutboxQuery,
  ProjectionRebuildResult,
  ProjectionVerification,
  StateReference,
  StateResult
} from "./api.js";
import {
  assertMigrationsCurrent,
  openDatabase,
  openReadOnlyDatabase,
  systemClock
} from "./database.js";
import type { Clock, IdGenerator, SqliteDatabase } from "./database.js";
import { decide } from "./domain.js";
import { evolve, replayEvents, serializeProjectionState, workflowKey } from "./model.js";
import { deriveOutcomeEvents, verifyOutcomePacketState } from "./outcome.js";
import type { OutcomePacketVerification } from "./outcome.js";
import {
  firstProjectionDifference,
  getStateEntity,
  loadEvents,
  projectionDigest,
  readProjectionState,
  writeProjectionState
} from "./projections.js";
import { CommandSchema } from "./schema.js";
import type { Command, DomainEventInput, JobState, OutboxState, StoredEvent } from "./schema.js";
import type {
  AttentionBudgetIncidentState,
  AttentionDeliveryState,
  AttentionDigestArtifactState,
  AttentionMeasurementReportState,
  AttentionPolicyState,
  AttentionSnapshotV1,
  AttentionSnapshotV2,
  ApprovalRequestState,
  AttentionSpanState,
  ArtifactManifestState,
  ContextPacketState,
  DecisionAcknowledgementState,
  DecisionActionResultState,
  DecisionEvidenceBundleState,
  DecisionPacketRevisionState,
  DecisionPacketState,
  DecisionPrecedentState,
  DecisionResolutionState,
  DriverReceiptState,
  JobPolicy,
  MeasurementReportState,
  MilestoneGenerationState,
  MilestoneState,
  OutcomePacketState,
  OutcomeDispositionState,
  OutcomeValidationState,
  OperatorDecisionRequestState,
  ProgramState,
  ProgramGraphState,
  ProgramInterviewState,
  RoutedIssueState,
  SourceRevisionState,
  VerificationState,
  PortfolioPolicyState,
  IntegrationTargetState,
  PortfolioAdmissionState,
  ConcurrencyLeaseState,
  CandidateDiffManifestState,
  IntegrationCandidateState,
  IntegrationWorkState,
  IntegrationConflictState,
  IntegrationVerificationState,
  PromotionReceiptState,
  PortfolioSloIncidentState,
  PortfolioMeasurementReportState,
  PortfolioSnapshotV1
} from "./schema.js";
import type {
  AdvisorAuditState,
  AdvisorCaseState,
  AdvisorContaminationState,
  AdvisorCorpusState,
  AdvisorEvaluationState,
  AdvisorIncidentState,
  AdvisorInvocationState,
  AdvisorRecommendationState,
  AdvisorResolutionState,
  AdvisorSnapshotV1,
  AdvisorSubjectState,
  DecisionPolicyPromotionState,
  DecisionPolicyProposalState,
  DecisionPolicyState
} from "./advisor-schema.js";

export interface Kernel {
  execute(command: unknown): Promise<CommandResult>;
  getState(reference: StateReference): Promise<StateResult>;
  listPrograms(): Promise<ProgramState[]>;
  listMilestones(programId?: string): Promise<MilestoneState[]>;
  listOutcomePackets(programId?: string): Promise<OutcomePacketState[]>;
  listProgramInterviews(programId?: string): Promise<ProgramInterviewState[]>;
  listProgramGraphs(programId?: string): Promise<ProgramGraphState[]>;
  listMilestoneGenerations(programId?: string): Promise<MilestoneGenerationState[]>;
  listContextPackets(programId?: string): Promise<ContextPacketState[]>;
  listOutcomeValidations(programId?: string): Promise<OutcomeValidationState[]>;
  listRoutedIssues(programId?: string): Promise<RoutedIssueState[]>;
  listAttentionSpans(programId?: string): Promise<AttentionSpanState[]>;
  listOutcomeDispositions(programId?: string): Promise<OutcomeDispositionState[]>;
  listMeasurementReports(programId?: string): Promise<MeasurementReportState[]>;
  listOperatorDecisionRequests(programId?: string): Promise<OperatorDecisionRequestState[]>;
  listDecisionPackets(programId?: string): Promise<DecisionPacketState[]>;
  listDecisionPacketRevisions(packetId?: string): Promise<DecisionPacketRevisionState[]>;
  listDecisionEvidenceBundles(packetId?: string): Promise<DecisionEvidenceBundleState[]>;
  listAttentionPolicies(): Promise<AttentionPolicyState[]>;
  listDecisionAcknowledgements(packetId?: string): Promise<DecisionAcknowledgementState[]>;
  listDecisionResolutions(programId?: string): Promise<DecisionResolutionState[]>;
  listDecisionActionResults(programId?: string): Promise<DecisionActionResultState[]>;
  listDecisionPrecedents(programId?: string): Promise<DecisionPrecedentState[]>;
  listAttentionDeliveries(programId?: string): Promise<AttentionDeliveryState[]>;
  listAttentionBudgetIncidents(programId?: string): Promise<AttentionBudgetIncidentState[]>;
  listAttentionMeasurementReports(programId?: string): Promise<AttentionMeasurementReportState[]>;
  listAttentionDigestArtifacts(programId?: string): Promise<AttentionDigestArtifactState[]>;
  listPortfolioPolicies(): Promise<PortfolioPolicyState[]>;
  listIntegrationTargets(): Promise<IntegrationTargetState[]>;
  listPortfolioAdmissions(programId?: string): Promise<PortfolioAdmissionState[]>;
  listConcurrencyLeases(programId?: string): Promise<ConcurrencyLeaseState[]>;
  listCandidateDiffManifests(programId?: string): Promise<CandidateDiffManifestState[]>;
  listIntegrationCandidates(programId?: string): Promise<IntegrationCandidateState[]>;
  listIntegrationWork(): Promise<IntegrationWorkState[]>;
  listIntegrationConflicts(): Promise<IntegrationConflictState[]>;
  listIntegrationVerifications(): Promise<IntegrationVerificationState[]>;
  listPromotionReceipts(programId?: string): Promise<PromotionReceiptState[]>;
  listPortfolioSloIncidents(): Promise<PortfolioSloIncidentState[]>;
  listPortfolioMeasurementReports(): Promise<PortfolioMeasurementReportState[]>;
  listAdvisorSubjects(): Promise<AdvisorSubjectState[]>;
  listAdvisorCases(programId?: string): Promise<AdvisorCaseState[]>;
  listAdvisorCorpora(): Promise<AdvisorCorpusState[]>;
  listAdvisorContamination(): Promise<AdvisorContaminationState[]>;
  listAdvisorInvocations(): Promise<AdvisorInvocationState[]>;
  listAdvisorRecommendations(programId?: string): Promise<AdvisorRecommendationState[]>;
  listAdvisorEvaluations(policyRevisionId?: string): Promise<AdvisorEvaluationState[]>;
  listDecisionPolicyProposals(): Promise<DecisionPolicyProposalState[]>;
  listDecisionPolicies(): Promise<DecisionPolicyState[]>;
  listDecisionPolicyPromotions(): Promise<DecisionPolicyPromotionState[]>;
  listAdvisorResolutions(programId?: string): Promise<AdvisorResolutionState[]>;
  listAdvisorAudits(policyRevisionId?: string): Promise<AdvisorAuditState[]>;
  listAdvisorIncidents(policyRevisionId?: string): Promise<AdvisorIncidentState[]>;
  getAdvisorSnapshot(): Promise<AdvisorSnapshotV1>;
  getPortfolioSnapshot(): Promise<PortfolioSnapshotV1>;
  evaluatePortfolioSlo(): Promise<CommandResult | null>;
  compilePortfolioMeasurementReport(reportId: string): Promise<CommandResult>;
  coordinatePortfolio(): Promise<CommandResult | null>;
  compileIntegrationDecision(candidateId: string): Promise<CommandResult | null>;
  listAttentionQueue(programId?: string, route?: "queue" | "page"): Promise<AttentionQueueItem[]>;
  getAttentionSnapshot(programId?: string): Promise<AttentionSnapshotV1>;
  getAttentionSnapshotV2(programId?: string): Promise<AttentionSnapshotV2>;
  compileAttention(): Promise<CommandResult | null>;
  getDecisionAudit(packetId: string): Promise<DecisionAudit | null>;
  advanceProgram(programId: string, policy?: JobPolicy): Promise<CommandResult | null>;
  verifyOutcomePacket(outcomePacketId: string): Promise<OutcomePacketVerification>;
  getMilestoneSnapshot(milestoneId: string): Promise<MilestoneSnapshot | null>;
  listJobs(query?: JobQuery): Promise<JobState[]>;
  listOutbox(query?: OutboxQuery): Promise<OutboxState[]>;
  listSourceRevisions(): Promise<SourceRevisionState[]>;
  listArtifactManifests(query?: EvidenceQuery): Promise<ArtifactManifestState[]>;
  listVerifications(query?: EvidenceQuery): Promise<VerificationState[]>;
  listDriverReceipts(query?: EvidenceQuery): Promise<DriverReceiptState[]>;
  listApprovalRequests(query?: EvidenceQuery): Promise<ApprovalRequestState[]>;
  listEvents(query?: { afterPosition?: number; limit?: number }): Promise<EventPage>;
  getExecutionTrace(runId: string): Promise<ExecutionTrace | null>;
  verifyProjections(): Promise<ProjectionVerification>;
  rebuildProjections(): Promise<ProjectionRebuildResult>;
  close(): Promise<void>;
}

export type ReadOnlyKernel = Pick<
  Kernel,
  | "getState"
  | "listPrograms"
  | "listMilestones"
  | "listOutcomePackets"
  | "listProgramInterviews"
  | "listProgramGraphs"
  | "listMilestoneGenerations"
  | "listContextPackets"
  | "listOutcomeValidations"
  | "listRoutedIssues"
  | "listAttentionSpans"
  | "listOutcomeDispositions"
  | "listMeasurementReports"
  | "listOperatorDecisionRequests"
  | "listDecisionPackets"
  | "listDecisionPacketRevisions"
  | "listDecisionEvidenceBundles"
  | "listAttentionPolicies"
  | "listDecisionAcknowledgements"
  | "listDecisionResolutions"
  | "listDecisionActionResults"
  | "listDecisionPrecedents"
  | "listAttentionDeliveries"
  | "listAttentionBudgetIncidents"
  | "listAttentionMeasurementReports"
  | "listAttentionDigestArtifacts"
  | "listPortfolioPolicies"
  | "listIntegrationTargets"
  | "listPortfolioAdmissions"
  | "listConcurrencyLeases"
  | "listCandidateDiffManifests"
  | "listIntegrationCandidates"
  | "listIntegrationWork"
  | "listIntegrationConflicts"
  | "listIntegrationVerifications"
  | "listPromotionReceipts"
  | "listPortfolioSloIncidents"
  | "listPortfolioMeasurementReports"
  | "listAdvisorSubjects"
  | "listAdvisorCases"
  | "listAdvisorCorpora"
  | "listAdvisorContamination"
  | "listAdvisorInvocations"
  | "listAdvisorRecommendations"
  | "listAdvisorEvaluations"
  | "listDecisionPolicyProposals"
  | "listDecisionPolicies"
  | "listDecisionPolicyPromotions"
  | "listAdvisorResolutions"
  | "listAdvisorAudits"
  | "listAdvisorIncidents"
  | "getAdvisorSnapshot"
  | "getPortfolioSnapshot"
  | "listAttentionQueue"
  | "getAttentionSnapshot"
  | "getAttentionSnapshotV2"
  | "getDecisionAudit"
  | "verifyOutcomePacket"
  | "getMilestoneSnapshot"
  | "listJobs"
  | "listOutbox"
  | "listSourceRevisions"
  | "listArtifactManifests"
  | "listVerifications"
  | "listDriverReceipts"
  | "listApprovalRequests"
  | "listEvents"
  | "getExecutionTrace"
  | "verifyProjections"
  | "close"
>;

export interface OpenKernelOptions {
  databasePath: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
}

export type FaultPoint = "after-events-appended" | "after-projection-written";

interface InternalOptions extends OpenKernelOptions {
  faultInjector?: (point: FaultPoint) => void;
  readOnly?: boolean;
}

const systemIdGenerator: IdGenerator = { next: () => randomUUID() };

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = "8";
  const value = bytes.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function receiptRow(
  database: SqliteDatabase,
  idempotencyKey: string
): { requestHash: string; resultJson: string } | undefined {
  return database
    .prepare(
      `SELECT request_hash AS requestHash, result_json AS resultJson
       FROM command_receipts WHERE idempotency_key = ?`
    )
    .get(idempotencyKey) as { requestHash: string; resultJson: string } | undefined;
}

function storeReceipt(
  database: SqliteDatabase,
  command: Command,
  commandId: string,
  requestHash: string,
  result: CommandResult,
  recordedAt: string
): void {
  database
    .prepare(
      `INSERT INTO command_receipts
         (command_id, idempotency_key, command_type, request_hash, status, result_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      commandId,
      command.idempotencyKey,
      command.type,
      requestHash,
      result.ok ? "accepted" : "rejected",
      canonicalJson(result),
      recordedAt
    );
}

function eventSummary(event: StoredEvent): {
  eventId: string;
  globalPosition: number;
  streamType: StoredEvent["streamType"];
  streamId: string;
  streamVersion: number;
  type: string;
};
function eventSummary(event: StoredEvent) {
  return {
    eventId: event.eventId,
    globalPosition: event.globalPosition,
    streamType: event.streamType,
    streamId: event.streamId,
    streamVersion: event.streamVersion,
    type: event.type
  };
}

function appendEvent(
  database: SqliteDatabase,
  event: Omit<StoredEvent, "globalPosition">
): StoredEvent {
  const result = database
    .prepare(
      `INSERT INTO events
         (event_id, command_id, stream_type, stream_id, stream_version, event_type,
          event_schema_version, data_json, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.eventId,
      event.commandId,
      event.streamType,
      event.streamId,
      event.streamVersion,
      event.type,
      event.schemaVersion,
      canonicalJson(event.data),
      canonicalJson(event.metadata),
      event.occurredAt
    );
  return { ...event, globalPosition: Number(result.lastInsertRowid) } as StoredEvent;
}

function streamVersion(database: SqliteDatabase, streamType: string, streamId: string): number {
  const row = database
    .prepare(
      "SELECT COALESCE(MAX(stream_version), 0) AS version FROM events WHERE stream_type = ? AND stream_id = ?"
    )
    .get(streamType, streamId) as { version: number };
  return row.version;
}

class SqliteKernel implements Kernel {
  readonly #database: SqliteDatabase;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #faultInjector?: (point: FaultPoint) => void;
  readonly #readOnly: boolean;
  #closed = false;

  constructor(options: InternalOptions) {
    assertMigrationsCurrent(options.databasePath);
    this.#readOnly = options.readOnly ?? false;
    this.#database = this.#readOnly
      ? openReadOnlyDatabase(options.databasePath)
      : openDatabase(options.databasePath);
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.idGenerator ?? systemIdGenerator;
    if (options.faultInjector) this.#faultInjector = options.faultInjector;
  }

  async execute(input: unknown): Promise<CommandResult> {
    this.#assertOpen();
    if (this.#readOnly) throw new Error("Read-only kernel does not permit commands");
    const parsed = CommandSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        commandId: null,
        idempotencyKey: null,
        replayed: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Command failed schema validation",
          details: { issueCount: parsed.error.issues.length }
        }
      };
    }

    const command = parsed.data;
    const requestHash = canonicalDigest(command);
    const commandId = this.#ids.next();
    const occurredAt = this.#clock.now().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const receipt = receiptRow(this.#database, command.idempotencyKey);
      if (receipt) {
        this.#database.exec("ROLLBACK");
        transactionOpen = false;
        if (receipt.requestHash !== requestHash) {
          return {
            ok: false,
            commandId,
            idempotencyKey: command.idempotencyKey,
            replayed: false,
            error: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "Idempotency key was already used for different input"
            }
          };
        }
        const original = CommandResultSchema.parse(JSON.parse(receipt.resultJson) as unknown);
        return { ...original, replayed: true };
      }

      const currentState = replayEvents(loadEvents(this.#database));
      const staleActionConflict = this.#database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM command_receipts
           WHERE status = 'rejected'
             AND command_type IN (
               'decision.approve', 'decision.retry', 'decision.cancel',
               'decision.park', 'decision.reprioritize', 'decision.integrate'
             )
             AND json_extract(result_json, '$.error.code') = 'DECISION_PACKET_STALE'`
        )
        .get() as { count: number };
      const decision = decide(currentState, command, {
        now: occurredAt,
        staleActionConflictCount: staleActionConflict.count
      });
      if (!decision.ok) {
        const result: CommandResult = {
          ok: false,
          commandId,
          idempotencyKey: command.idempotencyKey,
          replayed: false,
          error: decision.error
        };
        storeReceipt(this.#database, command, commandId, requestHash, result, occurredAt);
        this.#database.exec("COMMIT");
        transactionOpen = false;
        return result;
      }

      let nextState = currentState;
      const versions = new Map<string, number>();
      const storedEvents: StoredEvent[] = [];
      const appendInputs = (events: DomainEventInput[]): void => {
        for (const event of events) {
          const version =
            (versions.get(`${event.streamType}:${event.streamId}`) ??
              streamVersion(this.#database, event.streamType, event.streamId)) + 1;
          versions.set(`${event.streamType}:${event.streamId}`, version);
          const metadata = command.correlationId
            ? { actor: command.actor, correlationId: command.correlationId }
            : { actor: command.actor };
          const stored = appendEvent(this.#database, {
            ...event,
            eventId: this.#ids.next(),
            commandId,
            streamVersion: version,
            schemaVersion: 1,
            occurredAt,
            metadata
          });
          storedEvents.push(stored);
          nextState = evolve(nextState, stored);
        }
      };
      appendInputs(decision.events);
      const terminalRunIds = storedEvents.flatMap((event) =>
        event.type === "RunSucceeded" || event.type === "RunFailed" || event.type === "RunCancelled"
          ? [event.data.runId]
          : []
      );
      appendInputs(deriveOutcomeEvents(nextState, terminalRunIds));
      this.#faultInjector?.("after-events-appended");
      writeProjectionState(this.#database, nextState);
      this.#faultInjector?.("after-projection-written");

      const data = getStateEntity(nextState, decision.resultKind, decision.resultId);
      if (!data) throw new Error("Command result projection is missing");
      const result: CommandResult = {
        ok: true,
        commandId,
        idempotencyKey: command.idempotencyKey,
        replayed: false,
        events: storedEvents.map((event) => eventSummary(event)),
        data
      };
      storeReceipt(this.#database, command, commandId, requestHash, result, occurredAt);
      this.#database.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async getState(reference: StateReference): Promise<StateResult> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    const id =
      reference.kind === "workflow" ? workflowKey(reference.id, reference.version) : reference.id;
    return getStateEntity(state, reference.kind, id);
  }

  async listEvents(query: { afterPosition?: number; limit?: number } = {}): Promise<EventPage> {
    this.#assertOpen();
    const afterPosition = query.afterPosition ?? 0;
    const limit = query.limit ?? 100;
    if (!Number.isInteger(afterPosition) || afterPosition < 0)
      throw new TypeError("afterPosition must be >= 0");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new TypeError("limit must be 1..1000");
    const rows = loadEvents(this.#database, afterPosition, limit + 1);
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit);
    return {
      events,
      nextPosition: hasMore ? (events.at(-1)?.globalPosition ?? null) : null
    };
  }

  async listPrograms(): Promise<ProgramState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).programs.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.programId.localeCompare(right.programId)
    );
  }

  async listMilestones(programId?: string): Promise<MilestoneState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).milestones.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.approvedAt.localeCompare(right.approvedAt) ||
          left.milestoneId.localeCompare(right.milestoneId)
      );
  }

  async listOutcomePackets(programId?: string): Promise<OutcomePacketState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).outcomePackets.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.recordedAt.localeCompare(right.recordedAt) ||
          left.outcomePacketId.localeCompare(right.outcomePacketId)
      );
  }

  async listProgramInterviews(programId?: string): Promise<ProgramInterviewState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).programInterviews.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.capturedAt.localeCompare(right.capturedAt) ||
          left.interviewId.localeCompare(right.interviewId)
      );
  }

  async listProgramGraphs(programId?: string): Promise<ProgramGraphState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).programGraphs.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.revision - right.revision ||
          left.graphRevisionId.localeCompare(right.graphRevisionId)
      );
  }

  async listMilestoneGenerations(programId?: string): Promise<MilestoneGenerationState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).milestoneGenerations.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) ||
          left.milestoneId.localeCompare(right.milestoneId) ||
          left.generation - right.generation ||
          left.generationId.localeCompare(right.generationId)
      );
  }

  async listContextPackets(programId?: string): Promise<ContextPacketState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).contextPackets.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.compiledAt.localeCompare(right.compiledAt) ||
          left.contextPacketId.localeCompare(right.contextPacketId)
      );
  }

  async listOutcomeValidations(programId?: string): Promise<OutcomeValidationState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).outcomeValidations.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.validatedAt.localeCompare(right.validatedAt) ||
          left.validationId.localeCompare(right.validationId)
      );
  }

  async listRoutedIssues(programId?: string): Promise<RoutedIssueState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).routedIssues.values()]
      .filter((value) => programId === undefined || value.issue.programId === programId)
      .sort(
        (left, right) =>
          left.issue.raisedAt.localeCompare(right.issue.raisedAt) ||
          left.issue.issueId.localeCompare(right.issue.issueId)
      );
  }

  async listAttentionSpans(programId?: string): Promise<AttentionSpanState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).attentionSpans.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) ||
          left.attentionSpanId.localeCompare(right.attentionSpanId)
      );
  }

  async listOutcomeDispositions(programId?: string): Promise<OutcomeDispositionState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).outcomeDispositions.values()]
      .filter((value) => programId === undefined || value.disposition.programId === programId)
      .sort(
        (left, right) =>
          left.disposition.recordedAt.localeCompare(right.disposition.recordedAt) ||
          left.disposition.outcomePacketId.localeCompare(right.disposition.outcomePacketId)
      );
  }

  async listMeasurementReports(programId?: string): Promise<MeasurementReportState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).measurementReports.values()]
      .filter((value) => programId === undefined || value.report.programId === programId)
      .sort(
        (left, right) =>
          left.report.compiledAt.localeCompare(right.report.compiledAt) ||
          left.report.reportId.localeCompare(right.report.reportId)
      );
  }

  async listOperatorDecisionRequests(programId?: string): Promise<OperatorDecisionRequestState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).operatorDecisionRequests.values()]
      .filter((value) => programId === undefined || value.request.programId === programId)
      .sort(
        (left, right) =>
          left.request.requestedAt.localeCompare(right.request.requestedAt) ||
          left.request.requestId.localeCompare(right.request.requestId)
      );
  }

  async listDecisionPackets(programId?: string): Promise<DecisionPacketState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).decisionPackets.values()]
      .filter((value) => programId === undefined || value.programId === programId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.packetId.localeCompare(right.packetId)
      );
  }

  async listDecisionPacketRevisions(packetId?: string): Promise<DecisionPacketRevisionState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).decisionPacketRevisions.values()]
      .filter((value) => packetId === undefined || value.revision.packetId === packetId)
      .sort(
        (left, right) =>
          left.revision.revision - right.revision.revision ||
          left.revision.packetRevisionId.localeCompare(right.revision.packetRevisionId)
      );
  }

  async listDecisionEvidenceBundles(packetId?: string): Promise<DecisionEvidenceBundleState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).decisionEvidenceBundles.values()]
      .filter((value) => packetId === undefined || value.bundle.packetId === packetId)
      .sort(
        (left, right) =>
          left.bundle.compiledAt.localeCompare(right.bundle.compiledAt) ||
          left.bundle.evidenceBundleId.localeCompare(right.bundle.evidenceBundleId)
      );
  }

  async listAttentionPolicies(): Promise<AttentionPolicyState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).attentionPolicies.values()].sort(
      (left, right) =>
        left.policy.revision - right.policy.revision ||
        left.policy.policyRevisionId.localeCompare(right.policy.policyRevisionId)
    );
  }

  async listDecisionAcknowledgements(packetId?: string): Promise<DecisionAcknowledgementState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).decisionAcknowledgements.values()]
      .filter((value) => packetId === undefined || value.acknowledgement.packetId === packetId)
      .sort(
        (left, right) =>
          left.acknowledgement.acknowledgedAt.localeCompare(right.acknowledgement.acknowledgedAt) ||
          left.acknowledgement.acknowledgementId.localeCompare(
            right.acknowledgement.acknowledgementId
          )
      );
  }

  async listDecisionResolutions(programId?: string): Promise<DecisionResolutionState[]> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    return [...state.decisionResolutions.values()]
      .filter((value) => {
        const packet = state.decisionPackets.get(value.resolution.packetId);
        return programId === undefined || packet?.programId === programId;
      })
      .sort(
        (left, right) =>
          left.resolution.resolvedAt.localeCompare(right.resolution.resolvedAt) ||
          left.resolution.resolutionId.localeCompare(right.resolution.resolutionId)
      );
  }

  async listDecisionActionResults(programId?: string): Promise<DecisionActionResultState[]> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    return [...state.decisionActionResults.values()]
      .filter((value) => {
        const packet = state.decisionPackets.get(value.result.packetId);
        return programId === undefined || packet?.programId === programId;
      })
      .sort(
        (left, right) =>
          left.result.appliedAt.localeCompare(right.result.appliedAt) ||
          left.result.actionResultId.localeCompare(right.result.actionResultId)
      );
  }

  async listDecisionPrecedents(programId?: string): Promise<DecisionPrecedentState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).decisionPrecedents.values()]
      .filter((value) => programId === undefined || value.precedent.programId === programId)
      .sort(
        (left, right) =>
          left.precedent.recordedAt.localeCompare(right.precedent.recordedAt) ||
          left.precedent.precedentId.localeCompare(right.precedent.precedentId)
      );
  }

  async listAttentionDeliveries(programId?: string): Promise<AttentionDeliveryState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).attentionDeliveries.values()]
      .filter((value) => programId === undefined || value.delivery.programId === programId)
      .sort(
        (left, right) =>
          left.delivery.createdAt.localeCompare(right.delivery.createdAt) ||
          left.delivery.deliveryId.localeCompare(right.delivery.deliveryId)
      );
  }

  async listAttentionBudgetIncidents(programId?: string): Promise<AttentionBudgetIncidentState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).attentionBudgetIncidents.values()]
      .filter((value) => programId === undefined || value.incident.programId === programId)
      .sort(
        (left, right) =>
          left.incident.occurredAt.localeCompare(right.incident.occurredAt) ||
          left.incident.incidentId.localeCompare(right.incident.incidentId)
      );
  }

  async listAttentionMeasurementReports(
    programId?: string
  ): Promise<AttentionMeasurementReportState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).attentionMeasurementReports.values()]
      .filter((value) => programId === undefined || value.report.programId === programId)
      .sort(
        (left, right) =>
          left.report.compiledAt.localeCompare(right.report.compiledAt) ||
          left.report.reportId.localeCompare(right.report.reportId)
      );
  }

  async listAttentionDigestArtifacts(programId?: string): Promise<AttentionDigestArtifactState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).attentionDigestArtifacts.values()]
      .filter((value) => programId === undefined || value.artifact.programId === programId)
      .sort(
        (left, right) =>
          left.artifact.compiledAt.localeCompare(right.artifact.compiledAt) ||
          left.artifact.artifactId.localeCompare(right.artifact.artifactId)
      );
  }

  async listPortfolioPolicies(): Promise<PortfolioPolicyState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).portfolioPolicies.values()].sort(
      (left, right) =>
        left.policy.revision - right.policy.revision ||
        left.policy.policyRevisionId.localeCompare(right.policy.policyRevisionId)
    );
  }

  async listIntegrationTargets(): Promise<IntegrationTargetState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).integrationTargets.values()].sort(
      (left, right) =>
        left.target.targetId.localeCompare(right.target.targetId) ||
        left.target.revision - right.target.revision
    );
  }

  async listPortfolioAdmissions(programId?: string): Promise<PortfolioAdmissionState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).portfolioAdmissions.values()]
      .filter((entry) => programId === undefined || entry.admission.programId === programId)
      .sort(
        (left, right) =>
          left.admission.admissionSequence - right.admission.admissionSequence ||
          left.admission.admissionId.localeCompare(right.admission.admissionId)
      );
  }

  async listConcurrencyLeases(programId?: string): Promise<ConcurrencyLeaseState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).concurrencyLeases.values()]
      .filter((entry) => programId === undefined || entry.lease.programId === programId)
      .sort(
        (left, right) =>
          left.lease.claimKey.localeCompare(right.lease.claimKey) ||
          left.lease.leaseId.localeCompare(right.lease.leaseId)
      );
  }

  async listCandidateDiffManifests(programId?: string): Promise<CandidateDiffManifestState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).candidateDiffManifests.values()]
      .filter((entry) => programId === undefined || entry.manifest.programId === programId)
      .sort(
        (left, right) =>
          left.manifest.generatedAt.localeCompare(right.manifest.generatedAt) ||
          left.manifest.manifestId.localeCompare(right.manifest.manifestId)
      );
  }

  async listIntegrationCandidates(programId?: string): Promise<IntegrationCandidateState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).integrationCandidates.values()]
      .filter((entry) => programId === undefined || entry.candidate.programId === programId)
      .sort(
        (left, right) =>
          left.candidate.finalAdmissionSequence - right.candidate.finalAdmissionSequence ||
          left.candidate.candidateId.localeCompare(right.candidate.candidateId)
      );
  }

  async listIntegrationWork(): Promise<IntegrationWorkState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).integrationWork.values()].sort(
      (left, right) =>
        left.work.availableAt.localeCompare(right.work.availableAt) ||
        left.work.workId.localeCompare(right.work.workId)
    );
  }

  async listIntegrationConflicts(): Promise<IntegrationConflictState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).integrationConflicts.values()].sort(
      (left, right) =>
        left.conflict.recordedAt.localeCompare(right.conflict.recordedAt) ||
        left.conflict.conflictId.localeCompare(right.conflict.conflictId)
    );
  }

  async listIntegrationVerifications(): Promise<IntegrationVerificationState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).integrationVerifications.values()].sort(
      (left, right) =>
        left.verification.completedAt.localeCompare(right.verification.completedAt) ||
        left.verification.integrationVerificationId.localeCompare(
          right.verification.integrationVerificationId
        )
    );
  }

  async listPromotionReceipts(programId?: string): Promise<PromotionReceiptState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).promotionReceipts.values()]
      .filter((entry) => programId === undefined || entry.receipt.programId === programId)
      .sort(
        (left, right) =>
          left.receipt.promotedAt.localeCompare(right.receipt.promotedAt) ||
          left.receipt.receiptId.localeCompare(right.receipt.receiptId)
      );
  }

  async listPortfolioSloIncidents(): Promise<PortfolioSloIncidentState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).portfolioSloIncidents.values()].sort(
      (left, right) =>
        left.incident.recordedAt.localeCompare(right.incident.recordedAt) ||
        left.incident.incidentId.localeCompare(right.incident.incidentId)
    );
  }

  async listPortfolioMeasurementReports(): Promise<PortfolioMeasurementReportState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).portfolioMeasurementReports.values()].sort(
      (left, right) =>
        left.report.compiledAt.localeCompare(right.report.compiledAt) ||
        left.report.reportId.localeCompare(right.report.reportId)
    );
  }

  async listAdvisorSubjects(): Promise<AdvisorSubjectState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorSubjects.values()].sort(
      (left, right) =>
        left.subject.revision - right.subject.revision ||
        left.subject.subjectId.localeCompare(right.subject.subjectId)
    );
  }

  async listAdvisorCases(programId?: string): Promise<AdvisorCaseState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorCases.values()]
      .filter((entry) => programId === undefined || entry.case.input.programId === programId)
      .sort(
        (left, right) =>
          left.case.recordedAt.localeCompare(right.case.recordedAt) ||
          left.case.caseId.localeCompare(right.case.caseId)
      );
  }

  async listAdvisorCorpora(): Promise<AdvisorCorpusState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorCorpora.values()].sort(
      (left, right) =>
        left.corpus.corpusId.localeCompare(right.corpus.corpusId) ||
        left.corpus.revision - right.corpus.revision
    );
  }

  async listAdvisorContamination(): Promise<AdvisorContaminationState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorContamination.values()].sort(
      (left, right) =>
        left.contamination.recordedAt.localeCompare(right.contamination.recordedAt) ||
        left.contamination.contaminationId.localeCompare(right.contamination.contaminationId)
    );
  }

  async listAdvisorInvocations(): Promise<AdvisorInvocationState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorInvocations.values()].sort(
      (left, right) =>
        left.invocation.createdAt.localeCompare(right.invocation.createdAt) ||
        left.invocation.invocationId.localeCompare(right.invocation.invocationId)
    );
  }

  async listAdvisorRecommendations(programId?: string): Promise<AdvisorRecommendationState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorRecommendations.values()]
      .filter((entry) => programId === undefined || entry.recommendation.programId === programId)
      .sort(
        (left, right) =>
          left.recommendation.recordedAt.localeCompare(right.recommendation.recordedAt) ||
          left.recommendation.recommendationId.localeCompare(right.recommendation.recommendationId)
      );
  }

  async listAdvisorEvaluations(policyRevisionId?: string): Promise<AdvisorEvaluationState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorEvaluations.values()]
      .filter(
        (entry) =>
          policyRevisionId === undefined || entry.report.policyRevisionRef.id === policyRevisionId
      )
      .sort(
        (left, right) =>
          left.report.compiledAt.localeCompare(right.report.compiledAt) ||
          left.report.reportId.localeCompare(right.report.reportId)
      );
  }

  async listDecisionPolicyProposals(): Promise<DecisionPolicyProposalState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).decisionPolicyProposals.values()].sort(
      (left, right) =>
        left.proposal.compiledAt.localeCompare(right.proposal.compiledAt) ||
        left.proposal.proposalId.localeCompare(right.proposal.proposalId)
    );
  }

  async listDecisionPolicies(): Promise<DecisionPolicyState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).decisionPolicies.values()].sort(
      (left, right) =>
        left.policy.policyId.localeCompare(right.policy.policyId) ||
        left.policy.revision - right.policy.revision
    );
  }

  async listDecisionPolicyPromotions(): Promise<DecisionPolicyPromotionState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).decisionPolicyPromotions.values()].sort(
      (left, right) =>
        left.promotion.approvedAt.localeCompare(right.promotion.approvedAt) ||
        left.promotion.promotionId.localeCompare(right.promotion.promotionId)
    );
  }

  async listAdvisorResolutions(programId?: string): Promise<AdvisorResolutionState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorResolutions.values()]
      .filter((entry) => programId === undefined || entry.resolution.programId === programId)
      .sort(
        (left, right) =>
          left.resolution.appliedAt.localeCompare(right.resolution.appliedAt) ||
          left.resolution.resolutionId.localeCompare(right.resolution.resolutionId)
      );
  }

  async listAdvisorAudits(policyRevisionId?: string): Promise<AdvisorAuditState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorAudits.values()]
      .filter(
        (entry) =>
          policyRevisionId === undefined || entry.audit.policyRevisionRef.id === policyRevisionId
      )
      .sort(
        (left, right) =>
          left.audit.selectedAt.localeCompare(right.audit.selectedAt) ||
          left.audit.auditId.localeCompare(right.audit.auditId)
      );
  }

  async listAdvisorIncidents(policyRevisionId?: string): Promise<AdvisorIncidentState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).advisorIncidents.values()]
      .filter(
        (entry) =>
          policyRevisionId === undefined || entry.incident.policyRevisionRef.id === policyRevisionId
      )
      .sort(
        (left, right) =>
          left.incident.recordedAt.localeCompare(right.incident.recordedAt) ||
          left.incident.incidentId.localeCompare(right.incident.incidentId)
      );
  }

  async getAdvisorSnapshot(): Promise<AdvisorSnapshotV1> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    const subjects = [...state.advisorSubjects.values()].sort((left, right) =>
      left.subject.subjectId.localeCompare(right.subject.subjectId)
    );
    const corpora = [...state.advisorCorpora.values()].sort((left, right) =>
      left.corpus.corpusRevisionId.localeCompare(right.corpus.corpusRevisionId)
    );
    const contamination = [...state.advisorContamination.values()].sort((left, right) =>
      left.contamination.contaminationId.localeCompare(right.contamination.contaminationId)
    );
    const evaluations = [...state.advisorEvaluations.values()].sort((left, right) =>
      left.report.reportId.localeCompare(right.report.reportId)
    );
    const proposals = [...state.decisionPolicyProposals.values()].sort((left, right) =>
      left.proposal.proposalId.localeCompare(right.proposal.proposalId)
    );
    const policies = [...state.decisionPolicies.values()].sort((left, right) =>
      left.policy.policyRevisionId.localeCompare(right.policy.policyRevisionId)
    );
    const promotions = [...state.decisionPolicyPromotions.values()].sort((left, right) =>
      left.promotion.promotionId.localeCompare(right.promotion.promotionId)
    );
    const resolutions = [...state.advisorResolutions.values()].sort((left, right) =>
      left.resolution.resolutionId.localeCompare(right.resolution.resolutionId)
    );
    const audits = [...state.advisorAudits.values()].sort((left, right) =>
      left.audit.auditId.localeCompare(right.audit.auditId)
    );
    const incidents = [...state.advisorIncidents.values()].sort((left, right) =>
      left.incident.incidentId.localeCompare(right.incident.incidentId)
    );
    const now = this.#clock.now().toISOString();
    return {
      snapshotVersion: 1,
      throughPosition: state.lastAppliedPosition,
      subjects,
      corpora,
      contamination,
      evaluations,
      proposals,
      policies,
      promotions,
      resolutions,
      audits,
      incidents,
      blockers: policies.map((policy) => {
        const report = evaluations
          .filter((entry) => entry.report.policyRevisionRef.id === policy.policy.policyRevisionId)
          .sort((left, right) => right.report.compiledAt.localeCompare(left.report.compiledAt))[0];
        const reasons = [
          policy.status !== "active" ? `status_${policy.status}` : null,
          policy.policy.expiresAt <= now ? "policy_expired" : null,
          report && !report.report.promotionEligible ? "evaluation_blocked" : null,
          ...(report?.report.blockers ?? []),
          audits.some(
            (entry) =>
              entry.audit.policyRevisionRef.id === policy.policy.policyRevisionId &&
              entry.audit.status === "pending" &&
              entry.audit.dueAt <= now
          )
            ? "audit_overdue"
            : null,
          incidents.some(
            (entry) =>
              entry.incident.policyRevisionRef.id === policy.policy.policyRevisionId &&
              entry.incident.status === "open"
          )
            ? "open_incident"
            : null
        ].filter((value): value is string => value !== null);
        return { policyRevisionId: policy.policy.policyRevisionId, reasons: [...new Set(reasons)] };
      })
    };
  }

  async getAttentionSnapshotV2(programId?: string): Promise<AttentionSnapshotV2> {
    this.#assertOpen();
    return {
      snapshotVersion: 2,
      attention: await this.getAttentionSnapshot(programId),
      advisor: await this.getAdvisorSnapshot()
    };
  }

  async getPortfolioSnapshot(): Promise<PortfolioSnapshotV1> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    const programs = [...state.programs.values()]
      .filter((program) => program.programMode === "graph_v2")
      .sort(
        (left, right) =>
          (left.executionRequestedAt ?? left.createdAt).localeCompare(
            right.executionRequestedAt ?? right.createdAt
          ) || left.programId.localeCompare(right.programId)
      );
    const incidents = [...state.portfolioSloIncidents.values()].sort((left, right) =>
      left.incident.recordedAt.localeCompare(right.incident.recordedAt)
    );
    const policies = [...state.portfolioPolicies.values()].filter(
      (entry) => entry.supersededAt === null
    );
    const activePolicy = policies.sort(
      (left, right) => right.policy.revision - left.policy.revision
    )[0];
    const activeClaims = [...state.concurrencyLeases.values()]
      .filter((entry) => entry.status === "active")
      .sort((left, right) => left.lease.claimKey.localeCompare(right.lease.claimKey));
    const throughAt = this.#clock.now().toISOString();
    const activeHumanTimeMs = [...state.attentionSpans.values()].reduce(
      (total, span) =>
        total +
        (new Date(span.stoppedAt ?? throughAt).getTime() - new Date(span.startedAt).getTime()),
      0
    );
    const deliveries = [...state.attentionDeliveries.values()];
    const eligibilityBlockers = programs.map((program) => {
      const blockers: string[] = [];
      const graph = program.activeGraphRevisionId
        ? state.programGraphs.get(program.activeGraphRevisionId)
        : undefined;
      if (program.phase !== "eligible") blockers.push(`phase:${program.phase ?? "unknown"}`);
      if (graph?.graph.schemaVersion !== 2) blockers.push("graph_v2_missing");
      if (incidents.some((entry) => entry.incident.status === "open")) {
        blockers.push("admission_frozen_by_slo");
      }
      if (graph?.graph.schemaVersion === 2) {
        for (const dependency of graph.graph.crossProgramDependencies) {
          const promoted = [...state.promotionReceipts.values()].some((receipt) => {
            const candidate = state.integrationCandidates.get(receipt.receipt.candidateId);
            return (
              receipt.receipt.programId === dependency.programId &&
              candidate?.candidate.graphRevisionRef.id === dependency.graphRevisionId &&
              candidate.candidate.graphRevisionRef.digest === dependency.graphDigest
            );
          });
          if (!promoted) blockers.push(`dependency:${dependency.programId}`);
        }
      }
      return { programId: program.programId, blockers };
    });
    return {
      snapshotVersion: 1,
      throughPosition: state.lastAppliedPosition,
      admissionFrozen: incidents.some((entry) => entry.incident.status === "open"),
      programs,
      eligibilityBlockers,
      admissions: [...state.portfolioAdmissions.values()].sort(
        (left, right) => left.admission.admissionSequence - right.admission.admissionSequence
      ),
      activeClaims,
      leaseRecovery: activeClaims.filter((entry) => entry.lease.expiresAt <= throughAt),
      integrationOrder: [...state.integrationCandidates.values()].sort(
        (left, right) =>
          left.candidate.finalAdmissionSequence - right.candidate.finalAdmissionSequence ||
          left.candidate.candidateId.localeCompare(right.candidate.candidateId)
      ),
      integrationWork: [...state.integrationWork.values()].sort((left, right) =>
        left.work.workId.localeCompare(right.work.workId)
      ),
      conflicts: [...state.integrationConflicts.values()].sort((left, right) =>
        left.conflict.conflictId.localeCompare(right.conflict.conflictId)
      ),
      targets: [...state.integrationTargets.values()].sort((left, right) =>
        left.target.targetRevisionId.localeCompare(right.target.targetRevisionId)
      ),
      sloIncidents: incidents,
      reports: [...state.portfolioMeasurementReports.values()].sort((left, right) =>
        left.report.reportId.localeCompare(right.report.reportId)
      ),
      attention: {
        openPackets: [...state.decisionPackets.values()].filter(
          (packet) => packet.status === "open"
        ).length,
        routinePages: deliveries.filter((entry) => {
          const revision = state.decisionPacketRevisions.get(entry.delivery.packetRevisionId);
          return revision?.revision.safetyClass === "routine";
        }).length,
        safetyCriticalPages: deliveries.filter((entry) => {
          const revision = state.decisionPacketRevisions.get(entry.delivery.packetRevisionId);
          return revision?.revision.safetyClass === "safety_critical";
        }).length,
        activeHumanTimeMs
      },
      cost:
        activePolicy?.policy.costMode.kind === "known_priced"
          ? { status: "known", amount: "0", currency: activePolicy.policy.costMode.currency }
          : {
              status: "unavailable",
              reason:
                activePolicy?.policy.costMode.kind === "unpriced_local_only"
                  ? activePolicy.policy.costMode.unavailableReason
                  : "No active portfolio policy"
            }
    };
  }

  async evaluatePortfolioSlo(): Promise<CommandResult | null> {
    this.#assertOpen();
    if (this.#readOnly) throw new Error("Read-only kernel does not permit SLO evaluation");
    const state = readProjectionState(this.#database);
    const activePolicy = [...state.portfolioPolicies.values()]
      .filter((entry) => entry.supersededAt === null)
      .sort((left, right) => right.policy.revision - left.policy.revision)[0];
    if (!activePolicy) return null;
    const now = this.#clock.now();
    const openKinds = new Set(
      [...state.portfolioSloIncidents.values()]
        .filter((entry) => entry.incident.status === "open")
        .map((entry) => entry.incident.kind)
    );
    const requestedAt = [...state.programs.values()]
      .flatMap((program) => (program.executionRequestedAt ? [program.executionRequestedAt] : []))
      .sort()[0];
    const oldestCandidate = [...state.integrationCandidates.values()]
      .filter((candidate) =>
        [
          "pending",
          "blocked",
          "preparing",
          "verifying",
          "awaiting_authorization",
          "authorized",
          "promoting"
        ].includes(candidate.status)
      )
      .sort((left, right) => left.candidate.queuedAt.localeCompare(right.candidate.queuedAt))[0];
    const humanTimeMs = [...state.attentionSpans.values()].reduce(
      (total, span) =>
        total +
        (new Date(span.stoppedAt ?? now.toISOString()).getTime() -
          new Date(span.startedAt).getTime()),
      0
    );
    const observations: {
      kind: "merge_queue_age" | "trial_wall_time" | "active_human_time" | "cost";
      observed: string;
      limit: string;
      exceeded: boolean;
    }[] = [
      {
        kind: "merge_queue_age",
        observed: String(
          oldestCandidate
            ? Math.max(0, now.getTime() - new Date(oldestCandidate.candidate.queuedAt).getTime())
            : 0
        ),
        limit: String(activePolicy.policy.limits.maxMergeQueueAgeMs),
        exceeded:
          oldestCandidate !== undefined &&
          now.getTime() - new Date(oldestCandidate.candidate.queuedAt).getTime() >
            activePolicy.policy.limits.maxMergeQueueAgeMs
      },
      {
        kind: "trial_wall_time",
        observed: String(
          requestedAt ? Math.max(0, now.getTime() - new Date(requestedAt).getTime()) : 0
        ),
        limit: String(activePolicy.policy.limits.maxTrialWallTimeMs),
        exceeded:
          requestedAt !== undefined &&
          now.getTime() - new Date(requestedAt).getTime() >
            activePolicy.policy.limits.maxTrialWallTimeMs
      },
      {
        kind: "active_human_time",
        observed: String(humanTimeMs),
        limit: String(activePolicy.policy.limits.maxActiveHumanTimeMs),
        exceeded: humanTimeMs > activePolicy.policy.limits.maxActiveHumanTimeMs
      },
      {
        kind: "cost",
        observed:
          activePolicy.policy.costMode.kind === "unpriced_local_only"
            ? activePolicy.policy.costMode.unavailableReason
            : "Known-priced execution has no configured authoritative cost ledger",
        limit:
          activePolicy.policy.costMode.kind === "known_priced"
            ? `${activePolicy.policy.costMode.cap} ${activePolicy.policy.costMode.currency}`
            : "unpriced_local_only",
        exceeded: activePolicy.policy.costMode.kind === "known_priced"
      }
    ];
    const observation = observations.find(
      (candidate) => candidate.exceeded && !openKinds.has(candidate.kind)
    );
    if (!observation) return null;
    const incidentId = deterministicUuid(
      `parallelplay:integration:slo:${activePolicy.policy.policyRevisionId}:${observation.kind}`
    );
    const incident = {
      schemaVersion: 1 as const,
      incidentId,
      policyRef: {
        kind: "portfolio_policy" as const,
        id: activePolicy.policy.policyRevisionId,
        digest: activePolicy.policyDigest
      },
      kind: observation.kind,
      observed: observation.observed,
      limit: observation.limit,
      status: "open" as const,
      admissionFrozen: true as const,
      recordedAt: now.toISOString(),
      resolvedAt: null
    };
    return this.execute({
      type: "portfolio-slo.record",
      idempotencyKey: `portfolio-slo:${incidentId}`,
      actor: { kind: "system", id: "portfolio-slo-monitor" },
      payload: { incident, incidentDigest: canonicalDigest(incident) }
    });
  }

  async compilePortfolioMeasurementReport(reportId: string): Promise<CommandResult> {
    this.#assertOpen();
    if (this.#readOnly) throw new Error("Read-only kernel does not permit report compilation");
    const state = readProjectionState(this.#database);
    const activePolicy = [...state.portfolioPolicies.values()]
      .filter((entry) => entry.supersededAt === null)
      .sort((left, right) => right.policy.revision - left.policy.revision)[0];
    if (!activePolicy) throw new Error("Portfolio measurement requires an active policy");
    const now = this.#clock.now();
    const admissions = [...state.portfolioAdmissions.values()];
    const transitions = admissions
      .flatMap((entry) => [
        { at: entry.admission.admittedAt, delta: 1 },
        ...(entry.admission.releasedAt
          ? [{ at: entry.admission.releasedAt, delta: -1 }]
          : entry.admission.fencedAt
            ? [{ at: entry.admission.fencedAt, delta: -1 }]
            : [])
      ])
      .sort((left, right) => left.at.localeCompare(right.at) || left.delta - right.delta);
    let concurrent = 0;
    let maxObservedConcurrentPrograms = 0;
    for (const transition of transitions) {
      concurrent += transition.delta;
      maxObservedConcurrentPrograms = Math.max(maxObservedConcurrentPrograms, concurrent);
    }
    const readyCandidates = [...state.integrationCandidates.values()].filter((entry) =>
      [
        "pending",
        "blocked",
        "preparing",
        "verifying",
        "awaiting_authorization",
        "authorized",
        "promoting"
      ].includes(entry.status)
    );
    const oldest = readyCandidates.map((entry) => entry.candidate.queuedAt).sort()[0];
    const attention = await this.getPortfolioSnapshot();
    const pipelineWip = [...state.programs.values()].filter(
      (program) =>
        program.programMode === "graph_v2" &&
        ["eligible", "running", "integration_pending"].includes(program.phase ?? "")
    ).length;
    const report = {
      schemaVersion: 1 as const,
      reportId,
      policyRef: {
        kind: "portfolio_policy" as const,
        id: activePolicy.policy.policyRevisionId,
        digest: activePolicy.policyDigest
      },
      throughPosition: state.lastAppliedPosition,
      executingPrograms: admissions.filter((entry) => entry.status === "active").length,
      integrationReadyCandidates: readyCandidates.length,
      pipelineWip,
      maxObservedConcurrentPrograms,
      queuedProgramCount: [...state.programs.values()].filter(
        (program) => program.programMode === "graph_v2" && program.phase === "eligible"
      ).length,
      mergeQueueOldestAgeMs: oldest ? Math.max(0, now.getTime() - new Date(oldest).getTime()) : 0,
      activeHumanTimeMs: attention.attention.activeHumanTimeMs,
      routinePageCount: attention.attention.routinePages,
      safetyCriticalPageCount: attention.attention.safetyCriticalPages,
      cost: attention.cost,
      completeness: {
        admissions: true,
        integrations: true,
        attention: true,
        cost: activePolicy.policy.costMode.kind === "unpriced_local_only"
      },
      compiledAt: now.toISOString()
    };
    return this.execute({
      type: "portfolio-measurement-report.compile",
      idempotencyKey: `portfolio-measurement:${reportId}:${String(state.lastAppliedPosition)}`,
      actor: { kind: "system", id: "portfolio-reporter" },
      payload: { report, reportDigest: canonicalDigest(report) }
    });
  }

  async coordinatePortfolio(): Promise<CommandResult | null> {
    this.#assertOpen();
    if (this.#readOnly) throw new Error("Read-only kernel does not permit portfolio coordination");
    const state = readProjectionState(this.#database);
    if (
      ![...state.programs.values()].some(
        (program) => program.programMode === "graph_v2" && program.phase === "eligible"
      )
    ) {
      return null;
    }
    const result = await this.execute({
      type: "portfolio.coordinate",
      idempotencyKey: `portfolio-coordinate:${String(state.lastAppliedPosition)}`,
      actor: { kind: "system", id: "portfolio-coordinator" },
      payload: {
        schemaVersion: 1,
        expectedThroughPosition: state.lastAppliedPosition,
        leaseDurationMs: 60_000
      }
    });
    return result.ok ? result : null;
  }

  async compileIntegrationDecision(candidateId: string): Promise<CommandResult | null> {
    this.#assertOpen();
    if (this.#readOnly) throw new Error("Read-only kernel does not permit packet compilation");
    const state = readProjectionState(this.#database);
    const candidate = state.integrationCandidates.get(candidateId);
    if (candidate?.status !== "awaiting_authorization") return null;
    const result = await this.execute({
      type: "integration-decision.compile",
      idempotencyKey: `integration-decision:${candidateId}:${String(state.lastAppliedPosition)}`,
      actor: { kind: "system", id: "integration-supervisor" },
      payload: {
        schemaVersion: 1,
        candidateId,
        expectedThroughPosition: state.lastAppliedPosition
      }
    });
    return result.ok ? result : null;
  }

  async listAttentionQueue(
    programId?: string,
    route?: "queue" | "page"
  ): Promise<AttentionQueueItem[]> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    const priority = { p0: 0, p1: 1, p2: 2, p3: 3 } as const;
    return [...state.decisionPackets.values()]
      .filter((packet) => packet.status === "open")
      .filter((packet) => programId === undefined || packet.programId === programId)
      .flatMap((packet) => {
        const revision = state.decisionPacketRevisions.get(packet.currentRevisionId);
        if (!revision || (route !== undefined && revision.revision.routing.route !== route))
          return [];
        const acknowledgement = packet.acknowledgementId
          ? (state.decisionAcknowledgements.get(packet.acknowledgementId) ?? null)
          : null;
        return [{ packet, revision, acknowledgement }];
      })
      .sort((left, right) => {
        const leftRevision = left.revision.revision;
        const rightRevision = right.revision.revision;
        const deadline = (leftRevision.deadlineAt ?? "9999").localeCompare(
          rightRevision.deadlineAt ?? "9999"
        );
        return (
          priority[leftRevision.routing.urgency] - priority[rightRevision.routing.urgency] ||
          Number(rightRevision.safetyClass === "safety_critical") -
            Number(leftRevision.safetyClass === "safety_critical") ||
          deadline ||
          priority[state.programs.get(left.packet.programId)?.attentionPriority ?? "p2"] -
            priority[state.programs.get(right.packet.programId)?.attentionPriority ?? "p2"] ||
          left.packet.createdAt.localeCompare(right.packet.createdAt) ||
          left.packet.packetId.localeCompare(right.packet.packetId)
        );
      });
  }

  async getAttentionSnapshot(programId?: string): Promise<AttentionSnapshotV1> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    return {
      snapshotVersion: 1,
      throughPosition: state.lastAppliedPosition,
      queue: await this.listAttentionQueue(programId, "queue"),
      page: await this.listAttentionQueue(programId, "page"),
      policies: await this.listAttentionPolicies(),
      budgetIncidents: await this.listAttentionBudgetIncidents(programId),
      deliveries: await this.listAttentionDeliveries(programId)
    };
  }

  async compileAttention(): Promise<CommandResult | null> {
    this.#assertOpen();
    if (this.#readOnly) throw new Error("Read-only kernel does not permit attention compilation");
    const state = readProjectionState(this.#database);
    const alreadyClosed = (kind: string, id: string): boolean =>
      [...state.decisionPacketRevisions.values()].some((entry) => {
        if (entry.revision.source.kind !== kind || entry.revision.source.id !== id) return false;
        return state.decisionPackets.get(entry.revision.packetId)?.status !== "open";
      });
    const candidates: {
      kind: "routed_issue" | "approval_request" | "outcome_packet" | "operator_decision_request";
      id: string;
      digest: string;
      occurredAt: string;
    }[] = [
      ...[...state.routedIssues.values()]
        .filter((entry) => entry.issue.status === "open" && entry.issue.route !== "record_only")
        .map((entry) => ({
          kind: "routed_issue" as const,
          id: entry.issue.issueId,
          digest: entry.issueDigest,
          occurredAt: entry.issue.raisedAt
        })),
      ...[...state.approvalRequests.values()].map((entry) => ({
        kind: "approval_request" as const,
        id: entry.approvalRequestId,
        digest: canonicalDigest(entry),
        occurredAt: entry.requestedAt
      })),
      ...[...state.outcomePackets.values()]
        .filter((entry) => !state.outcomeDispositions.has(entry.outcomePacketId))
        .map((entry) => ({
          kind: "outcome_packet" as const,
          id: entry.outcomePacketId,
          digest: entry.packetDigest,
          occurredAt: entry.recordedAt
        })),
      ...[...state.operatorDecisionRequests.values()].map((entry) => ({
        kind: "operator_decision_request" as const,
        id: entry.request.requestId,
        digest: entry.requestDigest,
        occurredAt: entry.request.requestedAt
      }))
    ]
      .filter((entry) => !alreadyClosed(entry.kind, entry.id))
      .sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) ||
          left.kind.localeCompare(right.kind) ||
          left.id.localeCompare(right.id)
      );
    for (const candidate of candidates) {
      const result = await this.execute({
        type: "attention.compile",
        idempotencyKey: `attention-compile:${candidate.kind}:${candidate.id}:${candidate.digest}:${String(state.lastAppliedPosition)}`,
        actor: { kind: "system", id: "attention-compiler" },
        payload: {
          schemaVersion: 1,
          source: { kind: candidate.kind, id: candidate.id, digest: candidate.digest },
          expectedThroughPosition: state.lastAppliedPosition
        }
      });
      if (!result.ok || result.events.length > 0) return result;
    }
    return null;
  }

  async getDecisionAudit(packetId: string): Promise<DecisionAudit | null> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    const packet = state.decisionPackets.get(packetId);
    if (!packet) return null;
    const byTime = <T>(values: T[], at: (value: T) => string, id: (value: T) => string): T[] =>
      values.sort(
        (left, right) => at(left).localeCompare(at(right)) || id(left).localeCompare(id(right))
      );
    const revisions = [...state.decisionPacketRevisions.values()]
      .filter((value) => value.revision.packetId === packetId)
      .sort(
        (left, right) =>
          left.revision.revision - right.revision.revision ||
          left.revision.packetRevisionId.localeCompare(right.revision.packetRevisionId)
      );
    const revisionIds = new Set(revisions.map((value) => value.revision.packetRevisionId));
    const resolution = packet.resolutionId
      ? (state.decisionResolutions.get(packet.resolutionId) ?? null)
      : null;
    const actionResult = resolution
      ? ([...state.decisionActionResults.values()].find(
          (value) =>
            value.result.packetId === packetId &&
            value.result.packetRevisionId === resolution.resolution.packetRevisionId
        ) ?? null)
      : null;
    return {
      packet,
      revisions,
      evidenceBundles: byTime(
        [...state.decisionEvidenceBundles.values()].filter(
          (value) => value.bundle.packetId === packetId
        ),
        (value) => value.bundle.compiledAt,
        (value) => value.bundle.evidenceBundleId
      ),
      acknowledgements: byTime(
        [...state.decisionAcknowledgements.values()].filter(
          (value) => value.acknowledgement.packetId === packetId
        ),
        (value) => value.acknowledgement.acknowledgedAt,
        (value) => value.acknowledgement.acknowledgementId
      ),
      resolution,
      actionResult,
      precedent:
        [...state.decisionPrecedents.values()].find((value) =>
          revisionIds.has(value.precedent.packetRevisionRef.id)
        ) ?? null,
      deliveries: byTime(
        [...state.attentionDeliveries.values()].filter(
          (value) => value.delivery.packetId === packetId
        ),
        (value) => value.delivery.createdAt,
        (value) => value.delivery.deliveryId
      ),
      budgetIncidents: byTime(
        [...state.attentionBudgetIncidents.values()].filter(
          (value) => value.incident.packetId === packetId
        ),
        (value) => value.incident.occurredAt,
        (value) => value.incident.incidentId
      )
    };
  }

  async advanceProgram(
    programId: string,
    policy: JobPolicy = {
      maxAttempts: 3,
      attemptTimeoutMs: 300_000,
      retryDelaysMs: [1_000, 5_000]
    }
  ): Promise<CommandResult | null> {
    this.#assertOpen();
    if (this.#readOnly) throw new Error("Read-only kernel does not permit program advance");
    const state = readProjectionState(this.#database);
    const program = state.programs.get(programId);
    const graph = program?.activeGraphRevisionId
      ? state.programGraphs.get(program.activeGraphRevisionId)
      : undefined;
    if (
      !program ||
      !graph ||
      (program.phase !== "running" &&
        !(program.programMode === "graph_v2" && program.phase === "eligible"))
    ) {
      return null;
    }
    if (
      [...state.milestoneGenerations.values()].some(
        (generation) => generation.programId === programId && generation.status === "running"
      )
    ) {
      return null;
    }
    if (
      [...state.routedIssues.values()].some(
        (issue) =>
          issue.issue.programId === programId &&
          issue.issue.status !== "resolved" &&
          issue.issue.route !== "record_only"
      )
    ) {
      return null;
    }
    const nextNode = graph.graph.milestones.find(
      (node) =>
        state.milestones.get(node.contract.milestoneId)?.status === "approved" &&
        node.dependencies.every(
          (dependency) => state.milestones.get(dependency)?.status === "outcome_ready"
        )
    );
    const dependencyIds = nextNode
      ? nextNode.dependencies
      : graph.graph.milestones.flatMap((node) => {
          const milestone = state.milestones.get(node.contract.milestoneId);
          return milestone?.latestValidatedOutcomePacketId ? [] : [node.contract.milestoneId];
        });
    const validatedAt = this.#clock.now().toISOString();
    const validations = [];
    for (const milestoneId of dependencyIds) {
      const milestone = state.milestones.get(milestoneId);
      const packet = milestone?.outcomePacketId
        ? state.outcomePackets.get(milestone.outcomePacketId)
        : undefined;
      const verification = verifyOutcomePacketState(state, packet);
      if (
        !packet ||
        !verification.valid ||
        verification.packetDigest === null ||
        verification.computedDigest === null ||
        packet.packet.recommendation !== "merge" ||
        packet.packet.candidateRevisionId === null ||
        !packet.packet.criteriaResults.every((criterion) => criterion.result === "pass")
      ) {
        return null;
      }
      const validationId = deterministicUuid(
        `parallelplay:outcome-validation:v1:${graph.graphDigest}:${nextNode?.contract.milestoneId ?? "complete"}:${packet.outcomePacketId}:${packet.packetDigest}`
      );
      validations.push({
        schemaVersion: 1 as const,
        validationId,
        programId,
        milestoneId,
        outcomePacketId: packet.outcomePacketId,
        packetDigest: packet.packetDigest,
        computedDigest: verification.computedDigest,
        primaryEvidenceDigests: [
          ...packet.packet.driverReceipts.map((reference) => reference.digest),
          ...packet.packet.verificationReceipts.map((reference) => reference.digest),
          ...packet.packet.artifactManifests.map((reference) => reference.digest)
        ].sort(),
        criteriaPassed: true as const,
        recommendation: "merge" as const,
        candidateRevisionId: packet.packet.candidateRevisionId,
        valid: true as const,
        validatedAt
      });
    }
    const expectedGeneration = nextNode
      ? (state.milestones.get(nextNode.contract.milestoneId)?.generation ?? 0) + 1
      : null;
    const semanticIdentity = canonicalDigest({
      graphDigest: graph.graphDigest,
      milestoneId: nextNode?.contract.milestoneId ?? null,
      generation: expectedGeneration,
      outcomePacketDigests: validations.map((validation) => validation.packetDigest).sort()
    });
    return this.execute({
      type: "program.advance",
      idempotencyKey: `program-advance:${semanticIdentity}`,
      actor: { kind: "system", id: "program-lead" },
      payload: {
        schemaVersion: 1,
        programId,
        graphRevisionId: graph.graphRevisionId,
        graphDigest: graph.graphDigest,
        expectedMilestoneId: nextNode?.contract.milestoneId ?? null,
        expectedGeneration,
        dependencyValidations: validations,
        policy
      }
    });
  }

  async verifyOutcomePacket(outcomePacketId: string) {
    this.#assertOpen();
    try {
      const state = readProjectionState(this.#database);
      const result = verifyOutcomePacketState(state, state.outcomePackets.get(outcomePacketId));
      return result.outcomePacketId === "missing" ? { ...result, outcomePacketId } : result;
    } catch (error) {
      return {
        outcomePacketId,
        valid: false,
        packetDigest: null,
        computedDigest: null,
        failures: [error instanceof Error ? error.message : "outcome packet could not be read"]
      };
    }
  }

  async getMilestoneSnapshot(milestoneId: string): Promise<MilestoneSnapshot | null> {
    this.#assertOpen();
    const state = readProjectionState(this.#database);
    const milestone = state.milestones.get(milestoneId);
    if (!milestone) return null;
    const program = state.programs.get(milestone.programId);
    const workflow = state.workflows.get(
      workflowKey(milestone.contract.workflowId, milestone.contract.workflowVersion)
    );
    if (!program || !workflow) throw new Error("Milestone snapshot authority is incomplete");
    const run = milestone.runId ? (state.runs.get(milestone.runId) ?? null) : null;
    const job = milestone.jobId ? (state.jobs.get(milestone.jobId) ?? null) : null;
    const attempts = [...state.attempts.values()]
      .filter((value) => value.runId === milestone.runId)
      .sort(
        (left, right) =>
          left.ordinal - right.ordinal || left.attemptId.localeCompare(right.attemptId)
      );
    const byTime = <T>(values: T[], time: (value: T) => string, id: (value: T) => string): T[] =>
      values.sort(
        (left, right) => time(left).localeCompare(time(right)) || id(left).localeCompare(id(right))
      );
    return {
      snapshotVersion: 1,
      program,
      milestone,
      workflow,
      run,
      job,
      attempts,
      driverReceipts: byTime(
        [...state.driverReceipts.values()].filter((value) => value.runId === milestone.runId),
        (value) => value.recordedAt,
        (value) => value.driverReceiptId
      ),
      verifications: byTime(
        [...state.verifications.values()].filter((value) => value.runId === milestone.runId),
        (value) => value.requestedAt,
        (value) => value.verificationId
      ),
      artifactManifests: byTime(
        [...state.artifactManifests.values()].filter((value) => value.runId === milestone.runId),
        (value) => value.createdAt,
        (value) => value.artifactManifestId
      ),
      approvalRequests: byTime(
        [...state.approvalRequests.values()].filter((value) => value.runId === milestone.runId),
        (value) => value.requestedAt,
        (value) => value.approvalRequestId
      ),
      outcomePacket: milestone.outcomePacketId
        ? (state.outcomePackets.get(milestone.outcomePacketId) ?? null)
        : null,
      trace: milestone.runId ? await this.getExecutionTrace(milestone.runId) : null
    };
  }

  async listJobs(query: JobQuery = {}): Promise<JobState[]> {
    this.#assertOpen();
    const creationPositions = new Map(
      loadEvents(this.#database)
        .filter((event) => event.type === "JobScheduled")
        .map((event) => [event.streamId, event.globalPosition])
    );
    return [...readProjectionState(this.#database).jobs.values()]
      .filter((job) => query.runId === undefined || job.runId === query.runId)
      .filter((job) => query.statuses === undefined || query.statuses.includes(job.status))
      .filter((job) => query.ownerId === undefined || job.leaseOwnerId === query.ownerId)
      .sort(
        (left, right) =>
          (left.status === "active"
            ? (left.leaseExpiresAt ?? left.availableAt)
            : left.availableAt
          ).localeCompare(
            right.status === "active"
              ? (right.leaseExpiresAt ?? right.availableAt)
              : right.availableAt
          ) ||
          (creationPositions.get(left.jobId) ?? Number.MAX_SAFE_INTEGER) -
            (creationPositions.get(right.jobId) ?? Number.MAX_SAFE_INTEGER) ||
          left.jobId.localeCompare(right.jobId)
      );
  }

  async listOutbox(query: OutboxQuery = {}): Promise<OutboxState[]> {
    this.#assertOpen();
    const creationPositions = new Map(
      loadEvents(this.#database)
        .filter((event) => event.type === "OutboxEnqueued")
        .map((event) => [event.streamId, event.globalPosition])
    );
    return [...readProjectionState(this.#database).outbox.values()]
      .filter((outbox) => query.runId === undefined || outbox.runId === query.runId)
      .filter((outbox) => query.statuses === undefined || query.statuses.includes(outbox.status))
      .filter((outbox) => query.ownerId === undefined || outbox.leaseOwnerId === query.ownerId)
      .sort(
        (left, right) =>
          (left.status === "leased"
            ? (left.leaseExpiresAt ?? left.availableAt)
            : left.availableAt
          ).localeCompare(
            right.status === "leased"
              ? (right.leaseExpiresAt ?? right.availableAt)
              : right.availableAt
          ) ||
          (creationPositions.get(left.outboxId) ?? Number.MAX_SAFE_INTEGER) -
            (creationPositions.get(right.outboxId) ?? Number.MAX_SAFE_INTEGER) ||
          left.outboxId.localeCompare(right.outboxId)
      );
  }

  async listSourceRevisions(): Promise<SourceRevisionState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).sourceRevisions.values()].sort(
      (left, right) =>
        left.capturedAt.localeCompare(right.capturedAt) ||
        left.revisionId.localeCompare(right.revisionId)
    );
  }

  async listArtifactManifests(query: EvidenceQuery = {}): Promise<ArtifactManifestState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).artifactManifests.values()]
      .filter((value) => query.runId === undefined || value.runId === query.runId)
      .filter((value) => query.attemptId === undefined || value.attemptId === query.attemptId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.artifactManifestId.localeCompare(right.artifactManifestId)
      );
  }

  async listVerifications(query: EvidenceQuery = {}): Promise<VerificationState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).verifications.values()]
      .filter((value) => query.runId === undefined || value.runId === query.runId)
      .filter((value) => query.attemptId === undefined || value.attemptId === query.attemptId)
      .sort(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) ||
          left.verificationId.localeCompare(right.verificationId)
      );
  }

  async listDriverReceipts(query: EvidenceQuery = {}): Promise<DriverReceiptState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).driverReceipts.values()]
      .filter((value) => query.runId === undefined || value.runId === query.runId)
      .filter((value) => query.attemptId === undefined || value.attemptId === query.attemptId)
      .sort(
        (left, right) =>
          left.recordedAt.localeCompare(right.recordedAt) ||
          left.driverReceiptId.localeCompare(right.driverReceiptId)
      );
  }

  async listApprovalRequests(query: EvidenceQuery = {}): Promise<ApprovalRequestState[]> {
    this.#assertOpen();
    return [...readProjectionState(this.#database).approvalRequests.values()]
      .filter((value) => query.runId === undefined || value.runId === query.runId)
      .filter((value) => query.attemptId === undefined || value.attemptId === query.attemptId)
      .sort(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) ||
          left.approvalRequestId.localeCompare(right.approvalRequestId)
      );
  }

  async getExecutionTrace(runId: string): Promise<ExecutionTrace | null> {
    this.#assertOpen();
    const events = loadEvents(this.#database);
    const final = replayEvents(events);
    const run = final.runs.get(runId);
    if (!run) return null;
    let state = replayEvents([]);
    const records: ExecutionTrace["records"] = [];
    for (const event of events) {
      state = evolve(state, event);
      const data = event.data as Record<string, unknown>;
      const packet = event.type === "OutcomePacketRecorded" ? event.data.packet : null;
      const eventRunId = typeof data["runId"] === "string" ? data["runId"] : packet?.runId;
      if (eventRunId !== runId) continue;
      const entity =
        event.streamType === "run"
          ? state.runs.get(event.streamId)
          : event.streamType === "milestone"
            ? state.milestones.get(event.streamId)
            : event.streamType === "outcome_packet"
              ? state.outcomePackets.get(event.streamId)
              : event.streamType === "job"
                ? state.jobs.get(event.streamId)
                : event.streamType === "attempt"
                  ? state.attempts.get(event.streamId)
                  : event.streamType === "outbox"
                    ? state.outbox.get(event.streamId)
                    : event.streamType === "source_revision"
                      ? state.sourceRevisions.get(event.streamId)
                      : event.streamType === "artifact_manifest"
                        ? state.artifactManifests.get(event.streamId)
                        : event.streamType === "verification"
                          ? state.verifications.get(event.streamId)
                          : event.streamType === "driver_receipt"
                            ? state.driverReceipts.get(event.streamId)
                            : event.streamType === "approval_request"
                              ? state.approvalRequests.get(event.streamId)
                              : undefined;
      const sourceRevisionId =
        typeof data["sourceRevisionId"] === "string"
          ? data["sourceRevisionId"]
          : entity?.kind === "source_revision"
            ? entity.revisionId
            : entity?.kind === "artifact_manifest" || entity?.kind === "verification"
              ? entity.sourceRevisionId
              : entity?.kind === "job"
                ? entity.sourceRevisionId
                : entity?.kind === "driver_receipt"
                  ? (entity.candidateRevisionId ?? entity.baseRevisionId)
                  : null;
      const artifactManifestId =
        typeof data["artifactManifestId"] === "string"
          ? data["artifactManifestId"]
          : entity?.kind === "artifact_manifest"
            ? entity.artifactManifestId
            : entity?.kind === "verification"
              ? entity.artifactManifestId
              : null;
      const sourceRevision = sourceRevisionId
        ? state.sourceRevisions.get(sourceRevisionId)
        : undefined;
      const artifactManifest = artifactManifestId
        ? state.artifactManifests.get(artifactManifestId)
        : undefined;
      records.push({
        globalPosition: event.globalPosition,
        occurredAt: event.occurredAt,
        commandId: event.commandId,
        eventId: event.eventId,
        type: event.type,
        streamType: event.streamType,
        entityId: event.streamId,
        runId,
        milestoneId:
          typeof data["milestoneId"] === "string"
            ? data["milestoneId"]
            : entity?.kind === "milestone" || entity?.kind === "outcome_packet"
              ? entity.milestoneId
              : run.milestoneId,
        outcomePacketId:
          typeof data["outcomePacketId"] === "string"
            ? data["outcomePacketId"]
            : entity?.kind === "outcome_packet"
              ? entity.outcomePacketId
              : entity?.kind === "milestone"
                ? entity.outcomePacketId
                : (packet?.outcomePacketId ?? null),
        jobId:
          typeof data["jobId"] === "string"
            ? data["jobId"]
            : entity?.kind === "job"
              ? entity.jobId
              : entity?.kind === "attempt"
                ? entity.jobId
                : entity?.kind === "outbox"
                  ? entity.jobId
                  : entity?.kind === "driver_receipt" || entity?.kind === "approval_request"
                    ? entity.jobId
                    : null,
        attemptId:
          typeof data["attemptId"] === "string"
            ? data["attemptId"]
            : entity?.kind === "attempt"
              ? entity.attemptId
              : entity?.kind === "outbox"
                ? entity.attemptId
                : entity?.kind === "driver_receipt" || entity?.kind === "approval_request"
                  ? entity.attemptId
                  : null,
        outboxId:
          typeof data["outboxId"] === "string"
            ? data["outboxId"]
            : entity?.kind === "outbox"
              ? entity.outboxId
              : null,
        sourceRevisionId,
        artifactManifestId,
        verificationId:
          typeof data["verificationId"] === "string"
            ? data["verificationId"]
            : entity?.kind === "verification"
              ? entity.verificationId
              : null,
        driverReceiptId:
          typeof data["driverReceiptId"] === "string"
            ? data["driverReceiptId"]
            : entity?.kind === "driver_receipt"
              ? entity.driverReceiptId
              : entity?.kind === "attempt"
                ? entity.driverReceiptId
                : null,
        approvalRequestId:
          typeof data["approvalRequestId"] === "string"
            ? data["approvalRequestId"]
            : entity?.kind === "approval_request"
              ? entity.approvalRequestId
              : null,
        baseRevisionId:
          typeof data["baseRevisionId"] === "string"
            ? data["baseRevisionId"]
            : entity?.kind === "driver_receipt"
              ? entity.baseRevisionId
              : null,
        candidateRevisionId:
          typeof data["candidateRevisionId"] === "string"
            ? data["candidateRevisionId"]
            : entity?.kind === "driver_receipt" ||
                entity?.kind === "job" ||
                entity?.kind === "attempt"
              ? entity.candidateRevisionId
              : null,
        workflowDigest:
          typeof data["workflowDigest"] === "string"
            ? data["workflowDigest"]
            : entity?.kind === "verification"
              ? entity.workflowDigest
              : null,
        executionContractDigest:
          typeof data["executionContractDigest"] === "string"
            ? data["executionContractDigest"]
            : entity?.kind === "job"
              ? entity.executionContractDigest
              : entity?.kind === "driver_receipt"
                ? entity.receipt.executionContractDigest
                : null,
        capabilityManifestDigest:
          typeof data["capabilityManifestDigest"] === "string"
            ? data["capabilityManifestDigest"]
            : entity?.kind === "job"
              ? entity.capabilityManifestDigest
              : entity?.kind === "driver_receipt"
                ? entity.receipt.capabilityManifestDigest
                : null,
        verifierContractDigest:
          typeof data["verifierContractDigest"] === "string"
            ? data["verifierContractDigest"]
            : entity?.kind === "verification" || entity?.kind === "job"
              ? entity.verifierContractDigest
              : null,
        revisionDigest: sourceRevision?.revisionDigest ?? null,
        manifestDigest:
          typeof data["manifestDigest"] === "string"
            ? data["manifestDigest"]
            : (artifactManifest?.manifestDigest ?? null),
        resultDigest:
          typeof data["resultDigest"] === "string"
            ? data["resultDigest"]
            : entity?.kind === "verification"
              ? entity.resultDigest
              : null,
        receiptDigest:
          typeof data["receiptDigest"] === "string"
            ? data["receiptDigest"]
            : entity?.kind === "verification"
              ? entity.receiptDigest
              : entity?.kind === "driver_receipt"
                ? entity.receiptDigest
                : null,
        outcomePacketDigest:
          typeof data["packetDigest"] === "string"
            ? data["packetDigest"]
            : entity?.kind === "outcome_packet"
              ? entity.packetDigest
              : null,
        driverCursor: entity?.kind === "attempt" ? entity.driverCursor : null,
        cumulativeUsage:
          entity?.kind === "attempt"
            ? entity.cumulativeUsage
            : entity?.kind === "driver_receipt"
              ? entity.receipt.usage
              : null,
        driverEvents: Array.isArray(data["events"]) ? data["events"] : null,
        status: entity && "status" in entity ? entity.status : null,
        terminationReason: entity && "terminationReason" in entity ? entity.terminationReason : null
      });
    }
    return {
      traceId: runId,
      runId,
      programId: run.programId,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      records
    };
  }

  async verifyProjections(): Promise<ProjectionVerification> {
    this.#assertOpen();
    const events = loadEvents(this.#database);
    const replayed = replayEvents(events);
    const replayedDigest = projectionDigest(replayed);
    try {
      const current = readProjectionState(this.#database);
      const currentDigest = projectionDigest(current);
      return {
        projectionSchemaVersion: 1,
        valid: currentDigest === replayedDigest,
        currentDigest,
        replayedDigest,
        eventCount: events.length,
        firstDivergence: firstProjectionDifference(
          serializeProjectionState(current),
          serializeProjectionState(replayed)
        )
      };
    } catch (error) {
      return {
        projectionSchemaVersion: 1,
        valid: false,
        currentDigest: null,
        replayedDigest,
        eventCount: events.length,
        firstDivergence: error instanceof Error ? error.message : "Projection could not be read"
      };
    }
  }

  async rebuildProjections(): Promise<ProjectionRebuildResult> {
    this.#assertOpen();
    if (this.#readOnly) throw new Error("Read-only kernel does not permit projection rebuilds");
    this.#database.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const events = loadEvents(this.#database);
      const replayed = replayEvents(events);
      let previousDigest: string | null = null;
      let firstDivergence: string | null = null;
      try {
        const current = readProjectionState(this.#database);
        previousDigest = projectionDigest(current);
        firstDivergence = firstProjectionDifference(
          serializeProjectionState(current),
          serializeProjectionState(replayed)
        );
      } catch {
        firstDivergence = "Projection could not be read";
      }
      writeProjectionState(this.#database, replayed);
      const rebuiltDigest = projectionDigest(replayed);
      this.#database.exec("COMMIT");
      transactionOpen = false;
      return {
        projectionSchemaVersion: 1,
        previousDigest,
        rebuiltDigest,
        eventCount: events.length,
        firstDivergence
      };
    } catch (error) {
      if (transactionOpen) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Kernel is closed");
  }
}

export async function openKernel(options: OpenKernelOptions): Promise<Kernel> {
  return new SqliteKernel(options);
}

export async function openReadOnlyKernel(options: OpenKernelOptions): Promise<ReadOnlyKernel> {
  return new SqliteKernel({ ...options, readOnly: true });
}

export function openKernelForTesting(options: InternalOptions): Kernel {
  return new SqliteKernel(options);
}
