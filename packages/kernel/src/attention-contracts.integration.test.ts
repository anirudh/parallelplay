import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "./canonical.js";
import { migrateDatabase } from "./database.js";
import type { Clock, IdGenerator } from "./database.js";
import { openKernelForTesting } from "./sqlite-kernel.js";
import type { Kernel } from "./sqlite-kernel.js";

const ids = {
  program: "70000000-0000-4000-8000-000000000001",
  policy: "70000000-0000-4000-8000-000000000002",
  policy1: "70000000-0000-4000-8000-000000000003",
  policy2: "70000000-0000-4000-8000-000000000004",
  request: "70000000-0000-4000-8000-000000000005",
  option: "70000000-0000-4000-8000-000000000006",
  acknowledgement: "70000000-0000-4000-8000-000000000007",
  measurement: "70000000-0000-4000-8000-000000000008"
} as const;

const actor = { kind: "operator", id: "attention-operator" } as const;
const directories: string[] = [];

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-08-21T16:00:00.000Z");
  }
}

class SequenceIds implements IdGenerator {
  #next = 100;

  next(): string {
    return `70000000-0000-4000-8000-${String(this.#next++).padStart(12, "0")}`;
  }
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-attention-"));
  directories.push(directory);
  return join(directory, "parallelplay.db");
}

async function createKernel(): Promise<{ databasePath: string; kernel: Kernel }> {
  const databasePath = temporaryDatabase();
  const clock = new FixedClock();
  await migrateDatabase({ databasePath, clock });
  return {
    databasePath,
    kernel: openKernelForTesting({ databasePath, clock, idGenerator: new SequenceIds() })
  };
}

async function throughPosition(kernel: Kernel): Promise<number> {
  const events = (await kernel.listEvents({ limit: 1_000 })).events;
  return events.at(-1)?.globalPosition ?? 0;
}

function policy(
  policyRevisionId: string,
  revision: number,
  priorPolicyRef: { kind: "attention_policy"; id: string; digest: string } | null
) {
  return {
    schemaVersion: 1 as const,
    policyId: ids.policy,
    policyRevisionId,
    revision,
    priorPolicyRef,
    rules: [],
    defaultRoute: "page" as const,
    defaultUrgency: "p1" as const,
    routinePageBudget: { maxPages: 100, windowMs: 86_400_000 },
    deduplicationWindowMs: 86_400_000,
    oneWayDoorActionKinds: [],
    defaultOnTimeout: null
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("attention attention contracts", () => {
  it("binds progressive packet revisions to frozen policies and resolves a bounded action", async () => {
    const { kernel } = await createKernel();
    try {
      expect(
        await kernel.execute({
          type: "program.create",
          idempotencyKey: "attention-program",
          actor,
          payload: { programId: ids.program, name: "Attention pilot" }
        })
      ).toMatchObject({ ok: true });
      expect(
        await kernel.execute({
          type: "attention-policy.approve",
          idempotencyKey: "attention-policy-1",
          actor,
          payload: { policy: policy(ids.policy1, 1, null) }
        })
      ).toMatchObject({ ok: true });

      const target = {
        kind: "program_attention_priority" as const,
        programId: ids.program,
        expectedProgramVersion: 1,
        priority: "p1" as const
      };
      const requested = await kernel.execute({
        type: "decision.request",
        idempotencyKey: "attention-request",
        actor,
        payload: {
          request: {
            schemaVersion: 1,
            requestId: ids.request,
            programId: ids.program,
            milestoneId: null,
            originalQuestion: "Should this program move ahead of routine attention?",
            prompt: "Choose whether to raise the attention priority.",
            context: "The operator is explicitly requesting a bounded queue-order change.",
            riskClass: "normal",
            safetyClass: "routine",
            reversibility: "reversible",
            options: [
              {
                optionId: ids.option,
                label: "Raise priority",
                consequences: ["The program sorts ahead of p2 and p3 programs."],
                reversalCost: "A later reprioritization can reverse this.",
                action: { kind: "reprioritize", target }
              }
            ],
            refs: [],
            deadlineAt: null
          }
        }
      });
      expect(requested.ok && requested.events.map((event) => event.type)).toEqual([
        "OperatorDecisionRequestRecorded",
        "DecisionEvidenceBundleRecorded",
        "DecisionPacketRevisionRecorded",
        "DecisionPacketOpened",
        "AttentionDeliveryQueued"
      ]);

      const packet = (await kernel.listDecisionPackets(ids.program))[0];
      const firstRevision = (await kernel.listDecisionPacketRevisions(packet?.packetId))[0];
      expect(firstRevision?.revision.policyBinding).toMatchObject({
        kind: "attention_policy",
        id: ids.policy1
      });
      expect((await kernel.listAttentionQueue(ids.program, "page"))[0]).toMatchObject({
        packet: { packetId: packet?.packetId },
        revision: { revision: { routing: { route: "page", urgency: "p1" } } }
      });

      const firstPolicy = (await kernel.listAttentionPolicies())[0];
      expect(
        await kernel.execute({
          type: "attention-policy.approve",
          idempotencyKey: "attention-policy-2",
          actor,
          payload: {
            policy: policy(ids.policy2, 2, {
              kind: "attention_policy",
              id: ids.policy1,
              digest: firstPolicy?.policyDigest ?? ""
            })
          }
        })
      ).toMatchObject({ ok: true });
      const request = (await kernel.listOperatorDecisionRequests(ids.program))[0];
      const progressive = await kernel.execute({
        type: "attention.compile",
        idempotencyKey: "attention-progressive-compile",
        actor: { kind: "system", id: "attention-compiler" },
        payload: {
          schemaVersion: 1,
          source: {
            kind: "operator_decision_request",
            id: ids.request,
            digest: request?.requestDigest ?? ""
          },
          expectedThroughPosition: await throughPosition(kernel)
        }
      });
      expect(progressive.ok && progressive.events.map((event) => event.type)).toEqual([
        "DecisionEvidenceBundleRecorded",
        "DecisionPacketRevisionRecorded",
        "DecisionPacketCurrentRevisionChanged",
        "AttentionDeliveryObsoleted",
        "AttentionDeliveryQueued"
      ]);
      const revisions = await kernel.listDecisionPacketRevisions(packet?.packetId);
      expect(revisions).toHaveLength(2);
      expect(revisions[1]?.revision).toMatchObject({
        revision: 2,
        priorRevisionRef: { id: firstRevision?.revision.packetRevisionId },
        policyBinding: { kind: "attention_policy", id: ids.policy2 }
      });

      const stale = await kernel.execute({
        type: "decision.reprioritize",
        idempotencyKey: "attention-stale-action",
        actor,
        payload: {
          schemaVersion: 1,
          packetId: packet?.packetId ?? "",
          packetRevisionId: firstRevision?.revision.packetRevisionId ?? "",
          packetRevisionDigest: firstRevision?.revisionDigest ?? "",
          optionId: ids.option,
          targetPreconditionDigest: canonicalDigest(target)
        }
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "DECISION_PACKET_STALE" } });

      const latest = revisions[1];
      const acknowledged = await kernel.execute({
        type: "decision.acknowledge",
        idempotencyKey: "attention-ack",
        actor,
        payload: {
          schemaVersion: 1,
          acknowledgementId: ids.acknowledgement,
          packetId: packet?.packetId ?? "",
          packetRevisionId: latest?.revision.packetRevisionId ?? "",
          packetRevisionDigest: latest?.revisionDigest ?? ""
        }
      });
      expect(acknowledged.ok && acknowledged.events.map((event) => event.type)).toEqual([
        "DecisionAcknowledged",
        "AttentionDeliveryObsoleted"
      ]);

      const action = {
        type: "decision.reprioritize" as const,
        idempotencyKey: "attention-reprioritize",
        actor,
        payload: {
          schemaVersion: 1 as const,
          packetId: packet?.packetId ?? "",
          packetRevisionId: latest?.revision.packetRevisionId ?? "",
          packetRevisionDigest: latest?.revisionDigest ?? "",
          optionId: ids.option,
          targetPreconditionDigest: canonicalDigest(target)
        }
      };
      const resolved = await kernel.execute(action);
      expect(resolved.ok && resolved.events.map((event) => event.type)).toEqual([
        "ProgramAttentionPriorityChanged",
        "DecisionActionApplied",
        "DecisionResolved",
        "DecisionPrecedentRecorded"
      ]);
      expect(await kernel.execute(action)).toMatchObject({ ok: true, replayed: true });
      expect(await kernel.getState({ kind: "program", id: ids.program })).toMatchObject({
        attentionPriority: "p1",
        version: 2
      });
      expect(await kernel.listAttentionQueue(ids.program)).toEqual([]);
      expect(await kernel.getDecisionAudit(packet?.packetId ?? "")).toMatchObject({
        packet: { status: "resolved" },
        revisions: [{ revision: { revision: 1 } }, { revision: { revision: 2 } }],
        acknowledgements: [{ acknowledgement: { acknowledgementId: ids.acknowledgement } }],
        resolution: { resolution: { actionKind: "reprioritize" } },
        actionResult: { result: { actionKind: "reprioritize" } },
        precedent: { precedent: { selectedOptionId: ids.option } },
        deliveries: [{ delivery: { status: "obsolete" } }, { delivery: { status: "obsolete" } }]
      });
      expect(
        await kernel.execute({
          type: "attention-measurement-report.compile",
          idempotencyKey: "attention-attention-measurement",
          actor,
          payload: {
            schemaVersion: 1,
            reportId: ids.measurement,
            programId: ids.program,
            expectedThroughPosition: await throughPosition(kernel)
          }
        })
      ).toMatchObject({
        ok: true,
        data: { report: { staleActionConflictCount: 1 } }
      });
      expect(await kernel.verifyProjections()).toMatchObject({
        valid: true,
        projectionSchemaVersion: 1
      });
      expect(await kernel.rebuildProjections()).toMatchObject({ projectionSchemaVersion: 1 });
      expect(await kernel.verifyProjections()).toMatchObject({ valid: true });
    } finally {
      await kernel.close();
    }
  });

  it("detects digest tampering and repairs attention projections from replay", async () => {
    const { databasePath, kernel } = await createKernel();
    await kernel.execute({
      type: "program.create",
      idempotencyKey: "attention-tamper-program",
      actor,
      payload: { programId: ids.program, name: "Tamper evidence" }
    });
    await kernel.execute({
      type: "decision.request",
      idempotencyKey: "attention-tamper-request",
      actor,
      payload: {
        request: {
          schemaVersion: 1,
          requestId: ids.request,
          programId: ids.program,
          milestoneId: null,
          originalQuestion: "Should the priority change?",
          prompt: "Review the bounded priority action.",
          context: "This packet is used to prove digest tampering is detected.",
          riskClass: "low",
          safetyClass: "routine",
          reversibility: "reversible",
          options: [
            {
              optionId: ids.option,
              label: "Raise priority",
              consequences: ["Queue order changes."],
              reversalCost: "Low",
              action: {
                kind: "reprioritize",
                target: {
                  kind: "program_attention_priority",
                  programId: ids.program,
                  expectedProgramVersion: 1,
                  priority: "p1"
                }
              }
            }
          ],
          refs: [],
          deadlineAt: null
        }
      }
    });
    await kernel.close();

    const database = new Database(databasePath);
    database
      .prepare(
        "UPDATE decision_packet_revisions_projection SET state_json = json_set(state_json, '$.revision.prompt', ?)"
      )
      .run("Tampered prompt");
    database.close();

    const reopened = openKernelForTesting({
      databasePath,
      clock: new FixedClock(),
      idGenerator: new SequenceIds()
    });
    try {
      expect(await reopened.verifyProjections()).toMatchObject({
        valid: false,
        currentDigest: null
      });
      expect(await reopened.rebuildProjections()).toMatchObject({ projectionSchemaVersion: 1 });
      expect(await reopened.verifyProjections()).toMatchObject({ valid: true });
      expect((await reopened.listDecisionPacketRevisions())[0]?.revision.prompt).toBe(
        "Review the bounded priority action."
      );
    } finally {
      await reopened.close();
    }
  });

  it("rejects missing and cross-program action authority without appending events", async () => {
    const { kernel } = await createKernel();
    const otherProgram = "70000000-0000-4000-8000-000000000090";
    const requestId = "70000000-0000-4000-8000-000000000091";
    const optionId = "70000000-0000-4000-8000-000000000092";
    try {
      for (const [programId, key] of [
        [ids.program, "authority-program-1"],
        [otherProgram, "authority-program-2"]
      ] as const) {
        expect(
          await kernel.execute({
            type: "program.create",
            idempotencyKey: key,
            actor,
            payload: { programId, name: key }
          })
        ).toMatchObject({ ok: true });
      }
      const before = await throughPosition(kernel);
      expect(
        await kernel.execute({
          type: "decision.request",
          idempotencyKey: "cross-program-request",
          actor,
          payload: {
            request: {
              schemaVersion: 1,
              requestId,
              programId: ids.program,
              milestoneId: null,
              originalQuestion: "Can this packet mutate another program?",
              prompt: "This cross-program target must be rejected.",
              context: "The request program and target program differ.",
              riskClass: "reserved",
              safetyClass: "safety_critical",
              reversibility: "one_way",
              options: [
                {
                  optionId,
                  label: "Mutate another program",
                  consequences: ["This would cross the authority boundary."],
                  reversalCost: "Not allowed",
                  action: {
                    kind: "reprioritize",
                    target: {
                      kind: "program_attention_priority",
                      programId: otherProgram,
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
      ).toMatchObject({ ok: false, error: { code: "ATTENTION_SOURCE_NOT_FOUND" } });
      expect(await throughPosition(kernel)).toBe(before);
      expect(await kernel.listOperatorDecisionRequests()).toEqual([]);
      expect(await kernel.listDecisionPackets()).toEqual([]);
    } finally {
      await kernel.close();
    }
  });

  it("records routine budget exhaustion while safety-critical pages bypass the budget", async () => {
    const { kernel } = await createKernel();
    const routineRequest = "70000000-0000-4000-8000-000000000080";
    const routineOption = "70000000-0000-4000-8000-000000000081";
    const safetyRequest = "70000000-0000-4000-8000-000000000082";
    const safetyOption = "70000000-0000-4000-8000-000000000083";
    const digestId = "70000000-0000-4000-8000-000000000084";
    const reportId = "70000000-0000-4000-8000-000000000085";
    try {
      expect(
        await kernel.execute({
          type: "program.create",
          idempotencyKey: "budget-program",
          actor,
          payload: { programId: ids.program, name: "Attention budget" }
        })
      ).toMatchObject({ ok: true });
      expect(
        await kernel.execute({
          type: "attention-policy.approve",
          idempotencyKey: "budget-policy",
          actor,
          payload: {
            policy: {
              ...policy(ids.policy1, 1, null),
              routinePageBudget: { maxPages: 0, windowMs: 86_400_000 }
            }
          }
        })
      ).toMatchObject({ ok: true });
      const submit = async (
        requestId: string,
        optionId: string,
        safetyClass: "routine" | "safety_critical"
      ) =>
        kernel.execute({
          type: "decision.request",
          idempotencyKey: `budget-request-${requestId}`,
          actor,
          payload: {
            request: {
              schemaVersion: 1,
              requestId,
              programId: ids.program,
              milestoneId: null,
              originalQuestion: `Route ${safetyClass} attention?`,
              prompt: `Classify the ${safetyClass} decision.`,
              context: "The same policy budget applies; safety is evaluated independently.",
              riskClass: safetyClass === "safety_critical" ? "high" : "normal",
              safetyClass,
              reversibility: "reversible",
              options: [
                {
                  optionId,
                  label: "Raise priority",
                  consequences: ["Queue ordering changes."],
                  reversalCost: "Low",
                  action: {
                    kind: "reprioritize",
                    target: {
                      kind: "program_attention_priority",
                      programId: ids.program,
                      expectedProgramVersion: 1,
                      priority: "p1"
                    }
                  }
                }
              ],
              refs: [],
              deadlineAt: null
            }
          }
        });
      expect(await submit(routineRequest, routineOption, "routine")).toMatchObject({ ok: true });
      expect(await submit(safetyRequest, safetyOption, "safety_critical")).toMatchObject({
        ok: true
      });
      expect(await kernel.listAttentionQueue(ids.program, "queue")).toHaveLength(1);
      expect(await kernel.listAttentionQueue(ids.program, "page")).toHaveLength(1);
      expect(await kernel.listAttentionBudgetIncidents(ids.program)).toHaveLength(1);
      expect(await kernel.listAttentionDeliveries(ids.program)).toHaveLength(1);
      const digestResult = await kernel.execute({
        type: "attention-digest.compile",
        idempotencyKey: "budget-digest",
        actor,
        payload: {
          schemaVersion: 1,
          artifactId: digestId,
          programId: ids.program,
          expectedThroughPosition: await throughPosition(kernel)
        }
      });
      expect(digestResult).toMatchObject({ ok: true });
      if (!digestResult.ok || digestResult.data.kind !== "attention_digest_artifact") {
        throw new Error("Expected an attention digest artifact");
      }
      expect(digestResult.data.artifact.items).toHaveLength(2);
      for (const item of digestResult.data.artifact.items) {
        expect(item.deepLink).toMatch(/^\/decisions\/[0-9a-f-]+\?revision=[0-9a-f-]+$/);
      }
      expect(
        await kernel.execute({
          type: "attention-measurement-report.compile",
          idempotencyKey: "budget-measurement",
          actor,
          payload: {
            schemaVersion: 1,
            reportId,
            programId: ids.program,
            expectedThroughPosition: await throughPosition(kernel)
          }
        })
      ).toMatchObject({
        ok: true,
        data: {
          report: {
            packets: [
              { queueWait: { status: "open" }, resolutionLatency: { status: "open" } },
              { queueWait: { status: "open" }, resolutionLatency: { status: "open" } }
            ],
            pageCount: 1,
            routineBudgetIncidentCount: 1,
            completeness: { acknowledgements: false, resolutions: false, window: false }
          }
        }
      });
    } finally {
      await kernel.close();
    }
  });
});
