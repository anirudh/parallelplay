import { z } from "zod";
import {
  AdvisorAuditStateSchema,
  AdvisorAuditV1Schema,
  AdvisorAutomaticResolutionV1Schema,
  AdvisorCaseInputRecordV1Schema,
  AdvisorCaseStateSchema,
  AdvisorCaseV1Schema,
  AdvisorContaminationRecordV1Schema,
  AdvisorContaminationStateSchema,
  AdvisorCorpusInputV1Schema,
  AdvisorCorpusRevisionV1Schema,
  AdvisorCorpusStateSchema,
  AdvisorDriverReceiptV1Schema,
  AdvisorEvaluationReportV1Schema,
  AdvisorEvaluationStateSchema,
  AdvisorIncidentStateSchema,
  AdvisorIncidentV1Schema,
  AdvisorInvocationStateSchema,
  AdvisorInvocationV1Schema,
  AdvisorRecommendationOutputV1Schema,
  AdvisorRecommendationStateSchema,
  AdvisorRecommendationV1Schema,
  AdvisorReferenceV1Schema,
  AdvisorResolutionStateSchema,
  AdvisorSnapshotV1Schema,
  AdvisorSubjectInputV1Schema,
  AdvisorSubjectStateSchema,
  AdvisorSubjectV1Schema,
  DecisionPolicyInputV1Schema,
  DecisionActionResultV3Schema,
  DecisionEvidenceBundleV3Schema,
  DecisionPacketRevisionV3Schema,
  DecisionPrecedentV3Schema,
  DecisionResolutionV3Schema,
  DecisionPolicyProposalStateSchema,
  DecisionPolicyProposalV1Schema,
  DecisionPolicyPromotionStateSchema,
  DecisionPolicyPromotionV1Schema,
  DecisionPolicyStateSchema,
  DecisionPolicyV1Schema
} from "./advisor-schema.js";

const UUID = z.uuid();
const Identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9._-]*$/);
const NonEmptyText = z.string().trim().min(1);
const Timestamp = z.iso.datetime({ offset: true });
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const RelativePathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "." || part === ".." || part === ""),
    "Path must be a normalized POSIX-relative path"
  );

const EnvironmentNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/)
  .max(100);
const VerifierArgvSchema = z.array(z.string().min(1).max(4096)).min(1).max(64);
const DirectArgvSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0"))
  )
  .min(1)
  .max(64);

export const ToolProbeSchema = z.strictObject({
  name: Identifier,
  argv: VerifierArgvSchema,
  expectedExitCode: z.number().int().min(0).max(255),
  expectedStdoutDigest: DigestSchema
});

export const VerifierContractSchema = z
  .strictObject({
    mode: z.literal("verify"),
    argv: VerifierArgvSchema,
    cwd: z.union([z.literal("."), RelativePathSchema]),
    timeoutMs: z.number().int().min(1_000).max(3_600_000),
    environment: z.record(EnvironmentNameSchema, z.string().max(16_384)),
    toolProbes: z.array(ToolProbeSchema).max(32)
  })
  .superRefine((contract, context) => {
    const executableIsValid = (executable: string): boolean => {
      if (executable.includes("\0") || executable.includes("\\")) return false;
      if (executable.startsWith("/")) return true;
      if (!executable.startsWith("./")) return false;
      const path = executable.slice(2);
      return (
        path.length > 0 &&
        !path.split("/").some((part) => part === "." || part === ".." || part === "")
      );
    };
    const executable = contract.argv[0] ?? "";
    if (!executableIsValid(executable)) {
      context.addIssue({
        code: "custom",
        message: "Verifier executable must be absolute or repository-relative",
        path: ["argv", 0]
      });
    }
    for (const [index, value] of contract.argv.entries()) {
      if (value.includes("\0")) {
        context.addIssue({
          code: "custom",
          message: "Verifier arguments cannot contain NUL bytes",
          path: ["argv", index]
        });
      }
    }
    for (const [probeIndex, probe] of contract.toolProbes.entries()) {
      if (!executableIsValid(probe.argv[0] ?? "")) {
        context.addIssue({
          code: "custom",
          message: "Probe executable must be absolute or repository-relative",
          path: ["toolProbes", probeIndex, "argv", 0]
        });
      }
      for (const [argumentIndex, value] of probe.argv.entries()) {
        if (value.includes("\0")) {
          context.addIssue({
            code: "custom",
            message: "Probe arguments cannot contain NUL bytes",
            path: ["toolProbes", probeIndex, "argv", argumentIndex]
          });
        }
      }
    }
    for (const reserved of [
      "HOME",
      "TMPDIR",
      "CI",
      "LANG",
      "LC_ALL",
      "TZ",
      "PARALLELPLAY_VERIFICATION_CONTRACT",
      "PARALLELPLAY_SOURCE_REVISION"
    ]) {
      if (Object.hasOwn(contract.environment, reserved)) {
        context.addIssue({
          code: "custom",
          message: `Environment key ${reserved} is reserved`,
          path: ["environment", reserved]
        });
      }
    }
  });

export const ActorSchema = z.strictObject({
  kind: z.enum(["operator", "system"]),
  id: NonEmptyText.max(200)
});

export const GenericCommandContractV1Schema = z.strictObject({
  protocolVersion: z.literal(1),
  image: z
    .string()
    .min(1)
    .max(1000)
    .regex(/^(?:sha256:|[^\s@]+@sha256:)[a-f0-9]{64}$/),
  argv: DirectArgvSchema,
  workingDirectory: z.literal("/workspace")
});

export const GenericCommandContractV2Schema = z
  .strictObject({
    protocolVersion: z.literal(2),
    image: z
      .string()
      .min(1)
      .max(1000)
      .regex(/^(?:sha256:|[^\s@]+@sha256:)[a-f0-9]{64}$/),
    argv: DirectArgvSchema,
    workingDirectory: z.literal("/workspace"),
    context: z.strictObject({
      target: z.literal("/context/context.json"),
      contextPacketId: UUID.optional(),
      contextPacketDigest: DigestSchema.optional()
    })
  })
  .superRefine((contract, context) => {
    if (
      (contract.context.contextPacketId === undefined) !==
      (contract.context.contextPacketDigest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Context packet ID and digest must be bound together",
        path: ["context"]
      });
    }
  });

export const CapabilityManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  workspace: z.enum(["read_only", "read_write"]),
  artifactOutput: z.literal("read_write"),
  scratch: z.literal("read_write"),
  cpuLimit: z.number().positive().max(16),
  memoryLimitBytes: z.number().int().min(67_108_864).max(17_179_869_184),
  pidsLimit: z.number().int().min(16).max(4096),
  network: z.tuple([]),
  secrets: z.tuple([]),
  git: z.tuple([])
});

export const CapabilityManifestV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    workspace: z.enum(["read_only", "read_write"]),
    artifactOutput: z.literal("read_write"),
    scratch: z.literal("read_write"),
    context: z.strictObject({
      access: z.literal("read_only"),
      contextPacketId: UUID.optional(),
      contextPacketDigest: DigestSchema.optional()
    }),
    cpuLimit: z.number().positive().max(16),
    memoryLimitBytes: z.number().int().min(67_108_864).max(17_179_869_184),
    pidsLimit: z.number().int().min(16).max(4096),
    network: z.tuple([]),
    secrets: z.tuple([]),
    git: z.tuple([])
  })
  .superRefine((manifest, context) => {
    if (
      (manifest.context.contextPacketId === undefined) !==
      (manifest.context.contextPacketDigest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Context capability ID and digest must be bound together",
        path: ["context"]
      });
    }
  });

const DriverUsageSchema = z.strictObject({
  cpuMillis: z.number().int().nonnegative(),
  memoryPeakBytes: z.number().int().nonnegative()
});

const MonetaryCostSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("known"),
    amount: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    pricingSource: NonEmptyText.max(500),
    pricingVersion: NonEmptyText.max(200)
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: NonEmptyText.max(500)
  })
]);

const DriverUsageV2Schema = z.strictObject({
  cpuMillis: z.number().int().nonnegative(),
  memoryPeakBytes: z.number().int().nonnegative(),
  monetaryCost: MonetaryCostSchema
});

const DriverArtifactSchema = z.strictObject({
  path: RelativePathSchema,
  role: Identifier,
  size: z.number().int().nonnegative().max(268_435_456),
  sha256: DigestSchema
});

const DriverApprovalSchema = z.strictObject({
  requestId: UUID,
  capability: Identifier,
  reason: NonEmptyText.max(1000),
  sequence: z.number().int().positive()
});

const DriverOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "approval_required",
  "capability_violation",
  "protocol_invalid",
  "operator_cancelled",
  "timed_out"
]);

export const DriverReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  driver: Identifier,
  driverVersion: NonEmptyText.max(100),
  protocolVersion: z.literal(1),
  runId: UUID,
  jobId: UUID,
  attemptId: UUID,
  externalRunId: NonEmptyText.max(500),
  image: NonEmptyText.max(1000),
  baseRevisionId: UUID,
  baseRevisionDigest: DigestSchema,
  candidateRevisionId: UUID.nullable(),
  candidateRevisionDigest: DigestSchema.nullable(),
  executionContractDigest: DigestSchema,
  capabilityManifestDigest: DigestSchema,
  eventStreamDigest: DigestSchema,
  eventCount: z.number().int().nonnegative().max(4096),
  usage: DriverUsageSchema,
  approvals: z.array(DriverApprovalSchema).max(256),
  capabilitiesUsed: z.array(Identifier).max(256),
  artifacts: z.array(DriverArtifactSchema).max(256),
  outcome: DriverOutcomeSchema,
  terminalReason: NonEmptyText.max(1000),
  receiptDigest: DigestSchema
});

export const DriverReceiptV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  driver: Identifier,
  driverVersion: NonEmptyText.max(100),
  protocolVersion: z.literal(2),
  runId: UUID,
  jobId: UUID,
  attemptId: UUID,
  externalRunId: NonEmptyText.max(500),
  image: NonEmptyText.max(1000),
  baseRevisionId: UUID,
  baseRevisionDigest: DigestSchema,
  candidateRevisionId: UUID.nullable(),
  candidateRevisionDigest: DigestSchema.nullable(),
  executionContractDigest: DigestSchema,
  capabilityManifestDigest: DigestSchema,
  contextPacketId: UUID,
  contextPacketDigest: DigestSchema,
  eventStreamDigest: DigestSchema,
  eventCount: z.number().int().nonnegative().max(4096),
  usage: DriverUsageV2Schema,
  approvals: z.array(DriverApprovalSchema).max(256),
  capabilitiesUsed: z.array(Identifier).max(256),
  artifacts: z.array(DriverArtifactSchema).max(256),
  outcome: DriverOutcomeSchema,
  terminalReason: NonEmptyText.max(1000),
  receiptDigest: DigestSchema
});

export const DriverReceiptSchema = z.union([DriverReceiptV2Schema, DriverReceiptV1Schema]);

export const DriverProtocolEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    type: z.literal("started")
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    type: z.literal("usage"),
    cpuMillis: z.number().int().nonnegative(),
    memoryPeakBytes: z.number().int().nonnegative()
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    type: z.literal("artifact.declared"),
    path: RelativePathSchema,
    role: Identifier
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    type: z.literal("capability.used"),
    capability: Identifier
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    type: z.literal("approval.requested"),
    requestId: UUID,
    capability: Identifier,
    reason: NonEmptyText.max(1000)
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    type: z.literal("terminal"),
    outcome: DriverOutcomeSchema,
    detail: NonEmptyText.max(1000).optional()
  })
]);

export const DriverProtocolEventV2Schema = z.discriminatedUnion("type", [
  z.strictObject({
    schemaVersion: z.literal(2),
    sequence: z.number().int().positive(),
    type: z.literal("started")
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    sequence: z.number().int().positive(),
    type: z.literal("usage"),
    cpuMillis: z.number().int().nonnegative(),
    memoryPeakBytes: z.number().int().nonnegative()
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    sequence: z.number().int().positive(),
    type: z.literal("artifact.declared"),
    path: RelativePathSchema,
    role: Identifier
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    sequence: z.number().int().positive(),
    type: z.literal("capability.used"),
    capability: Identifier
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    sequence: z.number().int().positive(),
    type: z.literal("approval.requested"),
    requestId: UUID,
    capability: Identifier,
    reason: NonEmptyText.max(1000)
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    sequence: z.number().int().positive(),
    type: z.literal("issue.raised"),
    originalText: NonEmptyText.max(4_000),
    proposedClass: z.enum([
      "clarification",
      "new_idea",
      "contradiction",
      "blocker",
      "authority_boundary"
    ]),
    resultImpact: z.enum(["none", "may_change_accepted_result"]),
    affectedMilestoneIds: z.array(UUID).min(1).max(32)
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    sequence: z.number().int().positive(),
    type: z.literal("terminal"),
    outcome: DriverOutcomeSchema,
    detail: NonEmptyText.max(1000).optional()
  })
]);

export const DriverProtocolEventSchema = z.union([
  DriverProtocolEventV2Schema,
  DriverProtocolEventV1Schema
]);

export const LegacyWorkflowStepSchema = z.strictObject({
  id: Identifier,
  capability: Identifier,
  dependsOn: z.array(Identifier).max(256),
  verification: VerifierContractSchema.optional()
});

const WorkflowShape = {
  workflowId: UUID,
  version: z.number().int().positive(),
  name: NonEmptyText.max(160)
};

function validateWorkflowGraph(
  workflow: { steps: { id: string; dependsOn: string[] }[] },
  context: z.core.$RefinementCtx
): void {
  const stepIds = new Set<string>();
  for (const [index, step] of workflow.steps.entries()) {
    if (stepIds.has(step.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate workflow step id: ${step.id}`,
        path: ["steps", index, "id"],
        input: step.id
      });
    }
    stepIds.add(step.id);
  }
  for (const [index, step] of workflow.steps.entries()) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        context.addIssue({
          code: "custom",
          message: `Unknown workflow dependency: ${dependency}`,
          path: ["steps", index, "dependsOn"],
          input: dependency
        });
      }
      if (dependency === step.id) {
        context.addIssue({
          code: "custom",
          message: "A workflow step cannot depend on itself",
          path: ["steps", index, "dependsOn"],
          input: dependency
        });
      }
    }
  }
  const dependencies = new Map(workflow.steps.map((step) => [step.id, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(stepId: string): boolean {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    for (const dependency of dependencies.get(stepId) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  }
  for (const stepId of stepIds) {
    if (visit(stepId)) {
      context.addIssue({
        code: "custom",
        message: "Workflow dependencies must form an acyclic graph",
        path: ["steps"],
        input: workflow.steps
      });
      break;
    }
  }
}

export const LegacyWorkflowDefinitionSchema = z
  .strictObject({
    ...WorkflowShape,
    steps: z.array(LegacyWorkflowStepSchema).min(1).max(256)
  })
  .superRefine(validateWorkflowGraph);

export const WorkflowStepV2Schema = z.strictObject({
  id: Identifier,
  capability: Identifier,
  dependsOn: z.array(Identifier).max(256),
  execution: GenericCommandContractV1Schema,
  capabilities: CapabilityManifestV1Schema,
  verification: VerifierContractSchema
});

export const WorkflowDefinitionV2Schema = z
  .strictObject({
    ...WorkflowShape,
    schemaVersion: z.literal(2),
    steps: z.array(WorkflowStepV2Schema).min(1).max(256)
  })
  .superRefine(validateWorkflowGraph);

export const WorkflowStepV3Schema = z.strictObject({
  id: Identifier,
  capability: Identifier,
  dependsOn: z.array(Identifier).max(256),
  execution: GenericCommandContractV2Schema,
  capabilities: CapabilityManifestV2Schema,
  verification: VerifierContractSchema
});

export const WorkflowDefinitionV3Schema = z
  .strictObject({
    ...WorkflowShape,
    schemaVersion: z.literal(3),
    steps: z.array(WorkflowStepV3Schema).min(1).max(256)
  })
  .superRefine((workflow, context) => {
    validateWorkflowGraph(workflow, context);
    for (const [index, step] of workflow.steps.entries()) {
      if (
        step.execution.context.contextPacketId !== undefined ||
        step.execution.context.contextPacketDigest !== undefined ||
        step.capabilities.context.contextPacketId !== undefined ||
        step.capabilities.context.contextPacketDigest !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Workflow V3 context identity is bound only when a generation is scheduled",
          path: ["steps", index, "context"]
        });
      }
    }
  });

export const WorkflowDefinitionSchema = z.union([
  WorkflowDefinitionV3Schema,
  WorkflowDefinitionV2Schema,
  LegacyWorkflowDefinitionSchema
]);

export const ProgramIntentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  objective: NonEmptyText.max(4_000),
  nonGoals: z.array(NonEmptyText.max(500)).max(20),
  tenets: z.array(NonEmptyText.max(500)).min(3).max(7),
  riskClass: z.enum(["low", "normal", "high", "reserved"])
});

export const MilestoneCriterionV1Schema = z.strictObject({
  criterionId: Identifier,
  statement: NonEmptyText.max(1_000),
  verificationStepId: Identifier
});

export const MilestoneContractV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    milestoneId: UUID,
    title: NonEmptyText.max(160),
    objective: NonEmptyText.max(4_000),
    taskType: z.enum(["feature", "bugfix", "chore"]),
    priority: z.enum(["p0", "p1", "p2", "p3"]),
    tags: z.array(Identifier).max(20),
    workflowId: UUID,
    workflowVersion: z.number().int().positive(),
    criteria: z.array(MilestoneCriterionV1Schema).min(1).max(20)
  })
  .superRefine((contract, context) => {
    if (
      new Set(contract.criteria.map((criterion) => criterion.criterionId)).size !==
      contract.criteria.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Milestone criterion IDs must be unique",
        path: ["criteria"]
      });
    }
    if (new Set(contract.tags).size !== contract.tags.length) {
      context.addIssue({
        code: "custom",
        message: "Milestone tags must be unique",
        path: ["tags"]
      });
    }
  });

export const ProgramApprovalBundleV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  program: z.strictObject({
    programId: UUID,
    name: NonEmptyText.max(160),
    intent: ProgramIntentV1Schema
  }),
  milestone: MilestoneContractV1Schema
});

export const ImmutableReferenceV1Schema = z.strictObject({
  kind: z.enum([
    "intent_playback",
    "program_graph",
    "milestone_contract",
    "context_packet",
    "source_revision",
    "outcome_packet",
    "outcome_validation",
    "artifact_manifest",
    "driver_receipt",
    "verification"
  ]),
  id: UUID,
  digest: DigestSchema
});

const ScopedRecordV1Schema = z.strictObject({
  entryId: UUID,
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("program") }),
    z.strictObject({
      kind: z.literal("milestones"),
      milestoneIds: z.array(UUID).min(1).max(32)
    })
  ]),
  text: NonEmptyText.max(4_000),
  refs: z.array(ImmutableReferenceV1Schema).max(32)
});

export const ProgramKickoffV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  programId: UUID,
  name: NonEmptyText.max(160),
  initialSourceRevisionId: UUID,
  initialSourceRevisionDigest: DigestSchema
});

const InterviewAnswersV1Schema = z.strictObject({
  objective: NonEmptyText.max(4_000),
  desiredBehaviors: z.array(NonEmptyText.max(1_000)).min(1).max(20),
  nonGoals: z.array(NonEmptyText.max(1_000)).max(20),
  edgeCases: z.array(NonEmptyText.max(1_000)).max(30),
  ownershipBoundaries: z.array(NonEmptyText.max(1_000)).min(1).max(20),
  successMeasures: z.array(NonEmptyText.max(1_000)).min(1).max(20),
  riskTolerance: z.enum(["low", "normal", "high", "reserved"]),
  tenets: z.array(NonEmptyText.max(500)).min(3).max(7)
});

const InterviewTurnV1Schema = z.strictObject({
  questionId: Identifier,
  question: NonEmptyText.max(1_000),
  answer: NonEmptyText.max(8_000)
});

export const InterviewCaptureV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  interviewId: UUID,
  playbackId: UUID,
  programId: UUID,
  transcript: z.array(InterviewTurnV1Schema).min(8).max(64),
  answers: InterviewAnswersV1Schema
});

export const IntentPlaybackV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  playbackId: UUID,
  interviewId: UUID,
  programId: UUID,
  transcriptDigest: DigestSchema,
  ...InterviewAnswersV1Schema.shape
});

const ProgramGraphMilestoneV1Schema = z.strictObject({
  contract: MilestoneContractV1Schema,
  dependencies: z.array(UUID).max(32),
  sourcePredecessorMilestoneId: UUID.nullable(),
  allowedWorkSurfaces: z.array(RelativePathSchema).min(1).max(64),
  refs: z.array(ImmutableReferenceV1Schema).max(64)
});

function validateProgramGraph(
  graph: {
    milestones: {
      contract: { milestoneId: string };
      dependencies: string[];
      sourcePredecessorMilestoneId: string | null;
      allowedWorkSurfaces: string[];
    }[];
    initialContext: {
      decisions: { scope: { kind: string; milestoneIds?: string[] } }[];
      assumptions: { scope: { kind: string; milestoneIds?: string[] } }[];
      risks: { scope: { kind: string; milestoneIds?: string[] } }[];
      unresolvedQuestions: { scope: { kind: string; milestoneIds?: string[] } }[];
    };
  },
  context: z.core.$RefinementCtx
): void {
  const ids = graph.milestones.map((entry) => entry.contract.milestoneId);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    context.addIssue({
      code: "custom",
      message: "Milestone IDs must be unique",
      path: ["milestones"]
    });
  }
  const roots = graph.milestones.filter((entry) => entry.sourcePredecessorMilestoneId === null);
  if (roots.length !== 1) {
    context.addIssue({
      code: "custom",
      message: "A program graph must have exactly one source root",
      path: ["milestones"]
    });
  }
  if (roots.length === 1 && roots[0]?.dependencies.length !== 0) {
    context.addIssue({
      code: "custom",
      message: "The source root cannot depend on another milestone",
      path: ["milestones"]
    });
  }
  const sourceSuccessors = new Map<string, number>();
  for (const [index, entry] of graph.milestones.entries()) {
    if (new Set(entry.dependencies).size !== entry.dependencies.length) {
      context.addIssue({
        code: "custom",
        message: "Milestone dependencies must be unique",
        path: ["milestones", index, "dependencies"]
      });
    }
    if (new Set(entry.allowedWorkSurfaces).size !== entry.allowedWorkSurfaces.length) {
      context.addIssue({
        code: "custom",
        message: "Allowed work surfaces must be unique",
        path: ["milestones", index, "allowedWorkSurfaces"]
      });
    }
    for (const dependency of entry.dependencies) {
      if (!idSet.has(dependency) || dependency === entry.contract.milestoneId) {
        context.addIssue({
          code: "custom",
          message: "Dependencies must reference another milestone in the graph",
          path: ["milestones", index, "dependencies"]
        });
      }
    }
    const predecessor = entry.sourcePredecessorMilestoneId;
    if (predecessor !== null) {
      if (!idSet.has(predecessor) || !entry.dependencies.includes(predecessor)) {
        context.addIssue({
          code: "custom",
          message: "A source predecessor must also be an in-graph dependency",
          path: ["milestones", index, "sourcePredecessorMilestoneId"]
        });
      }
      sourceSuccessors.set(predecessor, (sourceSuccessors.get(predecessor) ?? 0) + 1);
    }
  }
  if ([...sourceSuccessors.values()].some((count) => count > 1)) {
    context.addIssue({
      code: "custom",
      message: "Source lineage cannot branch",
      path: ["milestones"]
    });
  }
  const dependencies = new Map(
    graph.milestones.map((entry) => [entry.contract.milestoneId, entry.dependencies])
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (ids.some(visit)) {
    context.addIssue({
      code: "custom",
      message: "Program dependencies must form an acyclic graph",
      path: ["milestones"]
    });
  }
  const rootId = roots[0]?.contract.milestoneId;
  if (rootId) {
    const reachable = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of graph.milestones) {
        const predecessor = entry.sourcePredecessorMilestoneId;
        if (
          predecessor &&
          reachable.has(predecessor) &&
          !reachable.has(entry.contract.milestoneId)
        ) {
          reachable.add(entry.contract.milestoneId);
          changed = true;
        }
      }
    }
    if (reachable.size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Every milestone must be connected to the single source root",
        path: ["milestones"]
      });
    }
  }
  for (const collection of [
    graph.initialContext.decisions,
    graph.initialContext.assumptions,
    graph.initialContext.risks,
    graph.initialContext.unresolvedQuestions
  ]) {
    for (const entry of collection) {
      if (
        entry.scope.kind === "milestones" &&
        (entry.scope.milestoneIds ?? []).some((id) => !idSet.has(id))
      ) {
        context.addIssue({
          code: "custom",
          message: "Scoped records must reference milestones in the graph",
          path: ["initialContext"]
        });
      }
    }
  }
}

export const ProgramGraphRevisionV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    graphRevisionId: UUID,
    programId: UUID,
    revision: z.number().int().positive(),
    priorGraphRef: ImmutableReferenceV1Schema.nullable(),
    intentPlaybackRef: ImmutableReferenceV1Schema,
    initialSourceRef: ImmutableReferenceV1Schema,
    milestones: z.array(ProgramGraphMilestoneV1Schema).min(2).max(32),
    initialContext: z.strictObject({
      decisions: z.array(ScopedRecordV1Schema).max(64),
      assumptions: z.array(ScopedRecordV1Schema).max(64),
      risks: z.array(ScopedRecordV1Schema).max(64),
      unresolvedQuestions: z.array(ScopedRecordV1Schema).max(64),
      refs: z.array(ImmutableReferenceV1Schema).max(128)
    })
  })
  .superRefine((graph, context) => {
    validateProgramGraph(graph, context);
    if (graph.intentPlaybackRef.kind !== "intent_playback") {
      context.addIssue({
        code: "custom",
        message: "Intent playback reference has the wrong kind",
        path: ["intentPlaybackRef", "kind"]
      });
    }
    if (graph.initialSourceRef.kind !== "source_revision") {
      context.addIssue({
        code: "custom",
        message: "Initial source reference has the wrong kind",
        path: ["initialSourceRef", "kind"]
      });
    }
    if (graph.priorGraphRef !== null && graph.priorGraphRef.kind !== "program_graph") {
      context.addIssue({
        code: "custom",
        message: "Prior graph reference has the wrong kind",
        path: ["priorGraphRef", "kind"]
      });
    }
  });

export const PortfolioReferenceV1Schema = z.strictObject({
  kind: z.enum([
    "portfolio_policy",
    "integration_target",
    "program_graph",
    "portfolio_admission",
    "concurrency_lease",
    "candidate_diff_manifest",
    "integration_candidate",
    "integration_verification",
    "promotion_receipt",
    "portfolio_slo_incident",
    "portfolio_measurement_report",
    "decision_evidence_bundle",
    "decision_packet_revision",
    "decision_action_result",
    "outcome_packet",
    "source_revision"
  ]),
  id: UUID,
  digest: DigestSchema
});

export const PortfolioResourceV1Schema = z.strictObject({
  resourceId: Identifier,
  kind: z.enum(["schema", "integration_environment", "device", "merge_lane"]),
  capacity: z.literal(1)
});

const PortfolioCostModeV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("unpriced_local_only"),
    allowedDriver: z.literal("generic-command"),
    unavailableReason: NonEmptyText.max(500)
  }),
  z.strictObject({
    kind: z.literal("known_priced"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    cap: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
  })
]);

const PortfolioPolicyV1Shape = {
  schemaVersion: z.literal(1),
  policyId: UUID,
  policyRevisionId: UUID,
  revision: z.number().int().positive(),
  priorPolicyRef: PortfolioReferenceV1Schema.nullable(),
  limits: z.strictObject({
    maxExecutingPrograms: z.number().int().min(1).max(2),
    maxIntegrationReadyCandidates: z.number().int().min(1).max(2),
    maxPipelineWip: z.number().int().min(1).max(4),
    maxAttemptMs: z.number().int().min(1_000).max(300_000),
    maxMergeQueueAgeMs: z.number().int().min(1_000).max(600_000),
    maxTrialWallTimeMs: z.number().int().min(1_000).max(900_000),
    maxActiveHumanTimeMs: z.number().int().min(1_000).max(900_000)
  }),
  resources: z.array(PortfolioResourceV1Schema).max(256),
  capabilityCapacities: z
    .array(
      z.strictObject({
        capability: Identifier,
        capacity: z.number().int().min(1).max(2)
      })
    )
    .min(1)
    .max(256),
  attention: z.strictObject({
    policyRef: z.strictObject({
      kind: z.literal("attention_policy"),
      id: UUID,
      digest: DigestSchema
    }),
    maxRoutinePagesPer24Hours: z.literal(0),
    safetyCriticalUncapped: z.literal(true)
  }),
  costMode: PortfolioCostModeV1Schema
};

function validatePortfolioPolicyV1(
  policy: {
    priorPolicyRef: z.infer<typeof PortfolioReferenceV1Schema> | null;
    resources: z.infer<typeof PortfolioResourceV1Schema>[];
    capabilityCapacities: { capability: string }[];
  },
  context: z.core.$RefinementCtx
): void {
  if (policy.priorPolicyRef !== null && policy.priorPolicyRef.kind !== "portfolio_policy") {
    context.addIssue({
      code: "custom",
      message: "Prior portfolio policy reference has the wrong kind",
      path: ["priorPolicyRef", "kind"]
    });
  }
  if (new Set(policy.resources.map((entry) => entry.resourceId)).size !== policy.resources.length) {
    context.addIssue({
      code: "custom",
      message: "Portfolio resource IDs must be unique",
      path: ["resources"]
    });
  }
  if (
    new Set(policy.capabilityCapacities.map((entry) => entry.capability)).size !==
    policy.capabilityCapacities.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Portfolio capability capacities must be unique",
      path: ["capabilityCapacities"]
    });
  }
}

export const PortfolioPolicyInputV1Schema = z
  .strictObject(PortfolioPolicyV1Shape)
  .superRefine(validatePortfolioPolicyV1);

export const PortfolioPolicyV1Schema = z
  .strictObject({
    ...PortfolioPolicyV1Shape,
    approvedBy: NonEmptyText.max(200),
    approvedAt: Timestamp
  })
  .superRefine(validatePortfolioPolicyV1);

const IntegrationTargetV1Shape = {
  schemaVersion: z.literal(1),
  targetId: UUID,
  targetRevisionId: UUID,
  revision: z.number().int().positive(),
  priorTargetRef: PortfolioReferenceV1Schema.nullable(),
  repositoryId: UUID,
  initialHeadRef: ImmutableReferenceV1Schema,
  managedRef: z.string().max(500),
  verifierContract: VerifierContractSchema,
  verifierContractDigest: DigestSchema,
  mergeLaneResourceId: Identifier
};

function validateIntegrationTargetV1(
  target: {
    priorTargetRef: z.infer<typeof PortfolioReferenceV1Schema> | null;
    initialHeadRef: z.infer<typeof ImmutableReferenceV1Schema>;
    managedRef: string;
    targetId: string;
  },
  context: z.core.$RefinementCtx
): void {
  if (target.priorTargetRef !== null && target.priorTargetRef.kind !== "integration_target") {
    context.addIssue({
      code: "custom",
      message: "Prior integration target reference has the wrong kind",
      path: ["priorTargetRef", "kind"]
    });
  }
  if (target.initialHeadRef.kind !== "source_revision") {
    context.addIssue({
      code: "custom",
      message: "Initial integration head must reference a source revision",
      path: ["initialHeadRef", "kind"]
    });
  }
  if (target.managedRef !== `refs/parallelplay/integration/${target.targetId}`) {
    context.addIssue({
      code: "custom",
      message: "Managed integration ref is not the derived target ref",
      path: ["managedRef"]
    });
  }
}

export const IntegrationTargetInputV1Schema = z
  .strictObject(IntegrationTargetV1Shape)
  .superRefine(validateIntegrationTargetV1);

export const IntegrationTargetV1Schema = z
  .strictObject({
    ...IntegrationTargetV1Shape,
    approvedBy: NonEmptyText.max(200),
    approvedAt: Timestamp
  })
  .superRefine(validateIntegrationTargetV1);

export const WorkSurfaceV1Schema = z.strictObject({
  kind: z.enum(["file", "subtree"]),
  path: RelativePathSchema
});

const CrossProgramDependencyV1Schema = z.strictObject({
  programId: UUID,
  graphRevisionId: UUID,
  graphDigest: DigestSchema
});

const ProgramGraphMilestoneV2Schema = z.strictObject({
  contract: MilestoneContractV1Schema,
  dependencies: z.array(UUID).max(32),
  sourcePredecessorMilestoneId: UUID.nullable(),
  workSurfaces: z.array(WorkSurfaceV1Schema).min(1).max(64),
  resourceClaims: z.array(Identifier).max(64),
  capabilityClaims: z.array(Identifier).min(1).max(64),
  refs: z.array(ImmutableReferenceV1Schema).max(64)
});

export const ProgramGraphRevisionV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    graphRevisionId: UUID,
    programId: UUID,
    revision: z.number().int().positive(),
    priorGraphRef: ImmutableReferenceV1Schema.nullable(),
    intentPlaybackRef: ImmutableReferenceV1Schema,
    initialSourceRef: ImmutableReferenceV1Schema,
    portfolioPolicyRef: PortfolioReferenceV1Schema,
    integrationTargetRef: PortfolioReferenceV1Schema,
    crossProgramDependencies: z.array(CrossProgramDependencyV1Schema).max(32),
    milestones: z.array(ProgramGraphMilestoneV2Schema).min(2).max(32),
    initialContext: z.strictObject({
      decisions: z.array(ScopedRecordV1Schema).max(64),
      assumptions: z.array(ScopedRecordV1Schema).max(64),
      risks: z.array(ScopedRecordV1Schema).max(64),
      unresolvedQuestions: z.array(ScopedRecordV1Schema).max(64),
      refs: z.array(ImmutableReferenceV1Schema).max(128)
    })
  })
  .superRefine((graph, context) => {
    validateProgramGraph(
      {
        ...graph,
        milestones: graph.milestones.map((milestone) => ({
          ...milestone,
          allowedWorkSurfaces: milestone.workSurfaces.map(
            (surface) => `${surface.kind}:${surface.path}`
          )
        }))
      },
      context
    );
    if (graph.portfolioPolicyRef.kind !== "portfolio_policy") {
      context.addIssue({
        code: "custom",
        message: "Graph V2 must reference a portfolio policy",
        path: ["portfolioPolicyRef", "kind"]
      });
    }
    if (graph.integrationTargetRef.kind !== "integration_target") {
      context.addIssue({
        code: "custom",
        message: "Graph V2 must reference an integration target",
        path: ["integrationTargetRef", "kind"]
      });
    }
    if (
      new Set(graph.crossProgramDependencies.map((entry) => entry.programId)).size !==
      graph.crossProgramDependencies.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Cross-program dependency programs must be unique",
        path: ["crossProgramDependencies"]
      });
    }
    for (const [index, milestone] of graph.milestones.entries()) {
      const surfaceKeys = milestone.workSurfaces.map(
        (surface) => `${surface.kind}:${surface.path}`
      );
      if (new Set(surfaceKeys).size !== surfaceKeys.length) {
        context.addIssue({
          code: "custom",
          message: "Structured work surfaces must be unique",
          path: ["milestones", index, "workSurfaces"]
        });
      }
      for (const [leftIndex, left] of milestone.workSurfaces.entries()) {
        for (const [rightIndex, right] of milestone.workSurfaces.entries()) {
          if (leftIndex >= rightIndex) continue;
          const leftContainsRight =
            left.kind === "subtree" &&
            (right.path === left.path || right.path.startsWith(`${left.path}/`));
          const rightContainsLeft =
            right.kind === "subtree" &&
            (left.path === right.path || left.path.startsWith(`${right.path}/`));
          if (leftContainsRight || rightContainsLeft) {
            context.addIssue({
              code: "custom",
              message: "Structured work surfaces within a milestone cannot overlap",
              path: ["milestones", index, "workSurfaces", rightIndex]
            });
          }
        }
      }
      if (new Set(milestone.resourceClaims).size !== milestone.resourceClaims.length) {
        context.addIssue({
          code: "custom",
          message: "Resource claims must be unique",
          path: ["milestones", index, "resourceClaims"]
        });
      }
      if (new Set(milestone.capabilityClaims).size !== milestone.capabilityClaims.length) {
        context.addIssue({
          code: "custom",
          message: "Capability claims must be unique",
          path: ["milestones", index, "capabilityClaims"]
        });
      }
    }
  });

export const ProgramStartV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  requestId: UUID,
  programId: UUID,
  graphRevisionId: UUID,
  graphDigest: DigestSchema,
  policy: z
    .strictObject({
      maxAttempts: z.number().int().min(1).max(10),
      attemptTimeoutMs: z.number().int().min(1_000).max(300_000),
      retryDelaysMs: z.array(z.number().int().min(0).max(86_400_000)).max(9)
    })
    .superRefine((policy, context) => {
      if (policy.retryDelaysMs.length !== policy.maxAttempts - 1) {
        context.addIssue({
          code: "custom",
          message: "retryDelaysMs must contain one delay between each attempt",
          path: ["retryDelaysMs"]
        });
      }
    })
});

export const PortfolioAdmissionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  admissionId: UUID,
  admissionSequence: z.number().int().positive(),
  requestId: UUID,
  programId: UUID,
  graphRevisionRef: PortfolioReferenceV1Schema,
  policyRef: PortfolioReferenceV1Schema,
  targetRef: PortfolioReferenceV1Schema,
  milestoneId: UUID,
  generationId: UUID,
  runId: UUID,
  executionSlot: z.number().int().min(1).max(2),
  capabilityClaims: z.array(Identifier).min(1).max(64),
  resourceClaims: z.array(Identifier).max(64),
  surfaceClaims: z.array(WorkSurfaceV1Schema).min(1).max(64),
  admittedAt: Timestamp,
  releasedAt: Timestamp.nullable(),
  fencedAt: Timestamp.nullable()
});

export const ConcurrencyLeaseV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  leaseId: UUID,
  admissionId: UUID,
  programId: UUID,
  generationId: UUID,
  claimKind: z.enum(["execution_slot", "capability", "resource", "surface"]),
  claimKey: NonEmptyText.max(2_000),
  fencingToken: z.number().int().positive(),
  acquiredAt: Timestamp,
  expiresAt: Timestamp,
  renewedAt: Timestamp.nullable(),
  releasedAt: Timestamp.nullable(),
  fencedAt: Timestamp.nullable()
});

export const CandidateDiffEntryV1Schema = z.strictObject({
  change: z.enum(["add", "modify", "delete"]),
  path: RelativePathSchema,
  oldOid: GitOidSchema.nullable(),
  newOid: GitOidSchema.nullable()
});

export const CandidateDiffManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  manifestId: UUID,
  programId: UUID,
  graphRevisionId: UUID,
  generationId: UUID,
  baseRevisionRef: ImmutableReferenceV1Schema,
  candidateRevisionRef: ImmutableReferenceV1Schema,
  entries: z.array(CandidateDiffEntryV1Schema).max(100_000),
  allowedSurfaces: z.array(WorkSurfaceV1Schema).min(1).max(64),
  violations: z.array(RelativePathSchema).max(100_000),
  eligible: z.boolean(),
  generatedAt: Timestamp
});

export const IntegrationCandidateV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateId: UUID,
  programId: UUID,
  graphRevisionRef: PortfolioReferenceV1Schema,
  policyRef: PortfolioReferenceV1Schema,
  targetRef: PortfolioReferenceV1Schema,
  originalCandidateRef: ImmutableReferenceV1Schema,
  diffManifestRef: PortfolioReferenceV1Schema,
  finalAdmissionSequence: z.number().int().positive(),
  dependencyCandidateIds: z.array(UUID).max(32),
  actualOverlapPredecessorIds: z.array(UUID).max(32),
  queuedAt: Timestamp
});

export const IntegrationWorkV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  workId: UUID,
  candidateId: UUID,
  status: z.enum([
    "pending",
    "leased",
    "prepared",
    "verified",
    "authorized",
    "promoted",
    "conflicted",
    "failed",
    "obsolete"
  ]),
  availableAt: Timestamp,
  leaseOwnerId: UUID.nullable(),
  leaseFencingToken: z.number().int().nonnegative(),
  leaseAcquiredAt: Timestamp.nullable(),
  leaseExpiresAt: Timestamp.nullable(),
  expectedHeadRef: ImmutableReferenceV1Schema.nullable(),
  rebasedCandidateRef: ImmutableReferenceV1Schema.nullable(),
  verification: z.lazy(() => IntegrationVerificationV1Schema).nullable(),
  authorizationRef: z
    .strictObject({
      kind: z.literal("decision_action_result"),
      id: UUID,
      digest: DigestSchema
    })
    .nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
  lastError: z.string().max(1_000).nullable()
});

export const IntegrationVerificationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  integrationVerificationId: UUID,
  candidateId: UUID,
  expectedHeadRef: ImmutableReferenceV1Schema,
  rebasedCandidateRef: ImmutableReferenceV1Schema,
  verifierContractDigest: DigestSchema,
  result: z.enum(["passed", "failed"]),
  exitCode: z.number().int().min(0).max(255).nullable(),
  failureReason: z.string().max(1_000).nullable(),
  resultDigest: DigestSchema,
  receiptDigest: DigestSchema,
  completedAt: Timestamp
});

export const IntegrationConflictV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  conflictId: UUID,
  candidateId: UUID,
  expectedHeadRef: ImmutableReferenceV1Schema,
  originalCandidateRef: ImmutableReferenceV1Schema,
  mergeBaseOid: GitOidSchema,
  paths: z.array(RelativePathSchema).min(1).max(100_000),
  recordedAt: Timestamp
});

export const PromotionReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  receiptId: UUID,
  candidateId: UUID,
  programId: UUID,
  targetRef: PortfolioReferenceV1Schema,
  managedRef: z.string().min(1).max(500),
  expectedOldHeadRef: ImmutableReferenceV1Schema,
  newHeadRef: ImmutableReferenceV1Schema,
  authorizationRef: z.strictObject({
    kind: z.literal("decision_action_result"),
    id: UUID,
    digest: DigestSchema
  }),
  refEffectKey: DigestSchema,
  promotedBy: NonEmptyText.max(200),
  promotedAt: Timestamp
});

export const PortfolioSloIncidentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  incidentId: UUID,
  policyRef: PortfolioReferenceV1Schema,
  kind: z.enum(["merge_queue_age", "trial_wall_time", "active_human_time", "cost"]),
  observed: NonEmptyText.max(500),
  limit: NonEmptyText.max(500),
  status: z.enum(["open", "resolved"]),
  admissionFrozen: z.literal(true),
  recordedAt: Timestamp,
  resolvedAt: Timestamp.nullable()
});

export const PortfolioMeasurementReportV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: UUID,
  policyRef: PortfolioReferenceV1Schema,
  throughPosition: z.number().int().nonnegative(),
  executingPrograms: z.number().int().nonnegative(),
  integrationReadyCandidates: z.number().int().nonnegative(),
  pipelineWip: z.number().int().nonnegative(),
  maxObservedConcurrentPrograms: z.number().int().nonnegative(),
  queuedProgramCount: z.number().int().nonnegative(),
  mergeQueueOldestAgeMs: z.number().int().nonnegative(),
  activeHumanTimeMs: z.number().int().nonnegative(),
  routinePageCount: z.number().int().nonnegative(),
  safetyCriticalPageCount: z.number().int().nonnegative(),
  cost: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("known"), amount: z.string(), currency: z.string() }),
    z.strictObject({ status: z.literal("unavailable"), reason: NonEmptyText.max(500) })
  ]),
  completeness: z.strictObject({
    admissions: z.boolean(),
    integrations: z.boolean(),
    attention: z.boolean(),
    cost: z.boolean()
  }),
  compiledAt: Timestamp
});

export const ContextPacketV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  contextPacketId: UUID,
  programId: UUID,
  milestoneId: UUID,
  generationId: UUID,
  generation: z.number().int().positive(),
  intentPlaybackRef: ImmutableReferenceV1Schema,
  graphRevisionRef: ImmutableReferenceV1Schema,
  milestoneContractRef: ImmutableReferenceV1Schema,
  sourceRevisionRef: ImmutableReferenceV1Schema,
  dependencyOutcomeRefs: z.array(ImmutableReferenceV1Schema).max(32),
  dependencyVerificationRefs: z.array(ImmutableReferenceV1Schema).max(128),
  decisions: z.array(ScopedRecordV1Schema).max(64),
  assumptions: z.array(ScopedRecordV1Schema).max(64),
  risks: z.array(ScopedRecordV1Schema).max(64),
  unresolvedQuestions: z.array(ScopedRecordV1Schema).max(64),
  refs: z.array(ImmutableReferenceV1Schema).max(256),
  allowedWorkSurfaces: z.array(RelativePathSchema).min(1).max(64),
  compiledAt: Timestamp
});

export const OutcomeValidationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  validationId: UUID,
  programId: UUID,
  milestoneId: UUID,
  outcomePacketId: UUID,
  packetDigest: DigestSchema,
  computedDigest: DigestSchema,
  primaryEvidenceDigests: z.array(DigestSchema).min(1).max(256),
  criteriaPassed: z.boolean(),
  recommendation: z.enum(["merge", "reject", "investigate"]),
  candidateRevisionId: UUID.nullable(),
  valid: z.literal(true),
  validatedAt: Timestamp
});

export const RoutedIssueV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  issueId: UUID,
  programId: UUID,
  originalText: NonEmptyText.max(4_000),
  proposedClass: z.enum([
    "clarification",
    "new_idea",
    "contradiction",
    "blocker",
    "authority_boundary"
  ]),
  resultImpact: z.enum(["none", "may_change_accepted_result"]),
  affectedMilestoneIds: z.array(UUID).min(1).max(32),
  refs: z.array(ImmutableReferenceV1Schema).max(64),
  requiredAuthority: z.literal("operator"),
  route: z.enum(["record_only", "pause_affected", "retry_exhausted", "operator_required"]),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("command") }),
    z.strictObject({
      kind: z.literal("driver_event"),
      attemptId: UUID,
      sequence: z.number().int().positive()
    })
  ]),
  status: z.enum(["open", "resolved", "requires_graph_revision"]),
  resolution: z
    .strictObject({
      action: z.enum(["record_only", "resume_unchanged_contract", "requires_graph_revision"]),
      text: NonEmptyText.max(4_000),
      resolvedBy: NonEmptyText.max(200),
      resolvedAt: Timestamp,
      satisfiedByGraphRevisionId: UUID.optional()
    })
    .nullable(),
  raisedAt: Timestamp
});

export const AttentionSpanV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  attentionSpanId: UUID,
  programId: UUID,
  actorId: NonEmptyText.max(200),
  label: NonEmptyText.max(500),
  startedAt: Timestamp,
  stoppedAt: Timestamp.nullable()
});

const OutcomeEvidenceReferenceV1Schema = z.strictObject({
  kind: z.enum(["source_revision", "artifact_manifest", "driver_receipt", "verification"]),
  id: UUID,
  digest: DigestSchema
});

const OutcomeCriterionResultV1Schema = z.strictObject({
  criterionId: Identifier,
  statement: NonEmptyText.max(1_000),
  result: z.enum(["pass", "fail", "unverified"]),
  evidenceRefs: z.array(OutcomeEvidenceReferenceV1Schema).max(32)
});

const OutcomeAttemptV1Schema = z.strictObject({
  attemptId: UUID,
  jobId: UUID,
  ordinal: z.number().int().positive(),
  status: z.enum([
    "allocated",
    "starting",
    "running",
    "verifying",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "approval_required"
  ]),
  terminationReason: z.string().max(1_000).nullable(),
  usage: DriverUsageSchema.nullable()
});

export const OutcomePacketV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  packetVersion: z.literal(1),
  outcomePacketId: UUID,
  programId: UUID,
  milestoneId: UUID,
  runId: UUID,
  baseRevisionId: UUID,
  candidateRevisionId: UUID.nullable(),
  intentDigest: DigestSchema,
  milestoneContractDigest: DigestSchema,
  workflowDigest: DigestSchema,
  criteriaResults: z.array(OutcomeCriterionResultV1Schema).min(1).max(20),
  attemptHistory: z.array(OutcomeAttemptV1Schema).max(100),
  driverReceipts: z.array(OutcomeEvidenceReferenceV1Schema).max(100),
  verificationReceipts: z.array(OutcomeEvidenceReferenceV1Schema).max(100),
  artifactManifests: z.array(OutcomeEvidenceReferenceV1Schema).max(200),
  capabilitiesUsed: z.array(Identifier).max(256),
  terminalReason: NonEmptyText.max(1_000),
  summary: NonEmptyText.max(2_000),
  deviationReasons: z.array(Identifier).max(32),
  recommendation: z.enum(["merge", "reject", "investigate"]),
  humanEvidenceFocus: z.array(NonEmptyText.max(1_000)).max(20),
  generatedAt: Timestamp
});

export const OutcomePacketV2Schema = OutcomePacketV1Schema.omit({
  schemaVersion: true,
  packetVersion: true
}).extend({
  schemaVersion: z.literal(2),
  packetVersion: z.literal(2),
  generationId: UUID,
  generation: z.number().int().positive(),
  graphRevisionId: UUID,
  graphDigest: DigestSchema,
  contextPacketId: UUID,
  contextPacketDigest: DigestSchema,
  dependencyOutcomeRefs: z.array(ImmutableReferenceV1Schema).max(32),
  dependencyValidationRefs: z.array(ImmutableReferenceV1Schema).max(32)
});

export const OutcomePacketSchema = z.union([OutcomePacketV2Schema, OutcomePacketV1Schema]);

export const MilestoneGenerationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  generationId: UUID,
  programId: UUID,
  milestoneId: UUID,
  graphRevisionId: UUID,
  generation: z.number().int().positive(),
  runId: UUID,
  jobId: UUID,
  contextPacketId: UUID,
  baseRevisionId: UUID,
  status: z.enum(["running", "outcome_ready", "paused"]),
  outcomePacketId: UUID.nullable(),
  recommendation: z.enum(["merge", "reject", "investigate"]).nullable(),
  startedAt: Timestamp,
  completedAt: Timestamp.nullable()
});

export const OutcomeDispositionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  outcomePacketId: UUID,
  programId: UUID,
  disposition: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().max(4_000).nullable(),
  actorId: NonEmptyText.max(200),
  recordedAt: Timestamp
});

const MetricUnavailableSchema = z.strictObject({
  status: z.literal("unavailable"),
  reason: NonEmptyText.max(500)
});

export const MeasurementReportV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: UUID,
  programId: UUID,
  observationWindow: z.strictObject({
    status: z.enum(["open", "complete"]),
    startedAt: Timestamp,
    throughAt: Timestamp,
    throughPosition: z.number().int().nonnegative()
  }),
  activeHumanTime: z.union([
    z.strictObject({
      status: z.literal("available"),
      milliseconds: z.number().int().nonnegative(),
      closedSpanCount: z.number().int().positive()
    }),
    MetricUnavailableSchema
  ]),
  latency: z.strictObject({
    status: z.enum(["partial", "complete"]),
    programMilliseconds: z.number().int().nonnegative(),
    generationMilliseconds: z.array(
      z.strictObject({ generationId: UUID, milliseconds: z.number().int().nonnegative() })
    )
  }),
  resources: z.union([
    z.strictObject({
      status: z.literal("available"),
      cpuMillis: z.number().int().nonnegative(),
      memoryPeakBytes: z.number().int().nonnegative(),
      receiptCount: z.number().int().positive()
    }),
    MetricUnavailableSchema
  ]),
  monetaryCost: z.union([
    z.strictObject({
      status: z.literal("available"),
      amount: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
      currency: z.string().regex(/^[A-Z]{3}$/),
      pricingSources: z.array(NonEmptyText.max(500)).min(1),
      pricingVersions: z.array(NonEmptyText.max(200)).min(1)
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: NonEmptyText.max(500),
      knownLineItems: z.array(
        z.strictObject({
          driverReceiptId: UUID,
          amount: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
          currency: z.string().regex(/^[A-Z]{3}$/),
          pricingSource: NonEmptyText.max(500),
          pricingVersion: NonEmptyText.max(200)
        })
      ),
      reasons: z.array(NonEmptyText.max(500)).min(1)
    })
  ]),
  clarificationCount: z.number().int().nonnegative(),
  reworkCount: z.number().int().nonnegative(),
  quality: z.strictObject({
    passedCriteria: z.number().int().nonnegative(),
    totalCriteria: z.number().int().nonnegative(),
    acceptedOutcomes: z.number().int().nonnegative(),
    rejectedOutcomes: z.number().int().nonnegative(),
    undisposedOutcomes: z.number().int().nonnegative()
  }),
  completeness: z.strictObject({
    attention: z.boolean(),
    resources: z.boolean(),
    cost: z.boolean(),
    quality: z.boolean(),
    window: z.boolean()
  }),
  compiledAt: Timestamp
});

export const JobPolicySchema = z
  .strictObject({
    maxAttempts: z.number().int().min(1).max(10).default(3),
    attemptTimeoutMs: z.number().int().min(1_000).max(86_400_000).default(300_000),
    retryDelaysMs: z.array(z.number().int().min(0).max(86_400_000)).max(9).default([1_000, 5_000])
  })
  .superRefine((policy, context) => {
    if (policy.retryDelaysMs.length !== policy.maxAttempts - 1) {
      context.addIssue({
        code: "custom",
        message: "retryDelaysMs must contain one delay between each attempt",
        path: ["retryDelaysMs"]
      });
    }
  });

export const MilestoneStartV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: UUID,
  runId: UUID,
  jobId: UUID,
  sourceRevisionId: UUID,
  policy: JobPolicySchema
});

export const ProgramStartV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  programId: UUID,
  graphRevisionId: UUID,
  graphDigest: DigestSchema,
  policy: JobPolicySchema
});

export const ProgramAdvanceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  programId: UUID,
  graphRevisionId: UUID,
  graphDigest: DigestSchema,
  expectedMilestoneId: UUID.nullable(),
  expectedGeneration: z.number().int().positive().nullable(),
  dependencyValidations: z.array(OutcomeValidationV1Schema).max(32),
  policy: JobPolicySchema
});

export const AttentionReferenceV1Schema = z.strictObject({
  kind: z.enum([
    "intent_playback",
    "program_graph",
    "milestone_contract",
    "context_packet",
    "source_revision",
    "outcome_packet",
    "outcome_validation",
    "artifact_manifest",
    "driver_receipt",
    "verification",
    "routed_issue",
    "approval_request",
    "outcome_disposition",
    "operator_decision_request",
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
    "attention_digest_artifact"
  ]),
  id: UUID,
  digest: DigestSchema
});

export const AttentionSourceReferenceV1Schema = z.strictObject({
  kind: z.enum(["routed_issue", "approval_request", "outcome_packet", "operator_decision_request"]),
  id: UUID,
  digest: DigestSchema
});

export const AttentionRiskClassSchema = z.enum(["low", "normal", "high", "reserved"]);
export const AttentionSafetyClassSchema = z.enum(["routine", "safety_critical"]);
export const DecisionReversibilitySchema = z.enum(["reversible", "costly", "one_way"]);
export const AttentionUrgencySchema = z.enum(["p0", "p1", "p2", "p3"]);
export const DecisionActionKindSchema = z.enum([
  "approve",
  "retry",
  "cancel",
  "park",
  "reprioritize"
]);

const ApproveDecisionTargetV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("issue_resolution"),
    issueId: UUID,
    issueDigest: DigestSchema,
    action: z.enum(["record_only", "resume_unchanged_contract", "requires_graph_revision"]),
    text: NonEmptyText.max(4_000)
  }),
  z.strictObject({
    kind: z.literal("outcome_disposition"),
    outcomePacketId: UUID,
    outcomePacketDigest: DigestSchema,
    disposition: z.enum(["accepted", "rejected"]),
    reason: z.string().trim().max(4_000).nullable()
  }),
  z.strictObject({
    kind: z.literal("program_resume"),
    programId: UUID,
    expectedProgramVersion: z.number().int().positive(),
    expectedGraphDigest: DigestSchema
  }),
  z.strictObject({
    kind: z.literal("record_only"),
    targetRef: AttentionReferenceV1Schema,
    text: NonEmptyText.max(4_000)
  })
]);

const RetryDecisionTargetV1Schema = z.strictObject({
  kind: z.literal("milestone_retry"),
  programId: UUID,
  milestoneId: UUID,
  expectedMilestoneVersion: z.number().int().positive(),
  expectedGeneration: z.number().int().nonnegative(),
  graphRevisionId: UUID,
  graphDigest: DigestSchema,
  contractDigest: DigestSchema,
  baseRevisionId: UUID,
  dependencyValidations: z.array(OutcomeValidationV1Schema).max(32),
  policy: JobPolicySchema
});

const CancelDecisionTargetV1Schema = z.strictObject({
  kind: z.literal("run_cancel"),
  runId: UUID,
  expectedRunVersion: z.number().int().positive(),
  reason: NonEmptyText.max(1_000)
});

const ParkDecisionTargetV1Schema = z.strictObject({
  kind: z.literal("program_park"),
  programId: UUID,
  expectedProgramVersion: z.number().int().positive(),
  expectedGraphDigest: DigestSchema,
  reason: NonEmptyText.max(1_000)
});

const ReprioritizeDecisionTargetV1Schema = z.strictObject({
  kind: z.literal("program_attention_priority"),
  programId: UUID,
  expectedProgramVersion: z.number().int().positive(),
  priority: AttentionUrgencySchema
});

export const DecisionTypedActionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("approve"), target: ApproveDecisionTargetV1Schema }),
  z.strictObject({ kind: z.literal("retry"), target: RetryDecisionTargetV1Schema }),
  z.strictObject({ kind: z.literal("cancel"), target: CancelDecisionTargetV1Schema }),
  z.strictObject({ kind: z.literal("park"), target: ParkDecisionTargetV1Schema }),
  z.strictObject({
    kind: z.literal("reprioritize"),
    target: ReprioritizeDecisionTargetV1Schema
  })
]);

export const DecisionOptionV1Schema = z.strictObject({
  optionId: UUID,
  label: NonEmptyText.max(300),
  consequences: z.array(NonEmptyText.max(1_000)).min(1).max(16),
  reversalCost: NonEmptyText.max(1_000),
  action: DecisionTypedActionV1Schema
});

export const DecisionTypedActionV2Schema = z.strictObject({
  kind: z.literal("integrate"),
  target: z.strictObject({
    kind: z.literal("managed_integration_promotion"),
    workId: UUID,
    candidateId: UUID,
    programId: UUID,
    graphRef: PortfolioReferenceV1Schema,
    policyRef: PortfolioReferenceV1Schema,
    targetRef: PortfolioReferenceV1Schema,
    expectedHeadRef: ImmutableReferenceV1Schema,
    originalCandidateRef: ImmutableReferenceV1Schema,
    rebasedCandidateRef: ImmutableReferenceV1Schema,
    finalOutcomeRef: ImmutableReferenceV1Schema,
    diffManifestRef: PortfolioReferenceV1Schema,
    integrationVerificationRef: PortfolioReferenceV1Schema,
    targetPreconditionDigest: DigestSchema
  })
});

export const DecisionOptionV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  optionId: UUID,
  label: NonEmptyText.max(300),
  consequences: z.array(NonEmptyText.max(1_000)).min(1).max(16),
  reversalCost: NonEmptyText.max(1_000),
  action: DecisionTypedActionV2Schema
});

export const AttentionSourceReferenceV2Schema = z.strictObject({
  kind: z.literal("integration_candidate"),
  id: UUID,
  digest: DigestSchema
});

export const OperatorDecisionRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: UUID,
  programId: UUID,
  milestoneId: UUID.nullable(),
  originalQuestion: NonEmptyText.max(4_000),
  prompt: NonEmptyText.max(2_000),
  context: NonEmptyText.max(8_000),
  requiredAuthority: z.literal("operator"),
  riskClass: AttentionRiskClassSchema,
  safetyClass: AttentionSafetyClassSchema,
  reversibility: DecisionReversibilitySchema,
  options: z.array(DecisionOptionV1Schema).min(1).max(8),
  refs: z.array(AttentionReferenceV1Schema).max(256),
  deadlineAt: Timestamp.nullable(),
  requestedBy: NonEmptyText.max(200),
  requestedAt: Timestamp
});

export const OperatorDecisionRequestV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  requestId: UUID,
  programId: UUID,
  milestoneId: z.null(),
  originalQuestion: NonEmptyText.max(4_000),
  prompt: NonEmptyText.max(2_000),
  context: NonEmptyText.max(8_000),
  requiredAuthority: z.literal("operator"),
  riskClass: z.literal("reserved"),
  safetyClass: z.literal("safety_critical"),
  reversibility: z.literal("one_way"),
  options: z.array(DecisionOptionV2Schema).length(1),
  refs: z.array(PortfolioReferenceV1Schema).min(6).max(256),
  deadlineAt: Timestamp.nullable(),
  requestedBy: NonEmptyText.max(200),
  requestedAt: Timestamp
});

export const DecisionEvidenceBundleV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceBundleId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  programId: UUID,
  sourceRef: AttentionSourceReferenceV1Schema,
  refs: z.array(AttentionReferenceV1Schema).max(512),
  orientation: NonEmptyText.max(8_000),
  compiledAt: Timestamp
});

export const DecisionEvidenceBundleV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  evidenceBundleId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  programId: UUID,
  sourceRef: AttentionSourceReferenceV2Schema,
  refs: z.array(PortfolioReferenceV1Schema).min(6).max(512),
  orientation: NonEmptyText.max(8_000),
  compiledAt: Timestamp
});

const AttentionPolicyConditionV1Schema = z.strictObject({
  sourceKinds: z
    .array(
      z.enum(["routed_issue", "approval_request", "outcome_packet", "operator_decision_request"])
    )
    .max(4),
  riskClasses: z.array(AttentionRiskClassSchema).max(4),
  safetyClasses: z.array(AttentionSafetyClassSchema).max(2),
  reversibilities: z.array(DecisionReversibilitySchema).max(3),
  actionKinds: z.array(DecisionActionKindSchema).max(5),
  deadlineWithinMs: z.number().int().positive().max(31_536_000_000).nullable()
});

export const AttentionPolicyRuleV1Schema = z.strictObject({
  ruleId: Identifier,
  when: AttentionPolicyConditionV1Schema,
  route: z.enum(["queue", "page"]),
  urgency: AttentionUrgencySchema,
  requireAcknowledgement: z.boolean()
});

export const AttentionPolicyV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  policyId: UUID,
  policyRevisionId: UUID,
  revision: z.number().int().positive(),
  priorPolicyRef: AttentionReferenceV1Schema.nullable(),
  rules: z.array(AttentionPolicyRuleV1Schema).max(64),
  defaultRoute: z.enum(["queue", "page"]),
  defaultUrgency: AttentionUrgencySchema,
  routinePageBudget: z.strictObject({
    maxPages: z.number().int().nonnegative().max(1_000),
    windowMs: z.number().int().min(60_000).max(31_536_000_000)
  }),
  deduplicationWindowMs: z.number().int().min(60_000).max(31_536_000_000),
  oneWayDoorActionKinds: z.array(DecisionActionKindSchema).max(5),
  defaultOnTimeout: z.null(),
  approvedBy: NonEmptyText.max(200),
  approvedAt: Timestamp
});

export const AttentionPolicyBindingV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("kernel_default"),
    version: z.literal("kernel-default-v1"),
    digest: DigestSchema
  }),
  z.strictObject({ kind: z.literal("attention_policy"), id: UUID, digest: DigestSchema })
]);

export const DecisionRoutingResultV1Schema = z.strictObject({
  route: z.enum(["queue", "page"]),
  urgency: AttentionUrgencySchema,
  matchedRuleId: Identifier.nullable(),
  requireAcknowledgement: z.boolean(),
  reason: NonEmptyText.max(1_000),
  routineBudget: z.strictObject({
    applied: z.boolean(),
    allowed: z.boolean(),
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    windowMs: z.number().int().nonnegative()
  })
});

export const DecisionPacketRevisionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  packetRevisionId: UUID,
  packetId: UUID,
  programId: UUID,
  milestoneId: UUID.nullable(),
  revision: z.number().int().positive(),
  priorRevisionRef: AttentionReferenceV1Schema.nullable(),
  source: AttentionSourceReferenceV1Schema,
  originalQuestion: NonEmptyText.max(4_000),
  prompt: NonEmptyText.max(2_000),
  context: NonEmptyText.max(8_000),
  requiredAuthority: z.literal("operator"),
  riskClass: AttentionRiskClassSchema,
  safetyClass: AttentionSafetyClassSchema,
  reversibility: DecisionReversibilitySchema,
  options: z.array(DecisionOptionV1Schema).min(1).max(8),
  evidenceBundleRef: AttentionReferenceV1Schema,
  policyBinding: AttentionPolicyBindingV1Schema,
  precedentRefs: z.array(AttentionReferenceV1Schema).max(64),
  deadlineAt: Timestamp.nullable(),
  defaultOnTimeout: z.null(),
  deduplicationKey: DigestSchema,
  routing: DecisionRoutingResultV1Schema,
  createdAt: Timestamp
});

export const DecisionPacketRevisionV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  packetRevisionId: UUID,
  packetId: UUID,
  programId: UUID,
  milestoneId: z.null(),
  revision: z.literal(1),
  priorRevisionRef: z.null(),
  source: AttentionSourceReferenceV2Schema,
  originalQuestion: NonEmptyText.max(4_000),
  prompt: NonEmptyText.max(2_000),
  context: NonEmptyText.max(8_000),
  requiredAuthority: z.literal("operator"),
  riskClass: z.literal("reserved"),
  safetyClass: z.literal("safety_critical"),
  reversibility: z.literal("one_way"),
  options: z.array(DecisionOptionV2Schema).length(1),
  evidenceBundleRef: PortfolioReferenceV1Schema,
  policyBinding: AttentionPolicyBindingV1Schema,
  precedentRefs: z.array(PortfolioReferenceV1Schema).max(64),
  deadlineAt: Timestamp.nullable(),
  defaultOnTimeout: z.null(),
  deduplicationKey: DigestSchema,
  routing: DecisionRoutingResultV1Schema,
  createdAt: Timestamp
});

export const DecisionAcknowledgementV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  acknowledgementId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  packetRevisionDigest: DigestSchema,
  actorId: NonEmptyText.max(200),
  acknowledgedAt: Timestamp
});

export const DecisionResolutionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  resolutionId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  packetRevisionDigest: DigestSchema,
  optionId: UUID,
  actionKind: DecisionActionKindSchema,
  actorId: NonEmptyText.max(200),
  resolvedAt: Timestamp
});

export const DecisionResolutionV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  resolutionId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  packetRevisionDigest: DigestSchema,
  optionId: UUID,
  actionKind: z.literal("integrate"),
  actorId: NonEmptyText.max(200),
  resolvedAt: Timestamp
});

export const DecisionActionResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  actionResultId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  optionId: UUID,
  actionKind: DecisionActionKindSchema,
  targetPreconditionDigest: DigestSchema,
  appliedEventTypes: z.array(NonEmptyText.max(200)).max(256),
  actorId: NonEmptyText.max(200),
  appliedAt: Timestamp
});

export const DecisionActionResultV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  actionResultId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  optionId: UUID,
  actionKind: z.literal("integrate"),
  targetPreconditionDigest: DigestSchema,
  appliedEventTypes: z.tuple([
    z.literal("OutcomeDispositionRecorded"),
    z.literal("IntegrationPromotionAuthorized")
  ]),
  actorId: NonEmptyText.max(200),
  appliedAt: Timestamp
});

export const DecisionPrecedentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  precedentId: UUID,
  programId: UUID,
  packetRevisionRef: AttentionReferenceV1Schema,
  selectedOptionId: UUID,
  actionResultRef: AttentionReferenceV1Schema,
  evidenceBundleRef: AttentionReferenceV1Schema,
  policyBinding: AttentionPolicyBindingV1Schema,
  authority: z.literal("operator"),
  actorId: NonEmptyText.max(200),
  recordedAt: Timestamp
});

export const DecisionPrecedentV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  precedentId: UUID,
  programId: UUID,
  packetRevisionRef: PortfolioReferenceV1Schema,
  selectedOptionId: UUID,
  actionResultRef: PortfolioReferenceV1Schema,
  evidenceBundleRef: PortfolioReferenceV1Schema,
  policyBinding: AttentionPolicyBindingV1Schema,
  authority: z.literal("operator"),
  actorId: NonEmptyText.max(200),
  recordedAt: Timestamp
});

export const AttentionBudgetIncidentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  incidentId: UUID,
  programId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  policyBinding: AttentionPolicyBindingV1Schema,
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  windowMs: z.number().int().positive(),
  occurredAt: Timestamp
});

export const AttentionDeliveryV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  deliveryId: UUID,
  programId: UUID,
  packetId: UUID,
  packetRevisionId: UUID,
  packetRevisionDigest: DigestSchema,
  policyBinding: AttentionPolicyBindingV1Schema,
  matchedRuleId: Identifier.nullable(),
  channel: z.literal("page"),
  deepLink: z.string().min(1).max(2_000),
  idempotencyKey: NonEmptyText.max(500),
  status: z.enum(["pending", "leased", "delivered", "obsolete", "permanent_failure"]),
  deliveryAttempts: z.number().int().nonnegative(),
  retryDelaysMs: z.array(z.number().int().nonnegative()).max(16),
  availableAt: Timestamp,
  leaseOwnerId: UUID.nullable(),
  leaseFencingToken: z.number().int().nonnegative(),
  leaseAcquiredAt: Timestamp.nullable(),
  leaseExpiresAt: Timestamp.nullable(),
  receipt: z
    .strictObject({
      provider: NonEmptyText.max(200),
      externalId: NonEmptyText.max(500),
      acceptedAt: Timestamp,
      metadata: z.record(z.string().max(100), z.string().max(1_000))
    })
    .nullable(),
  createdAt: Timestamp,
  deliveredAt: Timestamp.nullable(),
  lastError: z.string().max(1_000).nullable()
});

const AvailableDurationMetricSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), milliseconds: z.number().int().nonnegative() }),
  z.strictObject({ status: z.literal("open") }),
  MetricUnavailableSchema
]);

export const AttentionMeasurementReportV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: UUID,
  programId: UUID,
  observationWindow: z.strictObject({
    status: z.enum(["open", "complete"]),
    startedAt: Timestamp,
    throughAt: Timestamp,
    throughPosition: z.number().int().nonnegative()
  }),
  packets: z.array(
    z.strictObject({
      packetId: UUID,
      queueWait: AvailableDurationMetricSchema,
      acknowledgementLatency: AvailableDurationMetricSchema,
      resolutionLatency: AvailableDurationMetricSchema
    })
  ),
  pageCount: z.number().int().nonnegative(),
  routineBudgetIncidentCount: z.number().int().nonnegative(),
  staleActionConflictCount: z.number().int().nonnegative(),
  completeness: z.strictObject({
    acknowledgements: z.boolean(),
    resolutions: z.boolean(),
    window: z.boolean()
  }),
  compiledAt: Timestamp
});

export const AttentionDigestArtifactV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  artifactId: UUID,
  programId: UUID,
  throughPosition: z.number().int().nonnegative(),
  items: z.array(
    z.strictObject({
      packetId: UUID,
      packetRevisionId: UUID,
      packetRevisionDigest: DigestSchema,
      route: z.enum(["queue", "page"]),
      urgency: AttentionUrgencySchema,
      prompt: NonEmptyText.max(2_000),
      deepLink: z.string().min(1).max(2_000)
    })
  ),
  compiledAt: Timestamp
});

export const AttentionPolicyInputV1Schema = AttentionPolicyV1Schema.omit({
  approvedBy: true,
  approvedAt: true
});

export const OperatorDecisionRequestInputV1Schema = OperatorDecisionRequestV1Schema.omit({
  requiredAuthority: true,
  requestedBy: true,
  requestedAt: true
});

export const RunScheduleJobSchema = z.strictObject({
  jobId: UUID,
  stepId: Identifier,
  sourceRevisionId: UUID.optional(),
  policy: JobPolicySchema.default({
    maxAttempts: 3,
    attemptTimeoutMs: 300_000,
    retryDelaysMs: [1_000, 5_000]
  })
});

const CommandBase = {
  idempotencyKey: NonEmptyText.max(200),
  actor: ActorSchema,
  correlationId: UUID.optional()
};

const DecisionCommandBindingShape = {
  schemaVersion: z.literal(1),
  packetId: UUID,
  packetRevisionId: UUID,
  packetRevisionDigest: DigestSchema,
  optionId: UUID,
  targetPreconditionDigest: DigestSchema
};

export const CommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...CommandBase,
    type: z.literal("program.create"),
    payload: z.strictObject({ programId: UUID, name: NonEmptyText.max(160) })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("program.kickoff"),
    payload: ProgramKickoffV1Schema
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("interview.capture"),
    payload: InterviewCaptureV1Schema
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("program-graph.approve"),
    payload: z.union([ProgramGraphRevisionV2Schema, ProgramGraphRevisionV1Schema])
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("program.start"),
    payload: z.union([ProgramStartV2Schema, ProgramStartV1Schema])
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("program.advance"),
    payload: ProgramAdvanceV1Schema
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention-policy.approve"),
    payload: z.strictObject({ policy: AttentionPolicyInputV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("portfolio-policy.approve"),
    payload: z.strictObject({ policy: PortfolioPolicyInputV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-subject.approve"),
    payload: z.strictObject({ subject: AdvisorSubjectInputV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-case.record"),
    payload: z.strictObject({ case: AdvisorCaseInputRecordV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-corpus.approve"),
    payload: z.strictObject({ corpus: AdvisorCorpusInputV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-contamination.record"),
    payload: z.strictObject({
      contamination: AdvisorContaminationRecordV1Schema.omit({
        recordedBy: true,
        recordedAt: true
      })
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-invocation.queue"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      invocationId: UUID,
      subjectId: UUID,
      purpose: z.enum(["calibration", "holdout", "shadow", "promoted"]),
      caseId: UUID.nullable(),
      packetId: UUID.nullable(),
      packetRevisionId: UUID.nullable(),
      packetRevisionDigest: DigestSchema.nullable()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-invocation.lease.acquire"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      invocationId: UUID,
      ownerId: UUID,
      leaseDurationMs: z.number().int().min(1_000).max(300_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-invocation.complete"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      invocationId: UUID,
      recommendationId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      output: AdvisorRecommendationOutputV1Schema,
      driverReceipt: AdvisorDriverReceiptV1Schema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-invocation.fail"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      invocationId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      error: NonEmptyText.max(1_000),
      permanent: z.boolean()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-invocation.cancel"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      invocationId: UUID,
      reason: NonEmptyText.max(1_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-evaluation.compile"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      reportId: UUID,
      subjectId: UUID,
      policyRevisionId: UUID,
      corpusRevisionId: UUID,
      recentCaseIds: z.array(UUID).max(10_000),
      expectedThroughPosition: z.number().int().nonnegative()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision-policy-proposal.compile"),
    payload: z.strictObject({ proposal: DecisionPolicyProposalV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision-policy-proposal.close"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      proposalId: UUID,
      outcome: z.enum(["dismissed", "superseded"]),
      reason: NonEmptyText.max(2_000),
      replacementProposalId: UUID.nullable()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision-policy.approve"),
    payload: z.strictObject({ policy: DecisionPolicyInputV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-promotion.compile"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      packetId: UUID,
      packetRevisionId: UUID,
      evidenceBundleId: UUID,
      policyRevisionId: UUID,
      evaluationReportId: UUID,
      expectedThroughPosition: z.number().int().nonnegative()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.promote-advisor-policy"),
    payload: z.strictObject({
      schemaVersion: z.literal(3),
      promotionId: UUID,
      packetId: UUID,
      packetRevisionId: UUID,
      packetRevisionDigest: DigestSchema,
      optionId: UUID,
      targetPreconditionDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor.resolve"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      resolutionId: UUID,
      recommendationId: UUID,
      policyRevisionId: UUID,
      packetId: UUID,
      packetRevisionId: UUID,
      packetRevisionDigest: DigestSchema,
      optionId: UUID,
      targetPreconditionDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("advisor-audit.record"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      auditId: UUID,
      finding: z.enum(["agree", "benign_disagreement", "serious_disagreement", "harm"]),
      evidenceRefs: z.array(AdvisorReferenceV1Schema).max(128),
      notes: z.string().max(4_000).nullable()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision-policy.suspend"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      policyRevisionId: UUID,
      reason: NonEmptyText.max(2_000),
      sourceRef: AdvisorReferenceV1Schema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("integration-target.approve"),
    payload: z.strictObject({ target: IntegrationTargetInputV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("portfolio.coordinate"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      expectedThroughPosition: z.number().int().nonnegative(),
      leaseDurationMs: z.number().int().min(1_000).max(300_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("portfolio-lease.renew"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      leaseId: UUID,
      ownerAdmissionId: UUID,
      fencingToken: z.number().int().positive(),
      leaseDurationMs: z.number().int().min(1_000).max(300_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("portfolio-admission.release"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      admissionId: UUID,
      generationId: UUID,
      fencingToken: z.number().int().positive(),
      reason: NonEmptyText.max(1_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("portfolio-admission.fence"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      admissionId: UUID,
      generationId: UUID,
      fencingToken: z.number().int().positive(),
      reason: NonEmptyText.max(1_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("candidate-diff.record"),
    payload: z.strictObject({
      manifest: CandidateDiffManifestV1Schema,
      manifestDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("integration-candidate.queue"),
    payload: z.strictObject({
      candidate: IntegrationCandidateV1Schema,
      candidateDigest: DigestSchema,
      workId: UUID
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("integration-work.lease.acquire"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      workId: UUID,
      ownerId: UUID,
      leaseDurationMs: z.number().int().min(1_000).max(3_660_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("integration-work.prepare"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      workId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      expectedHeadRef: ImmutableReferenceV1Schema,
      rebasedCandidateRef: ImmutableReferenceV1Schema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("integration-work.conflict"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      workId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      conflict: IntegrationConflictV1Schema,
      conflictDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("integration-work.verify"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      workId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      verification: IntegrationVerificationV1Schema,
      verificationDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("integration-decision.compile"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      candidateId: UUID,
      expectedThroughPosition: z.number().int().nonnegative()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.integrate"),
    payload: z.strictObject({
      schemaVersion: z.literal(2),
      packetId: UUID,
      packetRevisionId: UUID,
      packetRevisionDigest: DigestSchema,
      optionId: UUID,
      targetPreconditionDigest: DigestSchema,
      candidateId: UUID,
      expectedHeadRef: ImmutableReferenceV1Schema,
      rebasedCandidateRef: ImmutableReferenceV1Schema,
      finalOutcomeRef: ImmutableReferenceV1Schema,
      diffManifestRef: PortfolioReferenceV1Schema,
      integrationVerificationRef: PortfolioReferenceV1Schema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("integration.promote.record"),
    payload: z.strictObject({
      receipt: PromotionReceiptV1Schema,
      receiptDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("portfolio-slo.record"),
    payload: z.strictObject({
      incident: PortfolioSloIncidentV1Schema,
      incidentDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("portfolio-measurement-report.compile"),
    payload: z.strictObject({
      report: PortfolioMeasurementReportV1Schema,
      reportDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.request"),
    payload: z.strictObject({ request: OperatorDecisionRequestInputV1Schema })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention.compile"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      source: AttentionSourceReferenceV1Schema,
      expectedThroughPosition: z.number().int().nonnegative()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.acknowledge"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      acknowledgementId: UUID,
      packetId: UUID,
      packetRevisionId: UUID,
      packetRevisionDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.approve"),
    payload: z.strictObject(DecisionCommandBindingShape)
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.retry"),
    payload: z.strictObject(DecisionCommandBindingShape)
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.cancel"),
    payload: z.strictObject(DecisionCommandBindingShape)
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.park"),
    payload: z.strictObject(DecisionCommandBindingShape)
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.reprioritize"),
    payload: z.strictObject(DecisionCommandBindingShape)
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("decision.expire"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      packetId: UUID,
      packetRevisionId: UUID,
      packetRevisionDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention-measurement-report.compile"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      reportId: UUID,
      programId: UUID,
      expectedThroughPosition: z.number().int().nonnegative()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention-digest.compile"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      artifactId: UUID,
      programId: UUID,
      expectedThroughPosition: z.number().int().nonnegative()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention-delivery.lease.acquire"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      deliveryId: UUID,
      ownerId: UUID,
      leaseDurationMs: z.number().int().min(1_000).max(3_660_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention-delivery.succeed"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      deliveryId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      receipt: AttentionDeliveryV1Schema.shape.receipt.unwrap()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention-delivery.fail"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      deliveryId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      error: NonEmptyText.max(1_000),
      permanent: z.boolean()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("issue.raise"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      issueId: UUID,
      programId: UUID,
      originalText: NonEmptyText.max(4_000),
      proposedClass: z.enum([
        "clarification",
        "new_idea",
        "contradiction",
        "blocker",
        "authority_boundary"
      ]),
      resultImpact: z.enum(["none", "may_change_accepted_result"]),
      affectedMilestoneIds: z.array(UUID).min(1).max(32),
      refs: z.array(ImmutableReferenceV1Schema).max(64),
      source: z
        .discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("command") }),
          z.strictObject({
            kind: z.literal("driver_event"),
            attemptId: UUID,
            sequence: z.number().int().positive()
          })
        ])
        .optional()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("issue.resolve"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      issueId: UUID,
      action: z.enum(["record_only", "resume_unchanged_contract", "requires_graph_revision"]),
      text: NonEmptyText.max(4_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention.start"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      attentionSpanId: UUID,
      programId: UUID,
      label: NonEmptyText.max(500)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attention.stop"),
    payload: z.strictObject({ schemaVersion: z.literal(1), attentionSpanId: UUID })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("outcome-packet.disposition"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      outcomePacketId: UUID,
      disposition: z.enum(["accepted", "rejected"]),
      reason: z.string().trim().max(4_000).nullable()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("measurement-report.compile"),
    payload: z.strictObject({
      schemaVersion: z.literal(1),
      reportId: UUID,
      programId: UUID,
      expectedThroughPosition: z.number().int().nonnegative()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("program.approve"),
    payload: ProgramApprovalBundleV1Schema
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("milestone.start"),
    payload: MilestoneStartV1Schema
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("source-revision.register"),
    payload: z.strictObject({
      revisionId: UUID,
      repositoryId: UUID,
      objectFormat: z.enum(["sha1", "sha256"]),
      commitOid: GitOidSchema,
      treeOid: GitOidSchema,
      storageRef: NonEmptyText.max(500),
      revisionDigest: DigestSchema
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("workflow.register"),
    payload: z.union([WorkflowDefinitionV3Schema, WorkflowDefinitionV2Schema])
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("run.create"),
    payload: z.strictObject({
      runId: UUID,
      programId: UUID,
      workflowId: UUID,
      workflowVersion: z.number().int().positive()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("run.schedule"),
    payload: z.strictObject({ runId: UUID, jobs: z.array(RunScheduleJobSchema).min(1).max(256) })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("run.cancel"),
    payload: z.strictObject({ runId: UUID, reason: NonEmptyText.max(1000) })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attempt.allocate"),
    payload: z.strictObject({ attemptId: UUID, runId: UUID })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attempt.cancel"),
    payload: z.strictObject({ attemptId: UUID, reason: NonEmptyText.max(1000) })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("job.lease.acquire"),
    payload: z.strictObject({
      jobId: UUID,
      ownerId: UUID,
      leaseDurationMs: z.number().int().min(1_000).max(3_660_000),
      attemptId: UUID,
      startOutboxId: UUID
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("job.lease.renew"),
    payload: z.strictObject({
      jobId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      leaseDurationMs: z.number().int().min(1_000).max(3_660_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("job.lease.release"),
    payload: z.strictObject({
      jobId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attempt.observe"),
    payload: z.strictObject({
      jobId: UUID,
      attemptId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      outcome: z.enum(["succeeded", "failed"]),
      detail: z.string().max(1000).optional(),
      verificationId: UUID.optional(),
      verificationOutboxId: UUID.optional()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attempt.driver-events.observe"),
    payload: z.strictObject({
      jobId: UUID,
      attemptId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      afterSequence: z.number().int().nonnegative(),
      events: z.array(DriverProtocolEventSchema).min(1).max(4096)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("driver.receipt.record"),
    payload: z.strictObject({
      driverReceiptId: UUID,
      artifactManifestId: UUID,
      verificationId: UUID.optional(),
      verificationOutboxId: UUID.optional(),
      jobId: UUID,
      attemptId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      receipt: DriverReceiptSchema,
      candidateRevision: z
        .strictObject({
          revisionId: UUID,
          repositoryId: UUID,
          objectFormat: z.enum(["sha1", "sha256"]),
          commitOid: GitOidSchema,
          treeOid: GitOidSchema,
          storageRef: NonEmptyText.max(500),
          revisionDigest: DigestSchema
        })
        .optional(),
      entries: z.array(DriverArtifactSchema).max(256)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("driver.terminal-receipt.record"),
    payload: z.strictObject({
      driverReceiptId: UUID,
      artifactManifestId: UUID,
      outboxId: UUID,
      jobId: UUID,
      attemptId: UUID,
      ownerId: UUID,
      outboxFencingToken: z.number().int().positive(),
      afterSequence: z.number().int().nonnegative(),
      events: z.array(DriverProtocolEventSchema).max(4096),
      receipt: DriverReceiptSchema,
      entries: z.array(DriverArtifactSchema).max(256)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("attempt.timeout"),
    payload: z.strictObject({
      jobId: UUID,
      attemptId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive()
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("outbox.lease.acquire"),
    payload: z.strictObject({
      outboxId: UUID,
      ownerId: UUID,
      leaseDurationMs: z.number().int().min(1_000).max(3_660_000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("outbox.delivery.succeed"),
    payload: z.strictObject({
      outboxId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      externalEffectId: NonEmptyText.max(500)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("outbox.delivery.fail"),
    payload: z.strictObject({
      outboxId: UUID,
      ownerId: UUID,
      fencingToken: z.number().int().positive(),
      error: NonEmptyText.max(1000)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("verification.complete"),
    payload: z.strictObject({
      verificationId: UUID,
      outboxId: UUID,
      artifactManifestId: UUID,
      jobId: UUID,
      attemptId: UUID,
      ownerId: UUID,
      jobFencingToken: z.number().int().positive(),
      outboxFencingToken: z.number().int().positive(),
      result: z.strictObject({
        outcome: z.enum(["passed", "failed", "invalid"]),
        exitCode: z.number().int().min(0).max(255).nullable(),
        failureReason: z.string().min(1).max(1000).nullable(),
        environmentDigest: DigestSchema,
        sourceStatusBeforeDigest: DigestSchema,
        sourceStatusAfterDigest: DigestSchema,
        contractDigestBefore: DigestSchema,
        contractDigestAfter: DigestSchema,
        artifactManifestDigest: DigestSchema
      }),
      resultDigest: DigestSchema,
      receiptDigest: DigestSchema,
      entries: z
        .array(
          z.strictObject({
            path: RelativePathSchema,
            role: Identifier,
            size: z.number().int().nonnegative().max(268_435_456),
            sha256: DigestSchema
          })
        )
        .max(256)
    })
  }),
  z.strictObject({
    ...CommandBase,
    type: z.literal("verification.execution.fail"),
    payload: z.strictObject({
      verificationId: UUID,
      outboxId: UUID,
      jobId: UUID,
      attemptId: UUID,
      ownerId: UUID,
      jobFencingToken: z.number().int().positive(),
      outboxFencingToken: z.number().int().positive(),
      reason: z.literal("timed_out"),
      detail: NonEmptyText.max(1000)
    })
  })
]);

export type Actor = z.infer<typeof ActorSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowDefinitionV2 = z.infer<typeof WorkflowDefinitionV2Schema>;
export type WorkflowDefinitionV3 = z.infer<typeof WorkflowDefinitionV3Schema>;
export type ProgramIntentV1 = z.infer<typeof ProgramIntentV1Schema>;
export type MilestoneContractV1 = z.infer<typeof MilestoneContractV1Schema>;
export type ProgramApprovalBundleV1 = z.infer<typeof ProgramApprovalBundleV1Schema>;
export type MilestoneStartV1 = z.infer<typeof MilestoneStartV1Schema>;
export type OutcomePacketV1 = z.infer<typeof OutcomePacketV1Schema>;
export type OutcomePacketV2 = z.infer<typeof OutcomePacketV2Schema>;
export type GenericCommandContractV1 = z.infer<typeof GenericCommandContractV1Schema>;
export type GenericCommandContractV2 = z.infer<typeof GenericCommandContractV2Schema>;
export type CapabilityManifestV1 = z.infer<typeof CapabilityManifestV1Schema>;
export type CapabilityManifestV2 = z.infer<typeof CapabilityManifestV2Schema>;
export type IntentPlaybackV1 = z.infer<typeof IntentPlaybackV1Schema>;
export type ProgramGraphRevisionV1 = z.infer<typeof ProgramGraphRevisionV1Schema>;
export type ProgramGraphRevisionV2 = z.infer<typeof ProgramGraphRevisionV2Schema>;
export type PortfolioReferenceV1 = z.infer<typeof PortfolioReferenceV1Schema>;
export type PortfolioResourceV1 = z.infer<typeof PortfolioResourceV1Schema>;
export type PortfolioPolicyV1 = z.infer<typeof PortfolioPolicyV1Schema>;
export type IntegrationTargetV1 = z.infer<typeof IntegrationTargetV1Schema>;
export type WorkSurfaceV1 = z.infer<typeof WorkSurfaceV1Schema>;
export type PortfolioAdmissionV1 = z.infer<typeof PortfolioAdmissionV1Schema>;
export type ConcurrencyLeaseV1 = z.infer<typeof ConcurrencyLeaseV1Schema>;
export type CandidateDiffEntryV1 = z.infer<typeof CandidateDiffEntryV1Schema>;
export type CandidateDiffManifestV1 = z.infer<typeof CandidateDiffManifestV1Schema>;
export type IntegrationCandidateV1 = z.infer<typeof IntegrationCandidateV1Schema>;
export type IntegrationWorkV1 = z.infer<typeof IntegrationWorkV1Schema>;
export type IntegrationVerificationV1 = z.infer<typeof IntegrationVerificationV1Schema>;
export type IntegrationConflictV1 = z.infer<typeof IntegrationConflictV1Schema>;
export type PromotionReceiptV1 = z.infer<typeof PromotionReceiptV1Schema>;
export type PortfolioSloIncidentV1 = z.infer<typeof PortfolioSloIncidentV1Schema>;
export type PortfolioMeasurementReportV1 = z.infer<typeof PortfolioMeasurementReportV1Schema>;
export type ContextPacketV1 = z.infer<typeof ContextPacketV1Schema>;
export type MilestoneGenerationV1 = z.infer<typeof MilestoneGenerationV1Schema>;
export type OutcomeValidationV1 = z.infer<typeof OutcomeValidationV1Schema>;
export type RoutedIssueV1 = z.infer<typeof RoutedIssueV1Schema>;
export type AttentionSpanV1 = z.infer<typeof AttentionSpanV1Schema>;
export type MeasurementReportV1 = z.infer<typeof MeasurementReportV1Schema>;
export type AttentionReferenceV1 = z.infer<typeof AttentionReferenceV1Schema>;
export type AttentionSourceReferenceV1 = z.infer<typeof AttentionSourceReferenceV1Schema>;
export type DecisionTypedActionV1 = z.infer<typeof DecisionTypedActionV1Schema>;
export type DecisionOptionV1 = z.infer<typeof DecisionOptionV1Schema>;
export type DecisionTypedActionV2 = z.infer<typeof DecisionTypedActionV2Schema>;
export type DecisionOptionV2 = z.infer<typeof DecisionOptionV2Schema>;
export type OperatorDecisionRequestV1 = z.infer<typeof OperatorDecisionRequestV1Schema>;
export type OperatorDecisionRequestV2 = z.infer<typeof OperatorDecisionRequestV2Schema>;
export type DecisionEvidenceBundleV1 = z.infer<typeof DecisionEvidenceBundleV1Schema>;
export type DecisionEvidenceBundleV2 = z.infer<typeof DecisionEvidenceBundleV2Schema>;
export type AttentionPolicyV1 = z.infer<typeof AttentionPolicyV1Schema>;
export type AttentionPolicyBindingV1 = z.infer<typeof AttentionPolicyBindingV1Schema>;
export type DecisionPacketRevisionV1 = z.infer<typeof DecisionPacketRevisionV1Schema>;
export type DecisionPacketRevisionV2 = z.infer<typeof DecisionPacketRevisionV2Schema>;
export type DecisionAcknowledgementV1 = z.infer<typeof DecisionAcknowledgementV1Schema>;
export type DecisionResolutionV1 = z.infer<typeof DecisionResolutionV1Schema>;
export type DecisionActionResultV1 = z.infer<typeof DecisionActionResultV1Schema>;
export type DecisionPrecedentV1 = z.infer<typeof DecisionPrecedentV1Schema>;
export type DecisionResolutionV2 = z.infer<typeof DecisionResolutionV2Schema>;
export type DecisionActionResultV2 = z.infer<typeof DecisionActionResultV2Schema>;
export type DecisionPrecedentV2 = z.infer<typeof DecisionPrecedentV2Schema>;
export type AttentionBudgetIncidentV1 = z.infer<typeof AttentionBudgetIncidentV1Schema>;
export type AttentionDeliveryV1 = z.infer<typeof AttentionDeliveryV1Schema>;
export type AttentionMeasurementReportV1 = z.infer<typeof AttentionMeasurementReportV1Schema>;
export type AttentionDigestArtifactV1 = z.infer<typeof AttentionDigestArtifactV1Schema>;
export type JobPolicy = z.infer<typeof JobPolicySchema>;
export type VerifierContract = z.infer<typeof VerifierContractSchema>;
export type Command = z.infer<typeof CommandSchema>;

const TerminationReasonSchema = z.enum([
  "completed",
  "driver_error",
  "timed_out",
  "operator_cancelled",
  "run_failed",
  "verification_failed",
  "verification_invalid",
  "approval_required",
  "protocol_invalid",
  "capability_violation"
]);

const OutboxEffectSchema = z.discriminatedUnion("effectType", [
  z.strictObject({
    effectType: z.literal("agent.start"),
    driver: z.enum(["fake", "generic-command"]).default("fake"),
    capability: Identifier,
    attemptId: UUID,
    attemptStartedAt: Timestamp.optional(),
    jobId: UUID,
    runId: UUID,
    baseRevisionId: UUID.optional(),
    executionContract: z
      .union([GenericCommandContractV2Schema, GenericCommandContractV1Schema])
      .optional(),
    executionContractDigest: DigestSchema.optional(),
    capabilityManifest: z
      .union([CapabilityManifestV2Schema, CapabilityManifestV1Schema])
      .optional(),
    capabilityManifestDigest: DigestSchema.optional(),
    contextPacket: ContextPacketV1Schema.optional(),
    contextPacketDigest: DigestSchema.optional()
  }),
  z.strictObject({
    effectType: z.literal("agent.cancel"),
    externalRunId: NonEmptyText.max(500),
    reason: z
      .enum(["operator_cancelled", "timed_out", "approval_required"])
      .default("operator_cancelled"),
    attemptId: UUID,
    jobId: UUID,
    runId: UUID
  }),
  z.strictObject({
    effectType: z.literal("verification.run"),
    verificationId: UUID,
    sourceRevisionId: UUID,
    workflowId: UUID,
    workflowVersion: z.number().int().positive(),
    workflowDigest: DigestSchema,
    verifierContract: VerifierContractSchema,
    verifierContractDigest: DigestSchema,
    attemptId: UUID,
    jobId: UUID,
    runId: UUID
  })
]);

export const EventPayloadSchemas = {
  ProgramCreated: z.strictObject({ programId: UUID, name: NonEmptyText.max(160) }),
  ProgramKickedOff: z.strictObject({
    programId: UUID,
    name: NonEmptyText.max(160),
    initialSourceRevisionId: UUID,
    initialSourceRevisionDigest: DigestSchema
  }),
  ProgramInterviewCaptured: z.strictObject({
    interviewId: UUID,
    programId: UUID,
    transcript: InterviewCaptureV1Schema.shape.transcript,
    transcriptDigest: DigestSchema,
    playback: IntentPlaybackV1Schema,
    playbackDigest: DigestSchema
  }),
  ProgramGraphApproved: z.strictObject({
    graph: z.union([ProgramGraphRevisionV2Schema, ProgramGraphRevisionV1Schema]),
    graphDigest: DigestSchema,
    approvedBy: NonEmptyText.max(200)
  }),
  ProgramGraphSuperseded: z.strictObject({
    graphRevisionId: UUID,
    programId: UUID,
    supersededByGraphRevisionId: UUID
  }),
  ProgramStarted: z.strictObject({
    programId: UUID,
    graphRevisionId: UUID,
    graphDigest: DigestSchema,
    startedBy: NonEmptyText.max(200)
  }),
  ProgramCompleted: z.strictObject({
    programId: UUID,
    graphRevisionId: UUID,
    graphDigest: DigestSchema
  }),
  ProgramExecutionRequested: z.strictObject({
    requestId: UUID,
    programId: UUID,
    graphRevisionId: UUID,
    graphDigest: DigestSchema,
    policy: JobPolicySchema,
    requestedBy: NonEmptyText.max(200)
  }),
  ProgramIntegrationPending: z.strictObject({
    programId: UUID,
    graphRevisionId: UUID,
    graphDigest: DigestSchema,
    candidateId: UUID
  }),
  ProgramParked: z.strictObject({
    programId: UUID,
    reason: NonEmptyText.max(1_000),
    parkedBy: NonEmptyText.max(200)
  }),
  ProgramResumed: z.strictObject({ programId: UUID, resumedBy: NonEmptyText.max(200) }),
  ProgramAttentionPriorityChanged: z.strictObject({
    programId: UUID,
    priority: AttentionUrgencySchema,
    changedBy: NonEmptyText.max(200)
  }),
  ProgramApproved: z.strictObject({
    programId: UUID,
    intent: ProgramIntentV1Schema,
    intentDigest: DigestSchema,
    approvedBy: NonEmptyText.max(200)
  }),
  MilestoneApproved: z.strictObject({
    milestoneId: UUID,
    programId: UUID,
    contract: MilestoneContractV1Schema,
    contractDigest: DigestSchema,
    workflowDigest: DigestSchema,
    approvedBy: NonEmptyText.max(200),
    graphRevisionId: UUID.optional(),
    dependencies: z.array(UUID).max(32).optional(),
    sourcePredecessorMilestoneId: UUID.nullable().optional(),
    allowedWorkSurfaces: z.array(RelativePathSchema).max(64).optional(),
    structuredWorkSurfaces: z.array(WorkSurfaceV1Schema).max(64).optional(),
    resourceClaims: z.array(Identifier).max(64).optional(),
    capabilityClaims: z.array(Identifier).max(64).optional()
  }),
  MilestoneStarted: z.strictObject({
    milestoneId: UUID,
    runId: UUID,
    jobId: UUID,
    baseRevisionId: UUID
  }),
  MilestoneOutcomeReady: z.strictObject({
    milestoneId: UUID,
    runId: UUID,
    outcomePacketId: UUID,
    recommendation: z.enum(["merge", "reject", "investigate"]),
    generationId: UUID.optional(),
    generation: z.number().int().positive().optional()
  }),
  OutcomePacketRecorded: z.strictObject({
    packet: OutcomePacketSchema,
    packetDigest: DigestSchema
  }),
  ContextPacketCompiled: z.strictObject({
    packet: ContextPacketV1Schema,
    packetDigest: DigestSchema
  }),
  MilestoneGenerationStarted: z.strictObject({
    generation: MilestoneGenerationV1Schema
  }),
  MilestoneGenerationOutcomeReady: z.strictObject({
    generationId: UUID,
    programId: UUID,
    milestoneId: UUID,
    generation: z.number().int().positive(),
    runId: UUID,
    outcomePacketId: UUID,
    recommendation: z.enum(["merge", "reject", "investigate"])
  }),
  OutcomeValidationRecorded: z.strictObject({
    validation: OutcomeValidationV1Schema,
    validationDigest: DigestSchema
  }),
  RoutedIssueRaised: z.strictObject({
    issue: RoutedIssueV1Schema,
    issueDigest: DigestSchema,
    pausedMilestoneIds: z.array(UUID).max(32)
  }),
  RoutedIssueResolved: z.strictObject({
    issueId: UUID,
    programId: UUID,
    action: z.enum(["record_only", "resume_unchanged_contract", "requires_graph_revision"]),
    text: NonEmptyText.max(4_000),
    resolvedBy: NonEmptyText.max(200),
    resumedMilestoneIds: z.array(UUID).max(32)
  }),
  RoutedIssueGraphRevisionSatisfied: z.strictObject({
    issueId: UUID,
    programId: UUID,
    graphRevisionId: UUID,
    resolvedBy: NonEmptyText.max(200)
  }),
  AttentionSpanStarted: z.strictObject({ span: AttentionSpanV1Schema }),
  AttentionSpanStopped: z.strictObject({
    attentionSpanId: UUID,
    programId: UUID,
    stoppedAt: Timestamp
  }),
  OutcomeDispositionRecorded: z.strictObject({ disposition: OutcomeDispositionV1Schema }),
  MeasurementReportCompiled: z.strictObject({
    report: MeasurementReportV1Schema,
    reportDigest: DigestSchema
  }),
  AttentionPolicyApproved: z.strictObject({
    policy: AttentionPolicyV1Schema,
    policyDigest: DigestSchema,
    supersededPolicyRevisionId: UUID.nullable()
  }),
  OperatorDecisionRequestRecorded: z.strictObject({
    request: z.union([OperatorDecisionRequestV2Schema, OperatorDecisionRequestV1Schema]),
    requestDigest: DigestSchema
  }),
  DecisionEvidenceBundleRecorded: z.strictObject({
    bundle: z.union([
      DecisionEvidenceBundleV3Schema,
      DecisionEvidenceBundleV2Schema,
      DecisionEvidenceBundleV1Schema
    ]),
    bundleDigest: DigestSchema
  }),
  DecisionPacketOpened: z.strictObject({
    packetId: UUID,
    programId: UUID,
    milestoneId: UUID.nullable(),
    packetRevisionId: UUID,
    packetRevisionDigest: DigestSchema
  }),
  DecisionPacketCurrentRevisionChanged: z.strictObject({
    packetId: UUID,
    priorPacketRevisionId: UUID,
    packetRevisionId: UUID,
    packetRevisionDigest: DigestSchema
  }),
  DecisionPacketRevisionRecorded: z.strictObject({
    revision: z.union([
      DecisionPacketRevisionV3Schema,
      DecisionPacketRevisionV2Schema,
      DecisionPacketRevisionV1Schema
    ]),
    revisionDigest: DigestSchema,
    supersededRevisionId: UUID.nullable()
  }),
  DecisionAcknowledged: z.strictObject({
    acknowledgement: DecisionAcknowledgementV1Schema,
    acknowledgementDigest: DigestSchema
  }),
  DecisionExpired: z.strictObject({
    packetId: UUID,
    packetRevisionId: UUID,
    packetRevisionDigest: DigestSchema
  }),
  DecisionActionApplied: z.strictObject({
    result: z.union([
      DecisionActionResultV3Schema,
      DecisionActionResultV2Schema,
      DecisionActionResultV1Schema
    ]),
    resultDigest: DigestSchema
  }),
  DecisionResolved: z.strictObject({
    resolution: z.union([
      DecisionResolutionV3Schema,
      DecisionResolutionV2Schema,
      DecisionResolutionV1Schema
    ]),
    resolutionDigest: DigestSchema
  }),
  DecisionPrecedentRecorded: z.strictObject({
    precedent: z.union([
      DecisionPrecedentV3Schema,
      DecisionPrecedentV2Schema,
      DecisionPrecedentV1Schema
    ]),
    precedentDigest: DigestSchema
  }),
  AttentionBudgetIncidentRecorded: z.strictObject({
    incident: AttentionBudgetIncidentV1Schema,
    incidentDigest: DigestSchema
  }),
  AttentionDeliveryQueued: z.strictObject({ delivery: AttentionDeliveryV1Schema }),
  AttentionDeliveryLeaseAcquired: z.strictObject({
    deliveryId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    leaseExpiresAt: Timestamp,
    deliveryAttempt: z.number().int().positive()
  }),
  AttentionDeliveryFailed: z.strictObject({
    deliveryId: UUID,
    availableAt: Timestamp,
    permanent: z.boolean(),
    error: NonEmptyText.max(1_000)
  }),
  AttentionDeliverySucceeded: z.strictObject({
    deliveryId: UUID,
    receipt: AttentionDeliveryV1Schema.shape.receipt.unwrap()
  }),
  AttentionDeliveryObsoleted: z.strictObject({
    deliveryId: UUID,
    reason: NonEmptyText.max(1_000)
  }),
  AttentionMeasurementReportCompiled: z.strictObject({
    report: AttentionMeasurementReportV1Schema,
    reportDigest: DigestSchema
  }),
  AttentionDigestArtifactCompiled: z.strictObject({
    artifact: AttentionDigestArtifactV1Schema,
    artifactDigest: DigestSchema
  }),
  PortfolioPolicyApproved: z.strictObject({
    policy: PortfolioPolicyV1Schema,
    policyDigest: DigestSchema,
    supersededPolicyRevisionId: UUID.nullable()
  }),
  IntegrationTargetApproved: z.strictObject({
    target: IntegrationTargetV1Schema,
    targetDigest: DigestSchema,
    supersededTargetRevisionId: UUID.nullable()
  }),
  PortfolioAdmissionGranted: z.strictObject({
    admission: PortfolioAdmissionV1Schema,
    admissionDigest: DigestSchema,
    leases: z
      .array(z.strictObject({ lease: ConcurrencyLeaseV1Schema, leaseDigest: DigestSchema }))
      .min(2)
      .max(256)
  }),
  PortfolioLeaseRenewed: z.strictObject({
    lease: ConcurrencyLeaseV1Schema,
    leaseDigest: DigestSchema
  }),
  PortfolioAdmissionReleased: z.strictObject({
    admissionId: UUID,
    generationId: UUID,
    fencingToken: z.number().int().positive(),
    reason: NonEmptyText.max(1_000),
    releasedAt: Timestamp,
    leaseIds: z.array(UUID).min(1).max(256)
  }),
  PortfolioAdmissionFenced: z.strictObject({
    admissionId: UUID,
    generationId: UUID,
    fencingToken: z.number().int().positive(),
    reason: NonEmptyText.max(1_000),
    fencedAt: Timestamp,
    leaseIds: z.array(UUID).min(1).max(256)
  }),
  CandidateDiffManifestRecorded: z.strictObject({
    manifest: CandidateDiffManifestV1Schema,
    manifestDigest: DigestSchema
  }),
  IntegrationCandidateQueued: z.strictObject({
    candidate: IntegrationCandidateV1Schema,
    candidateDigest: DigestSchema,
    work: IntegrationWorkV1Schema,
    workDigest: DigestSchema
  }),
  IntegrationWorkLeaseAcquired: z.strictObject({
    workId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    leaseExpiresAt: Timestamp
  }),
  IntegrationCandidatePrepared: z.strictObject({
    workId: UUID,
    candidateId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    expectedHeadRef: ImmutableReferenceV1Schema,
    rebasedCandidateRef: ImmutableReferenceV1Schema
  }),
  IntegrationConflictRecorded: z.strictObject({
    workId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    conflict: IntegrationConflictV1Schema,
    conflictDigest: DigestSchema
  }),
  IntegrationVerificationRecorded: z.strictObject({
    workId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    verification: IntegrationVerificationV1Schema,
    verificationDigest: DigestSchema
  }),
  IntegrationPromotionAuthorized: z.strictObject({
    workId: UUID,
    candidateId: UUID,
    actionResultRef: z.strictObject({
      kind: z.literal("decision_action_result"),
      id: UUID,
      digest: DigestSchema
    }),
    expectedHeadRef: ImmutableReferenceV1Schema,
    rebasedCandidateRef: ImmutableReferenceV1Schema
  }),
  IntegrationPromotionRecorded: z.strictObject({
    receipt: PromotionReceiptV1Schema,
    receiptDigest: DigestSchema
  }),
  PortfolioSloIncidentRecorded: z.strictObject({
    incident: PortfolioSloIncidentV1Schema,
    incidentDigest: DigestSchema
  }),
  PortfolioMeasurementReportCompiled: z.strictObject({
    report: PortfolioMeasurementReportV1Schema,
    reportDigest: DigestSchema
  }),
  AdvisorSubjectApproved: z.strictObject({
    subject: AdvisorSubjectV1Schema,
    subjectDigest: DigestSchema
  }),
  AdvisorCaseRecorded: z.strictObject({
    case: AdvisorCaseV1Schema,
    caseDigest: DigestSchema
  }),
  AdvisorCorpusApproved: z.strictObject({
    corpus: AdvisorCorpusRevisionV1Schema,
    corpusDigest: DigestSchema,
    supersededCorpusRevisionId: UUID.nullable()
  }),
  AdvisorContaminationRecorded: z.strictObject({
    contamination: AdvisorContaminationRecordV1Schema,
    contaminationDigest: DigestSchema
  }),
  AdvisorInvocationQueued: z.strictObject({
    invocation: AdvisorInvocationV1Schema,
    invocationDigest: DigestSchema
  }),
  AdvisorInvocationLeaseAcquired: z.strictObject({
    invocationId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    attempt: z.number().int().positive(),
    leaseExpiresAt: Timestamp
  }),
  AdvisorInvocationSucceeded: z.strictObject({
    invocationId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    recommendation: AdvisorRecommendationV1Schema,
    recommendationDigest: DigestSchema,
    completedAt: Timestamp
  }),
  AdvisorInvocationFailed: z.strictObject({
    invocationId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    error: NonEmptyText.max(1_000),
    permanent: z.boolean(),
    availableAt: Timestamp,
    completedAt: Timestamp.nullable()
  }),
  AdvisorInvocationCancelled: z.strictObject({
    invocationId: UUID,
    reason: NonEmptyText.max(1_000),
    cancelledAt: Timestamp
  }),
  AdvisorEvaluationCompiled: z.strictObject({
    report: AdvisorEvaluationReportV1Schema,
    reportDigest: DigestSchema
  }),
  DecisionPolicyProposalCompiled: z.strictObject({
    proposal: DecisionPolicyProposalV1Schema,
    proposalDigest: DigestSchema
  }),
  DecisionPolicyProposalClosed: z.strictObject({
    proposalId: UUID,
    outcome: z.enum(["dismissed", "superseded"]),
    reason: NonEmptyText.max(2_000),
    replacementProposalRef: AdvisorReferenceV1Schema.nullable(),
    closedBy: NonEmptyText.max(200),
    closedAt: Timestamp
  }),
  DecisionPolicyApproved: z.strictObject({
    policy: DecisionPolicyV1Schema,
    policyDigest: DigestSchema,
    supersededPolicyRevisionId: UUID.nullable()
  }),
  DecisionPolicyPromotionAuthorized: z.strictObject({
    promotion: DecisionPolicyPromotionV1Schema,
    promotionDigest: DigestSchema
  }),
  DecisionPolicySuspended: z.strictObject({
    policyRevisionId: UUID,
    reason: NonEmptyText.max(2_000),
    sourceRef: AdvisorReferenceV1Schema,
    suspendedAt: Timestamp
  }),
  AdvisorAutomaticResolutionRecorded: z.strictObject({
    resolution: AdvisorAutomaticResolutionV1Schema,
    resolutionDigest: DigestSchema
  }),
  AdvisorAuditSelected: z.strictObject({
    audit: AdvisorAuditV1Schema,
    auditDigest: DigestSchema
  }),
  AdvisorAuditCompleted: z.strictObject({
    audit: AdvisorAuditV1Schema,
    auditDigest: DigestSchema
  }),
  AdvisorIncidentRecorded: z.strictObject({
    incident: AdvisorIncidentV1Schema,
    incidentDigest: DigestSchema
  }),
  SourceRevisionRegistered: z.strictObject({
    revisionId: UUID,
    repositoryId: UUID,
    objectFormat: z.enum(["sha1", "sha256"]),
    commitOid: GitOidSchema,
    treeOid: GitOidSchema,
    storageRef: NonEmptyText.max(500),
    revisionDigest: DigestSchema
  }),
  WorkflowDefinitionRegistered: z.strictObject({
    definition: WorkflowDefinitionSchema,
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  RunCreated: z.strictObject({
    runId: UUID,
    programId: UUID,
    workflowId: UUID,
    workflowVersion: z.number().int().positive()
  }),
  MilestoneRunCreated: z.strictObject({
    runId: UUID,
    milestoneId: UUID,
    programId: UUID,
    workflowId: UUID,
    workflowVersion: z.number().int().positive(),
    generationId: UUID.optional(),
    generation: z.number().int().positive().optional()
  }),
  RunScheduled: z.strictObject({ runId: UUID }),
  RunStarted: z.strictObject({ runId: UUID }),
  RunSucceeded: z.strictObject({ runId: UUID }),
  RunFailed: z.strictObject({ runId: UUID, reason: NonEmptyText.max(1000) }),
  RunCancelled: z.strictObject({ runId: UUID, reason: NonEmptyText.max(1000) }),
  AttemptAllocated: z.strictObject({
    attemptId: UUID,
    runId: UUID,
    ordinal: z.number().int().positive()
  }),
  AttemptCancelled: z.strictObject({
    attemptId: UUID,
    runId: UUID,
    reason: NonEmptyText.max(1000)
  }),
  JobScheduled: z.strictObject({
    jobId: UUID,
    runId: UUID,
    stepId: Identifier,
    capability: Identifier,
    dependencyJobIds: z.array(UUID).max(256),
    initialStatus: z.enum(["blocked", "ready"]),
    policy: JobPolicySchema,
    sourceRevisionId: UUID.optional(),
    executionContract: z
      .union([GenericCommandContractV2Schema, GenericCommandContractV1Schema])
      .optional(),
    executionContractDigest: DigestSchema.optional(),
    capabilityManifest: z
      .union([CapabilityManifestV2Schema, CapabilityManifestV1Schema])
      .optional(),
    capabilityManifestDigest: DigestSchema.optional(),
    contextPacketId: UUID.optional(),
    contextPacketDigest: DigestSchema.optional(),
    verifierContract: VerifierContractSchema.optional(),
    verifierContractDigest: DigestSchema.optional()
  }),
  JobUnblocked: z.strictObject({ jobId: UUID, runId: UUID }),
  JobLeaseAcquired: z.strictObject({
    jobId: UUID,
    runId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    leaseExpiresAt: Timestamp,
    resumed: z.boolean()
  }),
  JobLeaseRenewed: z.strictObject({
    jobId: UUID,
    runId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    leaseExpiresAt: Timestamp
  }),
  JobLeaseReleased: z.strictObject({
    jobId: UUID,
    runId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive()
  }),
  JobRetryScheduled: z.strictObject({
    jobId: UUID,
    runId: UUID,
    availableAt: Timestamp,
    reason: z.enum(["driver_error", "timed_out"])
  }),
  JobSucceeded: z.strictObject({ jobId: UUID, runId: UUID }),
  JobFailed: z.strictObject({ jobId: UUID, runId: UUID, reason: NonEmptyText.max(1000) }),
  JobCancelled: z.strictObject({
    jobId: UUID,
    runId: UUID,
    reason: z.enum(["operator_cancelled", "run_failed"])
  }),
  AttemptStarted: z.strictObject({
    attemptId: UUID,
    jobId: UUID,
    runId: UUID,
    ordinal: z.number().int().positive(),
    deadlineAt: Timestamp
  }),
  AttemptRunning: z.strictObject({
    attemptId: UUID,
    jobId: UUID,
    runId: UUID,
    externalRunId: NonEmptyText.max(500)
  }),
  DriverEventsObserved: z.strictObject({
    attemptId: UUID,
    jobId: UUID,
    runId: UUID,
    afterSequence: z.number().int().nonnegative(),
    cursor: z.number().int().positive(),
    events: z.array(DriverProtocolEventSchema).min(1).max(4096),
    cumulativeUsage: DriverUsageSchema
  }),
  AttemptVerificationRequested: z.strictObject({
    attemptId: UUID,
    jobId: UUID,
    runId: UUID,
    verificationId: UUID
  }),
  AttemptFinished: z.strictObject({
    attemptId: UUID,
    jobId: UUID,
    runId: UUID,
    status: z.enum(["succeeded", "failed", "timed_out", "cancelled", "approval_required"]),
    terminationReason: TerminationReasonSchema,
    detail: z.string().max(1000).optional()
  }),
  OutboxEnqueued: z.strictObject({
    outboxId: UUID,
    runId: UUID,
    jobId: UUID,
    attemptId: UUID,
    effectKey: UUID,
    effect: OutboxEffectSchema,
    retryDelaysMs: z.array(z.number().int().nonnegative()).length(7)
  }),
  OutboxLeaseAcquired: z.strictObject({
    outboxId: UUID,
    runId: UUID,
    ownerId: UUID,
    fencingToken: z.number().int().positive(),
    leaseExpiresAt: Timestamp,
    deliveryAttempt: z.number().int().positive()
  }),
  OutboxDeliveryFailed: z.strictObject({
    outboxId: UUID,
    runId: UUID,
    availableAt: Timestamp.nullable(),
    deadLetter: z.boolean(),
    error: NonEmptyText.max(1000)
  }),
  OutboxDelivered: z.strictObject({
    outboxId: UUID,
    runId: UUID,
    externalEffectId: NonEmptyText.max(500)
  }),
  OutboxObsoleted: z.strictObject({ outboxId: UUID, runId: UUID, reason: NonEmptyText.max(1000) }),
  ArtifactManifestRecorded: z.strictObject({
    artifactManifestId: UUID,
    runId: UUID,
    jobId: UUID,
    attemptId: UUID,
    sourceRevisionId: UUID,
    producer: z.enum(["agent", "verifier"]).default("verifier"),
    entries: z
      .array(
        z.strictObject({
          path: RelativePathSchema,
          role: Identifier,
          size: z.number().int().nonnegative().max(268_435_456),
          sha256: DigestSchema
        })
      )
      .max(256),
    manifestDigest: DigestSchema,
    totalBytes: z.number().int().nonnegative().max(268_435_456)
  }),
  DriverReceiptRecorded: z.strictObject({
    driverReceiptId: UUID,
    runId: UUID,
    jobId: UUID,
    attemptId: UUID,
    baseRevisionId: UUID,
    candidateRevisionId: UUID.nullable(),
    receipt: DriverReceiptSchema,
    receiptDigest: DigestSchema,
    outcome: DriverOutcomeSchema,
    terminalReason: NonEmptyText.max(1000)
  }),
  ApprovalRequestRecorded: z.strictObject({
    approvalRequestId: UUID,
    runId: UUID,
    jobId: UUID,
    attemptId: UUID,
    capability: Identifier,
    reason: NonEmptyText.max(1000),
    sequence: z.number().int().positive()
  }),
  VerificationRequested: z.strictObject({
    verificationId: UUID,
    runId: UUID,
    jobId: UUID,
    attemptId: UUID,
    workflowId: UUID,
    workflowVersion: z.number().int().positive(),
    workflowDigest: DigestSchema,
    sourceRevisionId: UUID,
    verifierContractDigest: DigestSchema
  }),
  VerificationReceiptRecorded: z.strictObject({
    verificationId: UUID,
    runId: UUID,
    jobId: UUID,
    attemptId: UUID,
    artifactManifestId: UUID,
    status: z.enum(["passed", "failed", "invalid"]),
    result: z.strictObject({
      outcome: z.enum(["passed", "failed", "invalid"]),
      exitCode: z.number().int().min(0).max(255).nullable(),
      failureReason: z.string().min(1).max(1000).nullable(),
      environmentDigest: DigestSchema,
      sourceStatusBeforeDigest: DigestSchema,
      sourceStatusAfterDigest: DigestSchema,
      contractDigestBefore: DigestSchema,
      contractDigestAfter: DigestSchema,
      artifactManifestDigest: DigestSchema
    }),
    resultDigest: DigestSchema,
    receiptDigest: DigestSchema,
    exitCode: z.number().int().min(0).max(255).nullable(),
    failureReason: z.string().min(1).max(1000).nullable()
  }),
  VerificationCancelled: z.strictObject({
    verificationId: UUID,
    runId: UUID,
    reason: NonEmptyText.max(1000)
  })
} as const;

export type EventType = keyof typeof EventPayloadSchemas;
export type StreamType =
  | "program"
  | "milestone"
  | "milestone_generation"
  | "program_interview"
  | "program_graph"
  | "context_packet"
  | "outcome_validation"
  | "routed_issue"
  | "attention_span"
  | "outcome_disposition"
  | "measurement_report"
  | "outcome_packet"
  | "workflow"
  | "run"
  | "attempt"
  | "job"
  | "outbox"
  | "source_revision"
  | "artifact_manifest"
  | "verification"
  | "driver_receipt"
  | "approval_request"
  | "operator_decision_request"
  | "decision_packet"
  | "decision_packet_revision"
  | "decision_evidence_bundle"
  | "attention_policy"
  | "decision_acknowledgement"
  | "decision_resolution"
  | "decision_action_result"
  | "decision_precedent"
  | "attention_delivery"
  | "attention_budget_incident"
  | "attention_measurement_report"
  | "attention_digest_artifact"
  | "portfolio_policy"
  | "integration_target"
  | "portfolio_admission"
  | "concurrency_lease"
  | "candidate_diff_manifest"
  | "integration_candidate"
  | "integration_work"
  | "integration_conflict"
  | "promotion_receipt"
  | "portfolio_slo_incident"
  | "portfolio_measurement_report"
  | "advisor_subject"
  | "advisor_case"
  | "advisor_corpus"
  | "advisor_contamination"
  | "advisor_invocation"
  | "advisor_recommendation"
  | "advisor_evaluation"
  | "decision_policy_proposal"
  | "decision_policy"
  | "decision_policy_promotion"
  | "advisor_resolution"
  | "advisor_audit"
  | "advisor_incident";

export type DomainEventInput = {
  [K in EventType]: {
    type: K;
    streamType: StreamType;
    streamId: string;
    data: z.infer<(typeof EventPayloadSchemas)[K]>;
  };
}[EventType];

export type StoredEvent = DomainEventInput & {
  eventId: string;
  commandId: string;
  globalPosition: number;
  streamVersion: number;
  schemaVersion: 1;
  occurredAt: string;
  metadata: { actor: Actor; correlationId?: string };
};

export function parseEventPayload(type: EventType, value: unknown): DomainEventInput["data"] {
  return EventPayloadSchemas[type].parse(value);
}

export const EventMetadataSchema = z.strictObject({
  actor: ActorSchema,
  correlationId: UUID.optional()
});

export const ProgramStateSchema = z.strictObject({
  kind: z.literal("program"),
  programId: UUID,
  name: NonEmptyText.max(160),
  status: z.literal("active"),
  intent: ProgramIntentV1Schema.nullable().default(null),
  intentDigest: DigestSchema.nullable().default(null),
  approvedBy: z.string().nullable().default(null),
  approvedAt: Timestamp.nullable().default(null),
  programMode: z.enum(["legacy_v1", "graph_v1", "graph_v2"]).optional(),
  phase: z
    .enum([
      "legacy_active",
      "draft",
      "approved",
      "eligible",
      "running",
      "parked",
      "integration_pending",
      "completed"
    ])
    .optional(),
  resumePhase: z.enum(["eligible", "running", "integration_pending"]).nullable().optional(),
  executionRequestId: UUID.nullable().optional(),
  executionRequestedAt: Timestamp.nullable().optional(),
  executionPolicy: JobPolicySchema.nullable().optional(),
  attentionPriority: AttentionUrgencySchema.optional(),
  initialSourceRevisionId: UUID.nullable().optional(),
  initialSourceRevisionDigest: DigestSchema.nullable().optional(),
  activeGraphRevisionId: UUID.nullable().optional(),
  activeGraphDigest: DigestSchema.nullable().optional(),
  startedAt: Timestamp.nullable().optional(),
  createdAt: Timestamp,
  version: z.number().int().positive()
});

export const MilestoneStateSchema = z.strictObject({
  kind: z.literal("milestone"),
  milestoneId: UUID,
  programId: UUID,
  contract: MilestoneContractV1Schema,
  contractDigest: DigestSchema,
  workflowDigest: DigestSchema,
  graphRevisionId: UUID.nullable().optional(),
  dependencies: z.array(UUID).optional(),
  sourcePredecessorMilestoneId: UUID.nullable().optional(),
  allowedWorkSurfaces: z.array(RelativePathSchema).optional(),
  structuredWorkSurfaces: z.array(WorkSurfaceV1Schema).optional(),
  resourceClaims: z.array(Identifier).optional(),
  capabilityClaims: z.array(Identifier).optional(),
  status: z.enum(["approved", "eligible", "running", "paused", "outcome_ready"]),
  generation: z.number().int().nonnegative().optional(),
  activeGenerationId: UUID.nullable().optional(),
  runId: UUID.nullable(),
  jobId: UUID.nullable(),
  baseRevisionId: UUID.nullable(),
  outcomePacketId: UUID.nullable(),
  latestValidatedOutcomePacketId: UUID.nullable().optional(),
  recommendation: z.enum(["merge", "reject", "investigate"]).nullable(),
  pauseReason: z.string().nullable().optional(),
  approvedBy: NonEmptyText.max(200),
  approvedAt: Timestamp,
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
  version: z.number().int().positive()
});

export const OutcomePacketStateSchema = z.strictObject({
  kind: z.literal("outcome_packet"),
  outcomePacketId: UUID,
  programId: UUID,
  milestoneId: UUID,
  generationId: UUID.nullable().optional(),
  generation: z.number().int().positive().nullable().optional(),
  runId: UUID,
  packet: OutcomePacketSchema,
  packetDigest: DigestSchema,
  recordedAt: Timestamp,
  version: z.number().int().positive()
});

export const WorkflowStateSchema = z.strictObject({
  kind: z.literal("workflow"),
  workflowId: UUID,
  version: z.number().int().positive(),
  name: NonEmptyText.max(160),
  definition: WorkflowDefinitionSchema,
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  registeredAt: Timestamp,
  streamVersion: z.number().int().positive()
});

export const RunStateSchema = z.strictObject({
  kind: z.literal("run"),
  runId: UUID,
  programId: UUID,
  workflowId: UUID,
  workflowVersion: z.number().int().positive(),
  milestoneId: UUID.nullable().default(null),
  generationId: UUID.nullable().optional(),
  generation: z.number().int().positive().nullable().optional(),
  status: z.enum(["created", "scheduled", "running", "succeeded", "failed", "cancelled"]),
  createdAt: Timestamp,
  scheduledAt: Timestamp.nullable(),
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  cancellationReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  version: z.number().int().positive()
});

export const AttemptStateSchema = z.strictObject({
  kind: z.literal("attempt"),
  attemptId: UUID,
  runId: UUID,
  jobId: UUID.nullable(),
  ordinal: z.number().int().positive(),
  status: z.enum([
    "allocated",
    "starting",
    "running",
    "verifying",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "approval_required"
  ]),
  allocatedAt: Timestamp,
  startedAt: Timestamp.nullable(),
  deadlineAt: Timestamp.nullable(),
  externalRunId: z.string().nullable(),
  driverCursor: z.number().int().nonnegative().default(0),
  cumulativeUsage: z
    .strictObject({
      cpuMillis: z.number().int().nonnegative(),
      memoryPeakBytes: z.number().int().nonnegative()
    })
    .nullable()
    .default(null),
  candidateRevisionId: UUID.nullable().default(null),
  driverReceiptId: UUID.nullable().default(null),
  finishedAt: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  cancellationReason: z.string().nullable(),
  terminationReason: TerminationReasonSchema.nullable(),
  version: z.number().int().positive()
});

export const JobStateSchema = z.strictObject({
  kind: z.literal("job"),
  jobId: UUID,
  runId: UUID,
  stepId: Identifier,
  capability: Identifier,
  dependencyJobIds: z.array(UUID),
  status: z.enum(["blocked", "ready", "active", "retry_wait", "succeeded", "failed", "cancelled"]),
  policy: JobPolicySchema,
  sourceRevisionId: UUID.nullable().default(null),
  executionContract: z
    .union([GenericCommandContractV2Schema, GenericCommandContractV1Schema])
    .nullable()
    .default(null),
  executionContractDigest: DigestSchema.nullable().default(null),
  capabilityManifest: z
    .union([CapabilityManifestV2Schema, CapabilityManifestV1Schema])
    .nullable()
    .default(null),
  capabilityManifestDigest: DigestSchema.nullable().default(null),
  contextPacketId: UUID.nullable().optional(),
  contextPacketDigest: DigestSchema.nullable().optional(),
  verifierContract: VerifierContractSchema.nullable().default(null),
  verifierContractDigest: DigestSchema.nullable().default(null),
  candidateRevisionId: UUID.nullable().default(null),
  attemptCount: z.number().int().nonnegative(),
  activeAttemptId: UUID.nullable(),
  availableAt: Timestamp,
  leaseOwnerId: UUID.nullable(),
  leaseFencingToken: z.number().int().nonnegative(),
  leaseAcquiredAt: Timestamp.nullable(),
  leaseExpiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
  failureReason: z.string().nullable(),
  version: z.number().int().positive()
});

export const OutboxStateSchema = z.strictObject({
  kind: z.literal("outbox"),
  outboxId: UUID,
  runId: UUID,
  jobId: UUID,
  attemptId: UUID,
  effectKey: UUID,
  effect: OutboxEffectSchema,
  status: z.enum(["pending", "leased", "delivered", "obsolete", "dead_letter"]),
  deliveryAttempts: z.number().int().nonnegative(),
  retryDelaysMs: z.array(z.number().int().nonnegative()).length(7),
  availableAt: Timestamp,
  leaseOwnerId: UUID.nullable(),
  leaseFencingToken: z.number().int().nonnegative(),
  leaseAcquiredAt: Timestamp.nullable(),
  leaseExpiresAt: Timestamp.nullable(),
  externalEffectId: z.string().nullable(),
  createdAt: Timestamp,
  deliveredAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
  version: z.number().int().positive()
});

export const SourceRevisionStateSchema = z.strictObject({
  kind: z.literal("source_revision"),
  revisionId: UUID,
  repositoryId: UUID,
  objectFormat: z.enum(["sha1", "sha256"]),
  commitOid: GitOidSchema,
  treeOid: GitOidSchema,
  storageRef: NonEmptyText.max(500),
  revisionDigest: DigestSchema,
  capturedAt: Timestamp,
  version: z.number().int().positive()
});

export const ArtifactManifestStateSchema = z.strictObject({
  kind: z.literal("artifact_manifest"),
  artifactManifestId: UUID,
  runId: UUID,
  jobId: UUID,
  attemptId: UUID,
  sourceRevisionId: UUID,
  producer: z.enum(["agent", "verifier"]).default("verifier"),
  entries: EventPayloadSchemas.ArtifactManifestRecorded.shape.entries,
  manifestDigest: DigestSchema,
  totalBytes: z.number().int().nonnegative().max(268_435_456),
  createdAt: Timestamp,
  version: z.number().int().positive()
});

export const VerificationStateSchema = z.strictObject({
  kind: z.literal("verification"),
  verificationId: UUID,
  runId: UUID,
  jobId: UUID,
  attemptId: UUID,
  workflowId: UUID,
  workflowVersion: z.number().int().positive(),
  workflowDigest: DigestSchema,
  sourceRevisionId: UUID,
  verifierContractDigest: DigestSchema,
  artifactManifestId: UUID.nullable(),
  status: z.enum(["requested", "passed", "failed", "invalid", "cancelled"]),
  result: EventPayloadSchemas.VerificationReceiptRecorded.shape.result.nullable(),
  resultDigest: DigestSchema.nullable(),
  receiptDigest: DigestSchema.nullable(),
  exitCode: z.number().int().min(0).max(255).nullable(),
  failureReason: z.string().nullable(),
  requestedAt: Timestamp,
  completedAt: Timestamp.nullable(),
  version: z.number().int().positive()
});

export const DriverReceiptStateSchema = z.strictObject({
  kind: z.literal("driver_receipt"),
  driverReceiptId: UUID,
  runId: UUID,
  jobId: UUID,
  attemptId: UUID,
  baseRevisionId: UUID,
  candidateRevisionId: UUID.nullable(),
  receipt: DriverReceiptSchema,
  receiptDigest: DigestSchema,
  outcome: DriverOutcomeSchema,
  terminalReason: NonEmptyText.max(1000),
  recordedAt: Timestamp,
  version: z.number().int().positive()
});

export const ApprovalRequestStateSchema = z.strictObject({
  kind: z.literal("approval_request"),
  approvalRequestId: UUID,
  runId: UUID,
  jobId: UUID,
  attemptId: UUID,
  capability: Identifier,
  reason: NonEmptyText.max(1000),
  sequence: z.number().int().positive(),
  requestedAt: Timestamp,
  version: z.number().int().positive()
});

export const ProgramInterviewStateSchema = z.strictObject({
  kind: z.literal("program_interview"),
  interviewId: UUID,
  programId: UUID,
  transcript: InterviewCaptureV1Schema.shape.transcript,
  transcriptDigest: DigestSchema,
  playback: IntentPlaybackV1Schema,
  playbackDigest: DigestSchema,
  capturedAt: Timestamp,
  version: z.number().int().positive()
});

export const ProgramGraphStateSchema = z.strictObject({
  kind: z.literal("program_graph"),
  graphRevisionId: UUID,
  programId: UUID,
  revision: z.number().int().positive(),
  priorGraphRevisionId: UUID.nullable(),
  graph: z.union([ProgramGraphRevisionV2Schema, ProgramGraphRevisionV1Schema]),
  graphDigest: DigestSchema,
  approvedBy: NonEmptyText.max(200),
  approvedAt: Timestamp,
  supersededAt: Timestamp.nullable(),
  version: z.number().int().positive()
});

export const MilestoneGenerationStateSchema = z.strictObject({
  kind: z.literal("milestone_generation"),
  ...MilestoneGenerationV1Schema.omit({ schemaVersion: true }).shape,
  version: z.number().int().positive()
});

export const ContextPacketStateSchema = z.strictObject({
  kind: z.literal("context_packet"),
  contextPacketId: UUID,
  programId: UUID,
  milestoneId: UUID,
  generationId: UUID,
  packet: ContextPacketV1Schema,
  packetDigest: DigestSchema,
  compiledAt: Timestamp,
  version: z.number().int().positive()
});

export const OutcomeValidationStateSchema = z.strictObject({
  kind: z.literal("outcome_validation"),
  validationId: UUID,
  programId: UUID,
  milestoneId: UUID,
  outcomePacketId: UUID,
  packetDigest: DigestSchema,
  validation: OutcomeValidationV1Schema,
  validationDigest: DigestSchema,
  validatedAt: Timestamp,
  version: z.number().int().positive()
});

export const RoutedIssueStateSchema = z.strictObject({
  kind: z.literal("routed_issue"),
  issue: RoutedIssueV1Schema,
  issueDigest: DigestSchema,
  version: z.number().int().positive()
});

export const AttentionSpanStateSchema = z.strictObject({
  kind: z.literal("attention_span"),
  ...AttentionSpanV1Schema.omit({ schemaVersion: true }).shape,
  version: z.number().int().positive()
});

export const OutcomeDispositionStateSchema = z.strictObject({
  kind: z.literal("outcome_disposition"),
  disposition: OutcomeDispositionV1Schema,
  version: z.number().int().positive()
});

export const MeasurementReportStateSchema = z.strictObject({
  kind: z.literal("measurement_report"),
  report: MeasurementReportV1Schema,
  reportDigest: DigestSchema,
  version: z.number().int().positive()
});

export const OperatorDecisionRequestStateSchema = z.strictObject({
  kind: z.literal("operator_decision_request"),
  request: z.union([OperatorDecisionRequestV2Schema, OperatorDecisionRequestV1Schema]),
  requestDigest: DigestSchema,
  version: z.number().int().positive()
});

export const DecisionPacketStateSchema = z.strictObject({
  kind: z.literal("decision_packet"),
  packetId: UUID,
  programId: UUID,
  milestoneId: UUID.nullable(),
  currentRevisionId: UUID,
  currentRevisionDigest: DigestSchema,
  status: z.enum(["open", "resolved", "expired"]),
  acknowledgementId: UUID.nullable(),
  resolutionId: UUID.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  version: z.number().int().positive()
});

export const DecisionPacketRevisionStateSchema = z.strictObject({
  kind: z.literal("decision_packet_revision"),
  revision: z.union([
    DecisionPacketRevisionV3Schema,
    DecisionPacketRevisionV2Schema,
    DecisionPacketRevisionV1Schema
  ]),
  revisionDigest: DigestSchema,
  version: z.number().int().positive()
});

export const DecisionEvidenceBundleStateSchema = z.strictObject({
  kind: z.literal("decision_evidence_bundle"),
  bundle: z.union([
    DecisionEvidenceBundleV3Schema,
    DecisionEvidenceBundleV2Schema,
    DecisionEvidenceBundleV1Schema
  ]),
  bundleDigest: DigestSchema,
  version: z.number().int().positive()
});

export const AttentionPolicyStateSchema = z.strictObject({
  kind: z.literal("attention_policy"),
  policy: AttentionPolicyV1Schema,
  policyDigest: DigestSchema,
  supersededAt: Timestamp.nullable(),
  version: z.number().int().positive()
});

export const DecisionAcknowledgementStateSchema = z.strictObject({
  kind: z.literal("decision_acknowledgement"),
  acknowledgement: DecisionAcknowledgementV1Schema,
  acknowledgementDigest: DigestSchema,
  version: z.number().int().positive()
});

export const DecisionResolutionStateSchema = z.strictObject({
  kind: z.literal("decision_resolution"),
  resolution: z.union([
    DecisionResolutionV3Schema,
    DecisionResolutionV2Schema,
    DecisionResolutionV1Schema
  ]),
  resolutionDigest: DigestSchema,
  version: z.number().int().positive()
});

export const DecisionActionResultStateSchema = z.strictObject({
  kind: z.literal("decision_action_result"),
  result: z.union([
    DecisionActionResultV3Schema,
    DecisionActionResultV2Schema,
    DecisionActionResultV1Schema
  ]),
  resultDigest: DigestSchema,
  version: z.number().int().positive()
});

export const DecisionPrecedentStateSchema = z.strictObject({
  kind: z.literal("decision_precedent"),
  precedent: z.union([
    DecisionPrecedentV3Schema,
    DecisionPrecedentV2Schema,
    DecisionPrecedentV1Schema
  ]),
  precedentDigest: DigestSchema,
  version: z.number().int().positive()
});

export const AttentionDeliveryStateSchema = z.strictObject({
  kind: z.literal("attention_delivery"),
  delivery: AttentionDeliveryV1Schema,
  version: z.number().int().positive()
});

export const AttentionBudgetIncidentStateSchema = z.strictObject({
  kind: z.literal("attention_budget_incident"),
  incident: AttentionBudgetIncidentV1Schema,
  incidentDigest: DigestSchema,
  version: z.number().int().positive()
});

export const AttentionMeasurementReportStateSchema = z.strictObject({
  kind: z.literal("attention_measurement_report"),
  report: AttentionMeasurementReportV1Schema,
  reportDigest: DigestSchema,
  version: z.number().int().positive()
});

export const AttentionDigestArtifactStateSchema = z.strictObject({
  kind: z.literal("attention_digest_artifact"),
  artifact: AttentionDigestArtifactV1Schema,
  artifactDigest: DigestSchema,
  version: z.number().int().positive()
});

export const PortfolioPolicyStateSchema = z.strictObject({
  kind: z.literal("portfolio_policy"),
  policy: PortfolioPolicyV1Schema,
  policyDigest: DigestSchema,
  supersededAt: Timestamp.nullable(),
  version: z.number().int().positive()
});

export const IntegrationTargetStateSchema = z.strictObject({
  kind: z.literal("integration_target"),
  target: IntegrationTargetV1Schema,
  targetDigest: DigestSchema,
  supersededAt: Timestamp.nullable(),
  currentHeadRef: ImmutableReferenceV1Schema,
  version: z.number().int().positive()
});

export const PortfolioAdmissionStateSchema = z.strictObject({
  kind: z.literal("portfolio_admission"),
  admission: PortfolioAdmissionV1Schema,
  admissionDigest: DigestSchema,
  status: z.enum(["active", "released", "fenced"]),
  reason: z.string().max(1_000).nullable(),
  version: z.number().int().positive()
});

export const ConcurrencyLeaseStateSchema = z.strictObject({
  kind: z.literal("concurrency_lease"),
  lease: ConcurrencyLeaseV1Schema,
  leaseDigest: DigestSchema,
  status: z.enum(["active", "released", "fenced"]),
  version: z.number().int().positive()
});

export const CandidateDiffManifestStateSchema = z.strictObject({
  kind: z.literal("candidate_diff_manifest"),
  manifest: CandidateDiffManifestV1Schema,
  manifestDigest: DigestSchema,
  version: z.number().int().positive()
});

export const IntegrationCandidateStateSchema = z.strictObject({
  kind: z.literal("integration_candidate"),
  candidate: IntegrationCandidateV1Schema,
  candidateDigest: DigestSchema,
  status: z.enum([
    "pending",
    "blocked",
    "preparing",
    "conflicted",
    "verifying",
    "awaiting_authorization",
    "authorized",
    "promoting",
    "promoted",
    "ineligible"
  ]),
  version: z.number().int().positive()
});

export const IntegrationWorkStateSchema = z.strictObject({
  kind: z.literal("integration_work"),
  work: IntegrationWorkV1Schema,
  workDigest: DigestSchema,
  version: z.number().int().positive()
});

export const IntegrationConflictStateSchema = z.strictObject({
  kind: z.literal("integration_conflict"),
  conflict: IntegrationConflictV1Schema,
  conflictDigest: DigestSchema,
  version: z.number().int().positive()
});

export const IntegrationVerificationStateSchema = z.strictObject({
  kind: z.literal("integration_verification"),
  verification: IntegrationVerificationV1Schema,
  verificationDigest: DigestSchema,
  version: z.number().int().positive()
});

export const PromotionReceiptStateSchema = z.strictObject({
  kind: z.literal("promotion_receipt"),
  receipt: PromotionReceiptV1Schema,
  receiptDigest: DigestSchema,
  version: z.number().int().positive()
});

export const PortfolioSloIncidentStateSchema = z.strictObject({
  kind: z.literal("portfolio_slo_incident"),
  incident: PortfolioSloIncidentV1Schema,
  incidentDigest: DigestSchema,
  version: z.number().int().positive()
});

export const PortfolioMeasurementReportStateSchema = z.strictObject({
  kind: z.literal("portfolio_measurement_report"),
  report: PortfolioMeasurementReportV1Schema,
  reportDigest: DigestSchema,
  version: z.number().int().positive()
});

export const PortfolioSnapshotV1Schema = z.strictObject({
  snapshotVersion: z.literal(1),
  throughPosition: z.number().int().nonnegative(),
  admissionFrozen: z.boolean(),
  programs: z.array(ProgramStateSchema),
  eligibilityBlockers: z.array(
    z.strictObject({ programId: UUID, blockers: z.array(NonEmptyText.max(1_000)).max(64) })
  ),
  admissions: z.array(PortfolioAdmissionStateSchema),
  activeClaims: z.array(ConcurrencyLeaseStateSchema),
  leaseRecovery: z.array(ConcurrencyLeaseStateSchema),
  integrationOrder: z.array(IntegrationCandidateStateSchema),
  integrationWork: z.array(IntegrationWorkStateSchema),
  conflicts: z.array(IntegrationConflictStateSchema),
  targets: z.array(IntegrationTargetStateSchema),
  sloIncidents: z.array(PortfolioSloIncidentStateSchema),
  reports: z.array(PortfolioMeasurementReportStateSchema),
  attention: z.strictObject({
    openPackets: z.number().int().nonnegative(),
    routinePages: z.number().int().nonnegative(),
    safetyCriticalPages: z.number().int().nonnegative(),
    activeHumanTimeMs: z.number().int().nonnegative()
  }),
  cost: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("known"), amount: z.string(), currency: z.string() }),
    z.strictObject({ status: z.literal("unavailable"), reason: NonEmptyText.max(500) })
  ])
});

export const AttentionSnapshotV1Schema = z.strictObject({
  snapshotVersion: z.literal(1),
  throughPosition: z.number().int().nonnegative(),
  queue: z.array(
    z.strictObject({
      packet: DecisionPacketStateSchema,
      revision: DecisionPacketRevisionStateSchema,
      acknowledgement: DecisionAcknowledgementStateSchema.nullable()
    })
  ),
  page: z.array(
    z.strictObject({
      packet: DecisionPacketStateSchema,
      revision: DecisionPacketRevisionStateSchema,
      acknowledgement: DecisionAcknowledgementStateSchema.nullable()
    })
  ),
  policies: z.array(AttentionPolicyStateSchema),
  budgetIncidents: z.array(AttentionBudgetIncidentStateSchema),
  deliveries: z.array(AttentionDeliveryStateSchema)
});

export const AttentionSnapshotV2Schema = z.strictObject({
  snapshotVersion: z.literal(2),
  attention: AttentionSnapshotV1Schema,
  advisor: AdvisorSnapshotV1Schema
});

export const StateEntitySchema = z.discriminatedUnion("kind", [
  ProgramStateSchema,
  MilestoneStateSchema,
  OutcomePacketStateSchema,
  WorkflowStateSchema,
  RunStateSchema,
  AttemptStateSchema,
  JobStateSchema,
  OutboxStateSchema,
  SourceRevisionStateSchema,
  ArtifactManifestStateSchema,
  VerificationStateSchema,
  DriverReceiptStateSchema,
  ApprovalRequestStateSchema,
  ProgramInterviewStateSchema,
  ProgramGraphStateSchema,
  MilestoneGenerationStateSchema,
  ContextPacketStateSchema,
  OutcomeValidationStateSchema,
  RoutedIssueStateSchema,
  AttentionSpanStateSchema,
  OutcomeDispositionStateSchema,
  MeasurementReportStateSchema,
  OperatorDecisionRequestStateSchema,
  DecisionPacketStateSchema,
  DecisionPacketRevisionStateSchema,
  DecisionEvidenceBundleStateSchema,
  AttentionPolicyStateSchema,
  DecisionAcknowledgementStateSchema,
  DecisionResolutionStateSchema,
  DecisionActionResultStateSchema,
  DecisionPrecedentStateSchema,
  AttentionDeliveryStateSchema,
  AttentionBudgetIncidentStateSchema,
  AttentionMeasurementReportStateSchema,
  AttentionDigestArtifactStateSchema,
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
  AdvisorSubjectStateSchema,
  AdvisorCaseStateSchema,
  AdvisorCorpusStateSchema,
  AdvisorContaminationStateSchema,
  AdvisorInvocationStateSchema,
  AdvisorRecommendationStateSchema,
  AdvisorEvaluationStateSchema,
  DecisionPolicyProposalStateSchema,
  DecisionPolicyStateSchema,
  DecisionPolicyPromotionStateSchema,
  AdvisorResolutionStateSchema,
  AdvisorAuditStateSchema,
  AdvisorIncidentStateSchema
]);

export type ProgramState = z.infer<typeof ProgramStateSchema>;
export type MilestoneState = z.infer<typeof MilestoneStateSchema>;
export type OutcomePacketState = z.infer<typeof OutcomePacketStateSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type AttemptState = z.infer<typeof AttemptStateSchema>;
export type JobState = z.infer<typeof JobStateSchema>;
export type OutboxState = z.infer<typeof OutboxStateSchema>;
export type SourceRevisionState = z.infer<typeof SourceRevisionStateSchema>;
export type ArtifactManifestState = z.infer<typeof ArtifactManifestStateSchema>;
export type VerificationState = z.infer<typeof VerificationStateSchema>;
export type ProgramInterviewState = z.infer<typeof ProgramInterviewStateSchema>;
export type ProgramGraphState = z.infer<typeof ProgramGraphStateSchema>;
export type MilestoneGenerationState = z.infer<typeof MilestoneGenerationStateSchema>;
export type ContextPacketState = z.infer<typeof ContextPacketStateSchema>;
export type OutcomeValidationState = z.infer<typeof OutcomeValidationStateSchema>;
export type RoutedIssueState = z.infer<typeof RoutedIssueStateSchema>;
export type AttentionSpanState = z.infer<typeof AttentionSpanStateSchema>;
export type OutcomeDispositionState = z.infer<typeof OutcomeDispositionStateSchema>;
export type MeasurementReportState = z.infer<typeof MeasurementReportStateSchema>;
export type OperatorDecisionRequestState = z.infer<typeof OperatorDecisionRequestStateSchema>;
export type DecisionPacketState = z.infer<typeof DecisionPacketStateSchema>;
export type DecisionPacketRevisionState = z.infer<typeof DecisionPacketRevisionStateSchema>;
export type DecisionEvidenceBundleState = z.infer<typeof DecisionEvidenceBundleStateSchema>;
export type AttentionPolicyState = z.infer<typeof AttentionPolicyStateSchema>;
export type DecisionAcknowledgementState = z.infer<typeof DecisionAcknowledgementStateSchema>;
export type DecisionResolutionState = z.infer<typeof DecisionResolutionStateSchema>;
export type DecisionActionResultState = z.infer<typeof DecisionActionResultStateSchema>;
export type DecisionPrecedentState = z.infer<typeof DecisionPrecedentStateSchema>;
export type AttentionDeliveryState = z.infer<typeof AttentionDeliveryStateSchema>;
export type AttentionBudgetIncidentState = z.infer<typeof AttentionBudgetIncidentStateSchema>;
export type AttentionMeasurementReportState = z.infer<typeof AttentionMeasurementReportStateSchema>;
export type AttentionDigestArtifactState = z.infer<typeof AttentionDigestArtifactStateSchema>;
export type PortfolioPolicyState = z.infer<typeof PortfolioPolicyStateSchema>;
export type IntegrationTargetState = z.infer<typeof IntegrationTargetStateSchema>;
export type PortfolioAdmissionState = z.infer<typeof PortfolioAdmissionStateSchema>;
export type ConcurrencyLeaseState = z.infer<typeof ConcurrencyLeaseStateSchema>;
export type CandidateDiffManifestState = z.infer<typeof CandidateDiffManifestStateSchema>;
export type IntegrationCandidateState = z.infer<typeof IntegrationCandidateStateSchema>;
export type IntegrationWorkState = z.infer<typeof IntegrationWorkStateSchema>;
export type IntegrationConflictState = z.infer<typeof IntegrationConflictStateSchema>;
export type IntegrationVerificationState = z.infer<typeof IntegrationVerificationStateSchema>;
export type PromotionReceiptState = z.infer<typeof PromotionReceiptStateSchema>;
export type PortfolioSloIncidentState = z.infer<typeof PortfolioSloIncidentStateSchema>;
export type PortfolioMeasurementReportState = z.infer<typeof PortfolioMeasurementReportStateSchema>;
export type PortfolioSnapshotV1 = z.infer<typeof PortfolioSnapshotV1Schema>;
export type AttentionSnapshotV1 = z.infer<typeof AttentionSnapshotV1Schema>;
export type AttentionSnapshotV2 = z.infer<typeof AttentionSnapshotV2Schema>;
export type DriverReceiptState = z.infer<typeof DriverReceiptStateSchema>;
export type ApprovalRequestState = z.infer<typeof ApprovalRequestStateSchema>;
export type StateEntity = z.infer<typeof StateEntitySchema>;

export { AdvisorSnapshotV1Schema };
