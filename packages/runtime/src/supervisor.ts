import { createHash, randomUUID } from "node:crypto";
import { receiptIdentity, verificationReceiptDigest } from "@parallelplay/kernel";
import type {
  Clock,
  Command,
  CommandResult,
  IdGenerator,
  JobState,
  Kernel,
  OutboxState
} from "@parallelplay/kernel";
import { DriverRegistry, type AgentDriver } from "./driver.js";
import {
  VerifierTimeoutError,
  type TrustedCommandVerifier,
  type TrustedVerifierResult
} from "./verifier.js";

export type SupervisorFaultPoint =
  | "after-job-lease"
  | "before-effect-call"
  | "after-effect-call"
  | "after-outbox-receipt"
  | "after-inspect-call"
  | "after-attempt-result"
  | "before-verifier-call"
  | "after-verifier-call"
  | "after-verification-receipt";

export interface TickResult {
  action:
    | "idle"
    | "job_reclaimed"
    | "job_acquired"
    | "job_lease_renewed"
    | "attempt_timed_out"
    | "attempt_running"
    | "driver_events_observed"
    | "driver_receipt_recorded"
    | "attempt_succeeded"
    | "attempt_failed"
    | "verification_requested"
    | "verification_passed"
    | "verification_failed"
    | "verification_invalid"
    | "outbox_reclaimed"
    | "outbox_acquired"
    | "outbox_delivered"
    | "outbox_delivery_failed"
    | "attention_compiled"
    | "portfolio_slo_recorded"
    | "portfolio_lease_renewed"
    | "portfolio_admitted"
    | "program_advanced"
    | "program_completed"
    | "command_rejected";
  occurredAt: string;
  supervisorId: string;
  runId?: string;
  jobId?: string;
  attemptId?: string;
  outboxId?: string;
  commandResult?: CommandResult;
  error?: string;
}

export interface SupervisorOptions {
  kernel: Kernel;
  driver?: AgentDriver;
  drivers?: DriverRegistry;
  verifier?: TrustedCommandVerifier;
  supervisorId: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
  jobLeaseMs?: number;
  renewWhenRemainingMs?: number;
  outboxLeaseMs?: number;
  pollIntervalMs?: number;
  faultInjector?: (point: SupervisorFaultPoint) => void;
  onRecord?: (record: TickResult) => void;
}

export interface SupervisorRunOptions {
  signal?: AbortSignal;
  maxTicks?: number;
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdGenerator = { next: () => randomUUID() };

function isExpired(timestamp: string | null, now: string): boolean {
  return timestamp !== null && timestamp <= now;
}

function stableUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = "8";
  const value = bytes.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
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

export class Supervisor {
  readonly #kernel: Kernel;
  readonly #drivers: DriverRegistry;
  readonly #legacySingleDriver: boolean;
  readonly #verifier: TrustedCommandVerifier | undefined;
  readonly #supervisorId: string;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #jobLeaseMs: number;
  readonly #renewWhenRemainingMs: number;
  readonly #outboxLeaseMs: number;
  readonly #pollIntervalMs: number;
  readonly #faultInjector?: (point: SupervisorFaultPoint) => void;
  readonly #onRecord?: (record: TickResult) => void;

  constructor(options: SupervisorOptions) {
    this.#kernel = options.kernel;
    if (options.drivers) this.#drivers = options.drivers;
    else if (options.driver) this.#drivers = new DriverRegistry([options.driver]);
    else throw new Error("Supervisor requires a driver registry");
    this.#legacySingleDriver = options.drivers === undefined;
    this.#verifier = options.verifier;
    this.#supervisorId = options.supervisorId;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.idGenerator ?? systemIds;
    this.#jobLeaseMs = options.jobLeaseMs ?? 30_000;
    this.#renewWhenRemainingMs = options.renewWhenRemainingMs ?? 10_000;
    this.#outboxLeaseMs = options.outboxLeaseMs ?? 10_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    if (options.faultInjector) this.#faultInjector = options.faultInjector;
    if (options.onRecord) this.#onRecord = options.onRecord;
  }

  async tick(): Promise<TickResult> {
    const occurredAt = this.#clock.now().toISOString();
    const attention = await this.#kernel.compileAttention();
    if (attention) {
      const tick = this.#commandTick(attention, "attention_compiled", occurredAt, {});
      this.#emit(tick);
      return tick;
    }
    const slo = await this.#kernel.evaluatePortfolioSlo();
    if (slo) {
      const tick = this.#commandTick(slo, "portfolio_slo_recorded", occurredAt, {});
      this.#emit(tick);
      return tick;
    }
    const renewalCutoff = new Date(
      this.#clock.now().getTime() + this.#renewWhenRemainingMs
    ).toISOString();
    const portfolioLease = (await this.#kernel.listConcurrencyLeases()).find(
      (lease) =>
        lease.status === "active" &&
        lease.lease.expiresAt > occurredAt &&
        lease.lease.expiresAt <= renewalCutoff
    );
    if (portfolioLease) {
      const result = await this.#kernel.execute({
        type: "portfolio-lease.renew",
        idempotencyKey: `portfolio-lease-renew:${portfolioLease.lease.leaseId}:${portfolioLease.lease.expiresAt}`,
        actor: { kind: "system", id: this.#supervisorId },
        payload: {
          schemaVersion: 1,
          leaseId: portfolioLease.lease.leaseId,
          ownerAdmissionId: portfolioLease.lease.admissionId,
          fencingToken: portfolioLease.lease.fencingToken,
          leaseDurationMs: 60_000
        }
      });
      const tick = this.#commandTick(result, "portfolio_lease_renewed", occurredAt, {});
      this.#emit(tick);
      return tick;
    }
    const admission = await this.#kernel.coordinatePortfolio();
    if (admission) {
      const tick = this.#commandTick(
        admission,
        "portfolio_admitted",
        occurredAt,
        admission.ok && admission.data.kind === "portfolio_admission"
          ? { runId: admission.data.admission.runId }
          : {}
      );
      this.#emit(tick);
      return tick;
    }
    const jobs = await this.#kernel.listJobs();
    const outbox = await this.#kernel.listOutbox();
    const outboxLeaseDuration = (message: OutboxState): number => {
      if (message.effect.effectType === "verification.run") {
        return Math.min(3_660_000, message.effect.verifierContract.timeoutMs + 10_000);
      }
      const job = jobs.find((candidate) => candidate.jobId === message.jobId);
      const genericCommandEffect =
        !this.#legacySingleDriver &&
        ((message.effect.effectType === "agent.start" &&
          message.effect.driver === "generic-command") ||
          (message.effect.effectType === "agent.cancel" && job?.executionContract !== null));
      if (job && genericCommandEffect) {
        return Math.min(3_660_000, job.policy.attemptTimeoutMs + 10_000);
      }
      return this.#outboxLeaseMs;
    };
    const mayOwnVerificationEffect = (message: OutboxState): boolean => {
      if (message.effect.effectType !== "verification.run") return true;
      const job = jobs.find((candidate) => candidate.jobId === message.jobId);
      return (
        job?.status === "active" &&
        job.leaseOwnerId === this.#supervisorId &&
        !isExpired(job.leaseExpiresAt, occurredAt)
      );
    };

    const expiredJob = jobs.find(
      (job) =>
        job.status === "active" &&
        (job.leaseExpiresAt === null || isExpired(job.leaseExpiresAt, occurredAt))
    );
    if (expiredJob) return this.#acquireJob(expiredJob, true, occurredAt);

    for (const job of jobs) {
      if (
        job.status !== "active" ||
        job.leaseOwnerId !== this.#supervisorId ||
        isExpired(job.leaseExpiresAt, occurredAt) ||
        !job.activeAttemptId
      ) {
        continue;
      }
      const attempt = await this.#kernel.getState({ kind: "attempt", id: job.activeAttemptId });
      if (attempt?.kind === "attempt" && attempt.deadlineAt && attempt.deadlineAt <= occurredAt) {
        return this.#reconcileJob(job, occurredAt);
      }
    }

    const expiredOutbox = outbox.find(
      (message) =>
        message.status === "leased" &&
        isExpired(message.leaseExpiresAt, occurredAt) &&
        mayOwnVerificationEffect(message)
    );
    if (expiredOutbox) {
      return this.#acquireOutbox(
        expiredOutbox,
        true,
        occurredAt,
        outboxLeaseDuration(expiredOutbox)
      );
    }

    const ownedOutbox = outbox.find(
      (message) =>
        message.status === "leased" &&
        message.leaseOwnerId === this.#supervisorId &&
        !isExpired(message.leaseExpiresAt, occurredAt) &&
        mayOwnVerificationEffect(message)
    );
    if (ownedOutbox) return this.#deliverOutbox(ownedOutbox, occurredAt);

    const pendingOutbox = outbox.find(
      (message) =>
        message.status === "pending" &&
        message.availableAt <= occurredAt &&
        mayOwnVerificationEffect(message)
    );
    if (pendingOutbox) {
      if (pendingOutbox.effect.effectType === "verification.run") {
        const job = jobs.find((candidate) => candidate.jobId === pendingOutbox.jobId);
        const needed = Math.min(
          3_660_000,
          pendingOutbox.effect.verifierContract.timeoutMs + 10_000
        );
        if (
          job?.leaseOwnerId === this.#supervisorId &&
          job.leaseExpiresAt &&
          new Date(job.leaseExpiresAt).getTime() - new Date(occurredAt).getTime() < needed
        ) {
          return this.#renewJob(
            job,
            occurredAt,
            Math.min(3_660_000, needed + this.#renewWhenRemainingMs)
          );
        }
      }
      return this.#acquireOutbox(
        pendingOutbox,
        false,
        occurredAt,
        outboxLeaseDuration(pendingOutbox)
      );
    }

    const ownedJob = jobs.find(
      (job) =>
        job.status === "active" &&
        job.leaseOwnerId === this.#supervisorId &&
        !isExpired(job.leaseExpiresAt, occurredAt)
    );
    if (ownedJob) return this.#reconcileJob(ownedJob, occurredAt);

    const readyJob = jobs.find(
      (job) =>
        (job.status === "ready" || job.status === "retry_wait") && job.availableAt <= occurredAt
    );
    if (readyJob) return this.#acquireJob(readyJob, false, occurredAt);

    for (const program of await this.#kernel.listPrograms()) {
      if (!(
        (program.programMode === "graph_v1" && program.phase === "running") ||
        (program.programMode === "graph_v2" && program.phase === "eligible")
      )) {
        continue;
      }
      const result = await this.#kernel.advanceProgram(program.programId);
      if (!result) continue;
      const tick = this.#commandTick(
        result,
        result.ok && result.data.kind === "program" ? "program_completed" : "program_advanced",
        occurredAt,
        result.ok && result.data.kind === "run" ? { runId: result.data.runId } : {}
      );
      this.#emit(tick);
      return tick;
    }

    return { action: "idle", occurredAt, supervisorId: this.#supervisorId };
  }

  async run(options: SupervisorRunOptions = {}): Promise<number> {
    let ticks = 0;
    while (
      !options.signal?.aborted &&
      (options.maxTicks === undefined || ticks < options.maxTicks)
    ) {
      await this.tick();
      ticks += 1;
      if (
        !options.signal?.aborted &&
        (options.maxTicks === undefined || ticks < options.maxTicks)
      ) {
        await delay(this.#pollIntervalMs, options.signal);
      }
    }
    return ticks;
  }

  async #acquireJob(job: JobState, reclaiming: boolean, occurredAt: string): Promise<TickResult> {
    const result = await this.#execute({
      type: "job.lease.acquire",
      idempotencyKey: this.#commandKey("job-acquire", job.jobId, job.leaseFencingToken + 1),
      actor: { kind: "system", id: this.#supervisorId },
      correlationId: job.runId,
      payload: {
        jobId: job.jobId,
        ownerId: this.#supervisorId,
        leaseDurationMs: this.#jobLeaseMs,
        attemptId: this.#ids.next(),
        startOutboxId: this.#ids.next()
      }
    });
    const tick = this.#commandTick(
      result,
      reclaiming ? "job_reclaimed" : "job_acquired",
      occurredAt,
      { runId: job.runId, jobId: job.jobId }
    );
    if (result.ok) this.#faultInjector?.("after-job-lease");
    this.#emit(tick);
    return tick;
  }

  async #acquireOutbox(
    message: OutboxState,
    reclaiming: boolean,
    occurredAt: string,
    leaseDurationMs: number
  ): Promise<TickResult> {
    const result = await this.#execute({
      type: "outbox.lease.acquire",
      idempotencyKey: this.#commandKey(
        "outbox-acquire",
        message.outboxId,
        message.leaseFencingToken + 1
      ),
      actor: { kind: "system", id: this.#supervisorId },
      correlationId: message.runId,
      payload: {
        outboxId: message.outboxId,
        ownerId: this.#supervisorId,
        leaseDurationMs
      }
    });
    const tick = this.#commandTick(
      result,
      reclaiming ? "outbox_reclaimed" : "outbox_acquired",
      occurredAt,
      {
        runId: message.runId,
        jobId: message.jobId,
        attemptId: message.attemptId,
        outboxId: message.outboxId
      }
    );
    this.#emit(tick);
    return tick;
  }

  async #deliverOutbox(message: OutboxState, occurredAt: string): Promise<TickResult> {
    if (message.effect.effectType === "verification.run") {
      return this.#deliverVerification(message, occurredAt);
    }
    this.#faultInjector?.("before-effect-call");
    let externalEffectId: string;
    try {
      if (message.effect.effectType === "agent.start") {
        const driver = this.#legacySingleDriver
          ? this.#drivers.get("fake")
          : this.#drivers.get(message.effect.driver);
        if (message.effect.driver === "generic-command" && !this.#legacySingleDriver) {
          const revision = message.effect.baseRevisionId
            ? await this.#kernel.getState({
                kind: "source_revision",
                id: message.effect.baseRevisionId
              })
            : null;
          if (
            revision?.kind !== "source_revision" ||
            !message.effect.executionContract ||
            !message.effect.executionContractDigest ||
            !message.effect.capabilityManifest ||
            !message.effect.capabilityManifestDigest ||
            !message.effect.attemptStartedAt
          ) {
            throw new Error("Generic driver effect is missing its authoritative contracts");
          }
          const common = {
            driver: "generic-command",
            attemptId: message.effect.attemptId,
            attemptStartedAt: message.effect.attemptStartedAt,
            jobId: message.effect.jobId,
            runId: message.effect.runId,
            baseRevisionId: revision.revisionId,
            baseRevision: revision,
            executionContract: message.effect.executionContract,
            executionContractDigest: message.effect.executionContractDigest,
            capabilityManifest: message.effect.capabilityManifest,
            capabilityManifestDigest: message.effect.capabilityManifestDigest
          } as const;
          if (message.effect.executionContract.protocolVersion === 2) {
            if (
              message.effect.capabilityManifest.schemaVersion !== 2 ||
              !message.effect.contextPacket ||
              !message.effect.contextPacketDigest ||
              !message.effect.executionContract.context.contextPacketId ||
              !message.effect.executionContract.context.contextPacketDigest ||
              !message.effect.capabilityManifest.context.contextPacketId ||
              !message.effect.capabilityManifest.context.contextPacketDigest
            ) {
              throw new Error("Generic V2 driver effect is missing its context packet");
            }
            externalEffectId = await driver.start(message.effectKey, {
              ...common,
              executionContract: {
                ...message.effect.executionContract,
                context: {
                  ...message.effect.executionContract.context,
                  contextPacketId: message.effect.executionContract.context.contextPacketId,
                  contextPacketDigest: message.effect.executionContract.context.contextPacketDigest
                }
              },
              capabilityManifest: {
                ...message.effect.capabilityManifest,
                context: {
                  ...message.effect.capabilityManifest.context,
                  contextPacketId: message.effect.capabilityManifest.context.contextPacketId,
                  contextPacketDigest: message.effect.capabilityManifest.context.contextPacketDigest
                }
              },
              contextPacket: message.effect.contextPacket,
              contextPacketDigest: message.effect.contextPacketDigest
            });
          } else {
            if (message.effect.capabilityManifest.schemaVersion !== 1) {
              throw new Error("Generic V1 driver effect has a mismatched capability manifest");
            }
            externalEffectId = await driver.start(message.effectKey, {
              ...common,
              executionContract: message.effect.executionContract,
              capabilityManifest: message.effect.capabilityManifest
            });
          }
        } else {
          externalEffectId = await driver.start(message.effectKey, {
            driver: "fake",
            capability: message.effect.capability,
            attemptId: message.effect.attemptId,
            jobId: message.effect.jobId,
            runId: message.effect.runId
          });
        }
      } else {
        const driver = this.#driverForExternalRun(message.effect.externalRunId);
        externalEffectId = await driver.cancel(
          message.effectKey,
          message.effect.externalRunId,
          message.effect.reason
        );
        if (driver.name === "generic-command") {
          const bundle = await driver.collectReceipt(message.effect.externalRunId);
          const recorded = await this.#kernel.getState({
            kind: "driver_receipt",
            id: bundle.driverReceiptId
          });
          if (!recorded) {
            const attempt = await this.#kernel.getState({
              kind: "attempt",
              id: message.attemptId
            });
            if (attempt?.kind !== "attempt") {
              throw new Error("Cancellation receipt references a missing attempt");
            }
            const result = await this.#execute({
              type: "driver.terminal-receipt.record",
              idempotencyKey: this.#commandKey(
                "driver-terminal-receipt",
                message.attemptId,
                message.leaseFencingToken
              ),
              actor: { kind: "system", id: this.#supervisorId },
              correlationId: message.runId,
              payload: {
                driverReceiptId: bundle.driverReceiptId,
                artifactManifestId: bundle.artifactManifestId,
                outboxId: message.outboxId,
                jobId: message.jobId,
                attemptId: message.attemptId,
                ownerId: this.#supervisorId,
                outboxFencingToken: message.leaseFencingToken,
                afterSequence: attempt.driverCursor,
                events: bundle.events.filter((event) => event.sequence > attempt.driverCursor),
                receipt: bundle.receipt,
                entries: bundle.entries
              }
            });
            const tick = this.#commandTick(result, "driver_receipt_recorded", occurredAt, {
              runId: message.runId,
              jobId: message.jobId,
              attemptId: message.attemptId,
              outboxId: message.outboxId
            });
            this.#emit(tick);
            return tick;
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Driver effect call failed";
      return this.#failOutboxDelivery(message, occurredAt, errorMessage);
    }
    this.#faultInjector?.("after-effect-call");
    const result = await this.#execute({
      type: "outbox.delivery.succeed",
      idempotencyKey: this.#commandKey(
        "outbox-succeed",
        message.outboxId,
        message.leaseFencingToken
      ),
      actor: { kind: "system", id: this.#supervisorId },
      correlationId: message.runId,
      payload: {
        outboxId: message.outboxId,
        ownerId: this.#supervisorId,
        fencingToken: message.leaseFencingToken,
        externalEffectId
      }
    });
    const tick = this.#commandTick(result, "outbox_delivered", occurredAt, {
      runId: message.runId,
      jobId: message.jobId,
      attemptId: message.attemptId,
      outboxId: message.outboxId
    });
    if (result.ok) this.#faultInjector?.("after-outbox-receipt");
    this.#emit(tick);
    return tick;
  }

  async #deliverVerification(message: OutboxState, occurredAt: string): Promise<TickResult> {
    if (message.effect.effectType !== "verification.run") {
      throw new Error("Expected verification outbox effect");
    }
    if (!this.#verifier) throw new Error("Supervisor requires a verifier for verification effects");
    const verification = await this.#kernel.getState({
      kind: "verification",
      id: message.effect.verificationId
    });
    const revision = await this.#kernel.getState({
      kind: "source_revision",
      id: message.effect.sourceRevisionId
    });
    const job = await this.#kernel.getState({ kind: "job", id: message.jobId });
    const attempt = await this.#kernel.getState({ kind: "attempt", id: message.attemptId });
    if (
      verification?.kind !== "verification" ||
      revision?.kind !== "source_revision" ||
      job?.kind !== "job" ||
      attempt?.kind !== "attempt" ||
      !attempt.deadlineAt
    ) {
      throw new Error("Verification effect references missing authoritative state");
    }
    const remainingAttemptMs =
      new Date(attempt.deadlineAt).getTime() - new Date(occurredAt).getTime();
    if (remainingAttemptMs <= 0) {
      throw new VerifierTimeoutError("Attempt deadline elapsed before verification");
    }
    this.#faultInjector?.("before-effect-call");
    this.#faultInjector?.("before-verifier-call");
    let verified: TrustedVerifierResult;
    try {
      verified = await this.#verifier.verify({
        verificationId: verification.verificationId,
        attemptId: attempt.attemptId,
        sourceRevision: revision,
        verifierContract: message.effect.verifierContract,
        verifierContractDigest: message.effect.verifierContractDigest,
        remainingAttemptMs
      });
    } catch (error) {
      if (error instanceof VerifierTimeoutError) {
        return this.#failVerificationTimeout(
          message,
          message.effect.verificationId,
          occurredAt,
          error.message
        );
      }
      const errorMessage =
        error instanceof Error ? error.message : "Verification effect call failed";
      return this.#failOutboxDelivery(message, occurredAt, errorMessage);
    }
    const completedAt = this.#clock.now().toISOString();
    if (attempt.deadlineAt <= completedAt) {
      return this.#failVerificationTimeout(
        message,
        message.effect.verificationId,
        completedAt,
        "Attempt deadline elapsed during verification"
      );
    }
    this.#faultInjector?.("after-verifier-call");
    this.#faultInjector?.("after-effect-call");
    const artifactManifestId = verification.verificationId;
    const receiptDigest = verificationReceiptDigest(
      receiptIdentity(
        verification,
        artifactManifestId,
        verified.result.artifactManifestDigest,
        verified.resultDigest
      )
    );
    const result = await this.#execute({
      type: "verification.complete",
      idempotencyKey: this.#commandKey(
        "verification-complete",
        verification.verificationId,
        message.leaseFencingToken
      ),
      actor: { kind: "system", id: this.#supervisorId },
      correlationId: message.runId,
      payload: {
        verificationId: verification.verificationId,
        outboxId: message.outboxId,
        artifactManifestId,
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        ownerId: this.#supervisorId,
        jobFencingToken: job.leaseFencingToken,
        outboxFencingToken: message.leaseFencingToken,
        result: verified.result,
        resultDigest: verified.resultDigest,
        receiptDigest,
        entries: verified.entries
      }
    });
    const action =
      verified.result.outcome === "passed"
        ? "verification_passed"
        : verified.result.outcome === "failed"
          ? "verification_failed"
          : "verification_invalid";
    const tick = this.#commandTick(result, action, occurredAt, {
      runId: message.runId,
      jobId: message.jobId,
      attemptId: message.attemptId,
      outboxId: message.outboxId
    });
    if (result.ok) {
      this.#faultInjector?.("after-verification-receipt");
      this.#faultInjector?.("after-outbox-receipt");
    }
    this.#emit(tick);
    return tick;
  }

  async #failOutboxDelivery(
    message: OutboxState,
    occurredAt: string,
    errorMessage: string
  ): Promise<TickResult> {
    const result = await this.#execute({
      type: "outbox.delivery.fail",
      idempotencyKey: this.#commandKey("outbox-fail", message.outboxId, message.leaseFencingToken),
      actor: { kind: "system", id: this.#supervisorId },
      correlationId: message.runId,
      payload: {
        outboxId: message.outboxId,
        ownerId: this.#supervisorId,
        fencingToken: message.leaseFencingToken,
        error: errorMessage.slice(0, 1000) || "External effect call failed"
      }
    });
    const tick = this.#commandTick(result, "outbox_delivery_failed", occurredAt, {
      runId: message.runId,
      jobId: message.jobId,
      attemptId: message.attemptId,
      outboxId: message.outboxId,
      error: errorMessage
    });
    this.#emit(tick);
    return tick;
  }

  async #failVerificationTimeout(
    message: OutboxState,
    verificationId: string,
    occurredAt: string,
    detail: string
  ): Promise<TickResult> {
    const job = await this.#kernel.getState({ kind: "job", id: message.jobId });
    if (job?.kind !== "job") {
      const tick: TickResult = {
        action: "command_rejected",
        occurredAt,
        supervisorId: this.#supervisorId,
        runId: message.runId,
        jobId: message.jobId,
        attemptId: message.attemptId,
        outboxId: message.outboxId,
        error: "Verification timeout references a missing job"
      };
      this.#emit(tick);
      return tick;
    }
    const result = await this.#execute({
      type: "verification.execution.fail",
      idempotencyKey: this.#commandKey(
        "verification-timeout",
        verificationId,
        message.leaseFencingToken
      ),
      actor: { kind: "system", id: this.#supervisorId },
      correlationId: message.runId,
      payload: {
        verificationId,
        outboxId: message.outboxId,
        jobId: message.jobId,
        attemptId: message.attemptId,
        ownerId: this.#supervisorId,
        jobFencingToken: job.leaseFencingToken,
        outboxFencingToken: message.leaseFencingToken,
        reason: "timed_out",
        detail: detail.slice(0, 1000) || "Verifier timed out"
      }
    });
    const tick = this.#commandTick(result, "attempt_timed_out", occurredAt, {
      runId: message.runId,
      jobId: message.jobId,
      attemptId: message.attemptId,
      outboxId: message.outboxId,
      error: detail
    });
    if (result.ok) this.#faultInjector?.("after-attempt-result");
    this.#emit(tick);
    return tick;
  }

  async #reconcileJob(job: JobState, occurredAt: string): Promise<TickResult> {
    const attemptId = job.activeAttemptId;
    if (!attemptId) {
      const tick: TickResult = {
        action: "command_rejected",
        occurredAt,
        supervisorId: this.#supervisorId,
        runId: job.runId,
        jobId: job.jobId,
        error: "Active job has no active attempt"
      };
      this.#emit(tick);
      return tick;
    }
    const state = await this.#kernel.getState({ kind: "attempt", id: attemptId });
    if (state?.kind !== "attempt") {
      const tick: TickResult = {
        action: "command_rejected",
        occurredAt,
        supervisorId: this.#supervisorId,
        runId: job.runId,
        jobId: job.jobId,
        attemptId,
        error: "Active attempt is missing"
      };
      this.#emit(tick);
      return tick;
    }
    if (state.deadlineAt && state.deadlineAt <= occurredAt) {
      const result = await this.#execute({
        type: "attempt.timeout",
        idempotencyKey: this.#commandKey("attempt-timeout", attemptId, job.leaseFencingToken),
        actor: { kind: "system", id: this.#supervisorId },
        correlationId: job.runId,
        payload: {
          jobId: job.jobId,
          attemptId,
          ownerId: this.#supervisorId,
          fencingToken: job.leaseFencingToken
        }
      });
      const tick = this.#commandTick(result, "attempt_timed_out", occurredAt, {
        runId: job.runId,
        jobId: job.jobId,
        attemptId
      });
      if (result.ok) this.#faultInjector?.("after-attempt-result");
      this.#emit(tick);
      return tick;
    }
    if (
      job.leaseExpiresAt &&
      new Date(job.leaseExpiresAt).getTime() - new Date(occurredAt).getTime() <=
        this.#renewWhenRemainingMs
    ) {
      return this.#renewJob(job, occurredAt, this.#jobLeaseMs);
    }
    if (state.status !== "running" || !state.externalRunId) {
      const tick: TickResult = {
        action: "attempt_running",
        occurredAt,
        supervisorId: this.#supervisorId,
        runId: job.runId,
        jobId: job.jobId,
        attemptId
      };
      this.#emit(tick);
      return tick;
    }
    const driver = this.#driverForExternalRun(state.externalRunId);
    const inspection = await driver.inspect(state.externalRunId, state.driverCursor);
    this.#faultInjector?.("after-inspect-call");
    if (driver.name === "generic-command" && inspection.events.length > 0) {
      const result = await this.#execute({
        type: "attempt.driver-events.observe",
        idempotencyKey: this.#commandKey(
          `driver-events-${String(state.driverCursor)}`,
          attemptId,
          job.leaseFencingToken
        ),
        actor: { kind: "system", id: this.#supervisorId },
        correlationId: job.runId,
        payload: {
          jobId: job.jobId,
          attemptId,
          ownerId: this.#supervisorId,
          fencingToken: job.leaseFencingToken,
          afterSequence: state.driverCursor,
          events: inspection.events
        }
      });
      const tick = this.#commandTick(result, "driver_events_observed", occurredAt, {
        runId: job.runId,
        jobId: job.jobId,
        attemptId
      });
      this.#emit(tick);
      return tick;
    }
    if (inspection.status === "running") {
      const tick: TickResult = {
        action: "attempt_running",
        occurredAt,
        supervisorId: this.#supervisorId,
        runId: job.runId,
        jobId: job.jobId,
        attemptId
      };
      this.#emit(tick);
      return tick;
    }
    if (driver.name === "generic-command") {
      const bundle = await driver.collectReceipt(state.externalRunId);
      const candidate = bundle.candidateRevision;
      const result = await this.#execute({
        type: "driver.receipt.record",
        idempotencyKey: this.#commandKey("driver-receipt", attemptId, job.leaseFencingToken),
        actor: { kind: "system", id: this.#supervisorId },
        correlationId: job.runId,
        payload: {
          driverReceiptId: bundle.driverReceiptId,
          artifactManifestId: bundle.artifactManifestId,
          ...(bundle.receipt.outcome === "succeeded"
            ? {
                verificationId: stableUuid(`${attemptId}:verification`),
                verificationOutboxId: stableUuid(`${attemptId}:verification-outbox`)
              }
            : {}),
          jobId: job.jobId,
          attemptId,
          ownerId: this.#supervisorId,
          fencingToken: job.leaseFencingToken,
          receipt: bundle.receipt,
          ...(candidate
            ? {
                candidateRevision: {
                  revisionId: candidate.revisionId,
                  repositoryId: candidate.repositoryId,
                  objectFormat: candidate.objectFormat,
                  commitOid: candidate.commitOid,
                  treeOid: candidate.treeOid,
                  storageRef: candidate.storageRef,
                  revisionDigest: candidate.revisionDigest
                }
              }
            : {}),
          entries: bundle.entries
        }
      });
      const tick = this.#commandTick(result, "driver_receipt_recorded", occurredAt, {
        runId: job.runId,
        jobId: job.jobId,
        attemptId
      });
      if (result.ok) this.#faultInjector?.("after-attempt-result");
      this.#emit(tick);
      return tick;
    }
    const outcome = inspection.status === "succeeded" ? "succeeded" : "failed";
    const result = await this.#execute({
      type: "attempt.observe",
      idempotencyKey: this.#commandKey(`attempt-${outcome}`, attemptId, job.leaseFencingToken),
      actor: { kind: "system", id: this.#supervisorId },
      correlationId: job.runId,
      payload: {
        jobId: job.jobId,
        attemptId,
        ownerId: this.#supervisorId,
        fencingToken: job.leaseFencingToken,
        outcome,
        ...(outcome === "succeeded" && job.sourceRevisionId
          ? { verificationId: this.#ids.next(), verificationOutboxId: this.#ids.next() }
          : {}),
        ...(outcome === "failed"
          ? { detail: `fake driver terminated as ${inspection.status}` }
          : {})
      }
    });
    const tick = this.#commandTick(
      result,
      outcome === "succeeded" && job.sourceRevisionId
        ? "verification_requested"
        : outcome === "succeeded"
          ? "attempt_succeeded"
          : "attempt_failed",
      occurredAt,
      { runId: job.runId, jobId: job.jobId, attemptId }
    );
    if (result.ok) this.#faultInjector?.("after-attempt-result");
    this.#emit(tick);
    return tick;
  }

  async #renewJob(job: JobState, occurredAt: string, leaseDurationMs: number): Promise<TickResult> {
    const result = await this.#execute({
      type: "job.lease.renew",
      idempotencyKey: `${this.#commandKey("job-renew", job.jobId, job.leaseFencingToken)}:${job.leaseExpiresAt ?? "none"}:${String(leaseDurationMs)}`,
      actor: { kind: "system", id: this.#supervisorId },
      correlationId: job.runId,
      payload: {
        jobId: job.jobId,
        ownerId: this.#supervisorId,
        fencingToken: job.leaseFencingToken,
        leaseDurationMs
      }
    });
    const tick = this.#commandTick(result, "job_lease_renewed", occurredAt, {
      runId: job.runId,
      jobId: job.jobId,
      ...(job.activeAttemptId ? { attemptId: job.activeAttemptId } : {})
    });
    this.#emit(tick);
    return tick;
  }

  async #execute(command: Command): Promise<CommandResult> {
    return this.#kernel.execute(command);
  }

  #commandKey(action: string, id: string, fence: number): string {
    return `${action}:${id}:${String(fence)}:${this.#supervisorId}`;
  }

  #driverForExternalRun(externalRunId: string): AgentDriver {
    return this.#drivers.get(externalRunId.startsWith("docker:") ? "generic-command" : "fake");
  }

  #commandTick(
    result: CommandResult,
    successAction: Exclude<TickResult["action"], "idle" | "command_rejected">,
    occurredAt: string,
    context: Omit<TickResult, "action" | "occurredAt" | "supervisorId" | "commandResult">
  ): TickResult {
    return {
      action: result.ok ? successAction : "command_rejected",
      occurredAt,
      supervisorId: this.#supervisorId,
      ...context,
      commandResult: result,
      ...(!result.ok ? { error: `${result.error.code}: ${result.error.message}` } : {})
    };
  }

  #emit(result: TickResult): void {
    if (result.action !== "idle") this.#onRecord?.(result);
  }
}
