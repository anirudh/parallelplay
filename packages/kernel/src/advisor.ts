import { createHash } from "node:crypto";
import { canonicalDigest } from "./canonical.js";
import type { Decision, DomainErrorCode } from "./domain.js";
import type { ProjectionState } from "./model.js";
import type { Command, DomainEventInput } from "./schema.js";
import type {
  AdvisorCaseInputV1,
  AdvisorCaseState,
  AdvisorReferenceV1,
  AdvisorRecommendationOutputV1,
  DecisionPolicyMatcherV1,
  DecisionPolicyState
} from "./advisor-schema.js";

const DAY_MS = 86_400_000;
const ADVISOR_RETRY_DELAYS_MS = [1_000, 5_000];

function failure(code: DomainErrorCode, message: string): Decision {
  return { ok: false, error: { code, message } };
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = "8";
  const value = bytes.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function targetKind(action: { kind: string; target: { kind: string } }): string {
  return action.target.kind;
}

function promotionAllowed(action: {
  kind: string;
  target: { kind: string; priority?: string };
}): boolean {
  return (
    (action.kind === "reprioritize" &&
      action.target.kind === "program_attention_priority" &&
      action.target.priority !== "p0") ||
    (action.kind === "approve" && action.target.kind === "record_only")
  );
}

function toAdvisorRef(reference: { kind: string; id: string; digest: string }): AdvisorReferenceV1 {
  return reference as AdvisorReferenceV1;
}

function referenceAuthority(state: ProjectionState, reference: AdvisorReferenceV1): string | null {
  switch (reference.kind) {
    case "advisor_subject":
      return state.advisorSubjects.get(reference.id)?.subjectDigest ?? null;
    case "advisor_case":
      return state.advisorCases.get(reference.id)?.caseDigest ?? null;
    case "advisor_corpus":
      return state.advisorCorpora.get(reference.id)?.corpusDigest ?? null;
    case "advisor_recommendation":
      return state.advisorRecommendations.get(reference.id)?.recommendationDigest ?? null;
    case "advisor_evaluation":
      return state.advisorEvaluations.get(reference.id)?.reportDigest ?? null;
    case "decision_policy_proposal":
      return state.decisionPolicyProposals.get(reference.id)?.proposalDigest ?? null;
    case "decision_policy":
      return state.decisionPolicies.get(reference.id)?.policyDigest ?? null;
    case "decision_policy_promotion":
      return state.decisionPolicyPromotions.get(reference.id)?.promotionDigest ?? null;
    case "advisor_resolution":
      return state.advisorResolutions.get(reference.id)?.resolutionDigest ?? null;
    case "advisor_audit":
      return state.advisorAudits.get(reference.id)?.auditDigest ?? null;
    case "advisor_incident":
      return state.advisorIncidents.get(reference.id)?.incidentDigest ?? null;
    case "decision_packet_revision":
      return state.decisionPacketRevisions.get(reference.id)?.revisionDigest ?? null;
    case "decision_evidence_bundle":
      return state.decisionEvidenceBundles.get(reference.id)?.bundleDigest ?? null;
    case "attention_policy":
      return state.attentionPolicies.get(reference.id)?.policyDigest ?? null;
    case "decision_precedent":
      return state.decisionPrecedents.get(reference.id)?.precedentDigest ?? null;
    case "operator_decision_request":
      return state.operatorDecisionRequests.get(reference.id)?.requestDigest ?? null;
    case "routed_issue":
      return state.routedIssues.get(reference.id)?.issueDigest ?? null;
    case "program_graph":
      return state.programGraphs.get(reference.id)?.graphDigest ?? null;
    case "outcome_packet":
      return state.outcomePackets.get(reference.id)?.packetDigest ?? null;
    case "outcome_validation":
      return state.outcomeValidations.get(reference.id)?.validationDigest ?? null;
    case "artifact_manifest":
      return state.artifactManifests.get(reference.id)?.manifestDigest ?? null;
    case "driver_receipt":
      return state.driverReceipts.get(reference.id)?.receiptDigest ?? null;
    case "verification": {
      const value = state.verifications.get(reference.id);
      return value?.receiptDigest ?? value?.resultDigest ?? null;
    }
    case "program": {
      const value = state.programs.get(reference.id);
      return value ? canonicalDigest(value) : null;
    }
    case "intent_playback": {
      const value = [...state.programInterviews.values()].find(
        (entry) => entry.playback.playbackId === reference.id
      );
      return value?.playbackDigest ?? null;
    }
    case "milestone_contract": {
      const value = state.milestones.get(reference.id);
      return value?.contractDigest ?? null;
    }
    case "context_packet":
      return state.contextPackets.get(reference.id)?.packetDigest ?? null;
    case "source_revision":
      return state.sourceRevisions.get(reference.id)?.revisionDigest ?? null;
    case "approval_request": {
      const value = state.approvalRequests.get(reference.id);
      return value ? canonicalDigest(value) : null;
    }
    case "outcome_disposition": {
      const value = state.outcomeDispositions.get(reference.id);
      return value ? canonicalDigest(value.disposition) : null;
    }
    case "decision_acknowledgement":
      return state.decisionAcknowledgements.get(reference.id)?.acknowledgementDigest ?? null;
    case "decision_resolution":
      return state.decisionResolutions.get(reference.id)?.resolutionDigest ?? null;
    case "decision_action_result":
      return state.decisionActionResults.get(reference.id)?.resultDigest ?? null;
    case "attention_delivery": {
      const value = state.attentionDeliveries.get(reference.id);
      return value ? canonicalDigest(value.delivery) : null;
    }
    case "attention_budget_incident":
      return state.attentionBudgetIncidents.get(reference.id)?.incidentDigest ?? null;
    case "attention_measurement_report":
      return state.attentionMeasurementReports.get(reference.id)?.reportDigest ?? null;
    case "attention_digest_artifact":
      return state.attentionDigestArtifacts.get(reference.id)?.artifactDigest ?? null;
  }
}

function exactReference(state: ProjectionState, reference: AdvisorReferenceV1): boolean {
  return referenceAuthority(state, reference) === reference.digest;
}

function refsAreUniqueAndExact(state: ProjectionState, references: AdvisorReferenceV1[]): boolean {
  const keys = references.map((reference) => `${reference.kind}:${reference.id}`);
  return (
    new Set(keys).size === keys.length &&
    references.every((reference) => exactReference(state, reference))
  );
}

export function compileAdvisorCaseInput(
  state: ProjectionState,
  packetId: string,
  packetRevisionId: string,
  packetRevisionDigest: string,
  now: string
): AdvisorCaseInputV1 | Decision {
  const packet = state.decisionPackets.get(packetId);
  const stored = state.decisionPacketRevisions.get(packetRevisionId);
  if (
    !packet ||
    stored?.revision.schemaVersion !== 1 ||
    stored.revisionDigest !== packetRevisionDigest ||
    canonicalDigest(stored.revision) !== stored.revisionDigest ||
    packet.currentRevisionId !== packetRevisionId ||
    packet.currentRevisionDigest !== packetRevisionDigest
  ) {
    return failure("DECISION_PACKET_STALE", "Advisor input requires the exact current V1 packet");
  }
  const bundle = state.decisionEvidenceBundles.get(stored.revision.evidenceBundleRef.id);
  if (
    bundle?.bundle.schemaVersion !== 1 ||
    bundle.bundleDigest !== stored.revision.evidenceBundleRef.digest ||
    canonicalDigest(bundle.bundle) !== bundle.bundleDigest
  ) {
    return failure("EVIDENCE_DIGEST_MISMATCH", "Advisor evidence bundle is invalid");
  }
  const options = stored.revision.options.map((option) => ({
    optionId: option.optionId,
    label: option.label,
    consequences: option.consequences,
    reversalCost: option.reversalCost,
    actionKind: option.action.kind,
    targetKind: targetKind(option.action),
    targetParameters:
      option.action.kind === "reprioritize"
        ? {
            kind: "program_attention_priority" as const,
            priority: option.action.target.priority
          }
        : option.action.kind === "approve" && option.action.target.kind === "record_only"
          ? { kind: "record_only" as const }
          : { kind: "excluded" as const },
    targetPreconditionDigest: canonicalDigest(option.action.target)
  }));
  const actionKinds = unique(options.map((option) => option.actionKind)).sort();
  const targetKinds = unique(options.map((option) => option.targetKind)).sort();
  const eligible =
    stored.revision.riskClass === "low" &&
    stored.revision.safetyClass === "routine" &&
    stored.revision.reversibility === "reversible" &&
    stored.revision.options.every((option) => promotionAllowed(option.action));
  const exclusionReasons = [
    stored.revision.riskClass !== "low" ? "risk_not_low" : null,
    stored.revision.safetyClass !== "routine" ? "safety_not_routine" : null,
    stored.revision.reversibility !== "reversible" ? "not_reversible" : null,
    !stored.revision.options.every((option) => promotionAllowed(option.action))
      ? "action_not_allowlisted"
      : null
  ].filter((value): value is string => value !== null);
  const policyRefs: AdvisorReferenceV1[] =
    stored.revision.policyBinding.kind === "attention_policy"
      ? [
          {
            kind: "attention_policy",
            id: stored.revision.policyBinding.id,
            digest: stored.revision.policyBinding.digest
          }
        ]
      : [];
  const precedentRefs = stored.revision.precedentRefs.map(toAdvisorRef);
  const evidenceRefs = [
    toAdvisorRef(stored.revision.evidenceBundleRef),
    ...bundle.bundle.refs.map(toAdvisorRef)
  ];
  if (
    !refsAreUniqueAndExact(state, policyRefs) ||
    !refsAreUniqueAndExact(state, precedentRefs) ||
    !refsAreUniqueAndExact(state, evidenceRefs)
  ) {
    return failure("EVIDENCE_DIGEST_MISMATCH", "Advisor input references are stale or duplicated");
  }
  const inputId = deterministicUuid(
    `parallelplay:advisor-input:v1:${stored.revision.packetRevisionId}:${stored.revisionDigest}`
  );
  return {
    schemaVersion: 1,
    inputId,
    packetId,
    packetRevisionRef: {
      kind: "decision_packet_revision",
      id: stored.revision.packetRevisionId,
      digest: stored.revisionDigest
    },
    programId: stored.revision.programId,
    milestoneId: stored.revision.milestoneId,
    sourceRef: toAdvisorRef(stored.revision.source),
    originalQuestion: stored.revision.originalQuestion,
    prompt: stored.revision.prompt,
    context: stored.revision.context,
    classification: {
      riskClass: stored.revision.riskClass,
      safetyClass: stored.revision.safetyClass,
      reversibility: stored.revision.reversibility,
      sourceKind: stored.revision.source.kind,
      actionKinds,
      targetKinds,
      promotionEligible: eligible,
      exclusionReasons
    },
    options,
    policyRefs,
    precedentRefs,
    evidenceRefs,
    compiledAt: now
  };
}

export function wilsonLowerBound(successes: number, trials: number): number {
  if (trials <= 0 || successes < 0 || successes > trials) return 0;
  const z = 1.6448536269514722;
  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = proportion + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denominator);
}

function policyMatchesCase(policy: DecisionPolicyState, candidate: AdvisorCaseState): boolean {
  const matcher = policy.policy.matcher;
  const input = candidate.case.input;
  if (
    input.classification.sourceKind !== matcher.sourceKind ||
    input.classification.riskClass !== matcher.riskClass ||
    input.classification.safetyClass !== matcher.safetyClass ||
    input.classification.reversibility !== matcher.reversibility ||
    !input.classification.promotionEligible
  ) {
    return false;
  }
  const matching = input.options.filter((option) =>
    matcherAcceptsInput(matcher, input, option.optionId)
  );
  return matching.length === 1 && matching[0]?.optionId === candidate.case.label.selectedOptionId;
}

function evaluationForCases(
  state: ProjectionState,
  subjectId: string,
  cases: AdvisorCaseState[]
): {
  eligibleCount: number;
  recommendedCount: number;
  agreementCount: number;
  abstentionCount: number;
  invalidCount: number;
  seriousDisagreementCount: number;
  coverage: number;
  agreement: number;
} {
  let recommendedCount = 0;
  let agreementCount = 0;
  let abstentionCount = 0;
  let invalidCount = 0;
  let seriousDisagreementCount = 0;
  for (const candidate of cases) {
    const invocations = [...state.advisorInvocations.values()]
      .filter(
        (entry) =>
          entry.invocation.subjectRef.id === subjectId &&
          entry.invocation.caseRef?.id === candidate.case.caseId
      )
      .sort((left, right) => right.invocation.createdAt.localeCompare(left.invocation.createdAt));
    const completed = invocations.find(
      (entry) => entry.invocation.status === "succeeded" && entry.invocation.recommendationId
    );
    const failed = invocations.find((entry) => entry.invocation.status === "failed");
    if (!completed?.invocation.recommendationId) {
      invalidCount += failed ? 1 : 1;
      continue;
    }
    const recommendation = state.advisorRecommendations.get(
      completed.invocation.recommendationId
    )?.recommendation;
    if (!recommendation) {
      invalidCount += 1;
      continue;
    }
    if (recommendation.output.kind === "abstain") {
      abstentionCount += 1;
      continue;
    }
    recommendedCount += 1;
    if (recommendation.output.optionId === candidate.case.label.selectedOptionId) {
      agreementCount += 1;
    } else {
      seriousDisagreementCount += 1;
    }
  }
  return {
    eligibleCount: cases.length,
    recommendedCount,
    agreementCount,
    abstentionCount,
    invalidCount,
    seriousDisagreementCount,
    coverage: cases.length === 0 ? 0 : recommendedCount / cases.length,
    agreement: recommendedCount === 0 ? 0 : agreementCount / recommendedCount
  };
}

function citationsMatchInput(
  output: AdvisorRecommendationOutputV1,
  input: AdvisorCaseInputV1
): boolean {
  const exactSubset = (actual: AdvisorReferenceV1[], allowed: AdvisorReferenceV1[]): boolean => {
    const allowedKeys = new Set(
      allowed.map((reference) => `${reference.kind}:${reference.id}:${reference.digest}`)
    );
    const actualKeys = actual.map(
      (reference) => `${reference.kind}:${reference.id}:${reference.digest}`
    );
    return (
      new Set(actualKeys).size === actualKeys.length &&
      actualKeys.every((key) => allowedKeys.has(key))
    );
  };
  return (
    exactSubset(output.policyCitations, input.policyRefs) &&
    exactSubset(output.precedentCitations, input.precedentRefs) &&
    exactSubset(output.evidenceCitations, input.evidenceRefs)
  );
}

function matcherAcceptsInput(
  matcher: DecisionPolicyMatcherV1,
  input: AdvisorCaseInputV1,
  optionId: string
): boolean {
  const option = input.options.find((candidate) => candidate.optionId === optionId);
  const policyKinds = new Set(input.policyRefs.map((reference) => reference.kind));
  const evidenceKinds = new Set(input.evidenceRefs.map((reference) => reference.kind));
  return (
    input.classification.promotionEligible &&
    input.classification.sourceKind === matcher.sourceKind &&
    input.classification.riskClass === "low" &&
    input.classification.safetyClass === "routine" &&
    input.classification.reversibility === "reversible" &&
    option?.actionKind === matcher.actionKind &&
    option.targetKind === matcher.targetKind &&
    matcher.requiredPolicyKinds.every((kind) =>
      policyKinds.has(kind as AdvisorReferenceV1["kind"])
    ) &&
    matcher.requiredEvidenceKinds.every((kind) =>
      evidenceKinds.has(kind as AdvisorReferenceV1["kind"])
    ) &&
    (matcher.targetKind !== "program_attention_priority" ||
      (option.targetParameters.kind === "program_attention_priority" &&
        option.targetParameters.priority !== "p0" &&
        matcher.allowedPriorities.includes(option.targetParameters.priority)))
  );
}

function advisorCaseSignature(candidate: AdvisorCaseState): string {
  const selected = candidate.case.input.options.find(
    (option) => option.optionId === candidate.case.label.selectedOptionId
  );
  return canonicalDigest({
    sourceKind: candidate.case.input.classification.sourceKind,
    riskClass: candidate.case.input.classification.riskClass,
    safetyClass: candidate.case.input.classification.safetyClass,
    reversibility: candidate.case.input.classification.reversibility,
    actionKind: selected?.actionKind ?? null,
    targetKind: selected?.targetKind ?? null,
    targetParameters: selected?.targetParameters ?? null,
    policyKinds: unique(candidate.case.input.policyRefs.map((reference) => reference.kind)).sort(),
    evidenceKinds: unique(
      candidate.case.input.evidenceRefs.map((reference) => reference.kind)
    ).sort()
  });
}

function evaluationEvidenceChanged(
  state: ProjectionState,
  policy: DecisionPolicyState,
  report: { throughPosition: number }
): boolean {
  const matchingCaseIds = new Set(
    [...state.advisorCases.values()]
      .filter((candidate) => policyMatchesCase(policy, candidate))
      .map((candidate) => candidate.case.caseId)
  );
  return (
    [...state.advisorCases.values()].some(
      (candidate) =>
        candidate.recordedPosition > report.throughPosition && policyMatchesCase(policy, candidate)
    ) ||
    [...state.advisorInvocations.values()].some(
      (entry) =>
        entry.queuedPosition > report.throughPosition &&
        entry.invocation.subjectRef.id === policy.policy.subjectRef.id &&
        entry.invocation.caseRef !== null &&
        matchingCaseIds.has(entry.invocation.caseRef.id)
    )
  );
}

function automaticAuditSelected(resolutionId: string, count: number, rate: number): boolean {
  if (count < 20) return true;
  const sample = createHash("sha256")
    .update(`parallelplay:advisor-audit:v1:${resolutionId}`)
    .digest();
  const value = sample.readUInt32BE(0) / 0x1_0000_0000;
  return value < rate;
}

function suspensionEvents(
  policy: DecisionPolicyState,
  sourceRef: AdvisorReferenceV1,
  reason: string,
  now: string
): DomainEventInput[] {
  const incidentId = deterministicUuid(
    `parallelplay:advisor-incident:v1:${policy.policy.policyRevisionId}:${sourceRef.id}:${reason}`
  );
  const kind = reason.includes("audit")
    ? ("audit_overdue" as const)
    : reason.includes("expired")
      ? ("policy_expired" as const)
      : reason.includes("contamination")
        ? ("contamination" as const)
        : reason.includes("drift")
          ? ("subject_drift" as const)
          : ("evaluation_floor" as const);
  const incident = {
    schemaVersion: 1 as const,
    incidentId,
    policyRevisionRef: {
      kind: "decision_policy" as const,
      id: policy.policy.policyRevisionId,
      digest: policy.policyDigest
    },
    kind,
    sourceRef,
    status: "open" as const,
    detail: reason,
    recordedAt: now
  };
  return [
    {
      type: "AdvisorIncidentRecorded",
      streamType: "advisor_incident",
      streamId: incidentId,
      data: { incident, incidentDigest: canonicalDigest(incident) }
    },
    {
      type: "DecisionPolicySuspended",
      streamType: "decision_policy",
      streamId: policy.policy.policyRevisionId,
      data: {
        policyRevisionId: policy.policy.policyRevisionId,
        reason,
        sourceRef,
        suspendedAt: now
      }
    }
  ];
}

function safetyIncidentAttentionEvents(
  state: ProjectionState,
  incident: {
    incidentId: string;
    kind: string;
    detail: string;
    policyRevisionRef: AdvisorReferenceV1;
  },
  resolutionRef: AdvisorReferenceV1,
  now: string
): DomainEventInput[] {
  const automatic = state.advisorResolutions.get(resolutionRef.id);
  const actionResult = automatic
    ? [...state.decisionActionResults.values()].find(
        (entry) =>
          entry.result.packetRevisionId === automatic.resolution.packetRevisionRef.id &&
          entry.result.schemaVersion === 3
      )
    : undefined;
  if (!automatic || !actionResult) return [];
  const requestId = deterministicUuid(
    `parallelplay:advisor-incident-request:v1:${incident.incidentId}`
  );
  const packetId = deterministicUuid(
    `parallelplay:advisor-incident-packet:v1:${incident.incidentId}`
  );
  const packetRevisionId = deterministicUuid(
    `parallelplay:advisor-incident-revision:v1:${incident.incidentId}`
  );
  const evidenceBundleId = deterministicUuid(
    `parallelplay:advisor-incident-evidence:v1:${incident.incidentId}`
  );
  const optionId = deterministicUuid(
    `parallelplay:advisor-incident-option:v1:${incident.incidentId}`
  );
  const targetRef = {
    kind: "decision_action_result" as const,
    id: actionResult.result.actionResultId,
    digest: actionResult.resultDigest
  };
  const request = {
    schemaVersion: 1 as const,
    requestId,
    programId: automatic.resolution.programId,
    milestoneId: null,
    originalQuestion: `Review advisor incident ${incident.incidentId}?`,
    prompt: "Review the serious advisor finding and keep policy authority suspended.",
    context: `${incident.kind}: ${incident.detail}`,
    requiredAuthority: "operator" as const,
    riskClass: "reserved" as const,
    safetyClass: "safety_critical" as const,
    reversibility: "reversible" as const,
    options: [
      {
        optionId,
        label: "Acknowledge the incident record",
        consequences: ["Records review without reactivating the suspended advisor policy"],
        reversalCost: "The incident and suspension remain immutable history",
        action: {
          kind: "approve" as const,
          target: {
            kind: "record_only" as const,
            targetRef,
            text: `Review advisor incident ${incident.incidentId}`
          }
        }
      }
    ],
    refs: [targetRef],
    deadlineAt: null,
    requestedBy: "advisor-audit-fail-safe",
    requestedAt: now
  };
  const requestDigest = canonicalDigest(request);
  const source = {
    kind: "operator_decision_request" as const,
    id: requestId,
    digest: requestDigest
  };
  const bundle = {
    schemaVersion: 1 as const,
    evidenceBundleId,
    packetId,
    packetRevisionId,
    programId: automatic.resolution.programId,
    sourceRef: source,
    refs: [
      { kind: "operator_decision_request" as const, id: requestId, digest: requestDigest },
      targetRef
    ],
    orientation: `Advisor ${incident.kind} incident; policy ${incident.policyRevisionRef.id} remains suspended.`,
    compiledAt: now
  };
  const bundleDigest = canonicalDigest(bundle);
  const policyBinding = {
    kind: "kernel_default" as const,
    version: "kernel-default-v1" as const,
    digest: canonicalDigest({ advisorIncidentRouting: "v1" })
  };
  const revision = {
    schemaVersion: 1 as const,
    packetRevisionId,
    packetId,
    programId: automatic.resolution.programId,
    milestoneId: null,
    revision: 1,
    priorRevisionRef: null,
    source,
    originalQuestion: request.originalQuestion,
    prompt: request.prompt,
    context: request.context,
    requiredAuthority: "operator" as const,
    riskClass: "reserved" as const,
    safetyClass: "safety_critical" as const,
    reversibility: "reversible" as const,
    options: request.options,
    evidenceBundleRef: {
      kind: "decision_evidence_bundle" as const,
      id: evidenceBundleId,
      digest: bundleDigest
    },
    policyBinding,
    precedentRefs: [],
    deadlineAt: null,
    defaultOnTimeout: null,
    deduplicationKey: canonicalDigest({ advisorIncidentId: incident.incidentId }),
    routing: {
      route: "page" as const,
      urgency: "p0" as const,
      matchedRuleId: null,
      requireAcknowledgement: true,
      reason: "advisor_serious_incident" as const,
      routineBudget: { applied: false, allowed: true, used: 0, limit: 0, windowMs: 0 }
    },
    createdAt: now
  };
  const revisionDigest = canonicalDigest(revision);
  const deliveryId = deterministicUuid(
    `parallelplay:advisor-incident-delivery:v1:${incident.incidentId}`
  );
  return [
    {
      type: "OperatorDecisionRequestRecorded",
      streamType: "operator_decision_request",
      streamId: requestId,
      data: { request, requestDigest }
    },
    {
      type: "DecisionEvidenceBundleRecorded",
      streamType: "decision_evidence_bundle",
      streamId: evidenceBundleId,
      data: { bundle, bundleDigest }
    },
    {
      type: "DecisionPacketOpened",
      streamType: "decision_packet",
      streamId: packetId,
      data: {
        packetId,
        programId: automatic.resolution.programId,
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
          programId: automatic.resolution.programId,
          packetId,
          packetRevisionId,
          packetRevisionDigest: revisionDigest,
          policyBinding,
          matchedRuleId: null,
          channel: "page" as const,
          deepLink: `/decisions/${packetId}?revision=${packetRevisionId}`,
          idempotencyKey: `attention-page:${packetRevisionId}:${revisionDigest}`,
          status: "pending" as const,
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
    }
  ];
}

export function decideAdvisor(
  state: ProjectionState,
  command: Command,
  now: string
): Decision | null {
  switch (command.type) {
    case "advisor-subject.approve": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Advisor subject approval requires an operator"
        );
      }
      const input = command.payload.subject;
      if (state.advisorSubjects.has(input.subjectId)) {
        return failure("ADVISOR_SUBJECT_CONFLICT", "Advisor subject already exists");
      }
      if (
        (input.subjectKind === "model" && input.model === null) ||
        (input.subjectKind === "conformance" && input.model !== null) ||
        (input.revision === 1 && input.priorSubjectRef !== null) ||
        (input.revision > 1 &&
          (input.priorSubjectRef?.kind !== "advisor_subject" ||
            !exactReference(state, input.priorSubjectRef)))
      ) {
        return failure("ADVISOR_SUBJECT_CONFLICT", "Advisor subject revision chain is invalid");
      }
      const subject = { ...input, approvedBy: command.actor.id, approvedAt: now };
      const events: DomainEventInput[] = [
        {
          type: "AdvisorSubjectApproved",
          streamType: "advisor_subject",
          streamId: subject.subjectId,
          data: { subject, subjectDigest: canonicalDigest(subject) }
        }
      ];
      if (input.priorSubjectRef) {
        for (const policy of state.decisionPolicies.values()) {
          if (
            policy.status === "active" &&
            policy.policy.subjectRef.id === input.priorSubjectRef.id &&
            policy.policy.subjectRef.digest === input.priorSubjectRef.digest
          ) {
            events.push(...suspensionEvents(policy, input.priorSubjectRef, "subject_drift", now));
          }
        }
      }
      return {
        ok: true,
        events,
        resultKind: "advisor_subject",
        resultId: subject.subjectId
      };
    }
    case "advisor-case.record": {
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Advisor case recording requires an operator");
      }
      const input = command.payload.case;
      if (
        state.advisorCases.has(input.caseId) ||
        canonicalDigest(input.input) !== input.inputDigest ||
        !input.input.options.some((option) => option.optionId === input.label.selectedOptionId)
      ) {
        return failure("ADVISOR_CASE_INVALID", "Advisor case identity, input, or label is invalid");
      }
      const allRefs = [
        ...input.input.policyRefs,
        ...input.input.precedentRefs,
        ...input.input.evidenceRefs
      ];
      const refKeys = allRefs.map((reference) => `${reference.kind}:${reference.id}`);
      if (new Set(refKeys).size !== refKeys.length) {
        return failure("ADVISOR_CASE_INVALID", "Advisor case reference categories overlap");
      }
      if (input.provenance === "natural") {
        const packetRevision = state.decisionPacketRevisions.get(input.input.packetRevisionRef.id);
        const resolution = [...state.decisionResolutions.values()].find(
          (entry) =>
            entry.resolution.packetRevisionId === input.input.packetRevisionRef.id &&
            entry.resolution.optionId === input.label.selectedOptionId
        );
        const actionResult = [...state.decisionActionResults.values()].find(
          (entry) =>
            entry.result.packetRevisionId === input.input.packetRevisionRef.id &&
            entry.result.optionId === input.label.selectedOptionId
        );
        if (
          packetRevision?.revisionDigest !== input.input.packetRevisionRef.digest ||
          !resolution ||
          !actionResult ||
          input.label.actionResultRef?.kind !== "decision_action_result" ||
          input.label.actionResultRef.id !== actionResult.result.actionResultId ||
          input.label.actionResultRef.digest !== actionResult.resultDigest ||
          !refsAreUniqueAndExact(state, allRefs)
        ) {
          return failure(
            "ADVISOR_CASE_INVALID",
            "Natural advisor case lacks exact operator authority"
          );
        }
      }
      const recorded = { ...input, recordedBy: command.actor.id, recordedAt: now };
      return {
        ok: true,
        events: [
          {
            type: "AdvisorCaseRecorded",
            streamType: "advisor_case",
            streamId: recorded.caseId,
            data: { case: recorded, caseDigest: canonicalDigest(recorded) }
          }
        ],
        resultKind: "advisor_case",
        resultId: recorded.caseId
      };
    }
    case "advisor-corpus.approve": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Advisor corpus approval requires an operator"
        );
      }
      const input = command.payload.corpus;
      const active = [...state.advisorCorpora.values()].find(
        (entry) => entry.corpus.corpusId === input.corpusId && entry.supersededAt === null
      );
      if (
        state.advisorCorpora.has(input.corpusRevisionId) ||
        (active
          ? input.revision !== active.corpus.revision + 1 ||
            input.priorCorpusRef?.kind !== "advisor_corpus" ||
            input.priorCorpusRef.id !== active.corpus.corpusRevisionId ||
            input.priorCorpusRef.digest !== active.corpusDigest
          : input.revision !== 1 || input.priorCorpusRef !== null)
      ) {
        return failure("ADVISOR_CORPUS_INVALID", "Advisor corpus revision chain is invalid");
      }
      const calibrationIds = input.calibrationCaseRefs.map((reference) => reference.id);
      const holdoutIds = input.holdoutCaseRefs.map((reference) => reference.id);
      if (
        new Set(calibrationIds).size !== calibrationIds.length ||
        new Set(holdoutIds).size !== holdoutIds.length ||
        calibrationIds.some((id) => holdoutIds.includes(id)) ||
        ![...input.calibrationCaseRefs, ...input.holdoutCaseRefs].every(
          (reference) => reference.kind === "advisor_case" && exactReference(state, reference)
        )
      ) {
        return failure("ADVISOR_CORPUS_INVALID", "Advisor corpus partitions are invalid");
      }
      const calibrationFamilies = new Set(
        calibrationIds.map((id) => state.advisorCases.get(id)?.case.sourceFamily)
      );
      const holdoutFamilies = new Set(
        holdoutIds.map((id) => state.advisorCases.get(id)?.case.sourceFamily)
      );
      if ([...calibrationFamilies].some((family) => holdoutFamilies.has(family))) {
        return failure("ADVISOR_CORPUS_INVALID", "A source family crosses corpus partitions");
      }
      const corpus = { ...input, approvedBy: command.actor.id, approvedAt: now };
      return {
        ok: true,
        events: [
          {
            type: "AdvisorCorpusApproved",
            streamType: "advisor_corpus",
            streamId: corpus.corpusRevisionId,
            data: {
              corpus,
              corpusDigest: canonicalDigest(corpus),
              supersededCorpusRevisionId: active?.corpus.corpusRevisionId ?? null
            }
          }
        ],
        resultKind: "advisor_corpus",
        resultId: corpus.corpusRevisionId
      };
    }
    case "advisor-contamination.record": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Contamination recording requires an operator"
        );
      }
      const input = command.payload.contamination;
      const corpus = state.advisorCorpora.get(input.corpusRevisionRef.id);
      const expectedPartition = corpus?.corpus.calibrationCaseRefs.some(
        (reference) => reference.id === input.caseRef.id
      )
        ? "calibration"
        : corpus?.corpus.holdoutCaseRefs.some((reference) => reference.id === input.caseRef.id)
          ? "holdout"
          : null;
      if (
        state.advisorContamination.has(input.contaminationId) ||
        corpus?.corpusDigest !== input.corpusRevisionRef.digest ||
        input.caseRef.kind !== "advisor_case" ||
        !exactReference(state, input.caseRef) ||
        expectedPartition !== input.partition ||
        (input.subjectRef !== null && !exactReference(state, input.subjectRef))
      ) {
        return failure("ADVISOR_CORPUS_INVALID", "Contamination record is not bound to the corpus");
      }
      const contamination = { ...input, recordedBy: command.actor.id, recordedAt: now };
      const events: DomainEventInput[] = [
        {
          type: "AdvisorContaminationRecorded",
          streamType: "advisor_contamination",
          streamId: contamination.contaminationId,
          data: { contamination, contaminationDigest: canonicalDigest(contamination) }
        }
      ];
      for (const policy of state.decisionPolicies.values()) {
        if (
          policy.status === "active" &&
          policy.policy.corpusRevisionRef.id === corpus.corpus.corpusRevisionId
        ) {
          events.push(
            ...suspensionEvents(
              policy,
              {
                kind: "advisor_corpus",
                id: corpus.corpus.corpusRevisionId,
                digest: corpus.corpusDigest
              },
              "corpus_contamination",
              now
            )
          );
        }
      }
      return {
        ok: true,
        events,
        resultKind: "advisor_contamination",
        resultId: contamination.contaminationId
      };
    }
    case "advisor-invocation.queue": {
      if (command.actor.kind !== "system") {
        return failure(
          "ADVISOR_INVOCATION_NOT_CLAIMABLE",
          "Advisor invocation queueing is system-only"
        );
      }
      if (state.advisorInvocations.has(command.payload.invocationId)) {
        return failure("ADVISOR_INVOCATION_NOT_CLAIMABLE", "Advisor invocation already exists");
      }
      const subject = state.advisorSubjects.get(command.payload.subjectId);
      if (!subject) return failure("ADVISOR_SUBJECT_CONFLICT", "Advisor subject does not exist");
      let input: AdvisorCaseInputV1 | Decision;
      let caseRef: AdvisorReferenceV1 | null = null;
      if (command.payload.caseId !== null) {
        const candidate = state.advisorCases.get(command.payload.caseId);
        if (!candidate) return failure("ADVISOR_CASE_INVALID", "Advisor case does not exist");
        input = candidate.case.input;
        caseRef = { kind: "advisor_case", id: candidate.case.caseId, digest: candidate.caseDigest };
      } else if (
        command.payload.packetId !== null &&
        command.payload.packetRevisionId !== null &&
        command.payload.packetRevisionDigest !== null
      ) {
        input = compileAdvisorCaseInput(
          state,
          command.payload.packetId,
          command.payload.packetRevisionId,
          command.payload.packetRevisionDigest,
          now
        );
      } else {
        return failure(
          "ADVISOR_CASE_INVALID",
          "Invocation requires a case or exact packet binding"
        );
      }
      if ("ok" in input) return input;
      const invocation = {
        schemaVersion: 1 as const,
        invocationId: command.payload.invocationId,
        subjectRef: {
          kind: "advisor_subject" as const,
          id: subject.subject.subjectId,
          digest: subject.subjectDigest
        },
        input,
        inputDigest: canonicalDigest(input),
        purpose: command.payload.purpose,
        caseRef,
        status: "pending" as const,
        availableAt: now,
        attempt: 0,
        ownerId: null,
        fencingToken: 0,
        leaseExpiresAt: null,
        recommendationId: null,
        lastError: null,
        createdAt: now,
        completedAt: null
      };
      return {
        ok: true,
        events: [
          {
            type: "AdvisorInvocationQueued",
            streamType: "advisor_invocation",
            streamId: invocation.invocationId,
            data: { invocation, invocationDigest: canonicalDigest(invocation) }
          }
        ],
        resultKind: "advisor_invocation",
        resultId: invocation.invocationId
      };
    }
    case "advisor-invocation.lease.acquire": {
      if (command.actor.kind !== "system") {
        return failure(
          "ADVISOR_INVOCATION_NOT_CLAIMABLE",
          "Advisor invocation leasing is system-only"
        );
      }
      const stored = state.advisorInvocations.get(command.payload.invocationId);
      const reclaiming =
        stored?.invocation.status === "leased" &&
        stored.invocation.leaseExpiresAt !== null &&
        stored.invocation.leaseExpiresAt <= now;
      if (
        !stored ||
        !(
          (stored.invocation.status === "pending" && stored.invocation.availableAt <= now) ||
          reclaiming
        )
      ) {
        return failure("ADVISOR_INVOCATION_NOT_CLAIMABLE", "Advisor invocation is not claimable");
      }
      return {
        ok: true,
        events: [
          {
            type: "AdvisorInvocationLeaseAcquired",
            streamType: "advisor_invocation",
            streamId: stored.invocation.invocationId,
            data: {
              invocationId: stored.invocation.invocationId,
              ownerId: command.payload.ownerId,
              fencingToken: stored.invocation.fencingToken + 1,
              attempt: stored.invocation.attempt + 1,
              leaseExpiresAt: addMilliseconds(now, command.payload.leaseDurationMs)
            }
          }
        ],
        resultKind: "advisor_invocation",
        resultId: stored.invocation.invocationId
      };
    }
    case "advisor-invocation.complete": {
      const stored = state.advisorInvocations.get(command.payload.invocationId);
      const invocation = stored?.invocation;
      if (
        command.actor.kind !== "system" ||
        invocation?.status !== "leased" ||
        invocation.ownerId !== command.payload.ownerId ||
        invocation.fencingToken !== command.payload.fencingToken ||
        invocation.leaseExpiresAt === null ||
        invocation.leaseExpiresAt <= now
      ) {
        return failure("ADVISOR_INVOCATION_LEASE_CONFLICT", "Advisor invocation lease is stale");
      }
      const subject = state.advisorSubjects.get(invocation.subjectRef.id);
      const output = command.payload.output;
      const outputDigest = canonicalDigest(output);
      if (
        subject?.subjectDigest !== invocation.subjectRef.digest ||
        command.payload.driverReceipt.subjectRef.id !== subject.subject.subjectId ||
        command.payload.driverReceipt.subjectRef.digest !== subject.subjectDigest ||
        command.payload.driverReceipt.inputDigest !== invocation.inputDigest ||
        command.payload.driverReceipt.outputDigest !== outputDigest ||
        command.payload.driverReceipt.exitCode !== 0 ||
        command.payload.driverReceipt.completedAt > now ||
        command.payload.driverReceipt.startedAt > command.payload.driverReceipt.completedAt ||
        !citationsMatchInput(output, invocation.input) ||
        (output.kind === "recommend" &&
          !invocation.input.options.some((option) => option.optionId === output.optionId))
      ) {
        return failure("ADVISOR_OUTPUT_INVALID", "Advisor output or receipt is invalid");
      }
      const recommendation = {
        schemaVersion: 1 as const,
        recommendationId: command.payload.recommendationId,
        invocationId: invocation.invocationId,
        subjectRef: invocation.subjectRef,
        inputRef: invocation.caseRef ?? {
          kind: "decision_packet_revision" as const,
          id: invocation.input.packetRevisionRef.id,
          digest: invocation.input.packetRevisionRef.digest
        },
        packetRevisionRef: invocation.input.packetRevisionRef,
        programId: invocation.input.programId,
        purpose: invocation.purpose,
        output,
        outputDigest,
        driverReceipt: command.payload.driverReceipt,
        recordedAt: now
      };
      return {
        ok: true,
        events: [
          {
            type: "AdvisorInvocationSucceeded",
            streamType: "advisor_invocation",
            streamId: invocation.invocationId,
            data: {
              invocationId: invocation.invocationId,
              ownerId: command.payload.ownerId,
              fencingToken: command.payload.fencingToken,
              recommendation,
              recommendationDigest: canonicalDigest(recommendation),
              completedAt: now
            }
          }
        ],
        resultKind: "advisor_recommendation",
        resultId: recommendation.recommendationId
      };
    }
    case "advisor-invocation.fail": {
      const stored = state.advisorInvocations.get(command.payload.invocationId);
      const invocation = stored?.invocation;
      if (
        command.actor.kind !== "system" ||
        invocation?.status !== "leased" ||
        invocation.ownerId !== command.payload.ownerId ||
        invocation.fencingToken !== command.payload.fencingToken
      ) {
        return failure("ADVISOR_INVOCATION_LEASE_CONFLICT", "Advisor invocation lease is stale");
      }
      const delay = ADVISOR_RETRY_DELAYS_MS[invocation.attempt - 1];
      const permanent = command.payload.permanent || delay === undefined;
      return {
        ok: true,
        events: [
          {
            type: "AdvisorInvocationFailed",
            streamType: "advisor_invocation",
            streamId: invocation.invocationId,
            data: {
              invocationId: invocation.invocationId,
              ownerId: command.payload.ownerId,
              fencingToken: command.payload.fencingToken,
              error: command.payload.error,
              permanent,
              availableAt: permanent ? now : addMilliseconds(now, delay),
              completedAt: permanent ? now : null
            }
          }
        ],
        resultKind: "advisor_invocation",
        resultId: invocation.invocationId
      };
    }
    case "advisor-invocation.cancel": {
      const stored = state.advisorInvocations.get(command.payload.invocationId);
      if (
        !stored ||
        (stored.invocation.status !== "pending" && stored.invocation.status !== "leased")
      ) {
        return failure("ADVISOR_INVOCATION_NOT_CLAIMABLE", "Advisor invocation is not cancellable");
      }
      return {
        ok: true,
        events: [
          {
            type: "AdvisorInvocationCancelled",
            streamType: "advisor_invocation",
            streamId: stored.invocation.invocationId,
            data: {
              invocationId: stored.invocation.invocationId,
              reason: command.payload.reason,
              cancelledAt: now
            }
          }
        ],
        resultKind: "advisor_invocation",
        resultId: stored.invocation.invocationId
      };
    }
    case "decision-policy-proposal.compile": {
      if (command.actor.kind !== "system") {
        return failure("DECISION_POLICY_CONFLICT", "Policy proposal compilation is system-only");
      }
      const input = command.payload.proposal;
      const supporting = input.supportingCaseRefs.map((reference) =>
        state.advisorCases.get(reference.id)
      );
      const programIds = unique(
        supporting.flatMap((candidate) => (candidate ? [candidate.case.input.programId] : []))
      ).sort();
      if (
        state.decisionPolicyProposals.has(input.proposalId) ||
        input.status !== "open" ||
        input.supportingCaseRefs.length < 5 ||
        programIds.length < 3 ||
        input.conflictingCaseRefs.length > 0 ||
        supporting.some(
          (candidate) =>
            candidate?.case.provenance !== "natural" ||
            candidate.case.label.actionResultRef === null ||
            !exactReference(state, candidate.case.label.actionResultRef) ||
            advisorCaseSignature(candidate) !== input.selectedOptionSignature ||
            !matcherAcceptsInput(
              input.matcher,
              candidate.case.input,
              candidate.case.label.selectedOptionId
            )
        ) ||
        !input.supportingCaseRefs.every(
          (reference) => reference.kind === "advisor_case" && exactReference(state, reference)
        ) ||
        canonicalDigest(programIds) !== canonicalDigest([...input.supportingProgramIds].sort())
      ) {
        return failure(
          "DECISION_POLICY_CONFLICT",
          "Policy proposal recurrence evidence is invalid"
        );
      }
      const proposal = { ...input, supportingProgramIds: programIds, compiledAt: now };
      return {
        ok: true,
        events: [
          {
            type: "DecisionPolicyProposalCompiled",
            streamType: "decision_policy_proposal",
            streamId: proposal.proposalId,
            data: { proposal, proposalDigest: canonicalDigest(proposal) }
          }
        ],
        resultKind: "decision_policy_proposal",
        resultId: proposal.proposalId
      };
    }
    case "decision-policy-proposal.close": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Decision policy proposal closure requires an operator"
        );
      }
      const stored = state.decisionPolicyProposals.get(command.payload.proposalId);
      const replacement =
        command.payload.replacementProposalId === null
          ? null
          : state.decisionPolicyProposals.get(command.payload.replacementProposalId);
      if (
        stored?.status !== "open" ||
        (command.payload.outcome === "dismissed" &&
          command.payload.replacementProposalId !== null) ||
        (command.payload.outcome === "superseded" &&
          (replacement?.status !== "open" ||
            replacement.proposal.proposalId === stored.proposal.proposalId))
      ) {
        return failure(
          "DECISION_POLICY_CONFLICT",
          "Decision policy proposal closure is stale or invalid"
        );
      }
      const replacementProposalRef = replacement
        ? {
            kind: "decision_policy_proposal" as const,
            id: replacement.proposal.proposalId,
            digest: replacement.proposalDigest
          }
        : null;
      return {
        ok: true,
        events: [
          {
            type: "DecisionPolicyProposalClosed",
            streamType: "decision_policy_proposal",
            streamId: stored.proposal.proposalId,
            data: {
              proposalId: stored.proposal.proposalId,
              outcome: command.payload.outcome,
              reason: command.payload.reason,
              replacementProposalRef,
              closedBy: command.actor.id,
              closedAt: now
            }
          }
        ],
        resultKind: "decision_policy_proposal",
        resultId: stored.proposal.proposalId
      };
    }
    case "decision-policy.approve": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Decision policy approval requires an operator"
        );
      }
      const input = command.payload.policy;
      const active = [...state.decisionPolicies.values()].find(
        (entry) => entry.policy.policyId === input.policyId && entry.status !== "superseded"
      );
      const subject = state.advisorSubjects.get(input.subjectRef.id);
      const corpus = state.advisorCorpora.get(input.corpusRevisionRef.id);
      if (
        state.decisionPolicies.has(input.policyRevisionId) ||
        subject?.subjectDigest !== input.subjectRef.digest ||
        corpus?.corpusDigest !== input.corpusRevisionRef.digest ||
        corpus.supersededAt !== null ||
        (input.executionScope === "fixture" && input.fixtureProgramIds.length === 0) ||
        (input.executionScope === "live" && input.fixtureProgramIds.length > 0) ||
        new Set(input.fixtureProgramIds).size !== input.fixtureProgramIds.length ||
        input.expiresAt <= now ||
        (active
          ? input.revision !== active.policy.revision + 1 ||
            input.priorPolicyRef?.id !== active.policy.policyRevisionId ||
            input.priorPolicyRef.digest !== active.policyDigest
          : input.revision !== 1 || input.priorPolicyRef !== null) ||
        (input.matcher.actionKind === "reprioritize" &&
          (input.matcher.targetKind !== "program_attention_priority" ||
            input.matcher.allowedPriorities.length === 0)) ||
        (input.matcher.actionKind === "approve" && input.matcher.targetKind !== "record_only") ||
        (input.proposalRef !== null &&
          (!exactReference(state, input.proposalRef) ||
            state.decisionPolicyProposals.get(input.proposalRef.id)?.status !== "open"))
      ) {
        return failure(
          "DECISION_POLICY_CONFLICT",
          "Decision policy authority or revision is invalid"
        );
      }
      const policy = { ...input, approvedBy: command.actor.id, approvedAt: now };
      return {
        ok: true,
        events: [
          {
            type: "DecisionPolicyApproved",
            streamType: "decision_policy",
            streamId: policy.policyRevisionId,
            data: {
              policy,
              policyDigest: canonicalDigest(policy),
              supersededPolicyRevisionId: active?.policy.policyRevisionId ?? null
            }
          }
        ],
        resultKind: "decision_policy",
        resultId: policy.policyRevisionId
      };
    }
    case "advisor-evaluation.compile": {
      if (command.actor.kind !== "system") {
        return failure(
          "ADVISOR_EVALUATION_BLOCKED",
          "Advisor evaluation compilation is system-only"
        );
      }
      if (command.payload.expectedThroughPosition !== state.lastAppliedPosition) {
        return failure("ADVISOR_EVALUATION_BLOCKED", "Advisor evaluation cutoff is stale");
      }
      const subject = state.advisorSubjects.get(command.payload.subjectId);
      const policy = state.decisionPolicies.get(command.payload.policyRevisionId);
      const corpus = state.advisorCorpora.get(command.payload.corpusRevisionId);
      if (
        !subject ||
        !policy ||
        !corpus ||
        policy.policy.subjectRef.id !== subject.subject.subjectId ||
        policy.policy.subjectRef.digest !== subject.subjectDigest ||
        policy.policy.corpusRevisionRef.id !== corpus.corpus.corpusRevisionId ||
        policy.policy.corpusRevisionRef.digest !== corpus.corpusDigest ||
        corpus.supersededAt !== null
      ) {
        return failure(
          "ADVISOR_EVALUATION_BLOCKED",
          "Evaluation subject, policy, or corpus is stale"
        );
      }
      const contaminated = new Set(
        [...state.advisorContamination.values()]
          .filter(
            (entry) => entry.contamination.corpusRevisionRef.id === corpus.corpus.corpusRevisionId
          )
          .map((entry) => entry.contamination.caseRef.id)
      );
      const calibration = corpus.corpus.calibrationCaseRefs
        .map((reference) => state.advisorCases.get(reference.id))
        .filter(
          (candidate): candidate is AdvisorCaseState =>
            candidate !== undefined && !contaminated.has(candidate.case.caseId)
        )
        .filter((candidate) => policyMatchesCase(policy, candidate));
      const holdout = corpus.corpus.holdoutCaseRefs
        .map((reference) => state.advisorCases.get(reference.id))
        .filter(
          (candidate): candidate is AdvisorCaseState =>
            candidate !== undefined && !contaminated.has(candidate.case.caseId)
        )
        .filter((candidate) => policyMatchesCase(policy, candidate));
      const recentCutoff = addMilliseconds(now, -30 * DAY_MS);
      const fixtureScoped = policy.policy.executionScope === "fixture";
      const conformanceSubject = subject.subject.subjectKind === "conformance";
      const explicitRecent = new Set(command.payload.recentCaseIds);
      const recent = [...state.advisorCases.values()]
        .filter(
          (candidate) =>
            explicitRecent.has(candidate.case.caseId) &&
            (candidate.case.provenance === "natural" ||
              (fixtureScoped && candidate.case.provenance === "fixture")) &&
            candidate.case.label.labeledAt >= recentCutoff &&
            candidate.case.label.labeledAt <= now &&
            policyMatchesCase(policy, candidate)
        )
        .sort((left, right) => right.case.label.labeledAt.localeCompare(left.case.label.labeledAt))
        .slice(0, 50);
      const holdoutScore = evaluationForCases(state, subject.subject.subjectId, holdout);
      const recentScore = evaluationForCases(state, subject.subject.subjectId, recent);
      const adversarial = holdout.filter(
        (candidate) => candidate.case.adversarialCategories.length > 0
      );
      const presentCategories = new Set(
        adversarial.flatMap((candidate) => candidate.case.adversarialCategories)
      );
      const blockers = [
        calibration.length < 50 ? "calibration_below_50" : null,
        holdout.length < 100 ? "holdout_below_100" : null,
        adversarial.length < 25 ? "adversarial_below_25" : null,
        recent.length < 50 ? "recent_shadow_below_50" : null,
        holdoutScore.coverage < 0.8 ? "holdout_coverage_below_80_percent" : null,
        recentScore.coverage < 0.8 ? "recent_coverage_below_80_percent" : null,
        wilsonLowerBound(holdoutScore.agreementCount, holdoutScore.recommendedCount) < 0.95
          ? "wilson_lower_bound_below_95_percent"
          : null,
        holdoutScore.seriousDisagreementCount > 0 || recentScore.seriousDisagreementCount > 0
          ? "serious_disagreement"
          : null,
        recentScore.invalidCount > 0 ? "recent_invalid_output" : null,
        conformanceSubject && !fixtureScoped ? "conformance_subject_requires_fixture_scope" : null,
        contaminated.size > 0 ? "unresolved_contamination" : null,
        corpus.corpus.adversarialCategoryRequirements.some(
          (category) => !presentCategories.has(category)
        )
          ? "adversarial_category_missing"
          : null
      ].filter((value): value is string => value !== null);
      const report = {
        schemaVersion: 1 as const,
        reportId: command.payload.reportId,
        subjectRef: {
          kind: "advisor_subject" as const,
          id: subject.subject.subjectId,
          digest: subject.subjectDigest
        },
        policyRevisionRef: {
          kind: "decision_policy" as const,
          id: policy.policy.policyRevisionId,
          digest: policy.policyDigest
        },
        corpusRevisionRef: {
          kind: "advisor_corpus" as const,
          id: corpus.corpus.corpusRevisionId,
          digest: corpus.corpusDigest
        },
        scoringVersion: "advisor-scoring-v1" as const,
        calibrationCount: calibration.length,
        holdout: {
          ...holdoutScore,
          wilsonLowerBound: wilsonLowerBound(
            holdoutScore.agreementCount,
            holdoutScore.recommendedCount
          ),
          adversarialCount: adversarial.length
        },
        recentShadow: {
          eligibleCount: recentScore.eligibleCount,
          recommendedCount: recentScore.recommendedCount,
          agreementCount: recentScore.agreementCount,
          abstentionCount: recentScore.abstentionCount,
          invalidCount: recentScore.invalidCount,
          seriousDisagreementCount: recentScore.seriousDisagreementCount,
          coverage: recentScore.coverage
        },
        contaminationCount: contaminated.size,
        promotionEligible: blockers.length === 0,
        blockers,
        compiledAt: now,
        throughPosition: state.lastAppliedPosition
      };
      return {
        ok: true,
        events: [
          {
            type: "AdvisorEvaluationCompiled",
            streamType: "advisor_evaluation",
            streamId: report.reportId,
            data: { report, reportDigest: canonicalDigest(report) }
          }
        ],
        resultKind: "advisor_evaluation",
        resultId: report.reportId
      };
    }
    case "advisor-promotion.compile": {
      if (command.actor.kind !== "system") {
        return failure(
          "DECISION_POLICY_NOT_PROMOTABLE",
          "Promotion packet compilation is system-only"
        );
      }
      if (command.payload.expectedThroughPosition !== state.lastAppliedPosition) {
        return failure("DECISION_POLICY_NOT_PROMOTABLE", "Promotion packet cutoff is stale");
      }
      const policy = state.decisionPolicies.get(command.payload.policyRevisionId);
      const report = state.advisorEvaluations.get(command.payload.evaluationReportId);
      const subject = policy ? state.advisorSubjects.get(policy.policy.subjectRef.id) : undefined;
      const corpus = policy
        ? state.advisorCorpora.get(policy.policy.corpusRevisionRef.id)
        : undefined;
      const corpusContaminated = policy
        ? [...state.advisorContamination.values()].some(
            (entry) =>
              entry.contamination.corpusRevisionRef.id === policy.policy.corpusRevisionRef.id
          )
        : false;
      const policyHasOpenIncident = policy
        ? [...state.advisorIncidents.values()].some(
            (entry) =>
              entry.incident.policyRevisionRef.id === policy.policy.policyRevisionId &&
              entry.incident.status === "open"
          )
        : false;
      const latestReportPosition = policy
        ? Math.max(
            0,
            ...[...state.advisorEvaluations.values()]
              .filter(
                (entry) => entry.report.policyRevisionRef.id === policy.policy.policyRevisionId
              )
              .map((entry) => entry.report.throughPosition)
          )
        : 0;
      if (
        policy?.status !== "shadow" ||
        !report?.report.promotionEligible ||
        report.report.policyRevisionRef.id !== policy.policy.policyRevisionId ||
        report.report.policyRevisionRef.digest !== policy.policyDigest ||
        subject?.subjectDigest !== policy.policy.subjectRef.digest ||
        corpus?.corpusDigest !== policy.policy.corpusRevisionRef.digest ||
        corpus.supersededAt !== null ||
        corpusContaminated ||
        policyHasOpenIncident ||
        report.report.throughPosition !== latestReportPosition ||
        evaluationEvidenceChanged(state, policy, report.report) ||
        policy.policy.expiresAt <= now
      ) {
        return failure(
          "DECISION_POLICY_NOT_PROMOTABLE",
          "Decision policy has not earned promotion"
        );
      }
      const anchorCase = corpus.corpus.holdoutCaseRefs
        .map((reference) => state.advisorCases.get(reference.id))
        .filter((candidate): candidate is AdvisorCaseState => candidate !== undefined)
        .sort((left, right) =>
          left.case.input.programId.localeCompare(right.case.input.programId)
        )[0];
      if (!anchorCase)
        return failure("DECISION_POLICY_NOT_PROMOTABLE", "Promotion lacks an anchor program");
      const subjectRef: AdvisorReferenceV1 = {
        kind: "advisor_subject",
        id: subject.subject.subjectId,
        digest: subject.subjectDigest
      };
      const corpusRef: AdvisorReferenceV1 = {
        kind: "advisor_corpus",
        id: corpus.corpus.corpusRevisionId,
        digest: corpus.corpusDigest
      };
      const policyRef: AdvisorReferenceV1 = {
        kind: "decision_policy",
        id: policy.policy.policyRevisionId,
        digest: policy.policyDigest
      };
      const reportRef: AdvisorReferenceV1 = {
        kind: "advisor_evaluation",
        id: report.report.reportId,
        digest: report.reportDigest
      };
      const expiresAt = new Date(
        Math.min(new Date(policy.policy.expiresAt).getTime(), new Date(now).getTime() + 30 * DAY_MS)
      ).toISOString();
      const preconditionDigest = canonicalDigest({
        policyRef,
        subjectRef,
        corpusRef,
        reportRef,
        expiresAt,
        maxAutomaticResolutions: 200
      });
      const source = {
        kind: "advisor_policy_promotion" as const,
        id: policy.policy.policyRevisionId,
        digest: preconditionDigest
      };
      const optionId = deterministicUuid(
        `parallelplay:advisor-promotion-option:v1:${policy.policy.policyRevisionId}:${report.report.reportId}`
      );
      const option = {
        schemaVersion: 3 as const,
        optionId,
        label: "Promote this bounded low-risk advisor policy",
        consequences: [
          "Only the exact evaluated policy and advisor subject may resolve matching low-risk decisions",
          "The promotion expires after 30 days or 200 automatic resolutions",
          "Serious disagreement, drift, contamination, or overdue audit suspends authority"
        ],
        reversalCost:
          "Suspension is immediate; already applied attention-only actions remain recorded",
        action: {
          kind: "promote_advisor_policy" as const,
          target: {
            kind: "advisor_policy_promotion" as const,
            policyRevisionRef: policyRef,
            subjectRef,
            corpusRevisionRef: corpusRef,
            evaluationReportRef: reportRef,
            expiresAt,
            maxAutomaticResolutions: 200 as const,
            preconditionDigest
          }
        }
      };
      const bundle = {
        schemaVersion: 3 as const,
        evidenceBundleId: command.payload.evidenceBundleId,
        packetId: command.payload.packetId,
        packetRevisionId: command.payload.packetRevisionId,
        programId: anchorCase.case.input.programId,
        sourceRef: source,
        refs: [policyRef, subjectRef, corpusRef, reportRef],
        orientation: `Promote only ${policy.policy.policyRevisionId} under the locked advisor thresholds.`,
        compiledAt: now
      };
      const bundleDigest = canonicalDigest(bundle);
      const revision = {
        schemaVersion: 3 as const,
        packetRevisionId: command.payload.packetRevisionId,
        packetId: command.payload.packetId,
        programId: anchorCase.case.input.programId,
        milestoneId: null,
        revision: 1 as const,
        priorRevisionRef: null,
        source,
        originalQuestion: `Should policy ${policy.policy.policyRevisionId} receive bounded automatic resolution authority?`,
        prompt:
          "Review the exact evaluation evidence and explicitly promote or leave the policy in shadow mode.",
        context: `Subject ${subject.subject.subjectId}; corpus ${corpus.corpus.corpusRevisionId}; report ${report.report.reportId}.`,
        requiredAuthority: "operator" as const,
        riskClass: "reserved" as const,
        safetyClass: "safety_critical" as const,
        reversibility: "one_way" as const,
        options: [option],
        evidenceBundleRef: {
          kind: "decision_evidence_bundle" as const,
          id: bundle.evidenceBundleId,
          digest: bundleDigest
        },
        policyBinding: {
          kind: "kernel_default" as const,
          version: "kernel-default-v1" as const,
          digest: canonicalDigest({ advisorPromotionRouting: "v1" })
        },
        precedentRefs: [],
        deadlineAt: expiresAt,
        defaultOnTimeout: null,
        deduplicationKey: canonicalDigest({
          policyRevisionId: policy.policy.policyRevisionId,
          reportId: report.report.reportId
        }),
        routing: {
          route: "page" as const,
          urgency: "p0" as const,
          matchedRuleId: null,
          requireAcknowledgement: true as const,
          reason: "advisor_policy_promotion_requires_operator" as const,
          routineBudget: {
            applied: false as const,
            allowed: true as const,
            used: 0,
            limit: 0,
            windowMs: 0
          }
        },
        createdAt: now
      };
      const revisionDigest = canonicalDigest(revision);
      return {
        ok: true,
        events: [
          {
            type: "DecisionEvidenceBundleRecorded",
            streamType: "decision_evidence_bundle",
            streamId: bundle.evidenceBundleId,
            data: { bundle, bundleDigest }
          },
          {
            type: "DecisionPacketOpened",
            streamType: "decision_packet",
            streamId: revision.packetId,
            data: {
              packetId: revision.packetId,
              programId: revision.programId,
              milestoneId: null,
              packetRevisionId: revision.packetRevisionId,
              packetRevisionDigest: revisionDigest
            }
          },
          {
            type: "DecisionPacketRevisionRecorded",
            streamType: "decision_packet_revision",
            streamId: revision.packetRevisionId,
            data: { revision, revisionDigest, supersededRevisionId: null }
          }
        ],
        resultKind: "decision_packet",
        resultId: revision.packetId
      };
    }
    case "decision.promote-advisor-policy": {
      if (command.actor.kind !== "operator") {
        return failure(
          "APPROVAL_REQUIRES_OPERATOR",
          "Advisor policy promotion requires an operator"
        );
      }
      const packet = state.decisionPackets.get(command.payload.packetId);
      const stored = state.decisionPacketRevisions.get(command.payload.packetRevisionId);
      if (
        packet?.status !== "open" ||
        packet.currentRevisionId !== command.payload.packetRevisionId ||
        packet.currentRevisionDigest !== command.payload.packetRevisionDigest ||
        stored?.revision.schemaVersion !== 3 ||
        stored.revisionDigest !== command.payload.packetRevisionDigest ||
        stored.revision.deadlineAt <= now ||
        canonicalDigest(stored.revision) !== stored.revisionDigest
      ) {
        return failure("DECISION_PACKET_STALE", "Advisor promotion packet is stale");
      }
      const option = stored.revision.options.find(
        (candidate) => candidate.optionId === command.payload.optionId
      );
      const target = option?.action.target;
      if (target?.preconditionDigest !== command.payload.targetPreconditionDigest) {
        return failure("DECISION_ACTION_MISMATCH", "Advisor promotion option does not match");
      }
      const policy = state.decisionPolicies.get(target.policyRevisionRef.id);
      const report = state.advisorEvaluations.get(target.evaluationReportRef.id);
      const subject = state.advisorSubjects.get(target.subjectRef.id);
      const corpus = state.advisorCorpora.get(target.corpusRevisionRef.id);
      const corpusContaminated = [...state.advisorContamination.values()].some(
        (entry) => entry.contamination.corpusRevisionRef.id === target.corpusRevisionRef.id
      );
      const policyHasOpenIncident = [...state.advisorIncidents.values()].some(
        (entry) =>
          entry.incident.policyRevisionRef.id === target.policyRevisionRef.id &&
          entry.incident.status === "open"
      );
      if (
        policy?.status !== "shadow" ||
        policy.policyDigest !== target.policyRevisionRef.digest ||
        subject?.subjectDigest !== target.subjectRef.digest ||
        corpus?.corpusDigest !== target.corpusRevisionRef.digest ||
        corpus.supersededAt !== null ||
        report?.reportDigest !== target.evaluationReportRef.digest ||
        !report.report.promotionEligible ||
        report.report.policyRevisionRef.id !== policy.policy.policyRevisionId ||
        report.report.subjectRef.id !== subject.subject.subjectId ||
        report.report.corpusRevisionRef.id !== corpus.corpus.corpusRevisionId ||
        corpusContaminated ||
        policyHasOpenIncident ||
        target.expiresAt <= now ||
        policy.policy.expiresAt <= now ||
        evaluationEvidenceChanged(state, policy, report.report) ||
        canonicalDigest({
          policyRef: target.policyRevisionRef,
          subjectRef: target.subjectRef,
          corpusRef: target.corpusRevisionRef,
          reportRef: target.evaluationReportRef,
          expiresAt: target.expiresAt,
          maxAutomaticResolutions: 200
        }) !== target.preconditionDigest
      ) {
        return failure("DECISION_POLICY_NOT_PROMOTABLE", "Advisor promotion evidence changed");
      }
      const promotion = {
        schemaVersion: 1 as const,
        promotionId: command.payload.promotionId,
        policyRevisionRef: target.policyRevisionRef,
        subjectRef: target.subjectRef,
        corpusRevisionRef: target.corpusRevisionRef,
        evaluationReportRef: target.evaluationReportRef,
        promotionPacketRevisionRef: {
          kind: "decision_packet_revision" as const,
          id: stored.revision.packetRevisionId,
          digest: stored.revisionDigest
        },
        preconditionDigest: target.preconditionDigest,
        maxAutomaticResolutions: 200 as const,
        expiresAt: target.expiresAt,
        approvedBy: command.actor.id,
        approvedAt: now
      };
      const promotionDigest = canonicalDigest(promotion);
      const promotionRef: AdvisorReferenceV1 = {
        kind: "decision_policy_promotion",
        id: promotion.promotionId,
        digest: promotionDigest
      };
      const resultId = deterministicUuid(
        `parallelplay:decision-action-result:v3:${stored.revision.packetRevisionId}:${command.payload.optionId}`
      );
      const resolutionId = deterministicUuid(
        `parallelplay:decision-resolution:v3:${stored.revision.packetRevisionId}:${command.payload.optionId}`
      );
      const precedentId = deterministicUuid(
        `parallelplay:decision-precedent:v3:${stored.revision.packetRevisionId}:${command.payload.optionId}`
      );
      const result = {
        schemaVersion: 3 as const,
        actionResultId: resultId,
        packetId: stored.revision.packetId,
        packetRevisionId: stored.revision.packetRevisionId,
        optionId: command.payload.optionId,
        actionKind: "promote_advisor_policy" as const,
        targetPreconditionDigest: target.preconditionDigest,
        appliedEventTypes: ["DecisionPolicyPromotionAuthorized"],
        authority: "operator" as const,
        actorId: command.actor.id,
        policyRevisionRef: target.policyRevisionRef,
        promotionRef,
        recommendationRef: null,
        appliedAt: now
      };
      const resolution = {
        schemaVersion: 3 as const,
        resolutionId,
        packetId: stored.revision.packetId,
        packetRevisionId: stored.revision.packetRevisionId,
        packetRevisionDigest: stored.revisionDigest,
        optionId: command.payload.optionId,
        actionKind: "promote_advisor_policy" as const,
        authority: "operator" as const,
        actorId: command.actor.id,
        policyRevisionRef: target.policyRevisionRef,
        promotionRef,
        recommendationRef: null,
        resolvedAt: now
      };
      const precedent = {
        schemaVersion: 3 as const,
        precedentId,
        programId: stored.revision.programId,
        packetRevisionRef: {
          kind: "decision_packet_revision" as const,
          id: stored.revision.packetRevisionId,
          digest: stored.revisionDigest
        },
        selectedOptionId: command.payload.optionId,
        actionResultRef: {
          kind: "decision_action_result" as const,
          id: resultId,
          digest: canonicalDigest(result)
        },
        evidenceBundleRef: stored.revision.evidenceBundleRef,
        authority: "operator" as const,
        actorId: command.actor.id,
        policyRevisionRef: target.policyRevisionRef,
        promotionRef,
        recommendationRef: null,
        recordedAt: now
      };
      return {
        ok: true,
        events: [
          {
            type: "DecisionPolicyPromotionAuthorized",
            streamType: "decision_policy_promotion",
            streamId: promotion.promotionId,
            data: { promotion, promotionDigest }
          },
          {
            type: "DecisionActionApplied",
            streamType: "decision_action_result",
            streamId: resultId,
            data: { result, resultDigest: canonicalDigest(result) }
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
        resultKind: "decision_policy_promotion",
        resultId: promotion.promotionId
      };
    }
    case "advisor.resolve": {
      if (command.actor.kind !== "system") {
        return failure("DECISION_POLICY_INACTIVE", "Advisor resolution is system-only");
      }
      const recommendation = state.advisorRecommendations.get(command.payload.recommendationId);
      const policy = state.decisionPolicies.get(command.payload.policyRevisionId);
      if (
        recommendation?.recommendation === undefined ||
        policy?.status !== "active" ||
        !policy.promotionId
      ) {
        return failure("DECISION_POLICY_INACTIVE", "Advisor policy is not active");
      }
      if (
        policy.policy.executionScope === "fixture" &&
        !policy.policy.fixtureProgramIds.includes(recommendation.recommendation.programId)
      ) {
        return failure(
          "DECISION_POLICY_INACTIVE",
          "Fixture-scoped advisor policy cannot resolve outside its explicit trial programs"
        );
      }
      const promotion = state.decisionPolicyPromotions.get(policy.promotionId);
      const recommendationRef: AdvisorReferenceV1 = {
        kind: "advisor_recommendation",
        id: recommendation.recommendation.recommendationId,
        digest: recommendation.recommendationDigest
      };
      if (
        !promotion ||
        promotion.promotion.expiresAt <= now ||
        policy.policy.expiresAt <= now ||
        policy.automaticResolutionCount >= 200
      ) {
        return {
          ok: true,
          events: suspensionEvents(
            policy,
            recommendationRef,
            "policy_expired_or_limit_reached",
            now
          ),
          resultKind: "decision_policy",
          resultId: policy.policy.policyRevisionId
        };
      }
      const currentSubject = state.advisorSubjects.get(policy.policy.subjectRef.id);
      const currentCorpus = state.advisorCorpora.get(policy.policy.corpusRevisionRef.id);
      const latestEvaluation = [...state.advisorEvaluations.values()]
        .filter((entry) => entry.report.policyRevisionRef.id === policy.policy.policyRevisionId)
        .sort((left, right) => right.report.throughPosition - left.report.throughPosition)[0];
      const evaluationUnhealthy =
        !latestEvaluation?.report.promotionEligible ||
        latestEvaluation.report.policyRevisionRef.digest !== policy.policyDigest ||
        latestEvaluation.report.subjectRef.digest !== policy.policy.subjectRef.digest ||
        latestEvaluation.report.corpusRevisionRef.digest !==
          policy.policy.corpusRevisionRef.digest ||
        currentSubject?.subjectDigest !== policy.policy.subjectRef.digest ||
        currentCorpus?.corpusDigest !== policy.policy.corpusRevisionRef.digest ||
        currentCorpus.supersededAt !== null ||
        evaluationEvidenceChanged(state, policy, latestEvaluation.report) ||
        [...state.advisorIncidents.values()].some(
          (entry) =>
            entry.incident.policyRevisionRef.id === policy.policy.policyRevisionId &&
            entry.incident.status === "open"
        );
      if (evaluationUnhealthy) {
        return {
          ok: true,
          events: suspensionEvents(
            policy,
            recommendationRef,
            "evaluation_floor_or_subject_drift",
            now
          ),
          resultKind: "decision_policy",
          resultId: policy.policy.policyRevisionId
        };
      }
      const overdueAudit = [...state.advisorAudits.values()].find(
        (entry) =>
          entry.audit.policyRevisionRef.id === policy.policy.policyRevisionId &&
          entry.audit.status === "pending" &&
          entry.audit.dueAt <= now
      );
      if (overdueAudit) {
        return {
          ok: true,
          events: suspensionEvents(
            policy,
            {
              kind: "advisor_audit",
              id: overdueAudit.audit.auditId,
              digest: overdueAudit.auditDigest
            },
            "audit_overdue",
            now
          ),
          resultKind: "decision_policy",
          resultId: policy.policy.policyRevisionId
        };
      }
      const packet = state.decisionPackets.get(command.payload.packetId);
      const stored = state.decisionPacketRevisions.get(command.payload.packetRevisionId);
      const output = recommendation.recommendation.output;
      if (
        output.kind !== "recommend" ||
        output.optionId !== command.payload.optionId ||
        recommendation.recommendation.purpose !== "promoted" ||
        recommendation.recommendation.subjectRef.id !== policy.policy.subjectRef.id ||
        recommendation.recommendation.subjectRef.digest !== policy.policy.subjectRef.digest ||
        recommendation.recommendation.packetRevisionRef.id !== command.payload.packetRevisionId ||
        recommendation.recommendation.packetRevisionRef.digest !==
          command.payload.packetRevisionDigest ||
        packet?.status !== "open" ||
        packet.currentRevisionId !== command.payload.packetRevisionId ||
        packet.currentRevisionDigest !== command.payload.packetRevisionDigest ||
        stored?.revision.schemaVersion !== 1 ||
        stored.revisionDigest !== command.payload.packetRevisionDigest
      ) {
        return failure("DECISION_PACKET_STALE", "Promoted advisor recommendation is stale");
      }
      const compiled = compileAdvisorCaseInput(
        state,
        packet.packetId,
        stored.revision.packetRevisionId,
        stored.revisionDigest,
        now
      );
      if ("ok" in compiled) return compiled;
      const option = stored.revision.options.find(
        (candidate) => candidate.optionId === output.optionId
      );
      const policyMatchCount = compiled.options.filter((candidate) =>
        matcherAcceptsInput(policy.policy.matcher, compiled, candidate.optionId)
      ).length;
      if (
        !option ||
        canonicalDigest(option.action.target) !== command.payload.targetPreconditionDigest ||
        !matcherAcceptsInput(policy.policy.matcher, compiled, option.optionId) ||
        policyMatchCount !== 1 ||
        !promotionAllowed(option.action)
      ) {
        return failure("DECISION_ACTION_MISMATCH", "Recommendation does not match promoted policy");
      }
      const domainEvents: DomainEventInput[] = [];
      if (option.action.kind === "reprioritize") {
        const target = option.action.target;
        const program = state.programs.get(target.programId);
        if (
          target.priority === "p0" ||
          program?.version !== target.expectedProgramVersion ||
          !policy.policy.matcher.allowedPriorities.includes(target.priority)
        ) {
          return failure("DECISION_PACKET_STALE", "Program priority precondition changed");
        }
        domainEvents.push({
          type: "ProgramAttentionPriorityChanged",
          streamType: "program",
          streamId: program.programId,
          data: {
            programId: program.programId,
            priority: target.priority,
            changedBy: `policy:${policy.policy.policyRevisionId}`
          }
        });
      } else if (option.action.kind !== "approve" || option.action.target.kind !== "record_only") {
        return failure("DECISION_ACTION_MISMATCH", "Only record-only approval is promotable");
      }
      const automaticActionKind: "approve" | "reprioritize" = option.action.kind;
      const automaticTargetKind: "program_attention_priority" | "record_only" =
        automaticActionKind === "reprioritize" ? "program_attention_priority" : "record_only";
      const promotionRef: AdvisorReferenceV1 = {
        kind: "decision_policy_promotion",
        id: promotion.promotion.promotionId,
        digest: promotion.promotionDigest
      };
      const policyRef: AdvisorReferenceV1 = {
        kind: "decision_policy",
        id: policy.policy.policyRevisionId,
        digest: policy.policyDigest
      };
      const resultId = deterministicUuid(
        `parallelplay:decision-action-result:v3:${stored.revision.packetRevisionId}:${option.optionId}`
      );
      const decisionResolutionId = deterministicUuid(
        `parallelplay:decision-resolution:v3:${stored.revision.packetRevisionId}:${option.optionId}`
      );
      const precedentId = deterministicUuid(
        `parallelplay:decision-precedent:v3:${stored.revision.packetRevisionId}:${option.optionId}`
      );
      const actorId = `policy:${policy.policy.policyRevisionId}`;
      const result = {
        schemaVersion: 3 as const,
        actionResultId: resultId,
        packetId: stored.revision.packetId,
        packetRevisionId: stored.revision.packetRevisionId,
        optionId: option.optionId,
        actionKind: automaticActionKind,
        targetPreconditionDigest: command.payload.targetPreconditionDigest,
        appliedEventTypes: domainEvents.map((event) => event.type),
        authority: "approved_policy" as const,
        actorId,
        policyRevisionRef: policyRef,
        promotionRef,
        recommendationRef,
        appliedAt: now
      };
      const decisionResolution = {
        schemaVersion: 3 as const,
        resolutionId: decisionResolutionId,
        packetId: stored.revision.packetId,
        packetRevisionId: stored.revision.packetRevisionId,
        packetRevisionDigest: stored.revisionDigest,
        optionId: option.optionId,
        actionKind: automaticActionKind,
        authority: "approved_policy" as const,
        actorId,
        policyRevisionRef: policyRef,
        promotionRef,
        recommendationRef,
        resolvedAt: now
      };
      const precedent = {
        schemaVersion: 3 as const,
        precedentId,
        programId: stored.revision.programId,
        packetRevisionRef: {
          kind: "decision_packet_revision" as const,
          id: stored.revision.packetRevisionId,
          digest: stored.revisionDigest
        },
        selectedOptionId: option.optionId,
        actionResultRef: {
          kind: "decision_action_result" as const,
          id: resultId,
          digest: canonicalDigest(result)
        },
        evidenceBundleRef: toAdvisorRef(stored.revision.evidenceBundleRef),
        authority: "approved_policy" as const,
        actorId,
        policyRevisionRef: policyRef,
        promotionRef,
        recommendationRef,
        recordedAt: now
      };
      const auditSelected = automaticAuditSelected(
        command.payload.resolutionId,
        policy.automaticResolutionCount,
        policy.policy.auditRate
      );
      const automaticResolution = {
        schemaVersion: 1 as const,
        resolutionId: command.payload.resolutionId,
        policyRevisionRef: policyRef,
        promotionRef,
        recommendationRef,
        packetRevisionRef: precedent.packetRevisionRef,
        programId: stored.revision.programId,
        optionId: option.optionId,
        actionKind: automaticActionKind,
        targetKind: automaticTargetKind,
        targetPreconditionDigest: command.payload.targetPreconditionDigest,
        auditSelected,
        appliedEventTypes: [
          ...domainEvents.map((event) => event.type),
          "DecisionActionApplied",
          "DecisionResolved",
          "DecisionPrecedentRecorded"
        ],
        appliedAt: now
      };
      const events: DomainEventInput[] = [
        ...domainEvents,
        {
          type: "DecisionActionApplied",
          streamType: "decision_action_result",
          streamId: resultId,
          data: { result, resultDigest: canonicalDigest(result) }
        },
        {
          type: "DecisionResolved",
          streamType: "decision_resolution",
          streamId: decisionResolutionId,
          data: {
            resolution: decisionResolution,
            resolutionDigest: canonicalDigest(decisionResolution)
          }
        },
        {
          type: "DecisionPrecedentRecorded",
          streamType: "decision_precedent",
          streamId: precedentId,
          data: { precedent, precedentDigest: canonicalDigest(precedent) }
        },
        {
          type: "AdvisorAutomaticResolutionRecorded",
          streamType: "advisor_resolution",
          streamId: automaticResolution.resolutionId,
          data: {
            resolution: automaticResolution,
            resolutionDigest: canonicalDigest(automaticResolution)
          }
        }
      ];
      if (auditSelected) {
        const auditId = deterministicUuid(
          `parallelplay:advisor-audit:v1:${automaticResolution.resolutionId}`
        );
        const audit = {
          schemaVersion: 1 as const,
          auditId,
          resolutionRef: {
            kind: "advisor_resolution" as const,
            id: automaticResolution.resolutionId,
            digest: canonicalDigest(automaticResolution)
          },
          policyRevisionRef: policyRef,
          status: "pending" as const,
          finding: null,
          evidenceRefs: [],
          selectedAt: now,
          dueAt: addMilliseconds(now, 7 * DAY_MS),
          reviewedBy: null,
          reviewedAt: null,
          notes: null
        };
        events.push({
          type: "AdvisorAuditSelected",
          streamType: "advisor_audit",
          streamId: auditId,
          data: { audit, auditDigest: canonicalDigest(audit) }
        });
      }
      return {
        ok: true,
        events,
        resultKind: "advisor_resolution",
        resultId: automaticResolution.resolutionId
      };
    }
    case "advisor-audit.record": {
      if (command.actor.kind !== "operator") {
        return failure("APPROVAL_REQUIRES_OPERATOR", "Advisor audit review requires an operator");
      }
      const stored = state.advisorAudits.get(command.payload.auditId);
      if (stored?.audit.status !== "pending") {
        return failure("ADVISOR_AUDIT_NOT_FOUND", "Advisor audit is not pending");
      }
      if (!refsAreUniqueAndExact(state, command.payload.evidenceRefs)) {
        return failure("EVIDENCE_DIGEST_MISMATCH", "Advisor audit evidence is invalid");
      }
      const audit = {
        ...stored.audit,
        status: "completed" as const,
        finding: command.payload.finding,
        evidenceRefs: command.payload.evidenceRefs,
        reviewedBy: command.actor.id,
        reviewedAt: now,
        notes: command.payload.notes
      };
      const events: DomainEventInput[] = [
        {
          type: "AdvisorAuditCompleted",
          streamType: "advisor_audit",
          streamId: audit.auditId,
          data: { audit, auditDigest: canonicalDigest(audit) }
        }
      ];
      if (audit.finding === "serious_disagreement" || audit.finding === "harm") {
        const policy = state.decisionPolicies.get(audit.policyRevisionRef.id);
        if (!policy) return failure("DECISION_POLICY_CONFLICT", "Advisor audit policy is missing");
        const incidentId = deterministicUuid(
          `parallelplay:advisor-incident:v1:${audit.auditId}:${audit.finding}`
        );
        const sourceRef: AdvisorReferenceV1 = {
          kind: "advisor_audit",
          id: audit.auditId,
          digest: canonicalDigest(audit)
        };
        const incident = {
          schemaVersion: 1 as const,
          incidentId,
          policyRevisionRef: audit.policyRevisionRef,
          kind: audit.finding,
          sourceRef,
          status: "open" as const,
          detail: command.payload.notes ?? audit.finding,
          recordedAt: now
        };
        events.push(
          {
            type: "AdvisorIncidentRecorded",
            streamType: "advisor_incident",
            streamId: incidentId,
            data: { incident, incidentDigest: canonicalDigest(incident) }
          },
          {
            type: "DecisionPolicySuspended",
            streamType: "decision_policy",
            streamId: policy.policy.policyRevisionId,
            data: {
              policyRevisionId: policy.policy.policyRevisionId,
              reason: audit.finding,
              sourceRef,
              suspendedAt: now
            }
          }
        );
        events.push(...safetyIncidentAttentionEvents(state, incident, audit.resolutionRef, now));
      }
      return {
        ok: true,
        events,
        resultKind: "advisor_audit",
        resultId: audit.auditId
      };
    }
    case "decision-policy.suspend": {
      const policy = state.decisionPolicies.get(command.payload.policyRevisionId);
      if (
        !policy ||
        (command.actor.kind === "system" && !exactReference(state, command.payload.sourceRef))
      ) {
        return failure(
          "DECISION_POLICY_CONFLICT",
          "Decision policy suspension evidence is invalid"
        );
      }
      if (policy.status !== "active" && policy.status !== "shadow") {
        return failure("DECISION_POLICY_INACTIVE", "Decision policy is not suspendable");
      }
      return {
        ok: true,
        events: [
          {
            type: "DecisionPolicySuspended",
            streamType: "decision_policy",
            streamId: policy.policy.policyRevisionId,
            data: {
              policyRevisionId: policy.policy.policyRevisionId,
              reason: command.payload.reason,
              sourceRef: command.payload.sourceRef,
              suspendedAt: now
            }
          }
        ],
        resultKind: "decision_policy",
        resultId: policy.policy.policyRevisionId
      };
    }
    default:
      return null;
  }
}
