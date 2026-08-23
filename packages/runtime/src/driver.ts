import { z } from "zod";
import type { ContextPacketV1, SourceRevisionState } from "@parallelplay/kernel";

const UUID = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9._-]*$/);
const RelativePath = z
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

const EventBaseV1 = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive()
};

export const DriverProtocolEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({ ...EventBaseV1, type: z.literal("started") }),
  z.strictObject({
    ...EventBaseV1,
    type: z.literal("usage"),
    cpuMillis: z.number().int().nonnegative(),
    memoryPeakBytes: z.number().int().nonnegative()
  }),
  z.strictObject({
    ...EventBaseV1,
    type: z.literal("artifact.declared"),
    path: RelativePath,
    role: Identifier
  }),
  z.strictObject({
    ...EventBaseV1,
    type: z.literal("capability.used"),
    capability: Identifier
  }),
  z.strictObject({
    ...EventBaseV1,
    type: z.literal("approval.requested"),
    requestId: UUID,
    capability: Identifier,
    reason: z.string().trim().min(1).max(1000)
  }),
  z.strictObject({
    ...EventBaseV1,
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
    detail: z.string().trim().min(1).max(1000).optional()
  })
]);

const EventBaseV2 = {
  schemaVersion: z.literal(2),
  sequence: z.number().int().positive()
};

export const DriverProtocolEventV2Schema = z.discriminatedUnion("type", [
  z.strictObject({ ...EventBaseV2, type: z.literal("started") }),
  z.strictObject({
    ...EventBaseV2,
    type: z.literal("usage"),
    cpuMillis: z.number().int().nonnegative(),
    memoryPeakBytes: z.number().int().nonnegative()
  }),
  z.strictObject({
    ...EventBaseV2,
    type: z.literal("artifact.declared"),
    path: RelativePath,
    role: Identifier
  }),
  z.strictObject({
    ...EventBaseV2,
    type: z.literal("capability.used"),
    capability: Identifier
  }),
  z.strictObject({
    ...EventBaseV2,
    type: z.literal("approval.requested"),
    requestId: UUID,
    capability: Identifier,
    reason: z.string().trim().min(1).max(1000)
  }),
  z.strictObject({
    ...EventBaseV2,
    type: z.literal("issue.raised"),
    originalText: z.string().trim().min(1).max(4000),
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
    ...EventBaseV2,
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
    detail: z.string().trim().min(1).max(1000).optional()
  })
]);

export const DriverProtocolEventSchema = z.union([
  DriverProtocolEventV2Schema,
  DriverProtocolEventV1Schema
]);

export const DriverEventBatchSchema = z
  .strictObject({
    afterSequence: z.number().int().nonnegative(),
    events: z.array(DriverProtocolEventSchema).max(4096),
    status: z.enum([
      "running",
      "succeeded",
      "failed",
      "approval_required",
      "capability_violation",
      "protocol_invalid",
      "operator_cancelled",
      "timed_out"
    ]),
    exitCode: z.number().int().min(0).max(255).nullable()
  })
  .superRefine((batch, context) => {
    let expected = batch.afterSequence + 1;
    let terminals = 0;
    for (const [index, event] of batch.events.entries()) {
      if (event.sequence !== expected) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: `Expected event sequence ${String(expected)}`
        });
      }
      expected += 1;
      if (event.type === "terminal") terminals += 1;
    }
    if (terminals > 1) {
      context.addIssue({ code: "custom", path: ["events"], message: "Multiple terminal events" });
    }
    const last = batch.events.at(-1);
    if (
      (batch.status === "succeeded" || batch.status === "failed") &&
      batch.events.length > 0 &&
      (last?.type !== "terminal" || terminals !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "A terminal inspection must end with exactly one terminal event"
      });
    }
    if (batch.status === "running" && terminals !== 0) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "A running inspection cannot contain a terminal event"
      });
    }
  });

export const DriverUsageSchema = z.strictObject({
  cpuMillis: z.number().int().nonnegative(),
  memoryPeakBytes: z.number().int().nonnegative()
});

export const DriverArtifactSchema = z.strictObject({
  path: RelativePath,
  role: Identifier,
  size: z.number().int().nonnegative().max(268_435_456),
  sha256: Digest
});

export const DriverApprovalSchema = z.strictObject({
  requestId: UUID,
  capability: Identifier,
  reason: z.string().trim().min(1).max(1000),
  sequence: z.number().int().positive()
});

export const DriverReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  driver: Identifier,
  driverVersion: z.string().trim().min(1).max(100),
  protocolVersion: z.literal(1),
  runId: UUID,
  jobId: UUID,
  attemptId: UUID,
  externalRunId: z.string().trim().min(1).max(500),
  image: z.string().trim().min(1).max(1000),
  baseRevisionId: UUID,
  baseRevisionDigest: Digest,
  candidateRevisionId: UUID.nullable(),
  candidateRevisionDigest: Digest.nullable(),
  executionContractDigest: Digest,
  capabilityManifestDigest: Digest,
  eventStreamDigest: Digest,
  eventCount: z.number().int().nonnegative().max(4096),
  usage: DriverUsageSchema,
  approvals: z.array(DriverApprovalSchema).max(256),
  capabilitiesUsed: z.array(Identifier).max(256),
  artifacts: z.array(DriverArtifactSchema).max(256),
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
  receiptDigest: Digest
});

const MonetaryCostSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("known"),
    amount: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    pricingSource: z.string().trim().min(1).max(500),
    pricingVersion: z.string().trim().min(1).max(200)
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().trim().min(1).max(500)
  })
]);

export const DriverReceiptV2Schema = DriverReceiptV1Schema.omit({
  schemaVersion: true,
  protocolVersion: true,
  usage: true
}).extend({
  schemaVersion: z.literal(2),
  protocolVersion: z.literal(2),
  contextPacketId: UUID,
  contextPacketDigest: Digest,
  usage: z.strictObject({
    cpuMillis: z.number().int().nonnegative(),
    memoryPeakBytes: z.number().int().nonnegative(),
    monetaryCost: MonetaryCostSchema
  })
});

export const DriverReceiptSchema = z.union([DriverReceiptV2Schema, DriverReceiptV1Schema]);

export interface LegacyLaunchRequest {
  driver?: "fake";
  capability: string;
  attemptId: string;
  jobId: string;
  runId: string;
}

export interface GenericCommandLaunchRequestV1 {
  driver: "generic-command";
  attemptId: string;
  attemptStartedAt: string;
  jobId: string;
  runId: string;
  baseRevisionId: string;
  baseRevision: SourceRevisionState;
  executionContract: {
    protocolVersion: 1;
    image: string;
    argv: string[];
    workingDirectory: "/workspace";
  };
  executionContractDigest: string;
  capabilityManifest: {
    schemaVersion: 1;
    workspace: "read_only" | "read_write";
    artifactOutput: "read_write";
    scratch: "read_write";
    cpuLimit: number;
    memoryLimitBytes: number;
    pidsLimit: number;
    network: [];
    secrets: [];
    git: [];
  };
  capabilityManifestDigest: string;
}

export interface GenericCommandLaunchRequestV2 {
  driver: "generic-command";
  attemptId: string;
  attemptStartedAt: string;
  jobId: string;
  runId: string;
  baseRevisionId: string;
  baseRevision: SourceRevisionState;
  executionContract: {
    protocolVersion: 2;
    image: string;
    argv: string[];
    workingDirectory: "/workspace";
    context: {
      target: "/context/context.json";
      contextPacketId: string;
      contextPacketDigest: string;
    };
  };
  executionContractDigest: string;
  capabilityManifest: {
    schemaVersion: 2;
    workspace: "read_only" | "read_write";
    artifactOutput: "read_write";
    scratch: "read_write";
    context: {
      access: "read_only";
      contextPacketId: string;
      contextPacketDigest: string;
    };
    cpuLimit: number;
    memoryLimitBytes: number;
    pidsLimit: number;
    network: [];
    secrets: [];
    git: [];
  };
  capabilityManifestDigest: string;
  contextPacket: ContextPacketV1;
  contextPacketDigest: string;
}

export type GenericCommandLaunchRequest =
  GenericCommandLaunchRequestV2 | GenericCommandLaunchRequestV1;

export type DriverStartRequest = LegacyLaunchRequest | GenericCommandLaunchRequest;
export type DriverProtocolEvent = z.infer<typeof DriverProtocolEventSchema>;
export type DriverEventBatch = z.infer<typeof DriverEventBatchSchema>;
export type DriverReceipt = z.infer<typeof DriverReceiptSchema>;
export type DriverUsage = z.infer<typeof DriverUsageSchema>;
export type DriverArtifact = z.infer<typeof DriverArtifactSchema>;
export type DriverApproval = z.infer<typeof DriverApprovalSchema>;

export interface DriverCandidateRevision {
  revisionId: string;
  repositoryId: string;
  objectFormat: "sha1" | "sha256";
  commitOid: string;
  treeOid: string;
  storageRef: string;
  revisionDigest: string;
}

export interface DriverReceiptCollection {
  schemaVersion: 1;
  driverReceiptId: string;
  artifactManifestId: string;
  candidateRevision: DriverCandidateRevision | null;
  receipt: DriverReceipt;
  entries: DriverArtifact[];
  events: DriverProtocolEvent[];
}

export interface AgentDriver {
  readonly name: string;
  start(effectKey: string, request: DriverStartRequest): Promise<string>;
  inspect(externalRunId: string, afterSequence: number): Promise<DriverEventBatch>;
  cancel(
    effectKey: string,
    externalRunId: string,
    reason: "operator_cancelled" | "timed_out" | "approval_required"
  ): Promise<"cancelled">;
  collectReceipt(externalRunId: string): Promise<DriverReceiptCollection>;
  close(): Promise<void>;
}

export class DriverRegistry {
  readonly #drivers: Map<AgentDriver["name"], AgentDriver>;

  constructor(drivers: AgentDriver[]) {
    for (const driver of drivers) {
      if (!/^[a-z][a-z0-9._-]{0,99}$/.test(driver.name)) {
        throw new Error(`Driver name ${driver.name} is invalid`);
      }
    }
    this.#drivers = new Map(drivers.map((driver) => [driver.name, driver]));
    if (this.#drivers.size !== drivers.length) throw new Error("Driver names must be unique");
  }

  get(name: AgentDriver["name"]): AgentDriver {
    const driver = this.#drivers.get(name);
    if (!driver) throw new Error(`Driver ${name} is not configured`);
    return driver;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#drivers.values()].map(async (driver) => driver.close()));
  }
}
