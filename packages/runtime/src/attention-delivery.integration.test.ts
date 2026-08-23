import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase, openKernel } from "@parallelplay/kernel";
import type { AttentionPageAdapter, AttentionPageReceipt } from "./attention-delivery.js";
import {
  AttentionDeliverySupervisor,
  ConformanceAttentionPageAdapter
} from "./attention-delivery.js";

const ids = {
  program: "71000000-0000-4000-8000-000000000001",
  request: "71000000-0000-4000-8000-000000000002",
  option: "71000000-0000-4000-8000-000000000003",
  acknowledgement: "71000000-0000-4000-8000-000000000004",
  supervisor1: "71000000-0000-4000-8000-000000000005",
  supervisor2: "71000000-0000-4000-8000-000000000006"
} as const;

const actor = { kind: "operator", id: "attention-delivery-test" } as const;
const directories: string[] = [];

class MutableClock {
  #milliseconds = Date.parse("2026-08-21T17:00:00.000Z");

  now(): Date {
    return new Date(this.#milliseconds);
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }
}

async function fixture(clock: MutableClock) {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-attention-delivery-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  await migrateDatabase({ databasePath, clock });
  const kernel = await openKernel({ databasePath, clock });
  expect(
    await kernel.execute({
      type: "program.create",
      idempotencyKey: "delivery-program",
      actor,
      payload: { programId: ids.program, name: "Delivery fixture" }
    })
  ).toMatchObject({ ok: true });
  expect(
    await kernel.execute({
      type: "decision.request",
      idempotencyKey: "delivery-request",
      actor,
      payload: {
        request: {
          schemaVersion: 1,
          requestId: ids.request,
          programId: ids.program,
          milestoneId: null,
          originalQuestion: "Should this safety-critical program be reprioritized?",
          prompt: "Review this bounded, safety-critical attention action.",
          context: "Safety-critical requests bypass routine page budgets.",
          riskClass: "high",
          safetyClass: "safety_critical",
          reversibility: "reversible",
          options: [
            {
              optionId: ids.option,
              label: "Raise attention priority",
              consequences: ["The program moves to the front of the attention queue."],
              reversalCost: "Low",
              action: {
                kind: "reprioritize",
                target: {
                  kind: "program_attention_priority",
                  programId: ids.program,
                  expectedProgramVersion: 1,
                  priority: "p0"
                }
              }
            }
          ],
          refs: [],
          deadlineAt: null
        }
      }
    })
  ).toMatchObject({ ok: true });
  const delivery = (await kernel.listAttentionDeliveries(ids.program))[0];
  const packet = (await kernel.listDecisionPackets(ids.program))[0];
  const revision = (await kernel.listDecisionPacketRevisions(packet?.packetId))[0];
  if (!delivery || !packet || !revision) throw new Error("Delivery fixture did not compile");
  return { kernel, delivery, packet, revision };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("attention page delivery supervisor", () => {
  it("retries transient failures with durable attempts and receipts", async () => {
    const clock = new MutableClock();
    const { kernel, delivery } = await fixture(clock);
    const adapter = new ConformanceAttentionPageAdapter({ clock, transientFailures: 1 });
    const supervisor = new AttentionDeliverySupervisor({
      kernel,
      adapter,
      supervisorId: ids.supervisor1,
      clock,
      leaseDurationMs: 1_000
    });
    try {
      expect(await supervisor.tick()).toMatchObject({ action: "delivery_acquired" });
      expect(await supervisor.tick()).toMatchObject({ action: "delivery_retry_scheduled" });
      expect((await kernel.listAttentionDeliveries())[0]).toMatchObject({
        delivery: { status: "pending", deliveryAttempts: 1 }
      });
      clock.advance(1_000);
      expect(await supervisor.tick()).toMatchObject({ action: "delivery_acquired" });
      expect(await supervisor.tick()).toMatchObject({ action: "delivery_succeeded" });
      expect((await kernel.listAttentionDeliveries())[0]).toMatchObject({
        delivery: {
          status: "delivered",
          deliveryAttempts: 2,
          receipt: { provider: "conformance-fixture" }
        }
      });
      expect(adapter.callCount(delivery.delivery.idempotencyKey)).toBe(2);
      expect(await kernel.verifyProjections()).toMatchObject({ valid: true });
    } finally {
      await kernel.close();
    }
  });

  it("recovers after restart without duplicating the provider effect", async () => {
    const clock = new MutableClock();
    const { kernel, delivery } = await fixture(clock);
    const adapter = new ConformanceAttentionPageAdapter({ clock });
    const crashed = new AttentionDeliverySupervisor({
      kernel,
      adapter,
      supervisorId: ids.supervisor1,
      clock,
      leaseDurationMs: 1_000,
      faultInjector: (point) => {
        if (point === "after-provider-call") throw new Error("simulated supervisor crash");
      }
    });
    try {
      expect(await crashed.tick()).toMatchObject({ action: "delivery_acquired" });
      await expect(crashed.tick()).rejects.toThrow("simulated supervisor crash");
      expect((await kernel.listAttentionDeliveries())[0]).toMatchObject({
        delivery: { status: "leased", leaseFencingToken: 1 }
      });
      clock.advance(1_001);
      const restarted = new AttentionDeliverySupervisor({
        kernel,
        adapter,
        supervisorId: ids.supervisor2,
        clock,
        leaseDurationMs: 1_000
      });
      expect(await restarted.tick()).toMatchObject({ action: "delivery_reclaimed" });
      expect(await restarted.tick()).toMatchObject({ action: "delivery_succeeded" });
      const delivered = (await kernel.listAttentionDeliveries())[0];
      expect(delivered).toMatchObject({
        delivery: { status: "delivered", leaseFencingToken: 2, deliveryAttempts: 2 }
      });
      expect(adapter.callCount(delivery.delivery.idempotencyKey)).toBe(2);
      expect(delivered?.delivery.receipt?.externalId).toHaveLength(64);
    } finally {
      await kernel.close();
    }
  });

  it("treats an acknowledgement racing a delayed receipt as obsolete", async () => {
    const clock = new MutableClock();
    const { kernel, packet, revision } = await fixture(clock);
    let release: ((receipt: AttentionPageReceipt) => void) | undefined;
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const delayed = new Promise<AttentionPageReceipt>((resolve) => {
      release = resolve;
    });
    const adapter: AttentionPageAdapter = {
      name: "delayed-conformance",
      deliver: async () => {
        started?.();
        return delayed;
      }
    };
    const supervisor = new AttentionDeliverySupervisor({
      kernel,
      adapter,
      supervisorId: ids.supervisor1,
      clock,
      leaseDurationMs: 1_000
    });
    try {
      expect(await supervisor.tick()).toMatchObject({ action: "delivery_acquired" });
      const deliveryTick = supervisor.tick();
      await providerStarted;
      expect(
        await kernel.execute({
          type: "decision.acknowledge",
          idempotencyKey: "delivery-race-ack",
          actor,
          payload: {
            schemaVersion: 1,
            acknowledgementId: ids.acknowledgement,
            packetId: packet.packetId,
            packetRevisionId: revision.revision.packetRevisionId,
            packetRevisionDigest: revision.revisionDigest
          }
        })
      ).toMatchObject({ ok: true });
      release?.({
        provider: "delayed-conformance",
        externalId: "delayed-receipt",
        acceptedAt: clock.now().toISOString(),
        metadata: {}
      });
      expect(await deliveryTick).toMatchObject({ action: "delivery_obsolete" });
      expect((await kernel.listAttentionDeliveries())[0]).toMatchObject({
        delivery: { status: "obsolete", receipt: null }
      });
    } finally {
      await kernel.close();
    }
  });

  it("does not call the provider when acknowledgement wins before leasing", async () => {
    const clock = new MutableClock();
    const { kernel, delivery, packet, revision } = await fixture(clock);
    const adapter = new ConformanceAttentionPageAdapter({ clock });
    const supervisor = new AttentionDeliverySupervisor({
      kernel,
      adapter,
      supervisorId: ids.supervisor1,
      clock,
      leaseDurationMs: 1_000
    });
    try {
      expect(
        await kernel.execute({
          type: "decision.acknowledge",
          idempotencyKey: "delivery-before-lease-ack",
          actor,
          payload: {
            schemaVersion: 1,
            acknowledgementId: ids.acknowledgement,
            packetId: packet.packetId,
            packetRevisionId: revision.revision.packetRevisionId,
            packetRevisionDigest: revision.revisionDigest
          }
        })
      ).toMatchObject({ ok: true });
      expect(await supervisor.tick()).toMatchObject({ action: "idle" });
      expect(adapter.callCount(delivery.delivery.idempotencyKey)).toBe(0);
      expect((await kernel.listAttentionDeliveries())[0]).toMatchObject({
        delivery: { status: "obsolete" }
      });
    } finally {
      await kernel.close();
    }
  });

  it("records permanent provider failure without changing packet authority", async () => {
    const clock = new MutableClock();
    const { kernel, packet } = await fixture(clock);
    const supervisor = new AttentionDeliverySupervisor({
      kernel,
      adapter: new ConformanceAttentionPageAdapter({ clock, permanentFailure: true }),
      supervisorId: ids.supervisor1,
      clock,
      leaseDurationMs: 1_000
    });
    try {
      expect(await supervisor.tick()).toMatchObject({ action: "delivery_acquired" });
      expect(await supervisor.tick()).toMatchObject({ action: "delivery_permanently_failed" });
      expect((await kernel.listAttentionDeliveries())[0]).toMatchObject({
        delivery: { status: "permanent_failure" }
      });
      expect(await kernel.getState({ kind: "decision_packet", id: packet.packetId })).toMatchObject(
        {
          status: "open",
          acknowledgementId: null,
          resolutionId: null
        }
      );
    } finally {
      await kernel.close();
    }
  });
});
