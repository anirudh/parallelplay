import { createHash } from "node:crypto";
import { z } from "zod";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function outboundReceiptDigest(
  receipt: Omit<OutboundEffectReceiptV1, "receiptDigest">
): string {
  return createHash("sha256").update(canonicalJson(receipt)).digest("hex");
}

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9._-]*$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const UuidSchema = z.uuid();
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const SemverSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/);
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "Path must be normalized and relative"
  );

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)])
);

export const SecretReferenceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  provider: z.literal("environment"),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  purpose: IdentifierSchema,
  allowedConsumer: IdentifierSchema
});
export type SecretReferenceV1 = z.infer<typeof SecretReferenceV1Schema>;

export interface SecretHandleV1 {
  readonly schemaVersion: 1;
  readonly handleId: string;
  readonly expiresAt: string;
  readonly purpose: string;
  readonly allowedConsumer: string;
}

export interface SecretProviderV1 {
  readonly name: string;
  issueHandle(
    reference: SecretReferenceV1,
    context: { runId: string; now: string }
  ): SecretHandleV1;
  revoke(handleId: string): void;
}

export const ExtensionKindSchema = z.enum(["driver", "workflow", "evaluator", "policy", "adapter"]);
export const ExtensionCapabilityV1Schema = z.strictObject({
  name: IdentifierSchema,
  required: z.boolean(),
  detail: z.string().trim().min(1).max(1000).optional()
});
export const ExtensionManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdentifierSchema,
  displayName: z.string().trim().min(1).max(200),
  extensionVersion: SemverSchema,
  kind: ExtensionKindSchema,
  contract: z.strictObject({
    name: z.enum([
      "agent-driver-v1",
      "workflow-extension-v1",
      "evaluator-extension-v1",
      "policy-extension-v1",
      "outbound-adapter-v1"
    ]),
    version: z.literal(1)
  }),
  artifact: z.strictObject({
    mediaType: z.enum([
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.parallelplay.builtin+json"
    ]),
    reference: z.string().trim().min(1).max(1000),
    sha256: DigestSchema
  }),
  configurationSchemaDigest: DigestSchema,
  capabilities: z.array(ExtensionCapabilityV1Schema).max(64),
  provenance: z.strictObject({
    sourceRepository: z.url().max(1000),
    sourceRevision: z.string().trim().min(1).max(200),
    sbomDigest: DigestSchema,
    attestationDigest: DigestSchema
  }),
  conformance: z.strictObject({
    suiteVersion: SemverSchema,
    reportDigest: DigestSchema,
    approvedRegistryDigest: DigestSchema.nullable()
  })
});
export type ExtensionManifestV1 = z.infer<typeof ExtensionManifestV1Schema>;

export const CapabilityManifestV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  workspace: z.enum(["read_only", "read_write"]),
  artifactOutput: z.literal("read_write"),
  scratch: z.literal("read_write"),
  context: z.strictObject({ access: z.literal("read_only"), digest: DigestSchema }),
  resources: z.strictObject({
    cpuLimit: z.number().positive().max(16),
    memoryLimitBytes: z.number().int().positive().max(17_179_869_184),
    pidsLimit: z.number().int().positive().max(4096),
    wallTimeMs: z.number().int().positive().max(86_400_000)
  }),
  network: z
    .array(
      z.strictObject({
        broker: IdentifierSchema,
        provider: z.enum(["openai", "anthropic"]),
        purpose: z.literal("provider_api"),
        allowedModels: z.array(z.string().trim().min(1).max(200)).min(1).max(32)
      })
    )
    .max(1),
  secretHandles: z.array(IdentifierSchema).max(4),
  git: z.array(z.never()).max(0)
});
export type CapabilityManifestV3 = z.infer<typeof CapabilityManifestV3Schema>;

const DriverEventBaseV1 = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  occurredAt: IsoDateTimeSchema
};
export const DriverProtocolEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({ ...DriverEventBaseV1, type: z.literal("started") }),
  z.strictObject({
    ...DriverEventBaseV1,
    type: z.literal("usage"),
    provider: z.enum(["local", "openai", "anthropic"]),
    requestedModel: z.string().trim().min(1).max(200).nullable(),
    observedModel: z.string().trim().min(1).max(200).nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    monetaryCost: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("known"),
        amount: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
        pricingSource: z.string().trim().min(1).max(500)
      }),
      z.strictObject({
        status: z.literal("unavailable"),
        reason: z.string().trim().min(1).max(500)
      })
    ])
  }),
  z.strictObject({
    ...DriverEventBaseV1,
    type: z.literal("artifact.declared"),
    path: RelativePathSchema,
    role: IdentifierSchema,
    size: z.number().int().nonnegative().max(268_435_456),
    sha256: DigestSchema
  }),
  z.strictObject({
    ...DriverEventBaseV1,
    type: z.literal("capability.used"),
    capability: IdentifierSchema
  }),
  z.strictObject({
    ...DriverEventBaseV1,
    type: z.literal("approval.requested"),
    requestId: UuidSchema,
    capability: IdentifierSchema,
    reason: z.string().trim().min(1).max(1000)
  }),
  z.strictObject({
    ...DriverEventBaseV1,
    type: z.literal("checkpoint"),
    checkpointDigest: DigestSchema
  }),
  z.strictObject({
    ...DriverEventBaseV1,
    type: z.literal("terminal"),
    outcome: z.enum([
      "succeeded",
      "failed",
      "approval_required",
      "capability_violation",
      "protocol_invalid",
      "operator_cancelled",
      "timed_out"
    ]),
    reason: z.string().trim().min(1).max(1000)
  })
]);
export type DriverProtocolEventV1 = z.infer<typeof DriverProtocolEventV1Schema>;

export const DriverLaunchV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  effectKey: z.string().trim().min(1).max(500),
  runId: UuidSchema,
  jobId: UuidSchema,
  attemptId: UuidSchema,
  contextDigest: DigestSchema,
  executionContractDigest: DigestSchema,
  capabilityManifest: CapabilityManifestV3Schema,
  capabilityManifestDigest: DigestSchema,
  prompt: z.string().min(1).max(1_000_000),
  requestedModel: z.string().trim().min(1).max(200).nullable()
});
export const DriverResumeV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  effectKey: z.string().trim().min(1).max(500),
  sessionId: z.string().trim().min(1).max(500),
  checkpointDigest: DigestSchema,
  contextDigest: DigestSchema,
  executionContractDigest: DigestSchema,
  capabilityManifestDigest: DigestSchema
});
export const DriverSessionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  driverId: IdentifierSchema,
  driverVersion: SemverSchema,
  sessionId: z.string().trim().min(1).max(500),
  externalRunId: z.string().trim().min(1).max(500),
  startedAt: IsoDateTimeSchema,
  checkpointDigest: DigestSchema.nullable()
});
export const DriverInspectV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: z.string().trim().min(1).max(500),
  afterSequence: z.number().int().nonnegative()
});
export const DriverEventBatchV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    afterSequence: z.number().int().nonnegative(),
    events: z.array(DriverProtocolEventV1Schema).max(4096),
    status: z.enum([
      "running",
      "succeeded",
      "failed",
      "approval_required",
      "capability_violation",
      "protocol_invalid",
      "operator_cancelled",
      "timed_out"
    ])
  })
  .superRefine((batch, context) => {
    let expected = batch.afterSequence + 1;
    for (const [index, event] of batch.events.entries()) {
      if (event.sequence !== expected) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: `Expected sequence ${String(expected)}`
        });
      }
      expected += 1;
    }
    const terminals = batch.events.filter((event) => event.type === "terminal");
    if (terminals.length > 1) {
      context.addIssue({ code: "custom", path: ["events"], message: "Multiple terminal events" });
    }
    if (batch.status === "running" && terminals.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "Running batch contains a terminal event"
      });
    }
  });
export const DriverCancelV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  effectKey: z.string().trim().min(1).max(500),
  sessionId: z.string().trim().min(1).max(500),
  reason: z.enum(["operator_cancelled", "timed_out", "approval_required"])
});
export const DriverReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  driverId: IdentifierSchema,
  driverVersion: SemverSchema,
  sdkVersion: SemverSchema.nullable(),
  sessionId: z.string().trim().min(1).max(500),
  externalRunId: z.string().trim().min(1).max(500),
  requestedModel: z.string().trim().min(1).max(200).nullable(),
  observedModels: z.array(z.string().trim().min(1).max(200)).max(16),
  contextDigest: DigestSchema,
  executionContractDigest: DigestSchema,
  capabilityManifestDigest: DigestSchema,
  eventStreamDigest: DigestSchema,
  rawStreamDigest: DigestSchema,
  checkpointDigest: DigestSchema.nullable(),
  outcome: z.enum([
    "succeeded",
    "failed",
    "approval_required",
    "capability_violation",
    "protocol_invalid",
    "operator_cancelled",
    "timed_out"
  ]),
  terminalReason: z.string().trim().min(1).max(1000),
  completedAt: IsoDateTimeSchema
});

export type DriverLaunchV1 = z.infer<typeof DriverLaunchV1Schema>;
export type DriverResumeV1 = z.infer<typeof DriverResumeV1Schema>;
export type DriverSessionV1 = z.infer<typeof DriverSessionV1Schema>;
export type DriverInspectV1 = z.infer<typeof DriverInspectV1Schema>;
export type DriverEventBatchV1 = z.infer<typeof DriverEventBatchV1Schema>;
export type DriverCancelV1 = z.infer<typeof DriverCancelV1Schema>;
export type DriverReceiptV1 = z.infer<typeof DriverReceiptV1Schema>;

export interface AgentDriverV1 {
  readonly manifest: ExtensionManifestV1;
  start(request: DriverLaunchV1): Promise<DriverSessionV1>;
  resume(request: DriverResumeV1): Promise<DriverSessionV1>;
  inspect(request: DriverInspectV1): Promise<DriverEventBatchV1>;
  cancel(request: DriverCancelV1): Promise<{ status: "cancelled"; receiptDigest: string }>;
  collectReceipt(sessionId: string): Promise<DriverReceiptV1>;
  close(): Promise<void>;
}

export const WorkflowExtensionRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  profileId: IdentifierSchema,
  intentDigest: DigestSchema,
  milestones: z
    .array(
      z.strictObject({
        id: IdentifierSchema,
        title: z.string().trim().min(1).max(300),
        dependencies: z.array(IdentifierSchema).max(64),
        criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(64)
      })
    )
    .min(1)
    .max(256)
});
export const WorkflowExtensionResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  accepted: z.boolean(),
  compilerDigest: DigestSchema,
  workflowDigest: DigestSchema.nullable(),
  normalized: JsonValueSchema.nullable(),
  errors: z
    .array(z.strictObject({ code: IdentifierSchema, message: z.string().max(1000) }))
    .max(256)
});
export type WorkflowExtensionRequestV1 = z.infer<typeof WorkflowExtensionRequestV1Schema>;
export type WorkflowExtensionResultV1 = z.infer<typeof WorkflowExtensionResultV1Schema>;
export interface WorkflowExtensionV1 {
  readonly manifest: ExtensionManifestV1;
  compile(request: WorkflowExtensionRequestV1): Promise<WorkflowExtensionResultV1>;
}

export const EvaluatorExtensionRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  subjectDigest: DigestSchema,
  evidenceDigest: DigestSchema,
  evidence: JsonValueSchema,
  evaluatorConfigurationDigest: DigestSchema
});
export const EvaluatorExtensionResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  evaluatorDigest: DigestSchema,
  evidenceDigest: DigestSchema,
  passed: z.boolean(),
  report: JsonValueSchema,
  reportDigest: DigestSchema
});
export type EvaluatorExtensionRequestV1 = z.infer<typeof EvaluatorExtensionRequestV1Schema>;
export type EvaluatorExtensionResultV1 = z.infer<typeof EvaluatorExtensionResultV1Schema>;
export interface EvaluatorExtensionV1 {
  readonly manifest: ExtensionManifestV1;
  evaluate(request: EvaluatorExtensionRequestV1): Promise<EvaluatorExtensionResultV1>;
}

export const AutomaticActionKindSchema = z.enum([
  "attention.reprioritize",
  "record.approve",
  "github.check.upsert",
  "github.label.upsert",
  "github.comment.create",
  "github.candidate-branch.create",
  "github.draft-pr.create",
  "github.draft-pr.update",
  "notification.desktop.deliver",
  "notification.webhook.deliver",
  "merge",
  "ready-for-review",
  "release",
  "deploy",
  "scope.accept",
  "graph.accept",
  "outcome.accept",
  "policy.promote",
  "permission.change",
  "secret.change",
  "capability.expand"
]);
export type AutomaticActionKind = z.infer<typeof AutomaticActionKindSchema>;
export const AUTOMATIC_ACTION_ALLOWLIST = new Set<AutomaticActionKind>([
  "attention.reprioritize",
  "record.approve",
  "github.check.upsert",
  "github.label.upsert",
  "github.comment.create",
  "github.candidate-branch.create",
  "github.draft-pr.create",
  "github.draft-pr.update",
  "notification.desktop.deliver",
  "notification.webhook.deliver"
]);
export function isAutomaticActionAllowed(action: AutomaticActionKind): boolean {
  return AUTOMATIC_ACTION_ALLOWLIST.has(action);
}

export const PolicyExtensionRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  policyDigest: DigestSchema,
  evidenceDigest: DigestSchema,
  proposedAction: AutomaticActionKindSchema,
  risk: z.enum(["low", "medium", "high", "safety_critical"]),
  irreversible: z.boolean(),
  externalEffect: z.boolean()
});
export const PolicyExtensionResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  decision: z.enum(["deny", "recommend", "allow_within_global_ceiling"]),
  policyDigest: DigestSchema,
  evidenceDigest: DigestSchema,
  proposedAction: AutomaticActionKindSchema,
  rationale: z.string().trim().min(1).max(2000)
});
export type PolicyExtensionRequestV1 = z.infer<typeof PolicyExtensionRequestV1Schema>;
export type PolicyExtensionResultV1 = z.infer<typeof PolicyExtensionResultV1Schema>;
export interface PolicyExtensionV1 {
  readonly manifest: ExtensionManifestV1;
  decide(request: PolicyExtensionRequestV1): Promise<PolicyExtensionResultV1>;
}

export const OutboundEffectRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  adapterId: IdentifierSchema,
  effectKey: z.string().trim().min(1).max(500),
  action: AutomaticActionKindSchema,
  target: z.string().trim().min(1).max(1000),
  payload: JsonValueSchema,
  payloadDigest: DigestSchema,
  preconditionDigest: DigestSchema,
  policyPromotionDigest: DigestSchema
});
export const OutboundEffectReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  adapterId: IdentifierSchema,
  effectKey: z.string().trim().min(1).max(500),
  action: AutomaticActionKindSchema,
  payloadDigest: DigestSchema,
  externalId: z.string().trim().min(1).max(1000),
  requestId: z.string().trim().min(1).max(1000).nullable(),
  observedStateDigest: DigestSchema,
  acceptedAt: IsoDateTimeSchema,
  receiptDigest: DigestSchema
});
export const OutboundReconciliationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  effectKey: z.string().trim().min(1).max(500),
  status: z.enum(["not_observed", "observed_exact", "observed_conflict"]),
  externalId: z.string().trim().min(1).max(1000).nullable(),
  observedStateDigest: DigestSchema.nullable()
});
export const OutboundReconcileRequestV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    effect: OutboundEffectRequestV1Schema,
    priorReceipt: OutboundEffectReceiptV1Schema.nullable()
  })
  .superRefine((request, context) => {
    const receipt = request.priorReceipt;
    if (!receipt) return;
    const bindings = [
      ["adapterId", receipt.adapterId, request.effect.adapterId],
      ["effectKey", receipt.effectKey, request.effect.effectKey],
      ["action", receipt.action, request.effect.action],
      ["payloadDigest", receipt.payloadDigest, request.effect.payloadDigest]
    ] as const;
    for (const [field, actual, expected] of bindings) {
      if (actual !== expected) {
        context.addIssue({
          code: "custom",
          path: ["priorReceipt", field],
          message: `Prior receipt ${field} is not bound to the requested effect`
        });
      }
    }
    const { receiptDigest, ...unsigned } = receipt;
    if (outboundReceiptDigest(unsigned) !== receiptDigest) {
      context.addIssue({
        code: "custom",
        path: ["priorReceipt", "receiptDigest"],
        message: "Prior receipt digest is invalid"
      });
    }
  });
export type OutboundEffectRequestV1 = z.infer<typeof OutboundEffectRequestV1Schema>;
export type OutboundEffectReceiptV1 = z.infer<typeof OutboundEffectReceiptV1Schema>;
export type OutboundReconcileRequestV1 = z.infer<typeof OutboundReconcileRequestV1Schema>;
export type OutboundReconciliationV1 = z.infer<typeof OutboundReconciliationV1Schema>;
export interface OutboundAdapterV1 {
  readonly manifest: ExtensionManifestV1;
  deliver(request: OutboundEffectRequestV1): Promise<OutboundEffectReceiptV1>;
  reconcile(request: OutboundReconcileRequestV1): Promise<OutboundReconciliationV1>;
  close(): Promise<void>;
}

export interface OutboundAuthorityV1 {
  authorize(
    request: OutboundEffectRequestV1
  ): Promise<{ status: "authorized"; authorizationDigest: string }>;
  recordReceipt(request: OutboundEffectRequestV1, receipt: OutboundEffectReceiptV1): Promise<void>;
  recordFailure(
    request: OutboundEffectRequestV1,
    failure: { retryable: boolean; reason: string }
  ): Promise<void>;
}
