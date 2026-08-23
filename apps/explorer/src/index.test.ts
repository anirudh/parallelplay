import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase, openKernel, sourceRevisionDigest } from "@parallelplay/kernel";
import { initializeArtifactStore, initializeSourceStore } from "@parallelplay/runtime";
import { startExplorerServer } from "./index.js";

const ids = {
  workflow: "60000000-0000-4000-8000-000000000001",
  program: "60000000-0000-4000-8000-000000000002",
  milestone: "60000000-0000-4000-8000-000000000003",
  repository: "60000000-0000-4000-8000-000000000004",
  revision: "60000000-0000-4000-8000-000000000005",
  run: "60000000-0000-4000-8000-000000000006",
  job: "60000000-0000-4000-8000-000000000007",
  decisionRequest: "60000000-0000-4000-8000-000000000008",
  decisionOption: "60000000-0000-4000-8000-000000000009"
} as const;
const actor = { kind: "operator", id: "explorer-test" } as const;
const directories: string[] = [];

async function fixture(): Promise<{
  databasePath: string;
  sourceRoot: string;
  artifactRoot: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-explorer-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  const sourceRoot = join(directory, "source-store");
  const artifactRoot = join(directory, "artifact-store");
  initializeSourceStore(sourceRoot);
  initializeArtifactStore(artifactRoot);
  await migrateDatabase({ databasePath });
  const kernel = await openKernel({ databasePath });
  const revision = {
    repositoryId: ids.repository,
    objectFormat: "sha1" as const,
    commitOid: "a".repeat(40),
    treeOid: "b".repeat(40)
  };
  try {
    for (const command of [
      {
        type: "workflow.register" as const,
        idempotencyKey: "workflow",
        actor,
        payload: {
          schemaVersion: 2 as const,
          workflowId: ids.workflow,
          version: 1,
          name: "Explorer workflow",
          steps: [
            {
              id: "implement",
              capability: "implementation",
              dependsOn: [],
              execution: {
                protocolVersion: 1 as const,
                image: `parallelplay-fixture@sha256:${"0".repeat(64)}`,
                argv: ["/bin/true"],
                workingDirectory: "/workspace" as const
              },
              capabilities: {
                schemaVersion: 1 as const,
                workspace: "read_write" as const,
                artifactOutput: "read_write" as const,
                scratch: "read_write" as const,
                cpuLimit: 1,
                memoryLimitBytes: 268_435_456,
                pidsLimit: 64,
                network: [] as [],
                secrets: [] as [],
                git: [] as []
              },
              verification: {
                mode: "verify" as const,
                argv: ["./verify.sh"],
                cwd: "." as const,
                timeoutMs: 1_000,
                environment: {},
                toolProbes: []
              }
            }
          ]
        }
      },
      {
        type: "source-revision.register" as const,
        idempotencyKey: "revision",
        actor,
        payload: {
          revisionId: ids.revision,
          ...revision,
          storageRef: `refs/parallelplay/revisions/${ids.revision}`,
          revisionDigest: sourceRevisionDigest(revision)
        }
      },
      {
        type: "program.approve" as const,
        idempotencyKey: "approve",
        actor,
        payload: {
          schemaVersion: 1 as const,
          program: {
            programId: ids.program,
            name: "Explorer program",
            intent: {
              schemaVersion: 1 as const,
              objective: "Inspect one milestone.",
              nonGoals: [],
              tenets: ["Replay", "Evidence", "Read-only UI"],
              riskClass: "normal" as const
            }
          },
          milestone: {
            schemaVersion: 1 as const,
            milestoneId: ids.milestone,
            title: "Explorer milestone",
            objective: "Show authoritative execution evidence.",
            taskType: "feature" as const,
            priority: "p1" as const,
            tags: ["explorer"],
            workflowId: ids.workflow,
            workflowVersion: 1,
            criteria: [
              {
                criterionId: "visible",
                statement: "The milestone is visible in the explorer.",
                verificationStepId: "implement"
              }
            ]
          }
        }
      },
      {
        type: "milestone.start" as const,
        idempotencyKey: "start",
        actor,
        payload: {
          schemaVersion: 1 as const,
          milestoneId: ids.milestone,
          runId: ids.run,
          jobId: ids.job,
          sourceRevisionId: ids.revision,
          policy: { maxAttempts: 1, attemptTimeoutMs: 5_000, retryDelaysMs: [] }
        }
      },
      {
        type: "run.cancel" as const,
        idempotencyKey: "cancel",
        actor,
        payload: { runId: ids.run, reason: "Explorer fixture cancellation" }
      },
      {
        type: "decision.request" as const,
        idempotencyKey: "attention-request",
        actor,
        payload: {
          request: {
            schemaVersion: 1 as const,
            requestId: ids.decisionRequest,
            programId: ids.program,
            milestoneId: ids.milestone,
            originalQuestion: "Should this program receive higher attention priority?",
            prompt: "Review the evidence and choose the bounded queue-order action.",
            context: "Explorer fixture packet for read-only attention queries.",
            riskClass: "low" as const,
            safetyClass: "routine" as const,
            reversibility: "reversible" as const,
            options: [
              {
                optionId: ids.decisionOption,
                label: "Raise priority",
                consequences: ["The program moves ahead of routine programs."],
                reversalCost: "Low",
                action: {
                  kind: "reprioritize" as const,
                  target: {
                    kind: "program_attention_priority" as const,
                    programId: ids.program,
                    expectedProgramVersion: 2,
                    priority: "p1" as const
                  }
                }
              }
            ],
            refs: [],
            deadlineAt: null
          }
        }
      }
    ]) {
      expect((await kernel.execute(command)).ok).toBe(true);
    }
  } finally {
    await kernel.close();
  }
  return { databasePath, sourceRoot, artifactRoot };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("read-only execution explorer", () => {
  it("binds to loopback, serves complete snapshots, rejects writes, and survives restart", async () => {
    const options = { ...(await fixture()), port: 0 };
    let explorer = await startExplorerServer(options);
    expect(explorer.host).toBe("127.0.0.1");
    expect(explorer.port).toBeGreaterThan(0);
    const html = await fetch(explorer.url);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await html.text()).toContain("Read-only local evidence");

    const snapshot = await fetch(`${explorer.url}/api/snapshot`);
    expect(snapshot.status).toBe(200);
    const snapshotValue = (await snapshot.json()) as {
      snapshotVersion: number;
      programs: {
        programId: string;
        name: string;
        intent: { objective: string } | null;
      }[];
      milestones: {
        milestone: { milestoneId: string; contract: { title: string }; status: string };
        run: { runId: string } | null;
        job: { candidateRevisionId: string | null } | null;
        attempts: { attemptId: string; ordinal: number; status: string }[];
        driverReceipts: { driverReceiptId: string }[];
        verifications: { verificationId: string }[];
        outcomePacket: {
          packet: {
            criteriaResults: { criterionId: string; result: string }[];
            recommendation: string;
          };
        } | null;
      }[];
    };
    expect(snapshotValue).toMatchObject({
      snapshotVersion: 4,
      programs: [{ programId: ids.program }],
      milestones: [
        {
          milestone: { milestoneId: ids.milestone, status: "outcome_ready" },
          outcomePacket: { packet: { recommendation: "investigate" } }
        }
      ]
    });
    const normalizedSnapshot = {
      snapshotVersion: snapshotValue.snapshotVersion,
      programs: snapshotValue.programs
        .filter((program) => program.intent !== null)
        .map((program) => ({
          programId: program.programId,
          name: program.name,
          objective: program.intent?.objective
        })),
      milestones: snapshotValue.milestones.map((value) => ({
        milestoneId: value.milestone.milestoneId,
        title: value.milestone.contract.title,
        status: value.milestone.status,
        runId: value.run?.runId ?? null,
        candidateRevisionId: value.job?.candidateRevisionId ?? null,
        criterionResults:
          value.outcomePacket?.packet.criteriaResults.map((criterion) => ({
            criterionId: criterion.criterionId,
            result: criterion.result
          })) ?? [],
        attempts: value.attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          ordinal: attempt.ordinal,
          status: attempt.status
        })),
        driverReceiptIds: value.driverReceipts.map((receipt) => receipt.driverReceiptId),
        verificationReceiptIds: value.verifications.map(
          (verification) => verification.verificationId
        ),
        recommendation: value.outcomePacket?.packet.recommendation ?? null
      }))
    };
    const goldenSnapshot = JSON.parse(
      readFileSync(
        new URL("../test/fixtures/golden-explorer-snapshot.json", import.meta.url),
        "utf8"
      )
    ) as unknown;
    expect(normalizedSnapshot).toEqual(goldenSnapshot);
    const attentionSnapshot = await fetch(`${explorer.url}/api/attention/snapshot`);
    expect(attentionSnapshot.status).toBe(200);
    expect(await attentionSnapshot.json()).toMatchObject({
      ok: true,
      data: {
        snapshotVersion: 1,
        queue: [{ revision: { revision: { routing: { route: "queue" } } } }]
      }
    });
    const advisorSnapshot = await fetch(`${explorer.url}/api/advisor/snapshot`);
    expect(advisorSnapshot.status).toBe(200);
    expect(await advisorSnapshot.json()).toMatchObject({
      ok: true,
      data: { snapshotVersion: 1, subjects: [], policies: [], promotions: [] }
    });
    const packets = await fetch(`${explorer.url}/api/decision-packets`);
    const packetValue = (await packets.json()) as { data: { packetId: string }[] };
    expect(packetValue.data).toHaveLength(1);
    const packetAudit = await fetch(
      `${explorer.url}/api/decision-packets/${packetValue.data[0]?.packetId ?? "missing"}`
    );
    expect(packetAudit.status).toBe(200);
    expect(await packetAudit.json()).toMatchObject({
      ok: true,
      data: { revisions: [{ revision: { source: { kind: "operator_decision_request" } } }] }
    });
    expect((await fetch(`${explorer.url}/api/attention/queue?route=invalid`)).status).toBe(400);
    const writer = await openKernel({ databasePath: options.databasePath });
    try {
      expect(
        await writer.execute({
          type: "program.create",
          idempotencyKey: "live-program",
          actor,
          payload: {
            programId: "60000000-0000-4000-8000-000000000099",
            name: "Visible after refresh"
          }
        })
      ).toMatchObject({ ok: true });
    } finally {
      await writer.close();
    }
    const refreshedPrograms = await fetch(`${explorer.url}/api/programs`);
    const refreshedValue = (await refreshedPrograms.json()) as {
      data: { programId: string }[];
    };
    expect(refreshedValue.data.map((program) => program.programId)).toContain(
      "60000000-0000-4000-8000-000000000099"
    );
    const forbidden = await fetch(`${explorer.url}/api/programs`, { method: "POST" });
    expect(forbidden.status).toBe(405);
    expect(forbidden.headers.get("allow")).toBe("GET");
    const missingEvidence = await fetch(`${explorer.url}/api/evidence/${"a".repeat(64)}`);
    expect(missingEvidence.status).toBe(404);
    await explorer.close();

    explorer = await startExplorerServer(options);
    try {
      const milestone = await fetch(`${explorer.url}/api/milestones/${ids.milestone}`);
      expect(milestone.status).toBe(200);
      expect(await milestone.json()).toMatchObject({
        ok: true,
        data: { milestone: { milestoneId: ids.milestone } }
      });
      const client = await fetch(`${explorer.url}/assets/client.js`);
      expect(client.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await client.text()).not.toContain("localStorage");
    } finally {
      await explorer.close();
    }
  });
});
