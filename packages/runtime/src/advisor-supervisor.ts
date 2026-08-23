import { randomUUID } from "node:crypto";
import type { AdvisorInvocationState, CommandResult, Kernel } from "@parallelplay/kernel";
import type { AdvisorAdapter } from "./advisor-driver.js";

const wait = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
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

export interface AdvisorSupervisorOptions {
  kernel: Kernel;
  adapter: AdvisorAdapter;
  supervisorId: string;
  clock?: { now(): Date };
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  onRecord?: (record: AdvisorSupervisorTick) => void;
}

export interface AdvisorSupervisorTick {
  action:
    | "idle"
    | "invocation_acquired"
    | "invocation_reclaimed"
    | "invocation_succeeded"
    | "invocation_retry_scheduled"
    | "invocation_failed"
    | "invocation_obsolete"
    | "command_rejected";
  occurredAt: string;
  supervisorId: string;
  invocationId?: string;
  commandResult?: CommandResult;
  error?: string;
}

export class AdvisorSupervisor {
  readonly #kernel: Kernel;
  readonly #adapter: AdvisorAdapter;
  readonly #supervisorId: string;
  readonly #clock: { now(): Date };
  readonly #leaseDurationMs: number;
  readonly #pollIntervalMs: number;
  readonly #onRecord?: (record: AdvisorSupervisorTick) => void;

  constructor(options: AdvisorSupervisorOptions) {
    this.#kernel = options.kernel;
    this.#adapter = options.adapter;
    this.#supervisorId = options.supervisorId;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    if (this.#leaseDurationMs < 1_000 || this.#leaseDurationMs > 3_600_000) {
      throw new TypeError("Advisor lease must be between 1000 and 3600000 ms");
    }
    if (options.onRecord) this.#onRecord = options.onRecord;
  }

  async tick(): Promise<AdvisorSupervisorTick> {
    const occurredAt = this.#clock.now().toISOString();
    const invocations = await this.#kernel.listAdvisorInvocations();
    const owned = invocations.find(
      (entry) =>
        entry.invocation.status === "leased" &&
        entry.invocation.ownerId === this.#supervisorId &&
        entry.invocation.leaseExpiresAt !== null &&
        entry.invocation.leaseExpiresAt > occurredAt
    );
    if (owned) return this.#invoke(owned, occurredAt);
    const expired = invocations.find(
      (entry) =>
        entry.invocation.status === "leased" &&
        entry.invocation.leaseExpiresAt !== null &&
        entry.invocation.leaseExpiresAt <= occurredAt
    );
    if (expired) return this.#acquire(expired, true, occurredAt);
    const pending = invocations.find(
      (entry) => entry.invocation.status === "pending" && entry.invocation.availableAt <= occurredAt
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
    entry: AdvisorInvocationState,
    reclaimed: boolean,
    occurredAt: string
  ): Promise<AdvisorSupervisorTick> {
    const nextToken = entry.invocation.fencingToken + 1;
    const result = await this.#kernel.execute({
      type: "advisor-invocation.lease.acquire",
      idempotencyKey: `advisor-lease:${entry.invocation.invocationId}:${String(nextToken)}`,
      actor: { kind: "system", id: `advisor-supervisor:${this.#supervisorId}` },
      payload: {
        schemaVersion: 1,
        invocationId: entry.invocation.invocationId,
        ownerId: this.#supervisorId,
        leaseDurationMs: this.#leaseDurationMs
      }
    });
    return this.#emit({
      action: result.ok
        ? reclaimed
          ? "invocation_reclaimed"
          : "invocation_acquired"
        : result.error.code === "ADVISOR_INVOCATION_NOT_CLAIMABLE"
          ? "invocation_obsolete"
          : "command_rejected",
      occurredAt,
      supervisorId: this.#supervisorId,
      invocationId: entry.invocation.invocationId,
      commandResult: result
    });
  }

  async #invoke(entry: AdvisorInvocationState, occurredAt: string): Promise<AdvisorSupervisorTick> {
    const invocation = entry.invocation;
    const subject = (await this.#kernel.listAdvisorSubjects()).find(
      (candidate) => candidate.subject.subjectId === invocation.subjectRef.id
    );
    if (subject?.subjectDigest !== invocation.subjectRef.digest) {
      return await this.#fail(entry, occurredAt, "Advisor subject revision is unavailable", true);
    }
    try {
      const completed = await this.#adapter.invoke({ subject, input: invocation.input });
      const result = await this.#kernel.execute({
        type: "advisor-invocation.complete",
        idempotencyKey: `advisor-complete:${invocation.invocationId}:${String(invocation.fencingToken)}`,
        actor: { kind: "system", id: `advisor-supervisor:${this.#supervisorId}` },
        payload: {
          schemaVersion: 1,
          invocationId: invocation.invocationId,
          ownerId: this.#supervisorId,
          fencingToken: invocation.fencingToken,
          recommendationId: randomUUID(),
          output: completed.output,
          driverReceipt: completed.receipt
        }
      });
      if (!result.ok && result.error.code === "ADVISOR_OUTPUT_INVALID") {
        return await this.#fail(entry, occurredAt, result.error.message, true);
      }
      return this.#emit({
        action: result.ok ? "invocation_succeeded" : "invocation_obsolete",
        occurredAt,
        supervisorId: this.#supervisorId,
        invocationId: invocation.invocationId,
        commandResult: result
      });
    } catch (error) {
      return this.#fail(
        entry,
        occurredAt,
        error instanceof Error ? error.message : "Advisor adapter failed",
        false
      );
    }
  }

  async #fail(
    entry: AdvisorInvocationState,
    occurredAt: string,
    error: string,
    permanent: boolean
  ): Promise<AdvisorSupervisorTick> {
    const invocation = entry.invocation;
    const result = await this.#kernel.execute({
      type: "advisor-invocation.fail",
      idempotencyKey: `advisor-fail:${invocation.invocationId}:${String(invocation.fencingToken)}`,
      actor: { kind: "system", id: `advisor-supervisor:${this.#supervisorId}` },
      payload: {
        schemaVersion: 1,
        invocationId: invocation.invocationId,
        ownerId: this.#supervisorId,
        fencingToken: invocation.fencingToken,
        error: error.slice(0, 1_000),
        permanent
      }
    });
    const terminal =
      result.ok &&
      result.data.kind === "advisor_invocation" &&
      result.data.invocation.status === "failed";
    return this.#emit({
      action: result.ok
        ? terminal
          ? "invocation_failed"
          : "invocation_retry_scheduled"
        : "invocation_obsolete",
      occurredAt,
      supervisorId: this.#supervisorId,
      invocationId: invocation.invocationId,
      commandResult: result,
      error
    });
  }

  #emit(record: AdvisorSupervisorTick): AdvisorSupervisorTick {
    this.#onRecord?.(record);
    return record;
  }
}

export function randomAdvisorSupervisorId(): string {
  return randomUUID();
}
