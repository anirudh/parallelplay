import { createHash, randomUUID } from "node:crypto";
import type {
  AttentionDeliveryState,
  AttentionPolicyBindingV1,
  Clock,
  CommandResult,
  Kernel
} from "@parallelplay/kernel";

export interface AttentionPageRequest {
  deliveryId: string;
  packetId: string;
  packetRevisionId: string;
  packetRevisionDigest: string;
  policyBinding: AttentionPolicyBindingV1;
  matchedRuleId: string | null;
  channel: "page";
  deepLink: string;
  idempotencyKey: string;
}

export interface AttentionPageReceipt {
  provider: string;
  externalId: string;
  acceptedAt: string;
  metadata: Record<string, string>;
}

export interface AttentionPageAdapter {
  readonly name: string;
  deliver(request: AttentionPageRequest): Promise<AttentionPageReceipt>;
}

export class PermanentAttentionDeliveryError extends Error {}

export interface AttentionDeliveryTick {
  action:
    | "idle"
    | "delivery_acquired"
    | "delivery_reclaimed"
    | "delivery_succeeded"
    | "delivery_retry_scheduled"
    | "delivery_permanently_failed"
    | "delivery_obsolete"
    | "command_rejected";
  occurredAt: string;
  supervisorId: string;
  deliveryId?: string;
  commandResult?: CommandResult;
  error?: string;
}

export interface AttentionDeliverySupervisorOptions {
  kernel: Kernel;
  adapter: AttentionPageAdapter;
  supervisorId: string;
  clock?: Clock;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  faultInjector?: (point: "after-lease" | "before-provider-call" | "after-provider-call") => void;
  onRecord?: (record: AttentionDeliveryTick) => void;
}

const systemClock: Clock = { now: () => new Date() };

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

function stableExternalId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ConformanceAttentionPageAdapter implements AttentionPageAdapter {
  readonly name = "conformance-fixture";
  readonly #clock: Clock;
  readonly #receipts = new Map<string, AttentionPageReceipt>();
  readonly #calls = new Map<string, number>();
  #transientFailuresRemaining: number;
  readonly #permanentFailure: boolean;

  constructor(
    options: {
      clock?: Clock;
      transientFailures?: number;
      permanentFailure?: boolean;
    } = {}
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#transientFailuresRemaining = options.transientFailures ?? 0;
    this.#permanentFailure = options.permanentFailure ?? false;
  }

  async deliver(request: AttentionPageRequest): Promise<AttentionPageReceipt> {
    this.#calls.set(request.idempotencyKey, (this.#calls.get(request.idempotencyKey) ?? 0) + 1);
    const existing = this.#receipts.get(request.idempotencyKey);
    if (existing) return existing;
    if (this.#permanentFailure) {
      throw new PermanentAttentionDeliveryError("Conformance adapter permanent failure");
    }
    if (this.#transientFailuresRemaining > 0) {
      this.#transientFailuresRemaining -= 1;
      throw new Error("Conformance adapter transient failure");
    }
    const receipt = {
      provider: this.name,
      externalId: stableExternalId(request.idempotencyKey),
      acceptedAt: this.#clock.now().toISOString(),
      metadata: { conformance: "true", channel: request.channel }
    };
    this.#receipts.set(request.idempotencyKey, receipt);
    return receipt;
  }

  callCount(idempotencyKey: string): number {
    return this.#calls.get(idempotencyKey) ?? 0;
  }
}

export class AttentionDeliverySupervisor {
  readonly #kernel: Kernel;
  readonly #adapter: AttentionPageAdapter;
  readonly #supervisorId: string;
  readonly #clock: Clock;
  readonly #leaseDurationMs: number;
  readonly #pollIntervalMs: number;
  readonly #faultInjector?: AttentionDeliverySupervisorOptions["faultInjector"];
  readonly #onRecord?: AttentionDeliverySupervisorOptions["onRecord"];

  constructor(options: AttentionDeliverySupervisorOptions) {
    this.#kernel = options.kernel;
    this.#adapter = options.adapter;
    this.#supervisorId = options.supervisorId;
    this.#clock = options.clock ?? systemClock;
    this.#leaseDurationMs = options.leaseDurationMs ?? 10_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    if (this.#leaseDurationMs < 1_000 || this.#leaseDurationMs > 3_660_000) {
      throw new TypeError("Attention delivery lease must be between 1000 and 3660000 ms");
    }
    if (options.faultInjector) this.#faultInjector = options.faultInjector;
    if (options.onRecord) this.#onRecord = options.onRecord;
  }

  async tick(): Promise<AttentionDeliveryTick> {
    const occurredAt = this.#clock.now().toISOString();
    const deliveries = await this.#kernel.listAttentionDeliveries();
    const owned = deliveries.find(
      (entry) =>
        entry.delivery.status === "leased" &&
        entry.delivery.leaseOwnerId === this.#supervisorId &&
        entry.delivery.leaseExpiresAt !== null &&
        entry.delivery.leaseExpiresAt > occurredAt
    );
    if (owned) return this.#deliver(owned, occurredAt);
    const expired = deliveries.find(
      (entry) =>
        entry.delivery.status === "leased" &&
        entry.delivery.leaseExpiresAt !== null &&
        entry.delivery.leaseExpiresAt <= occurredAt
    );
    if (expired) return this.#acquire(expired, true, occurredAt);
    const pending = deliveries.find(
      (entry) => entry.delivery.status === "pending" && entry.delivery.availableAt <= occurredAt
    );
    if (pending) return this.#acquire(pending, false, occurredAt);
    return this.#emit({ action: "idle", occurredAt, supervisorId: this.#supervisorId });
  }

  async run(options: { signal?: AbortSignal; maxTicks?: number } = {}): Promise<number> {
    let ticks = 0;
    while (
      !options.signal?.aborted &&
      (options.maxTicks === undefined || ticks < options.maxTicks)
    ) {
      await this.tick();
      ticks += 1;
      if (!options.signal?.aborted) await wait(this.#pollIntervalMs, options.signal);
    }
    return ticks;
  }

  async #acquire(
    entry: AttentionDeliveryState,
    reclaimed: boolean,
    occurredAt: string
  ): Promise<AttentionDeliveryTick> {
    const expectedToken = entry.delivery.leaseFencingToken + 1;
    const result = await this.#kernel.execute({
      type: "attention-delivery.lease.acquire",
      idempotencyKey: `attention-delivery-lease:${entry.delivery.deliveryId}:${String(expectedToken)}`,
      actor: { kind: "system", id: `attention-delivery-supervisor:${this.#supervisorId}` },
      payload: {
        schemaVersion: 1,
        deliveryId: entry.delivery.deliveryId,
        ownerId: this.#supervisorId,
        leaseDurationMs: this.#leaseDurationMs
      }
    });
    const tick: AttentionDeliveryTick = {
      action: result.ok
        ? reclaimed
          ? "delivery_reclaimed"
          : "delivery_acquired"
        : result.error.code === "ATTENTION_DELIVERY_NOT_CLAIMABLE"
          ? "delivery_obsolete"
          : "command_rejected",
      occurredAt,
      supervisorId: this.#supervisorId,
      deliveryId: entry.delivery.deliveryId,
      commandResult: result
    };
    if (result.ok) this.#faultInjector?.("after-lease");
    return this.#emit(tick);
  }

  async #deliver(
    entry: AttentionDeliveryState,
    occurredAt: string
  ): Promise<AttentionDeliveryTick> {
    const delivery = entry.delivery;
    const request: AttentionPageRequest = {
      deliveryId: delivery.deliveryId,
      packetId: delivery.packetId,
      packetRevisionId: delivery.packetRevisionId,
      packetRevisionDigest: delivery.packetRevisionDigest,
      policyBinding: delivery.policyBinding,
      matchedRuleId: delivery.matchedRuleId,
      channel: delivery.channel,
      deepLink: delivery.deepLink,
      idempotencyKey: delivery.idempotencyKey
    };
    this.#faultInjector?.("before-provider-call");
    let receipt: AttentionPageReceipt;
    try {
      receipt = await this.#adapter.deliver(request);
    } catch (error) {
      const permanent = error instanceof PermanentAttentionDeliveryError;
      const result = await this.#kernel.execute({
        type: "attention-delivery.fail",
        idempotencyKey: `attention-delivery-failure:${delivery.deliveryId}:${String(delivery.leaseFencingToken)}`,
        actor: { kind: "system", id: `attention-delivery-supervisor:${this.#supervisorId}` },
        payload: {
          schemaVersion: 1,
          deliveryId: delivery.deliveryId,
          ownerId: this.#supervisorId,
          fencingToken: delivery.leaseFencingToken,
          error: error instanceof Error ? error.message : "Attention page adapter failed",
          permanent
        }
      });
      const terminal =
        result.ok &&
        result.data.kind === "attention_delivery" &&
        result.data.delivery.status === "permanent_failure";
      return this.#emit({
        action: result.ok
          ? terminal
            ? "delivery_permanently_failed"
            : "delivery_retry_scheduled"
          : "delivery_obsolete",
        occurredAt,
        supervisorId: this.#supervisorId,
        deliveryId: delivery.deliveryId,
        commandResult: result,
        error: error instanceof Error ? error.message : "Attention page adapter failed"
      });
    }
    this.#faultInjector?.("after-provider-call");
    const result = await this.#kernel.execute({
      type: "attention-delivery.succeed",
      idempotencyKey: `attention-delivery-success:${delivery.deliveryId}:${String(delivery.leaseFencingToken)}`,
      actor: { kind: "system", id: `attention-delivery-supervisor:${this.#supervisorId}` },
      payload: {
        schemaVersion: 1,
        deliveryId: delivery.deliveryId,
        ownerId: this.#supervisorId,
        fencingToken: delivery.leaseFencingToken,
        receipt
      }
    });
    return this.#emit({
      action: result.ok ? "delivery_succeeded" : "delivery_obsolete",
      occurredAt,
      supervisorId: this.#supervisorId,
      deliveryId: delivery.deliveryId,
      commandResult: result
    });
  }

  #emit(record: AttentionDeliveryTick): AttentionDeliveryTick {
    this.#onRecord?.(record);
    return record;
  }
}

export function randomAttentionDeliverySupervisorId(): string {
  return randomUUID();
}
