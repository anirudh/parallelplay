import { z } from "zod";

const UUID = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Text = z.string().trim().min(1);
const Identifier = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);

export const AdvisorReferenceKindSchema = z.enum([
  "advisor_subject",
  "advisor_case",
  "advisor_corpus",
  "advisor_recommendation",
  "advisor_evaluation",
  "decision_policy_proposal",
  "decision_policy",
  "decision_policy_promotion",
  "advisor_resolution",
  "advisor_audit",
  "advisor_incident",
  "decision_packet_revision",
  "decision_evidence_bundle",
  "attention_policy",
  "decision_precedent",
  "intent_playback",
  "operator_decision_request",
  "routed_issue",
  "milestone_contract",
  "context_packet",
  "source_revision",
  "approval_request",
  "outcome_disposition",
  "decision_acknowledgement",
  "decision_resolution",
  "decision_action_result",
  "attention_delivery",
  "attention_budget_incident",
  "attention_measurement_report",
  "attention_digest_artifact",
  "program",
  "program_graph",
  "outcome_packet",
  "outcome_validation",
  "artifact_manifest",
  "driver_receipt",
  "verification"
]);

export const AdvisorReferenceV1Schema = z.strictObject({
  kind: AdvisorReferenceKindSchema,
  id: UUID,
  digest: Digest
});

export const AdvisorHostClassificationV1Schema = z.strictObject({
  riskClass: z.enum(["low", "normal", "high", "reserved"]),
  safetyClass: z.enum(["routine", "safety_critical"]),
  reversibility: z.enum(["reversible", "costly", "one_way"]),
  sourceKind: Identifier,
  actionKinds: z.array(Identifier).min(1).max(8),
  targetKinds: z.array(Identifier).min(1).max(8),
  promotionEligible: z.boolean(),
  exclusionReasons: z.array(Text.max(500)).max(32)
});

export const AdvisorCaseOptionV1Schema = z.strictObject({
  optionId: UUID,
  label: Text.max(300),
  consequences: z.array(Text.max(1_000)).min(1).max(16),
  reversalCost: Text.max(1_000),
  actionKind: Identifier,
  targetKind: Identifier,
  targetParameters: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("program_attention_priority"),
      priority: z.enum(["p0", "p1", "p2", "p3"])
    }),
    z.strictObject({ kind: z.literal("record_only") }),
    z.strictObject({ kind: z.literal("excluded") })
  ]),
  targetPreconditionDigest: Digest
});

export const AdvisorCaseInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  inputId: UUID,
  packetId: UUID,
  packetRevisionRef: AdvisorReferenceV1Schema,
  programId: UUID,
  milestoneId: UUID.nullable(),
  sourceRef: AdvisorReferenceV1Schema,
  originalQuestion: Text.max(4_000),
  prompt: Text.max(2_000),
  context: z.string().max(8_000),
  classification: AdvisorHostClassificationV1Schema,
  options: z.array(AdvisorCaseOptionV1Schema).min(1).max(8),
  policyRefs: z.array(AdvisorReferenceV1Schema).max(64),
  precedentRefs: z.array(AdvisorReferenceV1Schema).max(64),
  evidenceRefs: z.array(AdvisorReferenceV1Schema).max(512),
  compiledAt: Timestamp
});

const AdvisorSubjectObjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  subjectId: UUID,
  revision: z.number().int().positive(),
  priorSubjectRef: AdvisorReferenceV1Schema.nullable(),
  name: Text.max(200),
  subjectKind: z.enum(["conformance", "model"]),
  driverProtocolVersion: z.literal(1),
  adapter: z.strictObject({
    adapterId: Identifier,
    adapterDigest: Digest,
    image: z.string().regex(/^(?:sha256:|[^\s@]+@sha256:)[a-f0-9]{64}$/),
    argv: z.array(z.string().min(1).max(4_000)).min(1).max(64)
  }),
  model: z
    .strictObject({
      provider: Identifier,
      model: Text.max(300),
      revision: Text.max(300)
    })
    .nullable(),
  systemPromptDigest: Digest,
  taskPromptDigest: Digest,
  responseSchemaVersion: z.literal(1),
  inference: z.strictObject({
    temperature: z.number().min(0).max(2),
    maxOutputBytes: z.number().int().min(1_024).max(1_048_576),
    timeoutMs: z.number().int().min(1_000).max(300_000)
  }),
  contextCompilerVersion: z.literal("advisor-context-v1"),
  capabilities: z.strictObject({
    network: z.literal(false),
    secrets: z.literal(false),
    git: z.literal(false),
    database: z.literal(false),
    source: z.literal(false),
    artifacts: z.literal(false)
  }),
  maxInputBytes: z.number().int().min(1_024).max(4_194_304),
  approvedBy: Text.max(200),
  approvedAt: Timestamp
});

export const AdvisorSubjectV1Schema = AdvisorSubjectObjectSchema.superRefine((subject, context) => {
  if (subject.subjectKind === "model" && subject.model === null) {
    context.addIssue({
      code: "custom",
      path: ["model"],
      message: "Model subjects bind a model revision"
    });
  }
  if (subject.subjectKind === "conformance" && subject.model !== null) {
    context.addIssue({
      code: "custom",
      path: ["model"],
      message: "Conformance subjects cannot claim a model"
    });
  }
});

export const AdvisorSubjectInputV1Schema = AdvisorSubjectObjectSchema.omit({
  approvedBy: true,
  approvedAt: true
});

export const AdvisorCaseV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: UUID,
  input: AdvisorCaseInputV1Schema,
  inputDigest: Digest,
  provenance: z.enum(["natural", "synthetic", "fixture"]),
  sourceFamily: Identifier,
  adversarialCategories: z.array(Identifier).max(32),
  label: z.strictObject({
    selectedOptionId: UUID,
    actionResultRef: AdvisorReferenceV1Schema.nullable(),
    labeledBy: Text.max(200),
    labeledAt: Timestamp
  }),
  recordedBy: Text.max(200),
  recordedAt: Timestamp
});

export const AdvisorCaseInputRecordV1Schema = AdvisorCaseV1Schema.omit({
  recordedBy: true,
  recordedAt: true
});

export const AdvisorCorpusRevisionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  corpusId: UUID,
  corpusRevisionId: UUID,
  revision: z.number().int().positive(),
  priorCorpusRef: AdvisorReferenceV1Schema.nullable(),
  calibrationCaseRefs: z.array(AdvisorReferenceV1Schema).max(10_000),
  holdoutCaseRefs: z.array(AdvisorReferenceV1Schema).max(10_000),
  adversarialCategoryRequirements: z.array(Identifier).max(64),
  approvedBy: Text.max(200),
  approvedAt: Timestamp
});

export const AdvisorCorpusInputV1Schema = AdvisorCorpusRevisionV1Schema.omit({
  approvedBy: true,
  approvedAt: true
});

export const AdvisorContaminationRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  contaminationId: UUID,
  corpusRevisionRef: AdvisorReferenceV1Schema,
  caseRef: AdvisorReferenceV1Schema,
  subjectRef: AdvisorReferenceV1Schema.nullable(),
  partition: z.enum(["calibration", "holdout"]),
  exposureKind: z.enum(["label", "expected_output", "future_evidence", "training", "unknown"]),
  reason: Text.max(2_000),
  recordedBy: Text.max(200),
  recordedAt: Timestamp
});

export const AdvisorRecommendationOutputV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("recommend"),
    optionId: UUID,
    summary: Text.max(4_000),
    policyCitations: z.array(AdvisorReferenceV1Schema).max(64),
    precedentCitations: z.array(AdvisorReferenceV1Schema).max(64),
    evidenceCitations: z.array(AdvisorReferenceV1Schema).max(256)
  }),
  z.strictObject({
    kind: z.literal("abstain"),
    reasonCode: z.enum([
      "insufficient_policy",
      "insufficient_evidence",
      "ambiguous_options",
      "out_of_scope",
      "low_confidence"
    ]),
    summary: Text.max(4_000),
    policyCitations: z.array(AdvisorReferenceV1Schema).max(64),
    precedentCitations: z.array(AdvisorReferenceV1Schema).max(64),
    evidenceCitations: z.array(AdvisorReferenceV1Schema).max(256)
  })
]);

export const AdvisorDriverReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  subjectRef: AdvisorReferenceV1Schema,
  inputDigest: Digest,
  outputDigest: Digest,
  exitCode: z.number().int().min(0).max(255),
  startedAt: Timestamp,
  completedAt: Timestamp,
  usage: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("known"),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative()
    }),
    z.strictObject({ status: z.literal("unavailable"), reason: Text.max(500) })
  ])
});

export const AdvisorInvocationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  invocationId: UUID,
  subjectRef: AdvisorReferenceV1Schema,
  input: AdvisorCaseInputV1Schema,
  inputDigest: Digest,
  purpose: z.enum(["calibration", "holdout", "shadow", "promoted"]),
  caseRef: AdvisorReferenceV1Schema.nullable(),
  status: z.enum(["pending", "leased", "succeeded", "failed", "cancelled"]),
  availableAt: Timestamp,
  attempt: z.number().int().nonnegative(),
  ownerId: UUID.nullable(),
  fencingToken: z.number().int().nonnegative(),
  leaseExpiresAt: Timestamp.nullable(),
  recommendationId: UUID.nullable(),
  lastError: z.string().max(1_000).nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable()
});

export const AdvisorRecommendationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  recommendationId: UUID,
  invocationId: UUID,
  subjectRef: AdvisorReferenceV1Schema,
  inputRef: AdvisorReferenceV1Schema,
  packetRevisionRef: AdvisorReferenceV1Schema,
  programId: UUID,
  purpose: z.enum(["calibration", "holdout", "shadow", "promoted"]),
  output: AdvisorRecommendationOutputV1Schema,
  outputDigest: Digest,
  driverReceipt: AdvisorDriverReceiptV1Schema,
  recordedAt: Timestamp
});

export const AdvisorEvaluationReportV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: UUID,
  subjectRef: AdvisorReferenceV1Schema,
  policyRevisionRef: AdvisorReferenceV1Schema,
  corpusRevisionRef: AdvisorReferenceV1Schema,
  scoringVersion: z.literal("advisor-scoring-v1"),
  calibrationCount: z.number().int().nonnegative(),
  holdout: z.strictObject({
    eligibleCount: z.number().int().nonnegative(),
    recommendedCount: z.number().int().nonnegative(),
    agreementCount: z.number().int().nonnegative(),
    abstentionCount: z.number().int().nonnegative(),
    invalidCount: z.number().int().nonnegative(),
    seriousDisagreementCount: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1),
    agreement: z.number().min(0).max(1),
    wilsonLowerBound: z.number().min(0).max(1),
    adversarialCount: z.number().int().nonnegative()
  }),
  recentShadow: z.strictObject({
    eligibleCount: z.number().int().nonnegative(),
    recommendedCount: z.number().int().nonnegative(),
    agreementCount: z.number().int().nonnegative(),
    abstentionCount: z.number().int().nonnegative(),
    invalidCount: z.number().int().nonnegative(),
    seriousDisagreementCount: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1)
  }),
  contaminationCount: z.number().int().nonnegative(),
  promotionEligible: z.boolean(),
  blockers: z.array(Identifier).max(64),
  compiledAt: Timestamp,
  throughPosition: z.number().int().nonnegative()
});

export const DecisionPolicyMatcherV1Schema = z.strictObject({
  sourceKind: Identifier,
  riskClass: z.literal("low"),
  safetyClass: z.literal("routine"),
  reversibility: z.literal("reversible"),
  actionKind: z.enum(["reprioritize", "approve"]),
  targetKind: z.enum(["program_attention_priority", "record_only"]),
  allowedPriorities: z.array(z.enum(["p1", "p2", "p3"])).max(3),
  requiredPolicyKinds: z.array(Identifier).max(32),
  requiredEvidenceKinds: z.array(Identifier).max(64)
});

export const DecisionPolicyProposalV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  proposalId: UUID,
  matcher: DecisionPolicyMatcherV1Schema,
  selectedOptionSignature: Digest,
  supportingCaseRefs: z.array(AdvisorReferenceV1Schema).min(5).max(10_000),
  conflictingCaseRefs: z.array(AdvisorReferenceV1Schema).max(10_000),
  supportingProgramIds: z.array(UUID).min(3).max(10_000),
  rationale: Text.max(8_000),
  examples: z.array(Text.max(2_000)).max(32),
  exceptions: z.array(Text.max(2_000)).max(32),
  draftedBy: z.enum(["system", "advisor"]),
  subjectRef: AdvisorReferenceV1Schema.nullable(),
  status: z.enum(["open", "dismissed", "approved"]),
  compiledAt: Timestamp
});

const DecisionPolicyObjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policyId: UUID,
  policyRevisionId: UUID,
  revision: z.number().int().positive(),
  priorPolicyRef: AdvisorReferenceV1Schema.nullable(),
  proposalRef: AdvisorReferenceV1Schema.nullable(),
  scope: Text.max(2_000),
  executionScope: z.enum(["fixture", "live"]),
  fixtureProgramIds: z.array(UUID).max(256),
  riskClass: z.literal("low"),
  matcher: DecisionPolicyMatcherV1Schema,
  rule: Text.max(8_000),
  rationale: Text.max(8_000),
  examples: z.array(Text.max(2_000)).max(32),
  exceptions: z.array(Text.max(2_000)).max(32),
  owner: Text.max(200),
  subjectRef: AdvisorReferenceV1Schema,
  corpusRevisionRef: AdvisorReferenceV1Schema,
  auditRate: z.number().min(0.2).max(1),
  expiresAt: Timestamp,
  approvedBy: Text.max(200),
  approvedAt: Timestamp
});

export const DecisionPolicyV1Schema = DecisionPolicyObjectSchema.superRefine((policy, context) => {
  if (policy.executionScope === "fixture" && policy.fixtureProgramIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["fixtureProgramIds"],
      message: "Fixture policies require at least one explicit program"
    });
  }
  if (policy.executionScope === "live" && policy.fixtureProgramIds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["fixtureProgramIds"],
      message: "Live policies cannot carry fixture program IDs"
    });
  }
});

export const DecisionPolicyInputV1Schema = DecisionPolicyObjectSchema.omit({
  approvedBy: true,
  approvedAt: true
});

export const DecisionPolicyPromotionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  promotionId: UUID,
  policyRevisionRef: AdvisorReferenceV1Schema,
  subjectRef: AdvisorReferenceV1Schema,
  corpusRevisionRef: AdvisorReferenceV1Schema,
  evaluationReportRef: AdvisorReferenceV1Schema,
  promotionPacketRevisionRef: AdvisorReferenceV1Schema,
  preconditionDigest: Digest,
  maxAutomaticResolutions: z.literal(200),
  expiresAt: Timestamp,
  approvedBy: Text.max(200),
  approvedAt: Timestamp
});

export const DecisionTypedActionV3Schema = z.strictObject({
  kind: z.literal("promote_advisor_policy"),
  target: z.strictObject({
    kind: z.literal("advisor_policy_promotion"),
    policyRevisionRef: AdvisorReferenceV1Schema,
    subjectRef: AdvisorReferenceV1Schema,
    corpusRevisionRef: AdvisorReferenceV1Schema,
    evaluationReportRef: AdvisorReferenceV1Schema,
    expiresAt: Timestamp,
    maxAutomaticResolutions: z.literal(200),
    preconditionDigest: Digest
  })
});

export const DecisionOptionV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  optionId: UUID,
  label: Text.max(300),
  consequences: z.array(Text.max(1_000)).min(1).max(16),
  reversalCost: Text.max(1_000),
  action: DecisionTypedActionV3Schema
});

export const DecisionEvidenceBundleV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  evidenceBundleId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  programId: UUID,
  sourceRef: z.strictObject({
    kind: z.literal("advisor_policy_promotion"),
    id: UUID,
    digest: Digest
  }),
  refs: z.array(AdvisorReferenceV1Schema).min(4).max(512),
  orientation: Text.max(8_000),
  compiledAt: Timestamp
});

export const DecisionPacketRevisionV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  packetRevisionId: UUID,
  packetId: UUID,
  programId: UUID,
  milestoneId: z.null(),
  revision: z.literal(1),
  priorRevisionRef: z.null(),
  source: z.strictObject({
    kind: z.literal("advisor_policy_promotion"),
    id: UUID,
    digest: Digest
  }),
  originalQuestion: Text.max(4_000),
  prompt: Text.max(2_000),
  context: Text.max(8_000),
  requiredAuthority: z.literal("operator"),
  riskClass: z.literal("reserved"),
  safetyClass: z.literal("safety_critical"),
  reversibility: z.literal("one_way"),
  options: z.array(DecisionOptionV3Schema).length(1),
  evidenceBundleRef: AdvisorReferenceV1Schema,
  policyBinding: z.strictObject({
    kind: z.literal("kernel_default"),
    version: z.literal("kernel-default-v1"),
    digest: Digest
  }),
  precedentRefs: z.array(AdvisorReferenceV1Schema).max(64),
  deadlineAt: Timestamp,
  defaultOnTimeout: z.null(),
  deduplicationKey: Digest,
  routing: z.strictObject({
    route: z.literal("page"),
    urgency: z.literal("p0"),
    matchedRuleId: z.null(),
    requireAcknowledgement: z.literal(true),
    reason: z.literal("advisor_policy_promotion_requires_operator"),
    routineBudget: z.strictObject({
      applied: z.literal(false),
      allowed: z.literal(true),
      used: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      windowMs: z.number().int().nonnegative()
    })
  }),
  createdAt: Timestamp
});

export const DecisionResolutionV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  resolutionId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  packetRevisionDigest: Digest,
  optionId: UUID,
  actionKind: z.enum(["approve", "reprioritize", "promote_advisor_policy"]),
  authority: z.enum(["operator", "approved_policy"]),
  actorId: Text.max(200),
  policyRevisionRef: AdvisorReferenceV1Schema.nullable(),
  promotionRef: AdvisorReferenceV1Schema.nullable(),
  recommendationRef: AdvisorReferenceV1Schema.nullable(),
  resolvedAt: Timestamp
});

export const DecisionActionResultV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  actionResultId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  optionId: UUID,
  actionKind: z.enum(["approve", "reprioritize", "promote_advisor_policy"]),
  targetPreconditionDigest: Digest,
  appliedEventTypes: z.array(Text.max(200)).max(32),
  authority: z.enum(["operator", "approved_policy"]),
  actorId: Text.max(200),
  policyRevisionRef: AdvisorReferenceV1Schema.nullable(),
  promotionRef: AdvisorReferenceV1Schema.nullable(),
  recommendationRef: AdvisorReferenceV1Schema.nullable(),
  appliedAt: Timestamp
});

export const DecisionPrecedentV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  precedentId: UUID,
  programId: UUID,
  packetRevisionRef: AdvisorReferenceV1Schema,
  selectedOptionId: UUID,
  actionResultRef: AdvisorReferenceV1Schema,
  evidenceBundleRef: AdvisorReferenceV1Schema,
  authority: z.enum(["operator", "approved_policy"]),
  actorId: Text.max(200),
  policyRevisionRef: AdvisorReferenceV1Schema.nullable(),
  promotionRef: AdvisorReferenceV1Schema.nullable(),
  recommendationRef: AdvisorReferenceV1Schema.nullable(),
  recordedAt: Timestamp
});

export const AdvisorAutomaticResolutionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  resolutionId: UUID,
  policyRevisionRef: AdvisorReferenceV1Schema,
  promotionRef: AdvisorReferenceV1Schema,
  recommendationRef: AdvisorReferenceV1Schema,
  packetRevisionRef: AdvisorReferenceV1Schema,
  programId: UUID,
  optionId: UUID,
  actionKind: z.enum(["reprioritize", "approve"]),
  targetKind: z.enum(["program_attention_priority", "record_only"]),
  targetPreconditionDigest: Digest,
  auditSelected: z.boolean(),
  appliedEventTypes: z.array(Text.max(200)).min(1).max(32),
  appliedAt: Timestamp
});

export const AdvisorAuditV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  auditId: UUID,
  resolutionRef: AdvisorReferenceV1Schema,
  policyRevisionRef: AdvisorReferenceV1Schema,
  status: z.enum(["pending", "completed"]),
  finding: z.enum(["agree", "benign_disagreement", "serious_disagreement", "harm"]).nullable(),
  evidenceRefs: z.array(AdvisorReferenceV1Schema).max(128),
  selectedAt: Timestamp,
  dueAt: Timestamp,
  reviewedBy: z.string().max(200).nullable(),
  reviewedAt: Timestamp.nullable(),
  notes: z.string().max(4_000).nullable()
});

export const AdvisorIncidentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  incidentId: UUID,
  policyRevisionRef: AdvisorReferenceV1Schema,
  kind: z.enum([
    "serious_disagreement",
    "harm",
    "audit_overdue",
    "citation_integrity",
    "invalid_output",
    "contamination",
    "subject_drift",
    "evaluation_floor",
    "policy_expired"
  ]),
  sourceRef: AdvisorReferenceV1Schema,
  status: z.enum(["open", "resolved"]),
  detail: Text.max(4_000),
  recordedAt: Timestamp
});

export const AdvisorSubjectStateSchema = z.strictObject({
  kind: z.literal("advisor_subject"),
  subject: AdvisorSubjectV1Schema,
  subjectDigest: Digest,
  version: z.number().int().positive()
});

export const AdvisorCaseStateSchema = z.strictObject({
  kind: z.literal("advisor_case"),
  case: AdvisorCaseV1Schema,
  caseDigest: Digest,
  recordedPosition: z.number().int().nonnegative(),
  version: z.number().int().positive()
});

export const AdvisorCorpusStateSchema = z.strictObject({
  kind: z.literal("advisor_corpus"),
  corpus: AdvisorCorpusRevisionV1Schema,
  corpusDigest: Digest,
  supersededAt: Timestamp.nullable(),
  version: z.number().int().positive()
});

export const AdvisorContaminationStateSchema = z.strictObject({
  kind: z.literal("advisor_contamination"),
  contamination: AdvisorContaminationRecordV1Schema,
  contaminationDigest: Digest,
  version: z.number().int().positive()
});

export const AdvisorInvocationStateSchema = z.strictObject({
  kind: z.literal("advisor_invocation"),
  invocation: AdvisorInvocationV1Schema,
  invocationDigest: Digest,
  queuedPosition: z.number().int().nonnegative(),
  version: z.number().int().positive()
});

export const AdvisorRecommendationStateSchema = z.strictObject({
  kind: z.literal("advisor_recommendation"),
  recommendation: AdvisorRecommendationV1Schema,
  recommendationDigest: Digest,
  version: z.number().int().positive()
});

export const AdvisorEvaluationStateSchema = z.strictObject({
  kind: z.literal("advisor_evaluation"),
  report: AdvisorEvaluationReportV1Schema,
  reportDigest: Digest,
  version: z.number().int().positive()
});

export const DecisionPolicyProposalStateSchema = z.strictObject({
  kind: z.literal("decision_policy_proposal"),
  proposal: DecisionPolicyProposalV1Schema,
  proposalDigest: Digest,
  status: z.enum(["open", "dismissed", "approved", "superseded"]),
  closedAt: Timestamp.nullable(),
  closedBy: z.string().max(200).nullable(),
  closeReason: z.string().max(2_000).nullable(),
  replacementProposalRef: AdvisorReferenceV1Schema.nullable(),
  approvedPolicyRef: AdvisorReferenceV1Schema.nullable(),
  version: z.number().int().positive()
});

export const DecisionPolicyStateSchema = z.strictObject({
  kind: z.literal("decision_policy"),
  policy: DecisionPolicyV1Schema,
  policyDigest: Digest,
  status: z.enum(["shadow", "active", "suspended", "expired", "superseded"]),
  promotionId: UUID.nullable(),
  automaticResolutionCount: z.number().int().nonnegative(),
  suspendedAt: Timestamp.nullable(),
  suspensionReason: z.string().max(2_000).nullable(),
  supersededAt: Timestamp.nullable(),
  version: z.number().int().positive()
});

export const DecisionPolicyPromotionStateSchema = z.strictObject({
  kind: z.literal("decision_policy_promotion"),
  promotion: DecisionPolicyPromotionV1Schema,
  promotionDigest: Digest,
  version: z.number().int().positive()
});

export const AdvisorResolutionStateSchema = z.strictObject({
  kind: z.literal("advisor_resolution"),
  resolution: AdvisorAutomaticResolutionV1Schema,
  resolutionDigest: Digest,
  version: z.number().int().positive()
});

export const AdvisorAuditStateSchema = z.strictObject({
  kind: z.literal("advisor_audit"),
  audit: AdvisorAuditV1Schema,
  auditDigest: Digest,
  version: z.number().int().positive()
});

export const AdvisorIncidentStateSchema = z.strictObject({
  kind: z.literal("advisor_incident"),
  incident: AdvisorIncidentV1Schema,
  incidentDigest: Digest,
  version: z.number().int().positive()
});

export const AdvisorSnapshotV1Schema = z.strictObject({
  snapshotVersion: z.literal(1),
  throughPosition: z.number().int().nonnegative(),
  subjects: z.array(AdvisorSubjectStateSchema),
  corpora: z.array(AdvisorCorpusStateSchema),
  contamination: z.array(AdvisorContaminationStateSchema),
  evaluations: z.array(AdvisorEvaluationStateSchema),
  proposals: z.array(DecisionPolicyProposalStateSchema),
  policies: z.array(DecisionPolicyStateSchema),
  promotions: z.array(DecisionPolicyPromotionStateSchema),
  resolutions: z.array(AdvisorResolutionStateSchema),
  audits: z.array(AdvisorAuditStateSchema),
  incidents: z.array(AdvisorIncidentStateSchema),
  blockers: z.array(z.strictObject({ policyRevisionId: UUID, reasons: z.array(Identifier) }))
});

export type AdvisorReferenceV1 = z.infer<typeof AdvisorReferenceV1Schema>;
export type AdvisorHostClassificationV1 = z.infer<typeof AdvisorHostClassificationV1Schema>;
export type AdvisorCaseInputV1 = z.infer<typeof AdvisorCaseInputV1Schema>;
export type AdvisorSubjectV1 = z.infer<typeof AdvisorSubjectV1Schema>;
export type AdvisorCaseV1 = z.infer<typeof AdvisorCaseV1Schema>;
export type AdvisorCorpusRevisionV1 = z.infer<typeof AdvisorCorpusRevisionV1Schema>;
export type AdvisorContaminationRecordV1 = z.infer<typeof AdvisorContaminationRecordV1Schema>;
export type AdvisorRecommendationOutputV1 = z.infer<typeof AdvisorRecommendationOutputV1Schema>;
export type AdvisorDriverReceiptV1 = z.infer<typeof AdvisorDriverReceiptV1Schema>;
export type AdvisorInvocationV1 = z.infer<typeof AdvisorInvocationV1Schema>;
export type AdvisorRecommendationV1 = z.infer<typeof AdvisorRecommendationV1Schema>;
export type AdvisorEvaluationReportV1 = z.infer<typeof AdvisorEvaluationReportV1Schema>;
export type DecisionPolicyMatcherV1 = z.infer<typeof DecisionPolicyMatcherV1Schema>;
export type DecisionPolicyProposalV1 = z.infer<typeof DecisionPolicyProposalV1Schema>;
export type DecisionPolicyV1 = z.infer<typeof DecisionPolicyV1Schema>;
export type DecisionPolicyPromotionV1 = z.infer<typeof DecisionPolicyPromotionV1Schema>;
export type DecisionTypedActionV3 = z.infer<typeof DecisionTypedActionV3Schema>;
export type DecisionOptionV3 = z.infer<typeof DecisionOptionV3Schema>;
export type DecisionEvidenceBundleV3 = z.infer<typeof DecisionEvidenceBundleV3Schema>;
export type DecisionPacketRevisionV3 = z.infer<typeof DecisionPacketRevisionV3Schema>;
export type DecisionResolutionV3 = z.infer<typeof DecisionResolutionV3Schema>;
export type DecisionActionResultV3 = z.infer<typeof DecisionActionResultV3Schema>;
export type DecisionPrecedentV3 = z.infer<typeof DecisionPrecedentV3Schema>;
export type AdvisorAutomaticResolutionV1 = z.infer<typeof AdvisorAutomaticResolutionV1Schema>;
export type AdvisorAuditV1 = z.infer<typeof AdvisorAuditV1Schema>;
export type AdvisorIncidentV1 = z.infer<typeof AdvisorIncidentV1Schema>;
export type AdvisorSubjectState = z.infer<typeof AdvisorSubjectStateSchema>;
export type AdvisorCaseState = z.infer<typeof AdvisorCaseStateSchema>;
export type AdvisorCorpusState = z.infer<typeof AdvisorCorpusStateSchema>;
export type AdvisorContaminationState = z.infer<typeof AdvisorContaminationStateSchema>;
export type AdvisorInvocationState = z.infer<typeof AdvisorInvocationStateSchema>;
export type AdvisorRecommendationState = z.infer<typeof AdvisorRecommendationStateSchema>;
export type AdvisorEvaluationState = z.infer<typeof AdvisorEvaluationStateSchema>;
export type DecisionPolicyProposalState = z.infer<typeof DecisionPolicyProposalStateSchema>;
export type DecisionPolicyState = z.infer<typeof DecisionPolicyStateSchema>;
export type DecisionPolicyPromotionState = z.infer<typeof DecisionPolicyPromotionStateSchema>;
export type AdvisorResolutionState = z.infer<typeof AdvisorResolutionStateSchema>;
export type AdvisorAuditState = z.infer<typeof AdvisorAuditStateSchema>;
export type AdvisorIncidentState = z.infer<typeof AdvisorIncidentStateSchema>;
export type AdvisorSnapshotV1 = z.infer<typeof AdvisorSnapshotV1Schema>;
