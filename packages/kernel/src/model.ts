import type {
  AttentionBudgetIncidentState,
  AttentionDeliveryState,
  AttentionDigestArtifactState,
  AttentionMeasurementReportState,
  AttentionPolicyState,
  AttentionSpanState,
  ArtifactManifestState,
  ApprovalRequestState,
  AttemptState,
  DecisionAcknowledgementState,
  DecisionActionResultState,
  DecisionEvidenceBundleState,
  DecisionPacketRevisionState,
  DecisionPacketState,
  DecisionPrecedentState,
  DecisionResolutionState,
  DriverReceiptState,
  JobState,
  ContextPacketState,
  MeasurementReportState,
  MilestoneGenerationState,
  MilestoneState,
  OutcomePacketState,
  OutcomeDispositionState,
  OutcomeValidationState,
  OperatorDecisionRequestState,
  OutboxState,
  ProgramState,
  ProgramGraphState,
  ProgramInterviewState,
  RoutedIssueState,
  RunState,
  SourceRevisionState,
  StoredEvent,
  VerificationState,
  WorkflowState,
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
  PortfolioMeasurementReportState
} from "./schema.js";
import {
  artifactManifestDigest,
  driverReceiptDigest,
  receiptIdentity,
  sourceRevisionDigest,
  verificationReceiptDigest,
  verificationResultDigest
} from "./evidence.js";
import { canonicalDigest } from "./canonical.js";
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
  AdvisorSubjectState,
  DecisionPolicyPromotionState,
  DecisionPolicyProposalState,
  DecisionPolicyState
} from "./advisor-schema.js";

export type {
  AttentionBudgetIncidentState,
  AttentionDeliveryState,
  AttentionDigestArtifactState,
  AttentionMeasurementReportState,
  AttentionPolicyState,
  AttentionSpanState,
  ArtifactManifestState,
  AttemptState,
  DecisionAcknowledgementState,
  DecisionActionResultState,
  DecisionEvidenceBundleState,
  DecisionPacketRevisionState,
  DecisionPacketState,
  DecisionPrecedentState,
  DecisionResolutionState,
  JobState,
  ContextPacketState,
  MeasurementReportState,
  MilestoneGenerationState,
  MilestoneState,
  OutcomePacketState,
  OutcomeDispositionState,
  OutcomeValidationState,
  OperatorDecisionRequestState,
  OutboxState,
  ProgramState,
  ProgramGraphState,
  ProgramInterviewState,
  RoutedIssueState,
  RunState,
  SourceRevisionState,
  VerificationState,
  WorkflowState,
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
  PortfolioMeasurementReportState
} from "./schema.js";
export type { StateEntity } from "./schema.js";

export interface ProjectionState {
  programs: Map<string, ProgramState>;
  milestones: Map<string, MilestoneState>;
  outcomePackets: Map<string, OutcomePacketState>;
  workflows: Map<string, WorkflowState>;
  runs: Map<string, RunState>;
  attempts: Map<string, AttemptState>;
  jobs: Map<string, JobState>;
  outbox: Map<string, OutboxState>;
  sourceRevisions: Map<string, SourceRevisionState>;
  artifactManifests: Map<string, ArtifactManifestState>;
  verifications: Map<string, VerificationState>;
  driverReceipts: Map<string, DriverReceiptState>;
  approvalRequests: Map<string, ApprovalRequestState>;
  programInterviews: Map<string, ProgramInterviewState>;
  programGraphs: Map<string, ProgramGraphState>;
  milestoneGenerations: Map<string, MilestoneGenerationState>;
  contextPackets: Map<string, ContextPacketState>;
  outcomeValidations: Map<string, OutcomeValidationState>;
  routedIssues: Map<string, RoutedIssueState>;
  attentionSpans: Map<string, AttentionSpanState>;
  outcomeDispositions: Map<string, OutcomeDispositionState>;
  measurementReports: Map<string, MeasurementReportState>;
  operatorDecisionRequests: Map<string, OperatorDecisionRequestState>;
  decisionPackets: Map<string, DecisionPacketState>;
  decisionPacketRevisions: Map<string, DecisionPacketRevisionState>;
  decisionEvidenceBundles: Map<string, DecisionEvidenceBundleState>;
  attentionPolicies: Map<string, AttentionPolicyState>;
  decisionAcknowledgements: Map<string, DecisionAcknowledgementState>;
  decisionResolutions: Map<string, DecisionResolutionState>;
  decisionActionResults: Map<string, DecisionActionResultState>;
  decisionPrecedents: Map<string, DecisionPrecedentState>;
  attentionDeliveries: Map<string, AttentionDeliveryState>;
  attentionBudgetIncidents: Map<string, AttentionBudgetIncidentState>;
  attentionMeasurementReports: Map<string, AttentionMeasurementReportState>;
  attentionDigestArtifacts: Map<string, AttentionDigestArtifactState>;
  portfolioPolicies: Map<string, PortfolioPolicyState>;
  integrationTargets: Map<string, IntegrationTargetState>;
  portfolioAdmissions: Map<string, PortfolioAdmissionState>;
  concurrencyLeases: Map<string, ConcurrencyLeaseState>;
  candidateDiffManifests: Map<string, CandidateDiffManifestState>;
  integrationCandidates: Map<string, IntegrationCandidateState>;
  integrationWork: Map<string, IntegrationWorkState>;
  integrationConflicts: Map<string, IntegrationConflictState>;
  integrationVerifications: Map<string, IntegrationVerificationState>;
  promotionReceipts: Map<string, PromotionReceiptState>;
  portfolioSloIncidents: Map<string, PortfolioSloIncidentState>;
  portfolioMeasurementReports: Map<string, PortfolioMeasurementReportState>;
  advisorSubjects: Map<string, AdvisorSubjectState>;
  advisorCases: Map<string, AdvisorCaseState>;
  advisorCorpora: Map<string, AdvisorCorpusState>;
  advisorContamination: Map<string, AdvisorContaminationState>;
  advisorInvocations: Map<string, AdvisorInvocationState>;
  advisorRecommendations: Map<string, AdvisorRecommendationState>;
  advisorEvaluations: Map<string, AdvisorEvaluationState>;
  decisionPolicyProposals: Map<string, DecisionPolicyProposalState>;
  decisionPolicies: Map<string, DecisionPolicyState>;
  decisionPolicyPromotions: Map<string, DecisionPolicyPromotionState>;
  advisorResolutions: Map<string, AdvisorResolutionState>;
  advisorAudits: Map<string, AdvisorAuditState>;
  advisorIncidents: Map<string, AdvisorIncidentState>;
  lastAppliedPosition: number;
}

export function emptyProjectionState(): ProjectionState {
  return {
    programs: new Map(),
    milestones: new Map(),
    outcomePackets: new Map(),
    workflows: new Map(),
    runs: new Map(),
    attempts: new Map(),
    jobs: new Map(),
    outbox: new Map(),
    sourceRevisions: new Map(),
    artifactManifests: new Map(),
    verifications: new Map(),
    driverReceipts: new Map(),
    approvalRequests: new Map(),
    programInterviews: new Map(),
    programGraphs: new Map(),
    milestoneGenerations: new Map(),
    contextPackets: new Map(),
    outcomeValidations: new Map(),
    routedIssues: new Map(),
    attentionSpans: new Map(),
    outcomeDispositions: new Map(),
    measurementReports: new Map(),
    operatorDecisionRequests: new Map(),
    decisionPackets: new Map(),
    decisionPacketRevisions: new Map(),
    decisionEvidenceBundles: new Map(),
    attentionPolicies: new Map(),
    decisionAcknowledgements: new Map(),
    decisionResolutions: new Map(),
    decisionActionResults: new Map(),
    decisionPrecedents: new Map(),
    attentionDeliveries: new Map(),
    attentionBudgetIncidents: new Map(),
    attentionMeasurementReports: new Map(),
    attentionDigestArtifacts: new Map(),
    portfolioPolicies: new Map(),
    integrationTargets: new Map(),
    portfolioAdmissions: new Map(),
    concurrencyLeases: new Map(),
    candidateDiffManifests: new Map(),
    integrationCandidates: new Map(),
    integrationWork: new Map(),
    integrationConflicts: new Map(),
    integrationVerifications: new Map(),
    promotionReceipts: new Map(),
    portfolioSloIncidents: new Map(),
    portfolioMeasurementReports: new Map(),
    advisorSubjects: new Map(),
    advisorCases: new Map(),
    advisorCorpora: new Map(),
    advisorContamination: new Map(),
    advisorInvocations: new Map(),
    advisorRecommendations: new Map(),
    advisorEvaluations: new Map(),
    decisionPolicyProposals: new Map(),
    decisionPolicies: new Map(),
    decisionPolicyPromotions: new Map(),
    advisorResolutions: new Map(),
    advisorAudits: new Map(),
    advisorIncidents: new Map(),
    lastAppliedPosition: 0
  };
}

export function workflowKey(workflowId: string, version: number): string {
  return `${workflowId}:${String(version)}`;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

export function evolve(state: ProjectionState, event: StoredEvent): ProjectionState {
  const next: ProjectionState = {
    programs: new Map(state.programs),
    milestones: new Map(state.milestones),
    outcomePackets: new Map(state.outcomePackets),
    workflows: new Map(state.workflows),
    runs: new Map(state.runs),
    attempts: new Map(state.attempts),
    jobs: new Map(state.jobs),
    outbox: new Map(state.outbox),
    sourceRevisions: new Map(state.sourceRevisions),
    artifactManifests: new Map(state.artifactManifests),
    verifications: new Map(state.verifications),
    driverReceipts: new Map(state.driverReceipts),
    approvalRequests: new Map(state.approvalRequests),
    programInterviews: new Map(state.programInterviews),
    programGraphs: new Map(state.programGraphs),
    milestoneGenerations: new Map(state.milestoneGenerations),
    contextPackets: new Map(state.contextPackets),
    outcomeValidations: new Map(state.outcomeValidations),
    routedIssues: new Map(state.routedIssues),
    attentionSpans: new Map(state.attentionSpans),
    outcomeDispositions: new Map(state.outcomeDispositions),
    measurementReports: new Map(state.measurementReports),
    operatorDecisionRequests: new Map(state.operatorDecisionRequests),
    decisionPackets: new Map(state.decisionPackets),
    decisionPacketRevisions: new Map(state.decisionPacketRevisions),
    decisionEvidenceBundles: new Map(state.decisionEvidenceBundles),
    attentionPolicies: new Map(state.attentionPolicies),
    decisionAcknowledgements: new Map(state.decisionAcknowledgements),
    decisionResolutions: new Map(state.decisionResolutions),
    decisionActionResults: new Map(state.decisionActionResults),
    decisionPrecedents: new Map(state.decisionPrecedents),
    attentionDeliveries: new Map(state.attentionDeliveries),
    attentionBudgetIncidents: new Map(state.attentionBudgetIncidents),
    attentionMeasurementReports: new Map(state.attentionMeasurementReports),
    attentionDigestArtifacts: new Map(state.attentionDigestArtifacts),
    portfolioPolicies: new Map(state.portfolioPolicies),
    integrationTargets: new Map(state.integrationTargets),
    portfolioAdmissions: new Map(state.portfolioAdmissions),
    concurrencyLeases: new Map(state.concurrencyLeases),
    candidateDiffManifests: new Map(state.candidateDiffManifests),
    integrationCandidates: new Map(state.integrationCandidates),
    integrationWork: new Map(state.integrationWork),
    integrationConflicts: new Map(state.integrationConflicts),
    integrationVerifications: new Map(state.integrationVerifications),
    promotionReceipts: new Map(state.promotionReceipts),
    portfolioSloIncidents: new Map(state.portfolioSloIncidents),
    portfolioMeasurementReports: new Map(state.portfolioMeasurementReports),
    advisorSubjects: new Map(state.advisorSubjects),
    advisorCases: new Map(state.advisorCases),
    advisorCorpora: new Map(state.advisorCorpora),
    advisorContamination: new Map(state.advisorContamination),
    advisorInvocations: new Map(state.advisorInvocations),
    advisorRecommendations: new Map(state.advisorRecommendations),
    advisorEvaluations: new Map(state.advisorEvaluations),
    decisionPolicyProposals: new Map(state.decisionPolicyProposals),
    decisionPolicies: new Map(state.decisionPolicies),
    decisionPolicyPromotions: new Map(state.decisionPolicyPromotions),
    advisorResolutions: new Map(state.advisorResolutions),
    advisorAudits: new Map(state.advisorAudits),
    advisorIncidents: new Map(state.advisorIncidents),
    lastAppliedPosition: event.globalPosition
  };

  switch (event.type) {
    case "SourceRevisionRegistered":
      if (
        event.data.revisionDigest !==
        sourceRevisionDigest({
          repositoryId: event.data.repositoryId,
          objectFormat: event.data.objectFormat,
          commitOid: event.data.commitOid,
          treeOid: event.data.treeOid
        })
      ) {
        throw new Error("Source revision event digest does not match its content");
      }
      next.sourceRevisions.set(event.data.revisionId, {
        kind: "source_revision",
        ...event.data,
        capturedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    case "ProgramCreated":
      next.programs.set(event.data.programId, {
        kind: "program",
        programId: event.data.programId,
        name: event.data.name,
        status: "active",
        intent: null,
        intentDigest: null,
        approvedBy: null,
        approvedAt: null,
        programMode: "legacy_v1",
        phase: "legacy_active",
        resumePhase: null,
        executionRequestId: null,
        executionRequestedAt: null,
        executionPolicy: null,
        attentionPriority: "p2",
        initialSourceRevisionId: null,
        initialSourceRevisionDigest: null,
        activeGraphRevisionId: null,
        activeGraphDigest: null,
        startedAt: null,
        createdAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    case "ProgramKickedOff":
      next.programs.set(event.data.programId, {
        kind: "program",
        programId: event.data.programId,
        name: event.data.name,
        status: "active",
        intent: null,
        intentDigest: null,
        approvedBy: null,
        approvedAt: null,
        programMode: "graph_v1",
        phase: "draft",
        resumePhase: null,
        executionRequestId: null,
        executionRequestedAt: null,
        executionPolicy: null,
        attentionPriority: "p2",
        initialSourceRevisionId: event.data.initialSourceRevisionId,
        initialSourceRevisionDigest: event.data.initialSourceRevisionDigest,
        activeGraphRevisionId: null,
        activeGraphDigest: null,
        startedAt: null,
        createdAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    case "ProgramInterviewCaptured":
      if (
        canonicalDigest(event.data.transcript) !== event.data.transcriptDigest ||
        canonicalDigest(event.data.playback) !== event.data.playbackDigest
      ) {
        throw new Error("Program interview event digest does not match its content");
      }
      next.programInterviews.set(event.data.interviewId, {
        kind: "program_interview",
        ...event.data,
        capturedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    case "ProgramGraphApproved": {
      if (canonicalDigest(event.data.graph) !== event.data.graphDigest) {
        throw new Error("Program graph event digest does not match its content");
      }
      const program = required(
        next.programs.get(event.data.graph.programId),
        `Missing program ${event.data.graph.programId}`
      );
      next.programGraphs.set(event.data.graph.graphRevisionId, {
        kind: "program_graph",
        graphRevisionId: event.data.graph.graphRevisionId,
        programId: event.data.graph.programId,
        revision: event.data.graph.revision,
        priorGraphRevisionId: event.data.graph.priorGraphRef?.id ?? null,
        graph: event.data.graph,
        graphDigest: event.data.graphDigest,
        approvedBy: event.data.approvedBy,
        approvedAt: event.occurredAt,
        supersededAt: null,
        version: event.streamVersion
      });
      next.programs.set(program.programId, {
        ...program,
        programMode: event.data.graph.schemaVersion === 2 ? "graph_v2" : program.programMode,
        phase: program.phase === "running" ? "running" : "approved",
        activeGraphRevisionId: event.data.graph.graphRevisionId,
        activeGraphDigest: event.data.graphDigest,
        approvedBy: event.data.approvedBy,
        approvedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "ProgramGraphSuperseded": {
      const graph = required(
        next.programGraphs.get(event.data.graphRevisionId),
        `Missing graph ${event.data.graphRevisionId}`
      );
      next.programGraphs.set(graph.graphRevisionId, {
        ...graph,
        supersededAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "ProgramStarted": {
      const program = required(
        next.programs.get(event.data.programId),
        `Missing program ${event.data.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        phase: "running",
        activeGraphRevisionId: event.data.graphRevisionId,
        activeGraphDigest: event.data.graphDigest,
        startedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "ProgramExecutionRequested": {
      const program = required(
        next.programs.get(event.data.programId),
        `Missing program ${event.data.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        programMode: "graph_v2",
        phase: "eligible",
        resumePhase: null,
        executionRequestId: event.data.requestId,
        executionRequestedAt: event.occurredAt,
        executionPolicy: event.data.policy,
        version: event.streamVersion
      });
      break;
    }
    case "ProgramIntegrationPending": {
      const program = required(
        next.programs.get(event.data.programId),
        `Missing program ${event.data.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        phase: "integration_pending",
        version: event.streamVersion
      });
      break;
    }
    case "ProgramCompleted": {
      const program = required(
        next.programs.get(event.data.programId),
        `Missing program ${event.data.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        phase: "completed",
        version: event.streamVersion
      });
      break;
    }
    case "ProgramParked": {
      const program = required(
        next.programs.get(event.data.programId),
        `Missing program ${event.data.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        phase: "parked",
        resumePhase:
          program.programMode === "graph_v2"
            ? program.phase === "running"
              ? "eligible"
              : program.phase === "eligible" || program.phase === "integration_pending"
                ? program.phase
                : null
            : null,
        version: event.streamVersion
      });
      break;
    }
    case "ProgramResumed": {
      const program = required(
        next.programs.get(event.data.programId),
        `Missing program ${event.data.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        phase: program.programMode === "graph_v2" ? (program.resumePhase ?? "eligible") : "running",
        resumePhase: null,
        version: event.streamVersion
      });
      break;
    }
    case "ProgramAttentionPriorityChanged": {
      const program = required(
        next.programs.get(event.data.programId),
        `Missing program ${event.data.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        attentionPriority: event.data.priority,
        version: event.streamVersion
      });
      break;
    }
    case "ProgramApproved": {
      if (canonicalDigest(event.data.intent) !== event.data.intentDigest) {
        throw new Error("Program intent event digest does not match its content");
      }
      const program = required(
        next.programs.get(event.data.programId),
        `Missing program ${event.data.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        intent: event.data.intent,
        intentDigest: event.data.intentDigest,
        approvedBy: event.data.approvedBy,
        approvedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "MilestoneApproved":
      if (canonicalDigest(event.data.contract) !== event.data.contractDigest) {
        throw new Error("Milestone contract event digest does not match its content");
      }
      next.milestones.set(event.data.milestoneId, {
        kind: "milestone",
        milestoneId: event.data.milestoneId,
        programId: event.data.programId,
        contract: event.data.contract,
        contractDigest: event.data.contractDigest,
        workflowDigest: event.data.workflowDigest,
        graphRevisionId: event.data.graphRevisionId ?? null,
        dependencies: event.data.dependencies ?? [],
        sourcePredecessorMilestoneId: event.data.sourcePredecessorMilestoneId ?? null,
        allowedWorkSurfaces: event.data.allowedWorkSurfaces ?? [],
        structuredWorkSurfaces: event.data.structuredWorkSurfaces ?? [],
        resourceClaims: event.data.resourceClaims ?? [],
        capabilityClaims: event.data.capabilityClaims ?? [],
        status: "approved",
        generation: 0,
        activeGenerationId: null,
        runId: null,
        jobId: null,
        baseRevisionId: null,
        outcomePacketId: null,
        latestValidatedOutcomePacketId: null,
        recommendation: null,
        pauseReason: null,
        approvedBy: event.data.approvedBy,
        approvedAt: event.occurredAt,
        startedAt: null,
        completedAt: null,
        version: event.streamVersion
      });
      break;
    case "ContextPacketCompiled":
      if (canonicalDigest(event.data.packet) !== event.data.packetDigest) {
        throw new Error("Context packet event digest does not match its content");
      }
      next.contextPackets.set(event.data.packet.contextPacketId, {
        kind: "context_packet",
        contextPacketId: event.data.packet.contextPacketId,
        programId: event.data.packet.programId,
        milestoneId: event.data.packet.milestoneId,
        generationId: event.data.packet.generationId,
        packet: event.data.packet,
        packetDigest: event.data.packetDigest,
        compiledAt: event.data.packet.compiledAt,
        version: event.streamVersion
      });
      break;
    case "MilestoneGenerationStarted": {
      const generation = event.data.generation;
      next.milestoneGenerations.set(generation.generationId, {
        kind: "milestone_generation",
        generationId: generation.generationId,
        programId: generation.programId,
        milestoneId: generation.milestoneId,
        graphRevisionId: generation.graphRevisionId,
        generation: generation.generation,
        runId: generation.runId,
        jobId: generation.jobId,
        contextPacketId: generation.contextPacketId,
        baseRevisionId: generation.baseRevisionId,
        status: generation.status,
        outcomePacketId: generation.outcomePacketId,
        recommendation: generation.recommendation,
        startedAt: generation.startedAt,
        completedAt: generation.completedAt,
        version: event.streamVersion
      });
      const milestone = required(
        next.milestones.get(generation.milestoneId),
        `Missing milestone ${generation.milestoneId}`
      );
      next.milestones.set(milestone.milestoneId, {
        ...milestone,
        status: "running",
        generation: generation.generation,
        activeGenerationId: generation.generationId,
        runId: generation.runId,
        jobId: generation.jobId,
        baseRevisionId: generation.baseRevisionId,
        outcomePacketId: null,
        recommendation: null,
        pauseReason: null,
        startedAt: generation.startedAt,
        completedAt: null,
        version: event.streamVersion
      });
      break;
    }
    case "MilestoneStarted": {
      const milestone = required(
        next.milestones.get(event.data.milestoneId),
        `Missing milestone ${event.data.milestoneId}`
      );
      next.milestones.set(milestone.milestoneId, {
        ...milestone,
        status: "running",
        runId: event.data.runId,
        jobId: event.data.jobId,
        baseRevisionId: event.data.baseRevisionId,
        startedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "MilestoneOutcomeReady": {
      const milestone = required(
        next.milestones.get(event.data.milestoneId),
        `Missing milestone ${event.data.milestoneId}`
      );
      next.milestones.set(milestone.milestoneId, {
        ...milestone,
        status: milestone.pauseReason ? "paused" : "outcome_ready",
        activeGenerationId: null,
        outcomePacketId: event.data.outcomePacketId,
        recommendation: event.data.recommendation,
        completedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "MilestoneGenerationOutcomeReady": {
      const generation = required(
        next.milestoneGenerations.get(event.data.generationId),
        `Missing generation ${event.data.generationId}`
      );
      next.milestoneGenerations.set(generation.generationId, {
        ...generation,
        status: generation.status === "paused" ? "paused" : "outcome_ready",
        outcomePacketId: event.data.outcomePacketId,
        recommendation: event.data.recommendation,
        completedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "OutcomePacketRecorded":
      if (canonicalDigest(event.data.packet) !== event.data.packetDigest) {
        throw new Error("Outcome packet event digest does not match its content");
      }
      next.outcomePackets.set(event.data.packet.outcomePacketId, {
        kind: "outcome_packet",
        outcomePacketId: event.data.packet.outcomePacketId,
        programId: event.data.packet.programId,
        milestoneId: event.data.packet.milestoneId,
        generationId: event.data.packet.schemaVersion === 2 ? event.data.packet.generationId : null,
        generation: event.data.packet.schemaVersion === 2 ? event.data.packet.generation : null,
        runId: event.data.packet.runId,
        packet: event.data.packet,
        packetDigest: event.data.packetDigest,
        recordedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    case "OutcomeValidationRecorded": {
      if (canonicalDigest(event.data.validation) !== event.data.validationDigest) {
        throw new Error("Outcome validation event digest does not match its content");
      }
      const validation = event.data.validation;
      next.outcomeValidations.set(validation.validationId, {
        kind: "outcome_validation",
        validationId: validation.validationId,
        programId: validation.programId,
        milestoneId: validation.milestoneId,
        outcomePacketId: validation.outcomePacketId,
        packetDigest: validation.packetDigest,
        validation,
        validationDigest: event.data.validationDigest,
        validatedAt: validation.validatedAt,
        version: event.streamVersion
      });
      const milestone = required(
        next.milestones.get(validation.milestoneId),
        `Missing milestone ${validation.milestoneId}`
      );
      next.milestones.set(milestone.milestoneId, {
        ...milestone,
        latestValidatedOutcomePacketId: validation.outcomePacketId
      });
      break;
    }
    case "WorkflowDefinitionRegistered":
      if (event.streamVersion !== event.data.definition.version) {
        throw new Error("Workflow business version must match its event stream version");
      }
      next.workflows.set(
        workflowKey(event.data.definition.workflowId, event.data.definition.version),
        {
          kind: "workflow",
          workflowId: event.data.definition.workflowId,
          version: event.data.definition.version,
          name: event.data.definition.name,
          definition: event.data.definition,
          definitionDigest: event.data.definitionDigest,
          registeredAt: event.occurredAt,
          streamVersion: event.streamVersion
        }
      );
      break;
    case "RunCreated":
      next.runs.set(event.data.runId, {
        kind: "run",
        runId: event.data.runId,
        programId: event.data.programId,
        workflowId: event.data.workflowId,
        workflowVersion: event.data.workflowVersion,
        milestoneId: null,
        generationId: null,
        generation: null,
        status: "created",
        createdAt: event.occurredAt,
        scheduledAt: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        cancellationReason: null,
        failureReason: null,
        version: event.streamVersion
      });
      break;
    case "MilestoneRunCreated":
      next.runs.set(event.data.runId, {
        kind: "run",
        runId: event.data.runId,
        programId: event.data.programId,
        workflowId: event.data.workflowId,
        workflowVersion: event.data.workflowVersion,
        milestoneId: event.data.milestoneId,
        generationId: event.data.generationId ?? null,
        generation: event.data.generation ?? null,
        status: "created",
        createdAt: event.occurredAt,
        scheduledAt: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        cancellationReason: null,
        failureReason: null,
        version: event.streamVersion
      });
      break;
    case "RunScheduled": {
      const run = required(next.runs.get(event.data.runId), `Missing run ${event.data.runId}`);
      next.runs.set(run.runId, {
        ...run,
        status: "scheduled",
        scheduledAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "RunStarted": {
      const run = required(next.runs.get(event.data.runId), `Missing run ${event.data.runId}`);
      next.runs.set(run.runId, {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "RunSucceeded": {
      const run = required(next.runs.get(event.data.runId), `Missing run ${event.data.runId}`);
      next.runs.set(run.runId, {
        ...run,
        status: "succeeded",
        completedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "RunFailed": {
      const run = required(next.runs.get(event.data.runId), `Missing run ${event.data.runId}`);
      next.runs.set(run.runId, {
        ...run,
        status: "failed",
        failureReason: event.data.reason,
        completedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "RunCancelled": {
      const run = required(next.runs.get(event.data.runId), `Missing run ${event.data.runId}`);
      next.runs.set(run.runId, {
        ...run,
        status: "cancelled",
        cancelledAt: event.occurredAt,
        cancellationReason: event.data.reason,
        completedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "AttemptAllocated":
      next.attempts.set(event.data.attemptId, {
        kind: "attempt",
        attemptId: event.data.attemptId,
        runId: event.data.runId,
        jobId: null,
        ordinal: event.data.ordinal,
        status: "allocated",
        allocatedAt: event.occurredAt,
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
        version: event.streamVersion
      });
      break;
    case "AttemptCancelled": {
      const attempt = required(
        next.attempts.get(event.data.attemptId),
        `Missing attempt ${event.data.attemptId}`
      );
      next.attempts.set(attempt.attemptId, {
        ...attempt,
        status: "cancelled",
        finishedAt: event.occurredAt,
        cancelledAt: event.occurredAt,
        cancellationReason: event.data.reason,
        terminationReason: "operator_cancelled",
        version: event.streamVersion
      });
      break;
    }
    case "JobScheduled": {
      if (event.data.executionContract?.protocolVersion === 2) {
        const manifest = event.data.capabilityManifest;
        const packet = event.data.contextPacketId
          ? next.contextPackets.get(event.data.contextPacketId)
          : undefined;
        if (
          manifest?.schemaVersion !== 2 ||
          !packet ||
          event.data.contextPacketDigest !== packet.packetDigest ||
          event.data.executionContract.context.contextPacketId !== packet.contextPacketId ||
          event.data.executionContract.context.contextPacketDigest !== packet.packetDigest ||
          manifest.context.contextPacketId !== packet.contextPacketId ||
          manifest.context.contextPacketDigest !== packet.packetDigest
        ) {
          throw new Error("Workflow V3 job is not bound to its immutable context packet");
        }
      } else if (
        event.data.executionContract?.protocolVersion === 1 &&
        (event.data.contextPacketId !== undefined ||
          event.data.contextPacketDigest !== undefined ||
          event.data.capabilityManifest?.schemaVersion === 2)
      ) {
        throw new Error("Workflow V1/V2 job cannot carry a program context binding");
      }
      next.jobs.set(event.data.jobId, {
        kind: "job",
        jobId: event.data.jobId,
        runId: event.data.runId,
        stepId: event.data.stepId,
        capability: event.data.capability,
        dependencyJobIds: event.data.dependencyJobIds,
        status: event.data.initialStatus,
        policy: event.data.policy,
        sourceRevisionId: event.data.sourceRevisionId ?? null,
        executionContract: event.data.executionContract ?? null,
        executionContractDigest: event.data.executionContractDigest ?? null,
        capabilityManifest: event.data.capabilityManifest ?? null,
        capabilityManifestDigest: event.data.capabilityManifestDigest ?? null,
        contextPacketId: event.data.contextPacketId ?? null,
        contextPacketDigest: event.data.contextPacketDigest ?? null,
        verifierContract: event.data.verifierContract ?? null,
        verifierContractDigest: event.data.verifierContractDigest ?? null,
        candidateRevisionId: null,
        attemptCount: 0,
        activeAttemptId: null,
        availableAt: event.occurredAt,
        leaseOwnerId: null,
        leaseFencingToken: 0,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        createdAt: event.occurredAt,
        completedAt: null,
        failureReason: null,
        version: event.streamVersion
      });
      break;
    }
    case "JobUnblocked": {
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        status: "ready",
        availableAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "JobLeaseAcquired": {
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        status: "active",
        leaseOwnerId: event.data.ownerId,
        leaseFencingToken: event.data.fencingToken,
        leaseAcquiredAt: event.occurredAt,
        leaseExpiresAt: event.data.leaseExpiresAt,
        version: event.streamVersion
      });
      break;
    }
    case "JobLeaseRenewed": {
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        leaseExpiresAt: event.data.leaseExpiresAt,
        version: event.streamVersion
      });
      break;
    }
    case "JobLeaseReleased": {
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        version: event.streamVersion
      });
      break;
    }
    case "JobRetryScheduled": {
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        status: "retry_wait",
        activeAttemptId: null,
        availableAt: event.data.availableAt,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        failureReason: event.data.reason,
        version: event.streamVersion
      });
      break;
    }
    case "JobSucceeded": {
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        status: "succeeded",
        activeAttemptId: null,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        completedAt: event.occurredAt,
        failureReason: null,
        version: event.streamVersion
      });
      break;
    }
    case "JobFailed": {
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        status: "failed",
        activeAttemptId: null,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        completedAt: event.occurredAt,
        failureReason: event.data.reason,
        version: event.streamVersion
      });
      break;
    }
    case "JobCancelled": {
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        status: "cancelled",
        activeAttemptId: null,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        completedAt: event.occurredAt,
        failureReason: event.data.reason,
        version: event.streamVersion
      });
      break;
    }
    case "AttemptStarted": {
      next.attempts.set(event.data.attemptId, {
        kind: "attempt",
        attemptId: event.data.attemptId,
        runId: event.data.runId,
        jobId: event.data.jobId,
        ordinal: event.data.ordinal,
        status: "starting",
        allocatedAt: event.occurredAt,
        startedAt: event.occurredAt,
        deadlineAt: event.data.deadlineAt,
        externalRunId: null,
        driverCursor: 0,
        cumulativeUsage: null,
        candidateRevisionId: null,
        driverReceiptId: null,
        finishedAt: null,
        cancelledAt: null,
        cancellationReason: null,
        terminationReason: null,
        version: event.streamVersion
      });
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      next.jobs.set(job.jobId, {
        ...job,
        attemptCount: event.data.ordinal,
        activeAttemptId: event.data.attemptId
      });
      break;
    }
    case "AttemptRunning": {
      const attempt = required(
        next.attempts.get(event.data.attemptId),
        `Missing attempt ${event.data.attemptId}`
      );
      next.attempts.set(attempt.attemptId, {
        ...attempt,
        status: "running",
        externalRunId: event.data.externalRunId,
        version: event.streamVersion
      });
      break;
    }
    case "DriverEventsObserved": {
      const attempt = required(
        next.attempts.get(event.data.attemptId),
        `Missing attempt ${event.data.attemptId}`
      );
      if (event.data.afterSequence !== attempt.driverCursor) {
        throw new Error("Driver event replay cursor does not match the attempt");
      }
      let expectedSequence = attempt.driverCursor + 1;
      for (const observed of event.data.events) {
        if (observed.sequence !== expectedSequence) {
          throw new Error("Driver event replay sequence is not contiguous");
        }
        expectedSequence += 1;
      }
      if (event.data.cursor !== expectedSequence - 1) {
        throw new Error("Driver event replay cursor does not match its events");
      }
      next.attempts.set(attempt.attemptId, {
        ...attempt,
        driverCursor: event.data.cursor,
        cumulativeUsage: event.data.cumulativeUsage,
        version: event.streamVersion
      });
      break;
    }
    case "AttemptVerificationRequested": {
      const attempt = required(
        next.attempts.get(event.data.attemptId),
        `Missing attempt ${event.data.attemptId}`
      );
      next.attempts.set(attempt.attemptId, {
        ...attempt,
        status: "verifying",
        version: event.streamVersion
      });
      break;
    }
    case "AttemptFinished": {
      const attempt = required(
        next.attempts.get(event.data.attemptId),
        `Missing attempt ${event.data.attemptId}`
      );
      next.attempts.set(attempt.attemptId, {
        ...attempt,
        status: event.data.status,
        finishedAt: event.occurredAt,
        cancelledAt: event.data.status === "cancelled" ? event.occurredAt : null,
        cancellationReason:
          event.data.status === "cancelled"
            ? (event.data.detail ?? event.data.terminationReason)
            : null,
        terminationReason: event.data.terminationReason,
        version: event.streamVersion
      });
      break;
    }
    case "OutboxEnqueued":
      next.outbox.set(event.data.outboxId, {
        kind: "outbox",
        outboxId: event.data.outboxId,
        runId: event.data.runId,
        jobId: event.data.jobId,
        attemptId: event.data.attemptId,
        effectKey: event.data.effectKey,
        effect: event.data.effect,
        status: "pending",
        deliveryAttempts: 0,
        retryDelaysMs: event.data.retryDelaysMs,
        availableAt: event.occurredAt,
        leaseOwnerId: null,
        leaseFencingToken: 0,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        externalEffectId: null,
        createdAt: event.occurredAt,
        deliveredAt: null,
        lastError: null,
        version: event.streamVersion
      });
      break;
    case "OutboxLeaseAcquired": {
      const outbox = required(
        next.outbox.get(event.data.outboxId),
        `Missing outbox ${event.data.outboxId}`
      );
      next.outbox.set(outbox.outboxId, {
        ...outbox,
        status: "leased",
        deliveryAttempts: event.data.deliveryAttempt,
        leaseOwnerId: event.data.ownerId,
        leaseFencingToken: event.data.fencingToken,
        leaseAcquiredAt: event.occurredAt,
        leaseExpiresAt: event.data.leaseExpiresAt,
        version: event.streamVersion
      });
      break;
    }
    case "OutboxDeliveryFailed": {
      const outbox = required(
        next.outbox.get(event.data.outboxId),
        `Missing outbox ${event.data.outboxId}`
      );
      next.outbox.set(outbox.outboxId, {
        ...outbox,
        status: event.data.deadLetter ? "dead_letter" : "pending",
        availableAt: event.data.availableAt ?? outbox.availableAt,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        lastError: event.data.error,
        version: event.streamVersion
      });
      break;
    }
    case "OutboxDelivered": {
      const outbox = required(
        next.outbox.get(event.data.outboxId),
        `Missing outbox ${event.data.outboxId}`
      );
      next.outbox.set(outbox.outboxId, {
        ...outbox,
        status: "delivered",
        externalEffectId: event.data.externalEffectId,
        deliveredAt: event.occurredAt,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        lastError: null,
        version: event.streamVersion
      });
      break;
    }
    case "OutboxObsoleted": {
      const outbox = required(
        next.outbox.get(event.data.outboxId),
        `Missing outbox ${event.data.outboxId}`
      );
      next.outbox.set(outbox.outboxId, {
        ...outbox,
        status: "obsolete",
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        lastError: event.data.reason,
        version: event.streamVersion
      });
      break;
    }
    case "ArtifactManifestRecorded":
      if (event.data.manifestDigest !== artifactManifestDigest(event.data.entries)) {
        throw new Error("Artifact manifest event digest does not match its content");
      }
      next.artifactManifests.set(event.data.artifactManifestId, {
        kind: "artifact_manifest",
        ...event.data,
        createdAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    case "DriverReceiptRecorded": {
      const attempt = required(
        next.attempts.get(event.data.attemptId),
        `Missing attempt ${event.data.attemptId}`
      );
      const job = required(next.jobs.get(event.data.jobId), `Missing job ${event.data.jobId}`);
      if (
        event.data.receiptDigest !== driverReceiptDigest(event.data.receipt) ||
        event.data.receipt.receiptDigest !== event.data.receiptDigest ||
        event.data.receipt.runId !== event.data.runId ||
        event.data.receipt.jobId !== event.data.jobId ||
        event.data.receipt.attemptId !== event.data.attemptId ||
        event.data.receipt.baseRevisionId !== event.data.baseRevisionId ||
        event.data.receipt.candidateRevisionId !== event.data.candidateRevisionId ||
        event.data.receipt.outcome !== event.data.outcome ||
        event.data.receipt.terminalReason !== event.data.terminalReason ||
        event.data.receipt.eventCount !== attempt.driverCursor ||
        (event.data.receipt.schemaVersion === 1
          ? event.data.receipt.driver !== "generic-command"
          : (event.data.receipt.driver !== "generic-command" &&
              event.data.receipt.driver !== "trusted-cost-adapter-v1") ||
            (event.data.receipt.driver === "generic-command" &&
              event.data.receipt.usage.monetaryCost.status !== "unavailable")) ||
        (event.data.receipt.schemaVersion === 2
          ? event.data.receipt.contextPacketId !== job.contextPacketId ||
            event.data.receipt.contextPacketDigest !== job.contextPacketDigest ||
            job.executionContract?.protocolVersion !== 2 ||
            job.capabilityManifest?.schemaVersion !== 2
          : job.contextPacketId != null ||
            job.contextPacketDigest != null ||
            job.executionContract?.protocolVersion === 2 ||
            job.capabilityManifest?.schemaVersion === 2)
      ) {
        throw new Error("Driver receipt event identity does not match its content");
      }
      next.driverReceipts.set(event.data.driverReceiptId, {
        kind: "driver_receipt",
        ...event.data,
        recordedAt: event.occurredAt,
        version: event.streamVersion
      });
      next.attempts.set(attempt.attemptId, {
        ...attempt,
        candidateRevisionId: event.data.candidateRevisionId,
        driverReceiptId: event.data.driverReceiptId
      });
      next.jobs.set(job.jobId, {
        ...job,
        candidateRevisionId: event.data.candidateRevisionId
      });
      break;
    }
    case "ApprovalRequestRecorded":
      next.approvalRequests.set(event.data.approvalRequestId, {
        kind: "approval_request",
        ...event.data,
        requestedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    case "RoutedIssueRaised": {
      if (canonicalDigest(event.data.issue) !== event.data.issueDigest) {
        throw new Error("Routed issue event digest does not match its content");
      }
      next.routedIssues.set(event.data.issue.issueId, {
        kind: "routed_issue",
        issue: event.data.issue,
        issueDigest: event.data.issueDigest,
        version: event.streamVersion
      });
      for (const milestoneId of event.data.pausedMilestoneIds) {
        const milestone = required(
          next.milestones.get(milestoneId),
          `Missing milestone ${milestoneId}`
        );
        next.milestones.set(milestoneId, {
          ...milestone,
          status: "paused",
          pauseReason: event.data.issue.issueId
        });
        if (milestone.activeGenerationId) {
          const generation = next.milestoneGenerations.get(milestone.activeGenerationId);
          if (generation) {
            next.milestoneGenerations.set(generation.generationId, {
              ...generation,
              status: "paused"
            });
          }
        }
      }
      break;
    }
    case "RoutedIssueResolved": {
      const stored = required(
        next.routedIssues.get(event.data.issueId),
        `Missing routed issue ${event.data.issueId}`
      );
      const issue = {
        ...stored.issue,
        status:
          event.data.action === "requires_graph_revision"
            ? ("requires_graph_revision" as const)
            : ("resolved" as const),
        resolution: {
          action: event.data.action,
          text: event.data.text,
          resolvedBy: event.data.resolvedBy,
          resolvedAt: event.occurredAt
        }
      };
      next.routedIssues.set(event.data.issueId, {
        ...stored,
        issue,
        issueDigest: canonicalDigest(issue),
        version: event.streamVersion
      });
      for (const milestoneId of event.data.resumedMilestoneIds) {
        const milestone = required(
          next.milestones.get(milestoneId),
          `Missing milestone ${milestoneId}`
        );
        next.milestones.set(milestoneId, {
          ...milestone,
          status: "approved",
          activeGenerationId: null,
          pauseReason: null
        });
      }
      break;
    }
    case "RoutedIssueGraphRevisionSatisfied": {
      const stored = required(
        next.routedIssues.get(event.data.issueId),
        `Missing routed issue ${event.data.issueId}`
      );
      if (
        stored.issue.programId !== event.data.programId ||
        stored.issue.status !== "requires_graph_revision" ||
        !stored.issue.resolution
      ) {
        throw new Error("Graph revision cannot satisfy this routed issue");
      }
      const issue = {
        ...stored.issue,
        status: "resolved" as const,
        resolution: {
          ...stored.issue.resolution,
          satisfiedByGraphRevisionId: event.data.graphRevisionId
        }
      };
      next.routedIssues.set(event.data.issueId, {
        ...stored,
        issue,
        issueDigest: canonicalDigest(issue),
        version: event.streamVersion
      });
      break;
    }
    case "AttentionSpanStarted":
      next.attentionSpans.set(event.data.span.attentionSpanId, {
        kind: "attention_span",
        attentionSpanId: event.data.span.attentionSpanId,
        programId: event.data.span.programId,
        actorId: event.data.span.actorId,
        label: event.data.span.label,
        startedAt: event.data.span.startedAt,
        stoppedAt: event.data.span.stoppedAt,
        version: event.streamVersion
      });
      break;
    case "AttentionSpanStopped": {
      const span = required(
        next.attentionSpans.get(event.data.attentionSpanId),
        `Missing attention span ${event.data.attentionSpanId}`
      );
      next.attentionSpans.set(span.attentionSpanId, {
        ...span,
        stoppedAt: event.data.stoppedAt,
        version: event.streamVersion
      });
      break;
    }
    case "OutcomeDispositionRecorded":
      next.outcomeDispositions.set(event.data.disposition.outcomePacketId, {
        kind: "outcome_disposition",
        disposition: event.data.disposition,
        version: event.streamVersion
      });
      break;
    case "MeasurementReportCompiled":
      if (canonicalDigest(event.data.report) !== event.data.reportDigest) {
        throw new Error("Measurement report event digest does not match its content");
      }
      next.measurementReports.set(event.data.report.reportId, {
        kind: "measurement_report",
        report: event.data.report,
        reportDigest: event.data.reportDigest,
        version: event.streamVersion
      });
      break;
    case "AttentionPolicyApproved": {
      if (canonicalDigest(event.data.policy) !== event.data.policyDigest) {
        throw new Error("Attention policy event digest does not match its content");
      }
      if (event.data.supersededPolicyRevisionId) {
        const prior = required(
          next.attentionPolicies.get(event.data.supersededPolicyRevisionId),
          `Missing attention policy ${event.data.supersededPolicyRevisionId}`
        );
        next.attentionPolicies.set(prior.policy.policyRevisionId, {
          ...prior,
          supersededAt: event.occurredAt
        });
      }
      next.attentionPolicies.set(event.data.policy.policyRevisionId, {
        kind: "attention_policy",
        policy: event.data.policy,
        policyDigest: event.data.policyDigest,
        supersededAt: null,
        version: event.streamVersion
      });
      break;
    }
    case "OperatorDecisionRequestRecorded":
      if (canonicalDigest(event.data.request) !== event.data.requestDigest) {
        throw new Error("Operator decision request event digest does not match its content");
      }
      next.operatorDecisionRequests.set(event.data.request.requestId, {
        kind: "operator_decision_request",
        request: event.data.request,
        requestDigest: event.data.requestDigest,
        version: event.streamVersion
      });
      break;
    case "DecisionEvidenceBundleRecorded":
      if (canonicalDigest(event.data.bundle) !== event.data.bundleDigest) {
        throw new Error("Decision evidence bundle event digest does not match its content");
      }
      next.decisionEvidenceBundles.set(event.data.bundle.evidenceBundleId, {
        kind: "decision_evidence_bundle",
        bundle: event.data.bundle,
        bundleDigest: event.data.bundleDigest,
        version: event.streamVersion
      });
      break;
    case "DecisionPacketOpened":
      next.decisionPackets.set(event.data.packetId, {
        kind: "decision_packet",
        packetId: event.data.packetId,
        programId: event.data.programId,
        milestoneId: event.data.milestoneId,
        currentRevisionId: event.data.packetRevisionId,
        currentRevisionDigest: event.data.packetRevisionDigest,
        status: "open",
        acknowledgementId: null,
        resolutionId: null,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    case "DecisionPacketCurrentRevisionChanged": {
      const packet = required(
        next.decisionPackets.get(event.data.packetId),
        `Missing decision packet ${event.data.packetId}`
      );
      if (
        packet.currentRevisionId !== event.data.priorPacketRevisionId ||
        packet.status !== "open"
      ) {
        throw new Error("Decision packet revision transition is stale");
      }
      next.decisionPackets.set(packet.packetId, {
        ...packet,
        currentRevisionId: event.data.packetRevisionId,
        currentRevisionDigest: event.data.packetRevisionDigest,
        acknowledgementId: null,
        updatedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "DecisionPacketRevisionRecorded":
      if (canonicalDigest(event.data.revision) !== event.data.revisionDigest) {
        throw new Error("Decision packet revision event digest does not match its content");
      }
      next.decisionPacketRevisions.set(event.data.revision.packetRevisionId, {
        kind: "decision_packet_revision",
        revision: event.data.revision,
        revisionDigest: event.data.revisionDigest,
        version: event.streamVersion
      });
      break;
    case "DecisionAcknowledged": {
      if (canonicalDigest(event.data.acknowledgement) !== event.data.acknowledgementDigest) {
        throw new Error("Decision acknowledgement event digest does not match its content");
      }
      const packet = required(
        next.decisionPackets.get(event.data.acknowledgement.packetId),
        `Missing decision packet ${event.data.acknowledgement.packetId}`
      );
      next.decisionAcknowledgements.set(event.data.acknowledgement.acknowledgementId, {
        kind: "decision_acknowledgement",
        acknowledgement: event.data.acknowledgement,
        acknowledgementDigest: event.data.acknowledgementDigest,
        version: event.streamVersion
      });
      next.decisionPackets.set(packet.packetId, {
        ...packet,
        acknowledgementId: event.data.acknowledgement.acknowledgementId,
        updatedAt: event.occurredAt
      });
      break;
    }
    case "DecisionExpired": {
      const packet = required(
        next.decisionPackets.get(event.data.packetId),
        `Missing decision packet ${event.data.packetId}`
      );
      next.decisionPackets.set(packet.packetId, {
        ...packet,
        status: "expired",
        updatedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "DecisionActionApplied":
      if (canonicalDigest(event.data.result) !== event.data.resultDigest) {
        throw new Error("Decision action result event digest does not match its content");
      }
      next.decisionActionResults.set(event.data.result.actionResultId, {
        kind: "decision_action_result",
        result: event.data.result,
        resultDigest: event.data.resultDigest,
        version: event.streamVersion
      });
      break;
    case "DecisionResolved": {
      if (canonicalDigest(event.data.resolution) !== event.data.resolutionDigest) {
        throw new Error("Decision resolution event digest does not match its content");
      }
      const packet = required(
        next.decisionPackets.get(event.data.resolution.packetId),
        `Missing decision packet ${event.data.resolution.packetId}`
      );
      next.decisionResolutions.set(event.data.resolution.resolutionId, {
        kind: "decision_resolution",
        resolution: event.data.resolution,
        resolutionDigest: event.data.resolutionDigest,
        version: event.streamVersion
      });
      next.decisionPackets.set(packet.packetId, {
        ...packet,
        status: "resolved",
        resolutionId: event.data.resolution.resolutionId,
        updatedAt: event.occurredAt
      });
      break;
    }
    case "DecisionPrecedentRecorded":
      if (canonicalDigest(event.data.precedent) !== event.data.precedentDigest) {
        throw new Error("Decision precedent event digest does not match its content");
      }
      next.decisionPrecedents.set(event.data.precedent.precedentId, {
        kind: "decision_precedent",
        precedent: event.data.precedent,
        precedentDigest: event.data.precedentDigest,
        version: event.streamVersion
      });
      break;
    case "AttentionBudgetIncidentRecorded":
      if (canonicalDigest(event.data.incident) !== event.data.incidentDigest) {
        throw new Error("Attention budget incident event digest does not match its content");
      }
      next.attentionBudgetIncidents.set(event.data.incident.incidentId, {
        kind: "attention_budget_incident",
        incident: event.data.incident,
        incidentDigest: event.data.incidentDigest,
        version: event.streamVersion
      });
      break;
    case "AttentionDeliveryQueued":
      next.attentionDeliveries.set(event.data.delivery.deliveryId, {
        kind: "attention_delivery",
        delivery: event.data.delivery,
        version: event.streamVersion
      });
      break;
    case "AttentionDeliveryLeaseAcquired": {
      const stored = required(
        next.attentionDeliveries.get(event.data.deliveryId),
        `Missing attention delivery ${event.data.deliveryId}`
      );
      next.attentionDeliveries.set(event.data.deliveryId, {
        ...stored,
        delivery: {
          ...stored.delivery,
          status: "leased",
          deliveryAttempts: event.data.deliveryAttempt,
          leaseOwnerId: event.data.ownerId,
          leaseFencingToken: event.data.fencingToken,
          leaseAcquiredAt: event.occurredAt,
          leaseExpiresAt: event.data.leaseExpiresAt
        },
        version: event.streamVersion
      });
      break;
    }
    case "AttentionDeliveryFailed": {
      const stored = required(
        next.attentionDeliveries.get(event.data.deliveryId),
        `Missing attention delivery ${event.data.deliveryId}`
      );
      next.attentionDeliveries.set(event.data.deliveryId, {
        ...stored,
        delivery: {
          ...stored.delivery,
          status: event.data.permanent ? "permanent_failure" : "pending",
          availableAt: event.data.availableAt,
          leaseOwnerId: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastError: event.data.error
        },
        version: event.streamVersion
      });
      break;
    }
    case "AttentionDeliverySucceeded": {
      const stored = required(
        next.attentionDeliveries.get(event.data.deliveryId),
        `Missing attention delivery ${event.data.deliveryId}`
      );
      next.attentionDeliveries.set(event.data.deliveryId, {
        ...stored,
        delivery: {
          ...stored.delivery,
          status: "delivered",
          receipt: event.data.receipt,
          deliveredAt: event.occurredAt,
          leaseOwnerId: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastError: null
        },
        version: event.streamVersion
      });
      break;
    }
    case "AttentionDeliveryObsoleted": {
      const stored = required(
        next.attentionDeliveries.get(event.data.deliveryId),
        `Missing attention delivery ${event.data.deliveryId}`
      );
      next.attentionDeliveries.set(event.data.deliveryId, {
        ...stored,
        delivery: {
          ...stored.delivery,
          status: "obsolete",
          leaseOwnerId: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastError: event.data.reason
        },
        version: event.streamVersion
      });
      break;
    }
    case "AttentionMeasurementReportCompiled":
      if (canonicalDigest(event.data.report) !== event.data.reportDigest) {
        throw new Error("Attention measurement report event digest does not match its content");
      }
      next.attentionMeasurementReports.set(event.data.report.reportId, {
        kind: "attention_measurement_report",
        report: event.data.report,
        reportDigest: event.data.reportDigest,
        version: event.streamVersion
      });
      break;
    case "AttentionDigestArtifactCompiled":
      if (canonicalDigest(event.data.artifact) !== event.data.artifactDigest) {
        throw new Error("Attention digest artifact event digest does not match its content");
      }
      next.attentionDigestArtifacts.set(event.data.artifact.artifactId, {
        kind: "attention_digest_artifact",
        artifact: event.data.artifact,
        artifactDigest: event.data.artifactDigest,
        version: event.streamVersion
      });
      break;
    case "PortfolioPolicyApproved": {
      if (canonicalDigest(event.data.policy) !== event.data.policyDigest) {
        throw new Error("Portfolio policy event digest does not match its content");
      }
      if (event.data.supersededPolicyRevisionId) {
        const prior = required(
          next.portfolioPolicies.get(event.data.supersededPolicyRevisionId),
          `Missing portfolio policy ${event.data.supersededPolicyRevisionId}`
        );
        next.portfolioPolicies.set(event.data.supersededPolicyRevisionId, {
          ...prior,
          supersededAt: event.occurredAt
        });
      }
      next.portfolioPolicies.set(event.data.policy.policyRevisionId, {
        kind: "portfolio_policy",
        policy: event.data.policy,
        policyDigest: event.data.policyDigest,
        supersededAt: null,
        version: event.streamVersion
      });
      break;
    }
    case "IntegrationTargetApproved": {
      if (
        canonicalDigest(event.data.target) !== event.data.targetDigest ||
        canonicalDigest(event.data.target.verifierContract) !==
          event.data.target.verifierContractDigest
      ) {
        throw new Error("Integration target event digest does not match its content");
      }
      if (event.data.supersededTargetRevisionId) {
        const prior = required(
          next.integrationTargets.get(event.data.supersededTargetRevisionId),
          `Missing integration target ${event.data.supersededTargetRevisionId}`
        );
        next.integrationTargets.set(event.data.supersededTargetRevisionId, {
          ...prior,
          supersededAt: event.occurredAt
        });
      }
      next.integrationTargets.set(event.data.target.targetRevisionId, {
        kind: "integration_target",
        target: event.data.target,
        targetDigest: event.data.targetDigest,
        supersededAt: null,
        currentHeadRef: event.data.target.initialHeadRef,
        version: event.streamVersion
      });
      break;
    }
    case "PortfolioAdmissionGranted": {
      if (canonicalDigest(event.data.admission) !== event.data.admissionDigest) {
        throw new Error("Portfolio admission event digest does not match its content");
      }
      next.portfolioAdmissions.set(event.data.admission.admissionId, {
        kind: "portfolio_admission",
        admission: event.data.admission,
        admissionDigest: event.data.admissionDigest,
        status: "active",
        reason: null,
        version: event.streamVersion
      });
      for (const entry of event.data.leases) {
        if (canonicalDigest(entry.lease) !== entry.leaseDigest) {
          throw new Error("Concurrency lease event digest does not match its content");
        }
        next.concurrencyLeases.set(entry.lease.leaseId, {
          kind: "concurrency_lease",
          lease: entry.lease,
          leaseDigest: entry.leaseDigest,
          status: "active",
          version: event.streamVersion
        });
      }
      const program = required(
        next.programs.get(event.data.admission.programId),
        `Missing program ${event.data.admission.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        phase: "running",
        version: event.streamVersion
      });
      break;
    }
    case "PortfolioLeaseRenewed": {
      if (canonicalDigest(event.data.lease) !== event.data.leaseDigest) {
        throw new Error("Renewed concurrency lease digest does not match its content");
      }
      const prior = required(
        next.concurrencyLeases.get(event.data.lease.leaseId),
        `Missing concurrency lease ${event.data.lease.leaseId}`
      );
      next.concurrencyLeases.set(event.data.lease.leaseId, {
        ...prior,
        lease: event.data.lease,
        leaseDigest: event.data.leaseDigest,
        version: event.streamVersion
      });
      break;
    }
    case "PortfolioAdmissionReleased":
    case "PortfolioAdmissionFenced": {
      const admission = required(
        next.portfolioAdmissions.get(event.data.admissionId),
        `Missing portfolio admission ${event.data.admissionId}`
      );
      const status = event.type === "PortfolioAdmissionReleased" ? "released" : "fenced";
      const transitionAt =
        event.type === "PortfolioAdmissionReleased" ? event.data.releasedAt : event.data.fencedAt;
      const nextAdmission = {
        ...admission.admission,
        releasedAt: status === "released" ? transitionAt : admission.admission.releasedAt,
        fencedAt: status === "fenced" ? transitionAt : admission.admission.fencedAt
      };
      next.portfolioAdmissions.set(event.data.admissionId, {
        ...admission,
        admission: nextAdmission,
        admissionDigest: canonicalDigest(nextAdmission),
        status,
        reason: event.data.reason,
        version: event.streamVersion
      });
      for (const leaseId of event.data.leaseIds) {
        const prior = required(
          next.concurrencyLeases.get(leaseId),
          `Missing concurrency lease ${leaseId}`
        );
        const lease = {
          ...prior.lease,
          releasedAt: status === "released" ? transitionAt : prior.lease.releasedAt,
          fencedAt: status === "fenced" ? transitionAt : prior.lease.fencedAt
        };
        next.concurrencyLeases.set(leaseId, {
          ...prior,
          lease,
          leaseDigest: canonicalDigest(lease),
          status,
          version: event.streamVersion
        });
      }
      const program = next.programs.get(admission.admission.programId);
      if (program?.programMode === "graph_v2" && program.phase === "running") {
        next.programs.set(program.programId, {
          ...program,
          phase: "eligible",
          version: event.streamVersion
        });
      }
      break;
    }
    case "CandidateDiffManifestRecorded":
      if (canonicalDigest(event.data.manifest) !== event.data.manifestDigest) {
        throw new Error("Candidate diff manifest event digest does not match its content");
      }
      next.candidateDiffManifests.set(event.data.manifest.manifestId, {
        kind: "candidate_diff_manifest",
        manifest: event.data.manifest,
        manifestDigest: event.data.manifestDigest,
        version: event.streamVersion
      });
      break;
    case "IntegrationCandidateQueued":
      if (
        canonicalDigest(event.data.candidate) !== event.data.candidateDigest ||
        canonicalDigest(event.data.work) !== event.data.workDigest
      ) {
        throw new Error("Integration candidate event digest does not match its content");
      }
      next.integrationCandidates.set(event.data.candidate.candidateId, {
        kind: "integration_candidate",
        candidate: event.data.candidate,
        candidateDigest: event.data.candidateDigest,
        status: "pending",
        version: event.streamVersion
      });
      next.integrationWork.set(event.data.work.workId, {
        kind: "integration_work",
        work: event.data.work,
        workDigest: event.data.workDigest,
        version: event.streamVersion
      });
      break;
    case "IntegrationWorkLeaseAcquired": {
      const stored = required(
        next.integrationWork.get(event.data.workId),
        `Missing integration work ${event.data.workId}`
      );
      const work = {
        ...stored.work,
        status: "leased" as const,
        leaseOwnerId: event.data.ownerId,
        leaseFencingToken: event.data.fencingToken,
        leaseAcquiredAt: event.occurredAt,
        leaseExpiresAt: event.data.leaseExpiresAt
      };
      next.integrationWork.set(event.data.workId, {
        ...stored,
        work,
        workDigest: canonicalDigest(work),
        version: event.streamVersion
      });
      const candidate = required(
        next.integrationCandidates.get(stored.work.candidateId),
        `Missing integration candidate ${stored.work.candidateId}`
      );
      next.integrationCandidates.set(stored.work.candidateId, {
        ...candidate,
        status: "preparing",
        version: event.streamVersion
      });
      break;
    }
    case "IntegrationCandidatePrepared": {
      const stored = required(
        next.integrationWork.get(event.data.workId),
        `Missing integration work ${event.data.workId}`
      );
      const work = {
        ...stored.work,
        status: "prepared" as const,
        expectedHeadRef: event.data.expectedHeadRef,
        rebasedCandidateRef: event.data.rebasedCandidateRef,
        leaseOwnerId: stored.work.leaseOwnerId,
        leaseAcquiredAt: stored.work.leaseAcquiredAt,
        leaseExpiresAt: stored.work.leaseExpiresAt
      };
      next.integrationWork.set(event.data.workId, {
        ...stored,
        work,
        workDigest: canonicalDigest(work),
        version: event.streamVersion
      });
      const candidate = required(
        next.integrationCandidates.get(stored.work.candidateId),
        `Missing integration candidate ${stored.work.candidateId}`
      );
      next.integrationCandidates.set(stored.work.candidateId, {
        ...candidate,
        status: "verifying",
        version: event.streamVersion
      });
      break;
    }
    case "IntegrationConflictRecorded": {
      if (canonicalDigest(event.data.conflict) !== event.data.conflictDigest) {
        throw new Error("Integration conflict event digest does not match its content");
      }
      const stored = required(
        next.integrationWork.get(event.data.workId),
        `Missing integration work ${event.data.workId}`
      );
      next.integrationConflicts.set(event.data.conflict.conflictId, {
        kind: "integration_conflict",
        conflict: event.data.conflict,
        conflictDigest: event.data.conflictDigest,
        version: event.streamVersion
      });
      const work = {
        ...stored.work,
        status: "conflicted" as const,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        lastError: `conflict:${event.data.conflict.conflictId}`
      };
      next.integrationWork.set(event.data.workId, {
        ...stored,
        work,
        workDigest: canonicalDigest(work),
        version: event.streamVersion
      });
      const candidate = required(
        next.integrationCandidates.get(stored.work.candidateId),
        `Missing integration candidate ${stored.work.candidateId}`
      );
      next.integrationCandidates.set(stored.work.candidateId, {
        ...candidate,
        status: "conflicted",
        version: event.streamVersion
      });
      break;
    }
    case "IntegrationVerificationRecorded": {
      if (canonicalDigest(event.data.verification) !== event.data.verificationDigest) {
        throw new Error("Integration verification event digest does not match its content");
      }
      const stored = required(
        next.integrationWork.get(event.data.workId),
        `Missing integration work ${event.data.workId}`
      );
      next.integrationVerifications.set(event.data.verification.integrationVerificationId, {
        kind: "integration_verification",
        verification: event.data.verification,
        verificationDigest: event.data.verificationDigest,
        version: event.streamVersion
      });
      const passed = event.data.verification.result === "passed";
      const status: IntegrationWorkState["work"]["status"] = passed ? "verified" : "failed";
      const work = {
        ...stored.work,
        status,
        verification: event.data.verification,
        leaseOwnerId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        lastError: passed ? null : event.data.verification.failureReason
      };
      next.integrationWork.set(event.data.workId, {
        ...stored,
        work,
        workDigest: canonicalDigest(work),
        version: event.streamVersion
      });
      const candidate = required(
        next.integrationCandidates.get(stored.work.candidateId),
        `Missing integration candidate ${stored.work.candidateId}`
      );
      next.integrationCandidates.set(stored.work.candidateId, {
        ...candidate,
        status: passed ? "awaiting_authorization" : "ineligible",
        version: event.streamVersion
      });
      break;
    }
    case "IntegrationPromotionAuthorized": {
      const stored = required(
        next.integrationWork.get(event.data.workId),
        `Missing integration work ${event.data.workId}`
      );
      const work = {
        ...stored.work,
        status: "authorized" as const,
        authorizationRef: event.data.actionResultRef
      };
      next.integrationWork.set(event.data.workId, {
        ...stored,
        work,
        workDigest: canonicalDigest(work),
        version: event.streamVersion
      });
      const candidate = required(
        next.integrationCandidates.get(event.data.candidateId),
        `Missing integration candidate ${event.data.candidateId}`
      );
      next.integrationCandidates.set(event.data.candidateId, {
        ...candidate,
        status: "authorized",
        version: event.streamVersion
      });
      break;
    }
    case "IntegrationPromotionRecorded": {
      if (canonicalDigest(event.data.receipt) !== event.data.receiptDigest) {
        throw new Error("Promotion receipt event digest does not match its content");
      }
      next.promotionReceipts.set(event.data.receipt.receiptId, {
        kind: "promotion_receipt",
        receipt: event.data.receipt,
        receiptDigest: event.data.receiptDigest,
        version: event.streamVersion
      });
      const candidate = required(
        next.integrationCandidates.get(event.data.receipt.candidateId),
        `Missing integration candidate ${event.data.receipt.candidateId}`
      );
      next.integrationCandidates.set(event.data.receipt.candidateId, {
        ...candidate,
        status: "promoted",
        version: event.streamVersion
      });
      const work = [...next.integrationWork.values()].find(
        (entry) => entry.work.candidateId === event.data.receipt.candidateId
      );
      if (work) {
        const updated = {
          ...work.work,
          status: "promoted" as const,
          completedAt: event.data.receipt.promotedAt
        };
        next.integrationWork.set(work.work.workId, {
          ...work,
          work: updated,
          workDigest: canonicalDigest(updated),
          version: event.streamVersion
        });
      }
      const target = required(
        next.integrationTargets.get(event.data.receipt.targetRef.id),
        `Missing integration target ${event.data.receipt.targetRef.id}`
      );
      next.integrationTargets.set(target.target.targetRevisionId, {
        ...target,
        currentHeadRef: event.data.receipt.newHeadRef,
        version: event.streamVersion
      });
      const program = required(
        next.programs.get(event.data.receipt.programId),
        `Missing program ${event.data.receipt.programId}`
      );
      next.programs.set(program.programId, {
        ...program,
        phase: "completed",
        version: event.streamVersion
      });
      break;
    }
    case "PortfolioSloIncidentRecorded":
      if (canonicalDigest(event.data.incident) !== event.data.incidentDigest) {
        throw new Error("Portfolio SLO incident event digest does not match its content");
      }
      next.portfolioSloIncidents.set(event.data.incident.incidentId, {
        kind: "portfolio_slo_incident",
        incident: event.data.incident,
        incidentDigest: event.data.incidentDigest,
        version: event.streamVersion
      });
      break;
    case "PortfolioMeasurementReportCompiled":
      if (canonicalDigest(event.data.report) !== event.data.reportDigest) {
        throw new Error("Portfolio measurement report event digest does not match its content");
      }
      next.portfolioMeasurementReports.set(event.data.report.reportId, {
        kind: "portfolio_measurement_report",
        report: event.data.report,
        reportDigest: event.data.reportDigest,
        version: event.streamVersion
      });
      break;
    case "AdvisorSubjectApproved":
      if (canonicalDigest(event.data.subject) !== event.data.subjectDigest) {
        throw new Error("Advisor subject event digest does not match its content");
      }
      next.advisorSubjects.set(event.data.subject.subjectId, {
        kind: "advisor_subject",
        subject: event.data.subject,
        subjectDigest: event.data.subjectDigest,
        version: event.streamVersion
      });
      break;
    case "AdvisorCaseRecorded":
      if (
        canonicalDigest(event.data.case) !== event.data.caseDigest ||
        canonicalDigest(event.data.case.input) !== event.data.case.inputDigest
      ) {
        throw new Error("Advisor case event digest does not match its content");
      }
      next.advisorCases.set(event.data.case.caseId, {
        kind: "advisor_case",
        case: event.data.case,
        caseDigest: event.data.caseDigest,
        recordedPosition: event.globalPosition,
        version: event.streamVersion
      });
      break;
    case "AdvisorCorpusApproved":
      if (canonicalDigest(event.data.corpus) !== event.data.corpusDigest) {
        throw new Error("Advisor corpus event digest does not match its content");
      }
      if (event.data.supersededCorpusRevisionId) {
        const prior = required(
          next.advisorCorpora.get(event.data.supersededCorpusRevisionId),
          `Missing advisor corpus ${event.data.supersededCorpusRevisionId}`
        );
        next.advisorCorpora.set(event.data.supersededCorpusRevisionId, {
          ...prior,
          supersededAt: event.occurredAt
        });
      }
      next.advisorCorpora.set(event.data.corpus.corpusRevisionId, {
        kind: "advisor_corpus",
        corpus: event.data.corpus,
        corpusDigest: event.data.corpusDigest,
        supersededAt: null,
        version: event.streamVersion
      });
      break;
    case "AdvisorContaminationRecorded":
      if (canonicalDigest(event.data.contamination) !== event.data.contaminationDigest) {
        throw new Error("Advisor contamination event digest does not match its content");
      }
      next.advisorContamination.set(event.data.contamination.contaminationId, {
        kind: "advisor_contamination",
        contamination: event.data.contamination,
        contaminationDigest: event.data.contaminationDigest,
        version: event.streamVersion
      });
      break;
    case "AdvisorInvocationQueued":
      if (
        canonicalDigest(event.data.invocation) !== event.data.invocationDigest ||
        canonicalDigest(event.data.invocation.input) !== event.data.invocation.inputDigest
      ) {
        throw new Error("Advisor invocation event digest does not match its content");
      }
      next.advisorInvocations.set(event.data.invocation.invocationId, {
        kind: "advisor_invocation",
        invocation: event.data.invocation,
        invocationDigest: event.data.invocationDigest,
        queuedPosition: event.globalPosition,
        version: event.streamVersion
      });
      break;
    case "AdvisorInvocationLeaseAcquired": {
      const stored = required(
        next.advisorInvocations.get(event.data.invocationId),
        `Missing advisor invocation ${event.data.invocationId}`
      );
      const invocation = {
        ...stored.invocation,
        status: "leased" as const,
        attempt: event.data.attempt,
        ownerId: event.data.ownerId,
        fencingToken: event.data.fencingToken,
        leaseExpiresAt: event.data.leaseExpiresAt
      };
      next.advisorInvocations.set(event.data.invocationId, {
        ...stored,
        invocation,
        invocationDigest: canonicalDigest(invocation),
        version: event.streamVersion
      });
      break;
    }
    case "AdvisorInvocationSucceeded": {
      if (canonicalDigest(event.data.recommendation) !== event.data.recommendationDigest) {
        throw new Error("Advisor recommendation event digest does not match its content");
      }
      const stored = required(
        next.advisorInvocations.get(event.data.invocationId),
        `Missing advisor invocation ${event.data.invocationId}`
      );
      const invocation = {
        ...stored.invocation,
        status: "succeeded" as const,
        ownerId: null,
        leaseExpiresAt: null,
        recommendationId: event.data.recommendation.recommendationId,
        completedAt: event.data.completedAt
      };
      next.advisorInvocations.set(event.data.invocationId, {
        ...stored,
        invocation,
        invocationDigest: canonicalDigest(invocation),
        version: event.streamVersion
      });
      next.advisorRecommendations.set(event.data.recommendation.recommendationId, {
        kind: "advisor_recommendation",
        recommendation: event.data.recommendation,
        recommendationDigest: event.data.recommendationDigest,
        version: event.streamVersion
      });
      break;
    }
    case "AdvisorInvocationFailed": {
      const stored = required(
        next.advisorInvocations.get(event.data.invocationId),
        `Missing advisor invocation ${event.data.invocationId}`
      );
      const invocation = {
        ...stored.invocation,
        status: event.data.permanent ? ("failed" as const) : ("pending" as const),
        availableAt: event.data.availableAt,
        ownerId: null,
        leaseExpiresAt: null,
        lastError: event.data.error,
        completedAt: event.data.completedAt
      };
      next.advisorInvocations.set(event.data.invocationId, {
        ...stored,
        invocation,
        invocationDigest: canonicalDigest(invocation),
        version: event.streamVersion
      });
      break;
    }
    case "AdvisorInvocationCancelled": {
      const stored = required(
        next.advisorInvocations.get(event.data.invocationId),
        `Missing advisor invocation ${event.data.invocationId}`
      );
      const invocation = {
        ...stored.invocation,
        status: "cancelled" as const,
        ownerId: null,
        leaseExpiresAt: null,
        lastError: event.data.reason,
        completedAt: event.data.cancelledAt
      };
      next.advisorInvocations.set(event.data.invocationId, {
        ...stored,
        invocation,
        invocationDigest: canonicalDigest(invocation),
        version: event.streamVersion
      });
      break;
    }
    case "AdvisorEvaluationCompiled":
      if (canonicalDigest(event.data.report) !== event.data.reportDigest) {
        throw new Error("Advisor evaluation event digest does not match its content");
      }
      next.advisorEvaluations.set(event.data.report.reportId, {
        kind: "advisor_evaluation",
        report: event.data.report,
        reportDigest: event.data.reportDigest,
        version: event.streamVersion
      });
      break;
    case "DecisionPolicyProposalCompiled":
      if (canonicalDigest(event.data.proposal) !== event.data.proposalDigest) {
        throw new Error("Decision policy proposal event digest does not match its content");
      }
      next.decisionPolicyProposals.set(event.data.proposal.proposalId, {
        kind: "decision_policy_proposal",
        proposal: event.data.proposal,
        proposalDigest: event.data.proposalDigest,
        status: "open",
        closedAt: null,
        closedBy: null,
        closeReason: null,
        replacementProposalRef: null,
        approvedPolicyRef: null,
        version: event.streamVersion
      });
      break;
    case "DecisionPolicyProposalClosed": {
      const stored = required(
        next.decisionPolicyProposals.get(event.data.proposalId),
        `Missing decision policy proposal ${event.data.proposalId}`
      );
      next.decisionPolicyProposals.set(event.data.proposalId, {
        ...stored,
        status: event.data.outcome,
        closedAt: event.data.closedAt,
        closedBy: event.data.closedBy,
        closeReason: event.data.reason,
        replacementProposalRef: event.data.replacementProposalRef,
        version: event.streamVersion
      });
      break;
    }
    case "DecisionPolicyApproved":
      if (canonicalDigest(event.data.policy) !== event.data.policyDigest) {
        throw new Error("Decision policy event digest does not match its content");
      }
      if (event.data.supersededPolicyRevisionId) {
        const prior = required(
          next.decisionPolicies.get(event.data.supersededPolicyRevisionId),
          `Missing decision policy ${event.data.supersededPolicyRevisionId}`
        );
        next.decisionPolicies.set(event.data.supersededPolicyRevisionId, {
          ...prior,
          status: "superseded",
          supersededAt: event.occurredAt
        });
      }
      if (event.data.policy.proposalRef) {
        const proposal = required(
          next.decisionPolicyProposals.get(event.data.policy.proposalRef.id),
          `Missing decision policy proposal ${event.data.policy.proposalRef.id}`
        );
        next.decisionPolicyProposals.set(event.data.policy.proposalRef.id, {
          ...proposal,
          status: "approved",
          closedAt: event.data.policy.approvedAt,
          closedBy: event.data.policy.approvedBy,
          closeReason: "Approved as an immutable decision policy revision",
          approvedPolicyRef: {
            kind: "decision_policy",
            id: event.data.policy.policyRevisionId,
            digest: event.data.policyDigest
          }
        });
      }
      next.decisionPolicies.set(event.data.policy.policyRevisionId, {
        kind: "decision_policy",
        policy: event.data.policy,
        policyDigest: event.data.policyDigest,
        status: "shadow",
        promotionId: null,
        automaticResolutionCount: 0,
        suspendedAt: null,
        suspensionReason: null,
        supersededAt: null,
        version: event.streamVersion
      });
      break;
    case "DecisionPolicyPromotionAuthorized": {
      if (canonicalDigest(event.data.promotion) !== event.data.promotionDigest) {
        throw new Error("Decision policy promotion event digest does not match its content");
      }
      const policy = required(
        next.decisionPolicies.get(event.data.promotion.policyRevisionRef.id),
        `Missing decision policy ${event.data.promotion.policyRevisionRef.id}`
      );
      next.decisionPolicies.set(policy.policy.policyRevisionId, {
        ...policy,
        status: "active",
        promotionId: event.data.promotion.promotionId,
        suspendedAt: null,
        suspensionReason: null,
        version: event.streamVersion
      });
      next.decisionPolicyPromotions.set(event.data.promotion.promotionId, {
        kind: "decision_policy_promotion",
        promotion: event.data.promotion,
        promotionDigest: event.data.promotionDigest,
        version: event.streamVersion
      });
      break;
    }
    case "DecisionPolicySuspended": {
      const policy = required(
        next.decisionPolicies.get(event.data.policyRevisionId),
        `Missing decision policy ${event.data.policyRevisionId}`
      );
      next.decisionPolicies.set(event.data.policyRevisionId, {
        ...policy,
        status: "suspended",
        suspendedAt: event.data.suspendedAt,
        suspensionReason: event.data.reason,
        version: event.streamVersion
      });
      break;
    }
    case "AdvisorAutomaticResolutionRecorded": {
      if (canonicalDigest(event.data.resolution) !== event.data.resolutionDigest) {
        throw new Error("Advisor resolution event digest does not match its content");
      }
      next.advisorResolutions.set(event.data.resolution.resolutionId, {
        kind: "advisor_resolution",
        resolution: event.data.resolution,
        resolutionDigest: event.data.resolutionDigest,
        version: event.streamVersion
      });
      const policy = required(
        next.decisionPolicies.get(event.data.resolution.policyRevisionRef.id),
        `Missing decision policy ${event.data.resolution.policyRevisionRef.id}`
      );
      next.decisionPolicies.set(policy.policy.policyRevisionId, {
        ...policy,
        automaticResolutionCount: policy.automaticResolutionCount + 1,
        version: event.streamVersion
      });
      break;
    }
    case "AdvisorAuditSelected":
    case "AdvisorAuditCompleted":
      if (canonicalDigest(event.data.audit) !== event.data.auditDigest) {
        throw new Error("Advisor audit event digest does not match its content");
      }
      next.advisorAudits.set(event.data.audit.auditId, {
        kind: "advisor_audit",
        audit: event.data.audit,
        auditDigest: event.data.auditDigest,
        version: event.streamVersion
      });
      break;
    case "AdvisorIncidentRecorded":
      if (canonicalDigest(event.data.incident) !== event.data.incidentDigest) {
        throw new Error("Advisor incident event digest does not match its content");
      }
      next.advisorIncidents.set(event.data.incident.incidentId, {
        kind: "advisor_incident",
        incident: event.data.incident,
        incidentDigest: event.data.incidentDigest,
        version: event.streamVersion
      });
      break;
    case "VerificationRequested":
      next.verifications.set(event.data.verificationId, {
        kind: "verification",
        ...event.data,
        artifactManifestId: null,
        status: "requested",
        result: null,
        resultDigest: null,
        receiptDigest: null,
        exitCode: null,
        failureReason: null,
        requestedAt: event.occurredAt,
        completedAt: null,
        version: event.streamVersion
      });
      break;
    case "VerificationReceiptRecorded": {
      const verification = required(
        next.verifications.get(event.data.verificationId),
        `Missing verification ${event.data.verificationId}`
      );
      const manifest = required(
        next.artifactManifests.get(event.data.artifactManifestId),
        `Missing artifact manifest ${event.data.artifactManifestId}`
      );
      const resultDigest = verificationResultDigest(event.data.result);
      if (
        resultDigest !== event.data.resultDigest ||
        event.data.result.artifactManifestDigest !== manifest.manifestDigest ||
        verificationReceiptDigest(
          receiptIdentity(
            verification,
            manifest.artifactManifestId,
            manifest.manifestDigest,
            resultDigest
          )
        ) !== event.data.receiptDigest
      ) {
        throw new Error("Verification receipt event digest does not match its content");
      }
      next.verifications.set(verification.verificationId, {
        ...verification,
        artifactManifestId: event.data.artifactManifestId,
        status: event.data.status,
        result: event.data.result,
        resultDigest: event.data.resultDigest,
        receiptDigest: event.data.receiptDigest,
        exitCode: event.data.exitCode,
        failureReason: event.data.failureReason,
        completedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
    case "VerificationCancelled": {
      const verification = required(
        next.verifications.get(event.data.verificationId),
        `Missing verification ${event.data.verificationId}`
      );
      next.verifications.set(verification.verificationId, {
        ...verification,
        status: "cancelled",
        failureReason: event.data.reason,
        completedAt: event.occurredAt,
        version: event.streamVersion
      });
      break;
    }
  }
  return next;
}

export interface SerializedProjectionState {
  projectionSchemaVersion: 1;
  programs: ProgramState[];
  milestones: MilestoneState[];
  outcomePackets: OutcomePacketState[];
  workflows: WorkflowState[];
  runs: RunState[];
  jobs: JobState[];
  attempts: AttemptState[];
  outbox: OutboxState[];
  sourceRevisions: SourceRevisionState[];
  artifactManifests: ArtifactManifestState[];
  verifications: VerificationState[];
  driverReceipts: DriverReceiptState[];
  approvalRequests: ApprovalRequestState[];
  programInterviews: ProgramInterviewState[];
  programGraphs: ProgramGraphState[];
  milestoneGenerations: MilestoneGenerationState[];
  contextPackets: ContextPacketState[];
  outcomeValidations: OutcomeValidationState[];
  routedIssues: RoutedIssueState[];
  attentionSpans: AttentionSpanState[];
  outcomeDispositions: OutcomeDispositionState[];
  measurementReports: MeasurementReportState[];
  operatorDecisionRequests: OperatorDecisionRequestState[];
  decisionPackets: DecisionPacketState[];
  decisionPacketRevisions: DecisionPacketRevisionState[];
  decisionEvidenceBundles: DecisionEvidenceBundleState[];
  attentionPolicies: AttentionPolicyState[];
  decisionAcknowledgements: DecisionAcknowledgementState[];
  decisionResolutions: DecisionResolutionState[];
  decisionActionResults: DecisionActionResultState[];
  decisionPrecedents: DecisionPrecedentState[];
  attentionDeliveries: AttentionDeliveryState[];
  attentionBudgetIncidents: AttentionBudgetIncidentState[];
  attentionMeasurementReports: AttentionMeasurementReportState[];
  attentionDigestArtifacts: AttentionDigestArtifactState[];
  portfolioPolicies: PortfolioPolicyState[];
  integrationTargets: IntegrationTargetState[];
  portfolioAdmissions: PortfolioAdmissionState[];
  concurrencyLeases: ConcurrencyLeaseState[];
  candidateDiffManifests: CandidateDiffManifestState[];
  integrationCandidates: IntegrationCandidateState[];
  integrationWork: IntegrationWorkState[];
  integrationConflicts: IntegrationConflictState[];
  integrationVerifications: IntegrationVerificationState[];
  promotionReceipts: PromotionReceiptState[];
  portfolioSloIncidents: PortfolioSloIncidentState[];
  portfolioMeasurementReports: PortfolioMeasurementReportState[];
  advisorSubjects: AdvisorSubjectState[];
  advisorCases: AdvisorCaseState[];
  advisorCorpora: AdvisorCorpusState[];
  advisorContamination: AdvisorContaminationState[];
  advisorInvocations: AdvisorInvocationState[];
  advisorRecommendations: AdvisorRecommendationState[];
  advisorEvaluations: AdvisorEvaluationState[];
  decisionPolicyProposals: DecisionPolicyProposalState[];
  decisionPolicies: DecisionPolicyState[];
  decisionPolicyPromotions: DecisionPolicyPromotionState[];
  advisorResolutions: AdvisorResolutionState[];
  advisorAudits: AdvisorAuditState[];
  advisorIncidents: AdvisorIncidentState[];
  lastAppliedPosition: number;
}

export function serializeProjectionState(state: ProjectionState): SerializedProjectionState {
  const byId = <T>(values: Iterable<T>, id: (value: T) => string): T[] =>
    [...values].sort((left, right) => id(left).localeCompare(id(right)));
  return {
    projectionSchemaVersion: 1,
    programs: byId(state.programs.values(), (value) => value.programId),
    milestones: byId(state.milestones.values(), (value) => value.milestoneId),
    outcomePackets: byId(state.outcomePackets.values(), (value) => value.outcomePacketId),
    workflows: byId(
      state.workflows.values(),
      (value) => `${value.workflowId}:${String(value.version).padStart(10, "0")}`
    ),
    runs: byId(state.runs.values(), (value) => value.runId),
    jobs: byId(state.jobs.values(), (value) => value.jobId),
    attempts: byId(state.attempts.values(), (value) => value.attemptId),
    outbox: byId(state.outbox.values(), (value) => value.outboxId),
    sourceRevisions: byId(state.sourceRevisions.values(), (value) => value.revisionId),
    artifactManifests: byId(state.artifactManifests.values(), (value) => value.artifactManifestId),
    verifications: byId(state.verifications.values(), (value) => value.verificationId),
    driverReceipts: byId(state.driverReceipts.values(), (value) => value.driverReceiptId),
    approvalRequests: byId(state.approvalRequests.values(), (value) => value.approvalRequestId),
    programInterviews: byId(state.programInterviews.values(), (value) => value.interviewId),
    programGraphs: byId(state.programGraphs.values(), (value) => value.graphRevisionId),
    milestoneGenerations: byId(state.milestoneGenerations.values(), (value) => value.generationId),
    contextPackets: byId(state.contextPackets.values(), (value) => value.contextPacketId),
    outcomeValidations: byId(state.outcomeValidations.values(), (value) => value.validationId),
    routedIssues: byId(state.routedIssues.values(), (value) => value.issue.issueId),
    attentionSpans: byId(state.attentionSpans.values(), (value) => value.attentionSpanId),
    outcomeDispositions: byId(
      state.outcomeDispositions.values(),
      (value) => value.disposition.outcomePacketId
    ),
    measurementReports: byId(state.measurementReports.values(), (value) => value.report.reportId),
    operatorDecisionRequests: byId(
      state.operatorDecisionRequests.values(),
      (value) => value.request.requestId
    ),
    decisionPackets: byId(state.decisionPackets.values(), (value) => value.packetId),
    decisionPacketRevisions: byId(
      state.decisionPacketRevisions.values(),
      (value) => value.revision.packetRevisionId
    ),
    decisionEvidenceBundles: byId(
      state.decisionEvidenceBundles.values(),
      (value) => value.bundle.evidenceBundleId
    ),
    attentionPolicies: byId(
      state.attentionPolicies.values(),
      (value) => value.policy.policyRevisionId
    ),
    decisionAcknowledgements: byId(
      state.decisionAcknowledgements.values(),
      (value) => value.acknowledgement.acknowledgementId
    ),
    decisionResolutions: byId(
      state.decisionResolutions.values(),
      (value) => value.resolution.resolutionId
    ),
    decisionActionResults: byId(
      state.decisionActionResults.values(),
      (value) => value.result.actionResultId
    ),
    decisionPrecedents: byId(
      state.decisionPrecedents.values(),
      (value) => value.precedent.precedentId
    ),
    attentionDeliveries: byId(
      state.attentionDeliveries.values(),
      (value) => value.delivery.deliveryId
    ),
    attentionBudgetIncidents: byId(
      state.attentionBudgetIncidents.values(),
      (value) => value.incident.incidentId
    ),
    attentionMeasurementReports: byId(
      state.attentionMeasurementReports.values(),
      (value) => value.report.reportId
    ),
    attentionDigestArtifacts: byId(
      state.attentionDigestArtifacts.values(),
      (value) => value.artifact.artifactId
    ),
    portfolioPolicies: byId(
      state.portfolioPolicies.values(),
      (value) => value.policy.policyRevisionId
    ),
    integrationTargets: byId(
      state.integrationTargets.values(),
      (value) => value.target.targetRevisionId
    ),
    portfolioAdmissions: byId(
      state.portfolioAdmissions.values(),
      (value) => value.admission.admissionId
    ),
    concurrencyLeases: byId(state.concurrencyLeases.values(), (value) => value.lease.leaseId),
    candidateDiffManifests: byId(
      state.candidateDiffManifests.values(),
      (value) => value.manifest.manifestId
    ),
    integrationCandidates: byId(
      state.integrationCandidates.values(),
      (value) => value.candidate.candidateId
    ),
    integrationWork: byId(state.integrationWork.values(), (value) => value.work.workId),
    integrationConflicts: byId(
      state.integrationConflicts.values(),
      (value) => value.conflict.conflictId
    ),
    integrationVerifications: byId(
      state.integrationVerifications.values(),
      (value) => value.verification.integrationVerificationId
    ),
    promotionReceipts: byId(state.promotionReceipts.values(), (value) => value.receipt.receiptId),
    portfolioSloIncidents: byId(
      state.portfolioSloIncidents.values(),
      (value) => value.incident.incidentId
    ),
    portfolioMeasurementReports: byId(
      state.portfolioMeasurementReports.values(),
      (value) => value.report.reportId
    ),
    advisorSubjects: byId(state.advisorSubjects.values(), (value) => value.subject.subjectId),
    advisorCases: byId(state.advisorCases.values(), (value) => value.case.caseId),
    advisorCorpora: byId(state.advisorCorpora.values(), (value) => value.corpus.corpusRevisionId),
    advisorContamination: byId(
      state.advisorContamination.values(),
      (value) => value.contamination.contaminationId
    ),
    advisorInvocations: byId(
      state.advisorInvocations.values(),
      (value) => value.invocation.invocationId
    ),
    advisorRecommendations: byId(
      state.advisorRecommendations.values(),
      (value) => value.recommendation.recommendationId
    ),
    advisorEvaluations: byId(state.advisorEvaluations.values(), (value) => value.report.reportId),
    decisionPolicyProposals: byId(
      state.decisionPolicyProposals.values(),
      (value) => value.proposal.proposalId
    ),
    decisionPolicies: byId(
      state.decisionPolicies.values(),
      (value) => value.policy.policyRevisionId
    ),
    decisionPolicyPromotions: byId(
      state.decisionPolicyPromotions.values(),
      (value) => value.promotion.promotionId
    ),
    advisorResolutions: byId(
      state.advisorResolutions.values(),
      (value) => value.resolution.resolutionId
    ),
    advisorAudits: byId(state.advisorAudits.values(), (value) => value.audit.auditId),
    advisorIncidents: byId(state.advisorIncidents.values(), (value) => value.incident.incidentId),
    lastAppliedPosition: state.lastAppliedPosition
  };
}

export function replayEvents(events: StoredEvent[]): ProjectionState {
  return events.reduce(evolve, emptyProjectionState());
}
