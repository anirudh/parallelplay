import { randomUUID } from "node:crypto";
import {
  AutomaticActionKindSchema,
  OutboundEffectReceiptV1Schema,
  OutboundEffectRequestV1Schema,
  isAutomaticActionAllowed,
  type AutomaticActionKind,
  type OutboundAuthorityV1,
  type OutboundEffectReceiptV1,
  type OutboundEffectRequestV1
} from "@parallelplay/contracts";
import { z } from "zod";
import { canonicalDigest, canonicalJson } from "./canonical.js";
import { assertMigrationsCurrent, openDatabase, systemClock } from "./database.js";
import type { Clock, SqliteDatabase } from "./database.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const OperatorSchema = z.strictObject({
  kind: z.literal("operator"),
  id: z.string().trim().min(1).max(200)
});

export const OutboundPolicyV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  policyRevisionId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  allowedActions: z.array(AutomaticActionKindSchema).min(1).max(32),
  targets: z.array(z.string().trim().min(1).max(1000)).min(1).max(128),
  expiresAt: TimestampSchema
});
export type OutboundPolicyV1 = z.infer<typeof OutboundPolicyV1Schema>;

export interface OutboundPolicyPromotionV1 {
  schemaVersion: 1;
  policy: OutboundPolicyV1;
  policyDigest: string;
  promotionDigest: string;
  promotedBy: string;
  promotedAt: string;
  status: "active" | "suspended";
  suspendedAt: string | null;
  suspensionReason: string | null;
}

interface EffectState {
  request: OutboundEffectRequestV1;
  requestDigest: string;
  authorizationDigest: string;
  authorizedAt: string;
  status: "authorized" | "delivered" | "failed";
  receipt: OutboundEffectReceiptV1 | null;
  failureCount: number;
  lastFailure: { retryable: boolean; reason: string; occurredAt: string } | null;
}

export interface OutboundAuthoritySnapshotV1 {
  schemaVersion: 1;
  throughPosition: number;
  policies: OutboundPolicyPromotionV1[];
  effects: {
    effectKey: string;
    requestDigest: string;
    authorizationDigest: string;
    status: EffectState["status"];
    receiptDigest: string | null;
    failureCount: number;
  }[];
  eventDigest: string;
}

const AuthorityEventSchema = z.discriminatedUnion("eventType", [
  z.strictObject({
    eventType: z.literal("policy.promoted"),
    data: z.strictObject({
      policy: OutboundPolicyV1Schema,
      policyDigest: DigestSchema,
      promotionDigest: DigestSchema,
      promotedBy: z.string().trim().min(1).max(200),
      promotedAt: TimestampSchema
    })
  }),
  z.strictObject({
    eventType: z.literal("policy.suspended"),
    data: z.strictObject({
      promotionDigest: DigestSchema,
      suspendedAt: TimestampSchema,
      reason: z.string().trim().min(1).max(2000)
    })
  }),
  z.strictObject({
    eventType: z.literal("effect.authorized"),
    data: z.strictObject({
      request: OutboundEffectRequestV1Schema,
      requestDigest: DigestSchema,
      authorizationDigest: DigestSchema,
      authorizedAt: TimestampSchema
    })
  }),
  z.strictObject({
    eventType: z.literal("effect.receipt-recorded"),
    data: z.strictObject({
      effectKey: z.string().trim().min(1).max(500),
      requestDigest: DigestSchema,
      receipt: OutboundEffectReceiptV1Schema,
      recordedAt: TimestampSchema
    })
  }),
  z.strictObject({
    eventType: z.literal("effect.failed"),
    data: z.strictObject({
      effectKey: z.string().trim().min(1).max(500),
      requestDigest: DigestSchema,
      retryable: z.boolean(),
      reason: z.string().trim().min(1).max(2000),
      occurredAt: TimestampSchema
    })
  })
]);

interface StoredAuthorityEvent {
  globalPosition: number;
  eventId: string;
  eventType: z.infer<typeof AuthorityEventSchema>["eventType"];
  streamId: string;
  data: z.infer<typeof AuthorityEventSchema>["data"];
  occurredAt: string;
}

interface ReplayedAuthority {
  throughPosition: number;
  policies: Map<string, OutboundPolicyPromotionV1>;
  effects: Map<string, EffectState>;
  eventDigest: string;
}

export interface OpenOutboundAuthorityOptions {
  databasePath: string;
  clock?: Clock;
  suspensionThreshold?: number;
}

function loadEvents(database: SqliteDatabase): StoredAuthorityEvent[] {
  const rows = database
    .prepare(
      `SELECT global_position AS globalPosition, event_id AS eventId, event_type AS eventType,
              stream_id AS streamId, data_json AS dataJson, occurred_at AS occurredAt
       FROM outbound_authority_events ORDER BY global_position`
    )
    .all() as {
    globalPosition: number;
    eventId: string;
    eventType: string;
    streamId: string;
    dataJson: string;
    occurredAt: string;
  }[];
  return rows.map((row) => {
    const parsed = AuthorityEventSchema.parse({
      eventType: row.eventType,
      data: JSON.parse(row.dataJson) as unknown
    });
    return { ...row, eventType: parsed.eventType, data: parsed.data };
  });
}

function replay(events: StoredAuthorityEvent[]): ReplayedAuthority {
  const policies = new Map<string, OutboundPolicyPromotionV1>();
  const effects = new Map<string, EffectState>();
  for (const event of events) {
    switch (event.eventType) {
      case "policy.promoted": {
        const data = AuthorityEventSchema.options[0].parse({
          eventType: event.eventType,
          data: event.data
        }).data;
        if (canonicalDigest(data.policy) !== data.policyDigest)
          throw new Error("Outbound policy digest drift");
        policies.set(data.promotionDigest, {
          schemaVersion: 1,
          ...data,
          status: "active",
          suspendedAt: null,
          suspensionReason: null
        });
        break;
      }
      case "policy.suspended": {
        const data = AuthorityEventSchema.options[1].parse({
          eventType: event.eventType,
          data: event.data
        }).data;
        const policy = policies.get(data.promotionDigest);
        if (!policy) throw new Error("Outbound policy suspension references an unknown promotion");
        policies.set(data.promotionDigest, {
          ...policy,
          status: "suspended",
          suspendedAt: data.suspendedAt,
          suspensionReason: data.reason
        });
        break;
      }
      case "effect.authorized": {
        const data = AuthorityEventSchema.options[2].parse({
          eventType: event.eventType,
          data: event.data
        }).data;
        if (canonicalDigest(data.request) !== data.requestDigest)
          throw new Error("Outbound request digest drift");
        effects.set(data.request.effectKey, {
          request: data.request,
          requestDigest: data.requestDigest,
          authorizationDigest: data.authorizationDigest,
          authorizedAt: data.authorizedAt,
          status: "authorized",
          receipt: null,
          failureCount: 0,
          lastFailure: null
        });
        break;
      }
      case "effect.receipt-recorded": {
        const data = AuthorityEventSchema.options[3].parse({
          eventType: event.eventType,
          data: event.data
        }).data;
        const effect = effects.get(data.effectKey);
        if (effect?.requestDigest !== data.requestDigest)
          throw new Error("Outbound receipt binding drift");
        effects.set(data.effectKey, { ...effect, status: "delivered", receipt: data.receipt });
        break;
      }
      case "effect.failed": {
        const data = AuthorityEventSchema.options[4].parse({
          eventType: event.eventType,
          data: event.data
        }).data;
        const effect = effects.get(data.effectKey);
        if (effect?.requestDigest !== data.requestDigest)
          throw new Error("Outbound failure binding drift");
        effects.set(data.effectKey, {
          ...effect,
          status: data.retryable ? "authorized" : "failed",
          failureCount: effect.failureCount + 1,
          lastFailure: {
            retryable: data.retryable,
            reason: data.reason,
            occurredAt: data.occurredAt
          }
        });
        break;
      }
    }
  }
  return {
    throughPosition: events.at(-1)?.globalPosition ?? 0,
    policies,
    effects,
    eventDigest: canonicalDigest(events)
  };
}

export class SqliteOutboundAuthority implements OutboundAuthorityV1 {
  readonly #database: SqliteDatabase;
  readonly #clock: Clock;
  readonly #suspensionThreshold: number;
  #closed = false;

  private constructor(database: SqliteDatabase, clock: Clock, suspensionThreshold: number) {
    this.#database = database;
    this.#clock = clock;
    this.#suspensionThreshold = suspensionThreshold;
  }

  static open(options: OpenOutboundAuthorityOptions): SqliteOutboundAuthority {
    assertMigrationsCurrent(options.databasePath);
    return new SqliteOutboundAuthority(
      openDatabase(options.databasePath),
      options.clock ?? systemClock,
      options.suspensionThreshold ?? 3
    );
  }

  promotePolicy(
    rawPolicy: OutboundPolicyV1,
    rawActor: { kind: "operator"; id: string }
  ): OutboundPolicyPromotionV1 {
    this.#assertOpen();
    const policy = OutboundPolicyV1Schema.parse(rawPolicy);
    const actor = OperatorSchema.parse(rawActor);
    const actions = [...new Set(policy.allowedActions)];
    if (actions.length !== policy.allowedActions.length)
      throw new Error("Outbound policy actions must be unique");
    for (const action of actions) {
      if (!isAutomaticActionAllowed(action)) {
        throw new Error(`Outbound policy cannot exceed the global authority ceiling: ${action}`);
      }
    }
    const targets = [...new Set(policy.targets)];
    if (targets.length !== policy.targets.length)
      throw new Error("Outbound policy targets must be unique");
    const promotedAt = this.#clock.now().toISOString();
    if (policy.expiresAt <= promotedAt)
      throw new Error("Outbound policy must expire in the future");
    const state = replay(loadEvents(this.#database));
    for (const existing of state.policies.values()) {
      if (existing.policy.policyRevisionId === policy.policyRevisionId) {
        if (canonicalDigest(existing.policy) !== canonicalDigest(policy)) {
          throw new Error("Outbound policy revision is immutable");
        }
        return existing;
      }
    }
    const policyDigest = canonicalDigest(policy);
    const promotionDigest = canonicalDigest({ policyDigest, promotedBy: actor.id, promotedAt });
    this.#append(
      "policy.promoted",
      policy.policyRevisionId,
      {
        policy,
        policyDigest,
        promotionDigest,
        promotedBy: actor.id,
        promotedAt
      },
      promotedAt
    );
    const promoted = replay(loadEvents(this.#database)).policies.get(promotionDigest);
    if (!promoted) throw new Error("Outbound policy promotion was not recorded");
    return promoted;
  }

  suspendPolicy(promotionDigest: string, reason: string): void {
    this.#assertOpen();
    const state = replay(loadEvents(this.#database));
    const policy = state.policies.get(DigestSchema.parse(promotionDigest));
    if (!policy) throw new Error("Outbound policy promotion does not exist");
    if (policy.status === "suspended") return;
    const occurredAt = this.#clock.now().toISOString();
    this.#append(
      "policy.suspended",
      policy.policy.policyRevisionId,
      {
        promotionDigest,
        suspendedAt: occurredAt,
        reason: z.string().trim().min(1).max(2000).parse(reason)
      },
      occurredAt
    );
  }

  async authorize(
    rawRequest: OutboundEffectRequestV1
  ): Promise<{ status: "authorized"; authorizationDigest: string }> {
    this.#assertOpen();
    const request = OutboundEffectRequestV1Schema.parse(rawRequest);
    if (!isAutomaticActionAllowed(request.action)) {
      throw new Error(
        `Outbound action is outside the non-configurable global authority ceiling: ${request.action}`
      );
    }
    const state = replay(loadEvents(this.#database));
    const requestDigest = canonicalDigest(request);
    const prior = state.effects.get(request.effectKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        throw new Error("Outbound effect key was reused with different input");
      if (prior.status === "failed")
        throw new Error("Outbound effect previously failed terminally");
      return { status: "authorized", authorizationDigest: prior.authorizationDigest };
    }
    const policy = state.policies.get(request.policyPromotionDigest);
    const now = this.#clock.now().toISOString();
    if (policy?.status !== "active") throw new Error("Outbound policy is not active");
    if (policy.policy.expiresAt <= now) throw new Error("Outbound policy is expired");
    if (!policy.policy.allowedActions.includes(request.action))
      throw new Error("Outbound action is not policy-approved");
    if (!policy.policy.targets.includes(request.target))
      throw new Error("Outbound target is not policy-approved");
    const authorizationDigest = canonicalDigest({
      requestDigest,
      policyPromotionDigest: request.policyPromotionDigest,
      now
    });
    this.#append(
      "effect.authorized",
      request.effectKey,
      { request, requestDigest, authorizationDigest, authorizedAt: now },
      now
    );
    return { status: "authorized", authorizationDigest };
  }

  async recordReceipt(
    rawRequest: OutboundEffectRequestV1,
    rawReceipt: OutboundEffectReceiptV1
  ): Promise<void> {
    this.#assertOpen();
    const request = OutboundEffectRequestV1Schema.parse(rawRequest);
    const receipt = OutboundEffectReceiptV1Schema.parse(rawReceipt);
    const requestDigest = canonicalDigest(request);
    const { receiptDigest, ...unsigned } = receipt;
    if (canonicalDigest(unsigned) !== receiptDigest)
      throw new Error("Outbound receipt digest is invalid");
    if (
      receipt.adapterId !== request.adapterId ||
      receipt.effectKey !== request.effectKey ||
      receipt.action !== request.action ||
      receipt.payloadDigest !== request.payloadDigest
    ) {
      throw new Error("Outbound receipt does not match the authorized request");
    }
    const state = replay(loadEvents(this.#database));
    const effect = state.effects.get(request.effectKey);
    if (effect?.requestDigest !== requestDigest)
      throw new Error("Outbound effect was not authorized");
    if (effect.receipt) {
      if (effect.receipt.receiptDigest !== receiptDigest)
        throw new Error("Outbound receipt conflicts with prior evidence");
      return;
    }
    const occurredAt = this.#clock.now().toISOString();
    this.#append(
      "effect.receipt-recorded",
      request.effectKey,
      { effectKey: request.effectKey, requestDigest, receipt, recordedAt: occurredAt },
      occurredAt
    );
  }

  async recordFailure(
    rawRequest: OutboundEffectRequestV1,
    rawFailure: { retryable: boolean; reason: string }
  ): Promise<void> {
    this.#assertOpen();
    const request = OutboundEffectRequestV1Schema.parse(rawRequest);
    const failure = z
      .strictObject({ retryable: z.boolean(), reason: z.string().trim().min(1).max(2000) })
      .parse(rawFailure);
    const requestDigest = canonicalDigest(request);
    const state = replay(loadEvents(this.#database));
    const effect = state.effects.get(request.effectKey);
    if (effect?.requestDigest !== requestDigest)
      throw new Error("Outbound effect was not authorized");
    if (effect.receipt) return;
    const occurredAt = this.#clock.now().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#append(
        "effect.failed",
        request.effectKey,
        {
          effectKey: request.effectKey,
          requestDigest,
          retryable: failure.retryable,
          reason: failure.reason,
          occurredAt
        },
        occurredAt
      );
      if (!failure.retryable || effect.failureCount + 1 >= this.#suspensionThreshold) {
        const policy = state.policies.get(request.policyPromotionDigest);
        if (policy?.status === "active") {
          this.#append(
            "policy.suspended",
            policy.policy.policyRevisionId,
            {
              promotionDigest: request.policyPromotionDigest,
              suspendedAt: occurredAt,
              reason: `Fail-safe suspension after outbound effect failure: ${failure.reason}`.slice(
                0,
                2000
              )
            },
            occurredAt
          );
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot(): OutboundAuthoritySnapshotV1 {
    this.#assertOpen();
    const state = replay(loadEvents(this.#database));
    return {
      schemaVersion: 1,
      throughPosition: state.throughPosition,
      policies: [...state.policies.values()].sort((left, right) =>
        left.promotionDigest.localeCompare(right.promotionDigest)
      ),
      effects: [...state.effects.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([effectKey, effect]) => ({
          effectKey,
          requestDigest: effect.requestDigest,
          authorizationDigest: effect.authorizationDigest,
          status: effect.status,
          receiptDigest: effect.receipt?.receiptDigest ?? null,
          failureCount: effect.failureCount
        })),
      eventDigest: state.eventDigest
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #append(
    eventType: z.infer<typeof AuthorityEventSchema>["eventType"],
    streamId: string,
    data: z.infer<typeof AuthorityEventSchema>["data"],
    occurredAt: string
  ): void {
    const parsed = AuthorityEventSchema.parse({ eventType, data });
    this.#database
      .prepare(
        `INSERT INTO outbound_authority_events
           (event_id, event_type, stream_id, data_json, occurred_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), parsed.eventType, streamId, canonicalJson(parsed.data), occurredAt);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Outbound authority is closed");
  }
}

export function allowedOutboundActions(actions: AutomaticActionKind[]): AutomaticActionKind[] {
  return actions.filter((action) => isAutomaticActionAllowed(action));
}
